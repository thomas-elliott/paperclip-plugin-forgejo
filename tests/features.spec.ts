import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginWorkspace, Project, ToolResult } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { BASE_URL, FakeForgejo } from "./fake-forgejo.js";

const config = { baseUrl: `${BASE_URL}/`, token: "token-ref", webhookSecret: "hook-ref", syncIssues: true };

// One company with one project whose workspaces were created from `repositories`.
async function setUp(pluginConfig: Record<string, unknown>, repositories: string[]) {
  const harness = createTestHarness({ manifest, config: pluginConfig });
  await plugin.definition.setup(harness.ctx);
  // Saving settings is how the plugin learns which companies to sync and check webhooks for.
  await plugin.definition.onConfigChanged!(pluginConfig, { companyId: "co-1" });
  harness.seed({
    projects: [{ id: "project-1", companyId: "co-1" } as Project],
    projectWorkspaces: repositories.map(
      (name, index) => ({ id: `ws-${index}`, projectId: "project-1", name, repoUrl: `${BASE_URL}/${name}.git` }) as PluginWorkspace,
    ),
  });
  return harness;
}

const runCtx = { companyId: "co-1", projectId: "project-1" };

// Several companies, each with its own settings and a project "project-<company>" using me/app.
// The harness serves one config to every company, so this stands in for Paperclip's per-company
// settings. All companies save their settings at the same moment.
async function setUpCompanies(configs: Record<string, Record<string, unknown>>) {
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config.get = async (companyId) => configs[companyId ?? ""] ?? {};
  await plugin.definition.setup(harness.ctx);
  await Promise.all(Object.entries(configs).map(([companyId, companyConfig]) => plugin.definition.onConfigChanged!(companyConfig, { companyId })));
  const companies = Object.keys(configs);
  harness.seed({
    projects: companies.map((companyId) => ({ id: `project-${companyId}`, companyId }) as Project),
    projectWorkspaces: companies.map(
      (companyId) => ({ id: `ws-${companyId}`, projectId: `project-${companyId}`, name: "app", repoUrl: `${BASE_URL}/me/app.git` }) as PluginWorkspace,
    ),
  });
  return harness;
}

async function issueTitles(harness: ReturnType<typeof createTestHarness>, companyId: string) {
  return (await harness.ctx.issues.list({ companyId })).map((issue) => issue.title);
}

// A Forgejo issue event signed the way Forgejo signs it. The harness resolves a secret reference to
// "resolved:<reference>", so "resolved:hook-ref" is the configured webhook secret.
function delivery(payload: unknown, secret = "resolved:hook-ref") {
  const rawBody = JSON.stringify(payload);
  return {
    endpointKey: "forgejo",
    requestId: "delivery-1",
    rawBody,
    headers: { "x-forgejo-event": "issues", "x-forgejo-signature": createHmac("sha256", secret).update(rawBody).digest("hex") },
  };
}

function issueEvent(forgejo: FakeForgejo, action: string, issue: { number: number; title: string; state: string; updated_at?: string }) {
  return {
    action,
    repository: forgejo.repositoryJson("me/app"),
    issue: { body: "", html_url: `${BASE_URL}/me/app/issues/${issue.number}`, updated_at: "2026-10-03T00:00:00Z", ...issue },
  };
}

// Paperclip's issues.list cuts descriptions to 1,200 characters; the harness does not, so do it here.
function shortenListedDescriptions(harness: ReturnType<typeof createTestHarness>) {
  const list = harness.ctx.issues.list.bind(harness.ctx.issues);
  harness.ctx.issues.list = async (input) =>
    (await list(input)).map((issue) =>
      issue.description && issue.description.length > 1200 ? { ...issue, description: `${issue.description.slice(0, 1185)} [truncated]` } : issue,
    );
}

// Counts Paperclip issue updates, and delivers issue.updated as soon as each is saved, as Paperclip may.
function watchIssueUpdates(harness: ReturnType<typeof createTestHarness>) {
  const update = harness.ctx.issues.update.bind(harness.ctx.issues);
  const counter = { updates: 0 };
  harness.ctx.issues.update = async (issueId, patch, companyId, actor) => {
    const updated = await update(issueId, patch, companyId, actor);
    counter.updates += 1;
    await harness.emit("issue.updated", {}, { entityId: issueId, entityType: "issue", companyId });
    return updated;
  };
  return counter;
}

