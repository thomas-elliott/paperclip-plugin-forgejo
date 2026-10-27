import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginWorkspace, Project } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const config = { baseUrl: "https://git.example.com/", token: "token-secret-ref" };

async function setUp(pluginConfig: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config: pluginConfig });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

// The harness passes ctx.http.fetch straight to the global fetch, so stubbing it stands in for Forgejo.
function stubForgejo(responses: Record<string, Response>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => responses[url] ?? new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("connection check", () => {
  it("asks for settings when the plugin is not configured", async () => {
    const harness = await setUp({});
    const status = await harness.getData("connection", { companyId: "co-1" });
    expect(status).toEqual({ connected: false, reason: expect.stringContaining("Set the Forgejo URL") });
  });

  it("reports the Forgejo version and user when the token works", async () => {
    const fetchMock = stubForgejo({
      "https://git.example.com/api/v1/version": Response.json({ version: "13.0.1" }),
      "https://git.example.com/api/v1/user": Response.json({ login: "telliott" }),
    });
    const harness = await setUp(config);

    const status = await harness.getData("connection", { companyId: "co-1" });

    expect(status).toEqual({ connected: true, forgejoVersion: "13.0.1", username: "telliott" });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "token resolved:token-secret-ref" });
  });

  it("tells a bad token apart from an unreachable server", async () => {
    stubForgejo({
      "https://git.example.com/api/v1/version": Response.json({ version: "13.0.1" }),
      "https://git.example.com/api/v1/user": new Response(null, { status: 401 }),
    });
    const harness = await setUp(config);

    const status = await harness.getData("connection", { companyId: "co-1" });

    expect(status).toEqual({ connected: false, reason: expect.stringContaining("rejected the access token") });
  });

  it("reports a bad token even when Forgejo rejects bad tokens on /version", async () => {
    // Codeberg answers /version with 401 when the request carries an invalid token.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const hasToken = Boolean((init?.headers as Record<string, string> | undefined)?.Authorization);
      if (url.endsWith("/version")) return hasToken ? new Response(null, { status: 401 }) : Response.json({ version: "13.0.1" });
      return new Response(null, { status: 401 });
    }));
    const harness = await setUp(config);

    const status = await harness.getData("connection", { companyId: "co-1" });

    expect(status).toEqual({ connected: false, reason: expect.stringContaining("rejected the access token") });
  });

  it("explains a network failure instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const harness = await setUp(config);

    const status = await harness.getData("connection", { companyId: "co-1" });

    expect(status).toEqual({ connected: false, reason: expect.stringContaining("Could not reach Forgejo") });
  });
});

describe("project repositories", () => {
  const repo = (name: string) => ({
    full_name: `me/${name}`,
    clone_url: `https://git.example.com/me/${name}.git`,
    ssh_url: `git@git.example.com:me/${name}.git`,
    html_url: `https://git.example.com/me/${name}`,
    private: false,
  });

  // Serves the repositories in pages of `pageSize`, the way a Forgejo admin's MAX_RESPONSE_ITEMS caps them.
  function stubRepositories(names: string[], pageSize: number) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json(names.slice((page - 1) * pageSize, page * pageSize).map(repo));
    }));
  }

  async function projectRepositories(workspaces: Partial<PluginWorkspace>[]) {
    const harness = await setUp(config);
    harness.seed({
      projects: [{ id: "project-1", companyId: "co-1" } as Project],
      projectWorkspaces: workspaces.map((workspace) => ({ projectId: "project-1", ...workspace }) as PluginWorkspace),
    });
    return (await harness.getData("projectRepositories", { companyId: "co-1", projectId: "project-1" })) as {
      linkedWorkspaces: { name: string; repoUrl: string }[];
      repositories: { fullName: string; linked: boolean }[];
    };
  }

  it("fetches every repository when the server caps pages below the requested size", async () => {
    stubRepositories(Array.from({ length: 40 }, (_, n) => `repo-${n}`), 30);

    const result = await projectRepositories([]);

    expect(result.repositories).toHaveLength(40);
  });

  it("recognises workspaces by any address Forgejo gives the repository", async () => {
    stubRepositories(["app", "site", "docs"], 50);

    const result = await projectRepositories([
      { id: "ws-1", name: "app", repoUrl: "ssh://git@git.example.com/me/app.git" },
      { id: "ws-2", name: "site", repoUrl: "https://git.example.com/me/site/" },
      { id: "ws-3", name: "other", repoUrl: "https://github.com/me/docs.git" },
    ]);

    expect(result.linkedWorkspaces.map((workspace) => workspace.name)).toEqual(["app", "site"]);
    expect(result.repositories.filter((repository) => repository.linked).map((repository) => repository.fullName)).toEqual([
      "me/app",
      "me/site",
    ]);
  });
});
