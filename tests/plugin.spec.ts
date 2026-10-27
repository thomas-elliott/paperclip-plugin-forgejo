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
});

describe("project repositories", () => {
  it("lists every page of repositories and only the workspaces on this Forgejo server", async () => {
    const repo = (n: number) => ({ full_name: `me/repo-${n}`, clone_url: `https://git.example.com/me/repo-${n}.git`, private: false });
    stubForgejo({
      "https://git.example.com/api/v1/user/repos?limit=50&page=1": Response.json(Array.from({ length: 50 }, (_, n) => repo(n))),
      "https://git.example.com/api/v1/user/repos?limit=50&page=2": Response.json([repo(50)]),
    });
    const harness = await setUp(config);
    harness.seed({
      projects: [{ id: "project-1", companyId: "co-1" } as Project],
      projectWorkspaces: [
        { id: "ws-1", projectId: "project-1", name: "app", repoUrl: "https://git.example.com/me/app.git" } as PluginWorkspace,
        { id: "ws-2", projectId: "project-1", name: "docs", repoUrl: "https://github.com/me/docs.git" } as PluginWorkspace,
      ],
    });

    const result = await harness.getData("projectRepositories", { companyId: "co-1", projectId: "project-1" });

    expect(result).toMatchObject({
      configured: true,
      linkedWorkspaces: [{ name: "app", repoUrl: "https://git.example.com/me/app.git" }],
    });
    expect((result as { repositories: unknown[] }).repositories).toHaveLength(51);
  });
});