afterEach(() => vi.unstubAllGlobals());

describe("link status", () => {
  const candidate = (url: string) => ({
    sanitizedCanonicalUrl: url,
    sanitizedDisplayUrl: url,
    canonicalIdentityHash: `hash:${url}`,
    canonicalIdentity: {},
    redactedMatchedText: url,
  });

  it("recognises issue and pull request links on the configured Forgejo only", async () => {
    await setUp(config, []);
    const { detections } = await plugin.definition.onDetectExternalObjects!({
      companyId: "co-1",
      sourceContext: {} as never,
      urls: [
        candidate(`${BASE_URL}/Me/App/issues/12`),
        candidate(`${BASE_URL}/me/app/pulls/3/files`),
        candidate(`${BASE_URL}/me/app/src/branch/main`),
        candidate("https://git.example.org/me/app/issues/12"),
        candidate(`${BASE_URL}/me/a%3Fb/issues/9`),
      ],
    });

    expect(detections.map(({ objectType, externalId, displayKey }) => ({ objectType, externalId, displayKey }))).toEqual([
      { objectType: "issue", externalId: "me/app#12", displayKey: "Me/App#12" },
      { objectType: "pull_request", externalId: "me/app#3", displayKey: "me/app#3" },
    ]);
  });

  async function resolve(objectType: string, externalId: string) {
    return plugin.definition.onResolveExternalObject!({ companyId: "co-1", providerKey: "forgejo", objectType, externalId, object: {} as never });
  }

  it("shows a merged pull request as merged and a closed issue as closed", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1, state: "closed" });
    forgejo.addIssue("me/app", { number: 2, isPull: true, merged: true, state: "closed" });
    await setUp(config, []);

    expect(await resolve("issue", "me/app#1")).toMatchObject({ ok: true, snapshot: { statusLabel: "Closed", isTerminal: true } });
    expect(await resolve("pull_request", "me/app#2")).toMatchObject({ ok: true, snapshot: { statusLabel: "Merged", statusCategory: "succeeded" } });
  });

  it("reads a proxy's HTML error page by its status", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.override = (path) => {
      const html = { headers: { "Content-Type": "text/html" } };
      if (path === "/repos/me/app/issues/1") return new Response("<html>Sign in</html>", { status: 401, ...html });
      if (path === "/repos/me/app/issues/2") return new Response("<html>Not here</html>", { status: 404, ...html });
    };
    await setUp(config, []);

    expect(await resolve("issue", "me/app#1")).toMatchObject({ ok: false, liveness: "auth_required" });
    expect(await resolve("issue", "me/app#2")).toMatchObject({ ok: true, snapshot: { statusKey: "not_found" } });
  });

  it("shows a missing item as not found rather than failing", async () => {
    new FakeForgejo(["me/app"]);
    await setUp(config, []);

    expect(await resolve("issue", "me/app#99")).toMatchObject({ ok: true, snapshot: { statusKey: "not_found" } });
  });
});

describe("agent tools", () => {
  it("installs a skill naming every tool when the settings are saved", async () => {
    new FakeForgejo(["me/app"]);
    const harness = await setUp(config, ["me/app"]);

    const { skill } = await harness.ctx.skills.managed.get("forgejo-tools", "co-1");

    expect(skill).not.toBeNull();
    for (const tool of manifest.tools ?? []) expect(skill!.markdown).toContain(`\`${tool.name}\``);
  });

  it("uses the project's only Forgejo repository when none is given", async () => {
    const forgejo = new FakeForgejo(["me/app", "me/other"]);
    forgejo.addIssue("me/app", { number: 4, title: "Fix login" });
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("get_issue", { number: 4 }, runCtx);

    expect(result.data).toMatchObject({ number: 4, title: "Fix login" });
  });

  it("asks for the repository when the project uses several", async () => {
    new FakeForgejo(["me/app", "me/site"]);
    const harness = await setUp(config, ["me/app", "me/site"]);

    const result = await harness.executeTool<ToolResult>("get_issue", { number: 4 }, runCtx);

    expect(result.error).toContain("me/app, me/site");
  });

  it("lists each comment once, though Forgejo ignores paging for comments", { timeout: 2000 }, async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 4 });
    forgejo.comments.set("me/app#4", ["First", "Second"]);
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("list_comments", { number: 4 }, runCtx);

    expect((result.data as { body: string }[]).map((comment) => comment.body)).toEqual(["First", "Second"]);
  });

  it("lists the files a pull request changes", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 7, isPull: true });
    forgejo.pullFiles.set("me/app#7", ["src/a.ts", "src/b.ts"]);
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("list_pull_request_files", { number: 7 }, runCtx);

    expect((result.data as { filename: string }[]).map((file) => file.filename)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("rejects a repository name that would reach other parts of the Forgejo API", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("get_issue", { repository: "me/app/../../../admin/users", number: 1 }, runCtx);

    const badNumber = await harness.executeTool<ToolResult>("get_issue", { number: "1/../../admin" }, runCtx);

    expect(result.error).toContain("owner/repo");
    expect(badNumber.error).toContain("whole number");
    expect(forgejo.requests).toEqual([]);
  });

  it("asks for missing required inputs instead of calling Forgejo", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    const harness = await setUp(config, ["me/app"]);

    const noNumber = await harness.executeTool<ToolResult>("get_issue", {}, runCtx);
    const noBody = await harness.executeTool<ToolResult>("add_comment", { number: 1 }, runCtx);

    expect([noNumber.error, noBody.error]).toEqual([expect.stringContaining("number"), expect.stringContaining("body")]);
    expect(forgejo.requests).toEqual([]);
  });

  it("finds the project's repository without listing every Forgejo repository", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 4 });
    const harness = await setUp(config, ["me/app"]);

    await harness.executeTool<ToolResult>("get_issue", { number: 4 }, runCtx);

    expect(forgejo.requests.map((request) => request.path)).toEqual(["/repos/me/app/issues/4"]);
  });

  it("recognises a workspace cloned over SSH from another host name", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.sshHost = "ssh.example.com";
    forgejo.addIssue("me/app", { number: 4, title: "Over SSH" });
    const harness = createTestHarness({ manifest, config });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      projects: [{ id: "project-1", companyId: "co-1" } as Project],
      projectWorkspaces: [{ id: "ws-1", projectId: "project-1", name: "app", repoUrl: "git@ssh.example.com:me/app.git" } as PluginWorkspace],
    });

    const result = await harness.executeTool<ToolResult>("get_issue", { number: 4 }, runCtx);

    expect(result.data).toMatchObject({ title: "Over SSH" });
  });

  it("refuses to merge until merging is allowed in the settings", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 7, isPull: true });

    const refused = await (await setUp(config, ["me/app"])).executeTool<ToolResult>("merge_pull_request", { number: 7 }, runCtx);
    expect(refused.error).toContain("Merging is turned off");
    expect(forgejo.issue("me/app", 7)?.merged).toBeFalsy();

    const merged = await (await setUp({ ...config, allowMerge: true }, ["me/app"])).executeTool<ToolResult>("merge_pull_request", { number: 7 }, runCtx);
    expect(merged.data).toMatchObject({ merged: true });
  });
});

describe("issue sync", () => {
  async function paperclipIssues(harness: Awaited<ReturnType<typeof setUp>>) {
    return harness.ctx.issues.list({ companyId: "co-1", projectId: "project-1" });
  }

  it("imports each open issue once, and nothing when import is turned off", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1, title: "First" });
    forgejo.addIssue("me/app", { number: 2, title: "Done already", state: "closed" });

    const off = await setUp({ ...config, syncIssues: false }, ["me/app"]);
    await off.runJob("sync-issues");
    expect(await paperclipIssues(off)).toHaveLength(0);

    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    await harness.runJob("sync-issues");
    expect((await paperclipIssues(harness)).map((issue) => issue.title)).toEqual(["First"]);
  });

  it("closes the Paperclip issue when the Forgejo issue closes, and reopens it when it reopens", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");

    forgejo.edit("me/app", 1, { state: "closed" });
    await harness.runJob("sync-issues");
    expect((await paperclipIssues(harness))[0].status).toBe("done");

    forgejo.edit("me/app", 1, { state: "open" });
    await harness.runJob("sync-issues");
    expect((await paperclipIssues(harness))[0].status).toBe("todo");
  });

  it("closes the Forgejo issue when the Paperclip issue is done", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    const [issue] = await paperclipIssues(harness);

    await harness.ctx.issues.update(issue.id, { status: "done" }, "co-1");
    await harness.emit("issue.updated", {}, { entityId: issue.id, entityType: "issue", companyId: "co-1" });

    expect(forgejo.issue("me/app", 1)?.state).toBe("closed");
  });

  it("keeps a Paperclip issue someone reopened, though its Forgejo issue stays closed", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    forgejo.edit("me/app", 1, { state: "closed" });
    await harness.runJob("sync-issues");
    const [issue] = await paperclipIssues(harness);

    await harness.ctx.issues.update(issue.id, { status: "todo" }, "co-1");
    await harness.runJob("sync-issues");
    await plugin.definition.onWebhook!(delivery(issueEvent(forgejo, "edited", { number: 1, title: "Renamed", state: "closed" })));

    expect((await paperclipIssues(harness))[0].status).toBe("todo");
  });
});

describe("issue sync without waste", () => {
  it("does not rewrite a long imported issue on every sync", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1, body: "Long. ".repeat(400) });
    const harness = await setUp(config, ["me/app"]);
    shortenListedDescriptions(harness);
    await harness.runJob("sync-issues");
    const counter = watchIssueUpdates(harness);

    await harness.runJob("sync-issues");
    await harness.runJob("sync-issues");

    expect(counter.updates).toBe(0);
  });

  it("copies a title changed in Forgejo", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1, title: "Old title" });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");

    forgejo.edit("me/app", 1, { title: "New title" });
    await harness.runJob("sync-issues");

    expect(await issueTitles(harness, "co-1")).toEqual(["New title"]);
  });

  it("does not send Forgejo back a close that came from Forgejo", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    watchIssueUpdates(harness);

    forgejo.edit("me/app", 1, { state: "closed" });
    forgejo.requests.length = 0;
    await harness.runJob("sync-issues");

    expect(forgejo.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });

  it("fetches a repository's issues once, however many projects use it", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    harness.seed({
      projects: [{ id: "project-2", companyId: "co-1" } as Project],
      projectWorkspaces: [{ id: "ws-other", projectId: "project-2", name: "app", repoUrl: `${BASE_URL}/me/app.git` } as PluginWorkspace],
    });

    await harness.runJob("sync-issues");

    // Page 1, then an empty page 2 that ends the list.
    expect(forgejo.requests.filter((request) => request.path === "/repos/me/app/issues")).toHaveLength(2);
  });

  it("imports an issue once when two deliveries and a sync arrive together", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 5, title: "Busy issue" });
    const harness = await setUp(config, ["me/app"]);
    const payload = issueEvent(forgejo, "opened", { number: 5, title: "Busy issue", state: "open" });

    await Promise.all([plugin.definition.onWebhook!(delivery(payload)), plugin.definition.onWebhook!(delivery(payload)), harness.runJob("sync-issues")]);

    expect(await issueTitles(harness, "co-1")).toEqual(["Busy issue"]);
  });
});

describe("issue sync when something goes wrong", () => {
  it("closes the Forgejo issue on the next sync when closing it straight away failed", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    const [issue] = await harness.ctx.issues.list({ companyId: "co-1" });

    forgejo.unreachable = true;
    await harness.ctx.issues.update(issue.id, { status: "done" }, "co-1");
    await harness.emit("issue.updated", {}, { entityId: issue.id, entityType: "issue", companyId: "co-1" }).catch(() => {});
    forgejo.unreachable = false;
    await harness.runJob("sync-issues");

    expect(forgejo.issue("me/app", 1)?.state).toBe("closed");
    expect((await harness.ctx.issues.get(issue.id, "co-1"))?.status).toBe("done");
  });

  it("tries a Forgejo close again when updating Paperclip failed", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    const update = harness.ctx.issues.update.bind(harness.ctx.issues);
    harness.ctx.issues.update = async () => {
      throw new Error("Paperclip is busy");
    };

    forgejo.edit("me/app", 1, { state: "closed" });
    await expect(harness.runJob("sync-issues")).rejects.toThrow("Paperclip is busy");
    harness.ctx.issues.update = update;
    await harness.runJob("sync-issues");

    expect((await harness.ctx.issues.list({ companyId: "co-1" }))[0].status).toBe("done");
  });

  it("does not import an issue again after someone hides it in Paperclip", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    const [issue] = await harness.ctx.issues.list({ companyId: "co-1" });

    // Paperclip leaves hidden issues out of issues.list; the harness does not, so filter here.
    const list = harness.ctx.issues.list.bind(harness.ctx.issues);
    harness.ctx.issues.list = async (input) => (await list(input)).filter((candidate) => candidate.id !== issue.id);
    await harness.runJob("sync-issues");

    expect(await list({ companyId: "co-1" })).toHaveLength(1);
  });

  it("keeps syncing a project's other repositories when one fails, then reports the failure", async () => {
    const forgejo = new FakeForgejo(["me/app", "me/site"]);
    forgejo.broken.add("me/app");
    forgejo.addIssue("me/site", { number: 1, title: "Site issue" });
    const harness = await setUp(config, ["me/app", "me/site"]);

    await expect(harness.runJob("sync-issues")).rejects.toThrow("me/app");

    expect(await issueTitles(harness, "co-1")).toEqual(["Site issue"]);
  });

  it("syncs every company, though they saved their settings at the same moment", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1, title: "Shared" });
    const harness = await setUpCompanies({ "co-1": config, "co-2": config, "co-3": config });

    await harness.runJob("sync-issues");

    expect([await issueTitles(harness, "co-1"), await issueTitles(harness, "co-2"), await issueTitles(harness, "co-3")]).toEqual([
      ["Shared"],
      ["Shared"],
      ["Shared"],
    ]);
  });
});

describe("webhook", () => {
  it("acts only for the company whose secret signed the delivery", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    const harness = await setUpCompanies({ "co-1": { ...config, webhookSecret: "secret-1" }, "co-2": { ...config, webhookSecret: "secret-2" } });

    await plugin.definition.onWebhook!(delivery(issueEvent(forgejo, "opened", { number: 5, title: "For company 2", state: "open" }), "resolved:secret-2"));

    expect([await issueTitles(harness, "co-1"), await issueTitles(harness, "co-2")]).toEqual([[], ["For company 2"]]);
  });

  it("still reaches the right company when another company's secret cannot be read", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    const harness = await setUpCompanies({ "co-1": { ...config, webhookSecret: "deleted-secret" }, "co-2": { ...config, webhookSecret: "secret-2" } });
    const resolve = harness.ctx.secrets.resolve.bind(harness.ctx.secrets);
    harness.ctx.secrets.resolve = async (ref, options) => {
      if (ref === ("deleted-secret" as never)) throw new Error("secret not found");
      return resolve(ref, options);
    };

    await plugin.definition.onWebhook!(delivery(issueEvent(forgejo, "opened", { number: 5, title: "For company 2", state: "open" }), "resolved:secret-2"));

    expect(await issueTitles(harness, "co-2")).toEqual(["For company 2"]);
  });

  it("imports the issue from a signed delivery and rejects a wrongly signed one", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    const harness = await setUp(config, ["me/app"]);
    const payload = issueEvent(forgejo, "opened", { number: 5, title: "From a webhook", state: "open" });

    await expect(plugin.definition.onWebhook!(delivery(payload, "wrong secret"))).rejects.toThrow("signature");
    await plugin.definition.onWebhook!(delivery(payload));

    expect((await harness.ctx.issues.list({ companyId: "co-1" })).map((issue) => issue.title)).toEqual(["From a webhook"]);
  });
});
