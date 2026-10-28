import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Issue, PluginWorkspace, Project, ToolResult } from "@paperclipai/plugin-sdk";
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
function delivery(payload: unknown, secret = "resolved:hook-ref", event = "issues") {
  const rawBody = JSON.stringify(payload);
  return {
    endpointKey: "forgejo",
    requestId: "delivery-1",
    rawBody,
    headers: { "x-forgejo-event": event, "x-forgejo-signature": createHmac("sha256", secret).update(rawBody).digest("hex") },
  };
}

function issueEvent(forgejo: FakeForgejo, action: string, issue: { number: number; title: string; state: string; updated_at?: string }) {
  return {
    action,
    repository: forgejo.repositoryJson("me/app"),
    sender: { login: "someone" },
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

  it("shows a merged pull request linked by its issue address as merged", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 2, isPull: true, merged: true, state: "closed" });
    await setUp(config, []);

    expect(await resolve("issue", "me/app#2")).toMatchObject({ ok: true, snapshot: { statusLabel: "Merged", statusCategory: "succeeded" } });
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
    forgejo.addComment("me/app", 4, "First");
    forgejo.addComment("me/app", 4, "Second");
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

  it("accepts a repository given as any address of it on the Forgejo server", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 4, title: "Fix login" });
    const harness = await setUp(config, ["me/app"]);

    for (const repository of ["me/app", `${BASE_URL}/me/app`, "https://Git.Example.com/me/app.git", "git@git.example.com:me/app.git"]) {
      const result = await harness.executeTool<ToolResult>("get_issue", { repository, number: 4 }, runCtx);
      expect(result.data, repository).toMatchObject({ title: "Fix login" });
    }
  });

  describe("opening a pull request", () => {
    const agentRun = { ...runCtx, agentId: "agent-1", runId: "run-1" };
    const pullInput = { head: "feature", base: "main", title: "Add a feature" };

    // Two tasks assigned to the agent; only "task-current" is checked out by this run.
    async function setUpTasks() {
      new FakeForgejo(["me/app"]);
      const harness = await setUp(config, ["me/app"]);
      const task = { companyId: "co-1", projectId: "project-1", assigneeAgentId: "agent-1", executionRunId: null };
      harness.seed({
        issues: [
          { ...task, id: "task-old", identifier: "PAP-1", checkoutRunId: "run-0" },
          { ...task, id: "task-current", identifier: "PAP-2", checkoutRunId: "run-1" },
        ] as Issue[],
      });
      return harness;
    }

    it("posts the pull request's link on the task the run is working on", async () => {
      const harness = await setUpTasks();
      // Reading comments back would need a capability the plugin does not use.
      const createComment = vi.spyOn(harness.ctx.issues, "createComment");

      const result = await harness.executeTool<ToolResult>("create_pull_request", pullInput, agentRun);

      expect(result.data).toMatchObject({ number: 1, linkedTask: "PAP-2" });
      expect(createComment.mock.calls).toEqual([["task-current", `Opened pull request ${BASE_URL}/me/app/pulls/1`, "co-1"]]);
    });

    it("still returns the pull request when the run has no task to link it to", async () => {
      const harness = await setUpTasks();

      const result = await harness.executeTool<ToolResult>("create_pull_request", pullInput, { ...agentRun, runId: "run-other" });

      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({ number: 1, linkedTask: null });
    });
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

describe("labels, assignees, branches and files", () => {
  function labelled() {
    const forgejo = new FakeForgejo(["team/app"]);
    forgejo.repositoryLabels.set("team/app", [{ id: 1, name: "bug" }]);
    forgejo.organisationLabels.set("team", [{ id: 7, name: "priority/high" }]);
    return forgejo;
  }

  it("creates an issue with labels, including the organisation's, and assignees", async () => {
    const forgejo = labelled();
    const harness = await setUp(config, ["team/app"]);

    const result = await harness.executeTool<ToolResult>("create_issue", { title: "Crash", labels: ["bug", "priority/high"], assignees: ["ana"] }, runCtx);

    expect(result.data).toMatchObject({ labels: ["bug", "priority/high"], assignees: ["ana"] });
    expect(forgejo.requests.find((request) => request.method === "POST")?.body).toMatchObject({ labels: [1, 7] });
  });

  it("refuses an unknown label, naming the labels there are, and creates nothing", async () => {
    const forgejo = labelled();
    const harness = await setUp(config, ["team/app"]);

    const result = await harness.executeTool<ToolResult>("create_issue", { title: "Crash", labels: ["bgu"] }, runCtx);

    expect(result.error).toBe("team/app has no label bgu. Its labels are: bug, priority/high.");
    expect(forgejo.issues.get("team/app")).toEqual([]);
  });

  it("replaces an issue's labels and assignees, leaving out what is not given", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.repositoryLabels.set("me/app", [{ id: 1, name: "bug" }, { id: 2, name: "docs" }]);
    forgejo.addIssue("me/app", { number: 4, labels: ["bug"], assignees: ["ana"] });
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("update_issue", { number: 4, labels: ["docs"], assignees: [] }, runCtx);

    expect(result.data).toMatchObject({ labels: ["docs"], assignees: [] });
    const unlabelled = await harness.executeTool<ToolResult>("update_issue", { number: 4, labels: [] }, runCtx);
    expect(unlabelled.data).toMatchObject({ labels: [], title: "Issue 4" });
  });

  it("closes and reopens a pull request", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 5, isPull: true });
    const harness = await setUp(config, ["me/app"]);

    await harness.executeTool<ToolResult>("update_issue", { number: 5, state: "closed" }, runCtx);
    expect(forgejo.issue("me/app", 5)?.state).toBe("closed");
    await harness.executeTool<ToolResult>("update_issue", { number: 5, state: "open" }, runCtx);
    expect(forgejo.issue("me/app", 5)?.state).toBe("open");
  });

  it("rejects labels that are not a list of names", async () => {
    new FakeForgejo(["me/app"]);
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("update_issue", { number: 4, labels: "bug" }, runCtx);

    expect(result.error).toBe("labels must be a list of names.");
  });

  it("lists branches with their latest commit", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.branches.set("me/app", [{ name: "main", sha: "aaa" }, { name: "feature", sha: "bbb" }]);
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("list_branches", {}, runCtx);

    expect(result.data).toEqual([
      { name: "main", commit: "aaa", protected: true },
      { name: "feature", commit: "bbb", protected: false },
    ]);
  });

  it("reads a file at a branch, and lists a directory", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.files.set("me/app@main:src/app.ts", "old");
    forgejo.files.set("me/app@feature:src/app.ts", "new");
    forgejo.files.set("me/app@feature:src/lib/util.ts", "");
    const harness = await setUp(config, ["me/app"]);

    const onMain = await harness.executeTool<ToolResult>("read_file", { path: "src/app.ts" }, runCtx);
    const onFeature = await harness.executeTool<ToolResult>("read_file", { path: "src/app.ts", ref: "feature" }, runCtx);
    const directory = await harness.executeTool<ToolResult>("read_file", { path: "src/", ref: "feature" }, runCtx);

    expect(onMain.data).toMatchObject({ content: "old" });
    expect(onFeature.data).toMatchObject({ content: "new" });
    expect(directory.data).toEqual({
      type: "dir",
      entries: [
        { name: "app.ts", path: "src/app.ts", type: "file" },
        { name: "lib", path: "src/lib", type: "dir" },
      ],
    });
  });

  it("lists the top folder when no path is given, and explains a missing file", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.files.set("me/app@main:README.md", "Hello");
    forgejo.files.set("me/app@main:src/app.ts", "");
    const harness = await setUp(config, ["me/app"]);

    const top = await harness.executeTool<ToolResult>("read_file", {}, runCtx);
    const missing = await harness.executeTool<ToolResult>("read_file", { path: "src/gone.ts", ref: "feature" }, runCtx);

    expect(top.data).toEqual({
      type: "dir",
      entries: [
        { name: "README.md", path: "README.md", type: "file" },
        { name: "src", path: "src", type: "dir" },
      ],
    });
    expect(missing.error).toBe("me/app has no file or directory src/gone.ts at feature. Check the path, and the ref with list_branches.");
  });

  it("refuses to show a binary file as text", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.files.set("me/app@main:logo.png", "\u0089PNG\u0000");
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("read_file", { path: "logo.png" }, runCtx);

    expect(result.error).toContain("logo.png is a binary file");
  });

  it("rejects a file path that would reach other parts of the Forgejo API", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("read_file", { path: "../../../user" }, runCtx);

    expect(result.error).toBe('"../../../user" is not a file path in the repository.');
    expect(forgejo.requests.some((request) => request.path.includes("contents"))).toBe(false);
  });
});

describe("pull request reviews", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    " export default a;",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-Old",
    "+New",
    "",
  ].join("\n");

  function pullRequest() {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 7, isPull: true });
    forgejo.pullDiffs.set("me/app#7", diff);
    forgejo.pullFiles.set("me/app#7", ["src/app.ts", "README.md"]);
    return forgejo;
  }

  it("reads a pull request's diff, whole or for one file, with the commit it shows", async () => {
    pullRequest();
    const harness = await setUp(config, ["me/app"]);

    const whole = await harness.executeTool<ToolResult>("get_pull_request_diff", { number: 7 }, runCtx);
    const oneFile = await harness.executeTool<ToolResult>("get_pull_request_diff", { number: 7, path: "README.md" }, runCtx);
    const missing = await harness.executeTool<ToolResult>("get_pull_request_diff", { number: 7, path: "nope.ts" }, runCtx);

    expect(whole.data).toEqual({ commit: "abc123", diff });
    expect(oneFile.data).toEqual({ commit: "abc123", diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Old\n+New\n" });
    expect(missing.error).toBe("Pull request 7 does not change nope.ts. It changes: src/app.ts, README.md.");
  });

  it("posts a review with comments on changed and removed lines", async () => {
    const forgejo = pullRequest();
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>(
      "review_pull_request",
      {
        number: 7,
        event: "request_changes",
        commit: "abc123",
        body: "Two problems.",
        comments: [
          { path: "src/app.ts", line: 1, body: "Why 2?" },
          { path: "src/app.ts", line: 1, side: "old", body: "1 was right." },
        ],
      },
      runCtx,
    );

    expect(result.data).toMatchObject({ state: "REQUEST_CHANGES", commit: "abc123" });
    expect(forgejo.requests.find((request) => request.method === "POST")?.body).toEqual({
      event: "REQUEST_CHANGES",
      body: "Two problems.",
      commit_id: "abc123",
      comments: [
        { path: "src/app.ts", body: "Why 2?", new_position: 1, old_position: 0 },
        { path: "src/app.ts", body: "1 was right.", new_position: 0, old_position: 1 },
      ],
    });
  });

  it("refuses a review of a commit that is no longer the pull request's latest", async () => {
    const forgejo = pullRequest();
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>("review_pull_request", { number: 7, event: "comment", commit: "old456", body: "Fine." }, runCtx);

    expect(result.error).toContain("its latest commit is abc123");
    expect(forgejo.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("sends Forgejo only events that publish the review, and checks line comments", async () => {
    const forgejo = pullRequest();
    const harness = await setUp(config, ["me/app"]);

    // Forgejo would save a review with any other event as a draft that no one else can see.
    const draft = await harness.executeTool<ToolResult>("review_pull_request", { number: 7, event: "PENDING", commit: "abc123" }, runCtx);
    const badLine = await harness.executeTool<ToolResult>(
      "review_pull_request",
      { number: 7, event: "comment", commit: "abc123", comments: [{ path: "src/app.ts", line: "1", body: "Hm" }] },
      runCtx,
    );

    expect(draft.error).toBe("event must be one of comment, request_changes, approve.");
    expect(badLine.error).toContain("comments must be a list");
    expect(forgejo.requests).toEqual([]);
  });

  it("refuses comments on lines the diff does not show, which Forgejo would accept but not place", async () => {
    const forgejo = pullRequest();
    const harness = await setUp(config, ["me/app"]);

    const result = await harness.executeTool<ToolResult>(
      "review_pull_request",
      {
        number: 7,
        event: "comment",
        commit: "abc123",
        comments: [
          { path: "src/app.ts", line: 2, side: "old", body: "Unchanged line, shown in the diff." },
          { path: "README.md", line: 1, body: "Added line." },
          { path: "src/app.ts", line: 3, body: "Past the end of the diff." },
          { path: "other.ts", line: 1, body: "Not in the pull request." },
        ],
      },
      runCtx,
    );

    expect(result.error).toContain("lines the diff does not show: src/app.ts line 3 (new), other.ts line 1 (new).");
    expect(forgejo.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("approves only when approving is allowed, and through the reviewer account when one is set", async () => {
    const forgejo = pullRequest();
    const approve = { number: 7, event: "approve", commit: "abc123" };

    const refused = await (await setUp(config, ["me/app"])).executeTool<ToolResult>("review_pull_request", approve, runCtx);
    expect(refused.error).toContain("Approving is turned off");

    // The plugin's own account opened the pull request, so Forgejo refuses its approval.
    const ownPull = await (await setUp({ ...config, allowApprove: true }, ["me/app"])).executeTool<ToolResult>("review_pull_request", approve, runCtx);
    expect(ownPull.error).toContain("An operator can set a reviewer access token");

    const approved = await (await setUp({ ...config, allowApprove: true, reviewToken: "review-ref" }, ["me/app"])).executeTool<ToolResult>(
      "review_pull_request",
      approve,
      runCtx,
    );
    expect(approved.data).toMatchObject({ state: "APPROVED" });
    expect(forgejo.requests.at(-1)?.token).toBe("resolved:review-ref");
  });

  it("lists reviews with their comments on lines", async () => {
    pullRequest();
    const harness = await setUp(config, ["me/app"]);
    await harness.executeTool<ToolResult>(
      "review_pull_request",
      { number: 7, event: "comment", commit: "abc123", body: "Looks fine.", comments: [{ path: "README.md", line: 1, side: "old", body: "Keep this?" }] },
      runCtx,
    );

    const result = await harness.executeTool<ToolResult>("list_reviews", { number: 7 }, runCtx);

    expect(result.data).toEqual([
      expect.objectContaining({
        author: "someone",
        state: "COMMENT",
        body: "Looks fine.",
        commit: "abc123",
        comments: [{ path: "README.md", line: 1, side: "old", author: "someone", body: "Keep this?", resolved: false }],
      }),
    ]);
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

describe("comment copy", () => {
  // Reading comments back would need a capability the plugin does not use, so this records the bodies posted.
  function copiedComments(harness: Awaited<ReturnType<typeof setUp>>) {
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");
    return () => createComment.mock.calls.map(([, body]) => body);
  }

  it("copies an issue's comments when importing it, oldest first, with author and link", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    forgejo.addComment("me/app", 1, "First");
    forgejo.addComment("me/app", 1, "Second");
    const harness = await setUp(config, ["me/app"]);
    const copied = copiedComments(harness);

    await harness.runJob("sync-issues");
    await harness.runJob("sync-issues");

    expect(copied()).toEqual([
      `**someone** [commented in Forgejo](${BASE_URL}/me/app/issues/1#issuecomment-100):\n\nFirst`,
      `**someone** [commented in Forgejo](${BASE_URL}/me/app/issues/1#issuecomment-101):\n\nSecond`,
    ]);
  });

  it("catches up on new comments in the sync, reading only those since the last one seen", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    forgejo.addIssue("me/app", { number: 2, isPull: true });
    forgejo.addComment("me/app", 1, "Before import");
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    const copied = copiedComments(harness);

    forgejo.addComment("me/app", 1, "Missed by the webhook");
    forgejo.addComment("me/app", 2, "On a pull request");
    await harness.runJob("sync-issues");

    expect(copied()).toEqual([expect.stringContaining("Missed by the webhook")]);
    const sinces = forgejo.requests.filter((request) => request.path === "/repos/me/app/issues/comments").map((request) => request.query.since);
    expect(sinces).toContain(forgejo.comments.get("me/app#1")![0].updatedAt);
  });

  it("copies a comment from a webhook delivery once, and ignores edits", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    const copied = copiedComments(harness);

    forgejo.addComment("me/app", 1, "Hello");
    const [comment] = (await (await fetch(`${BASE_URL}/api/v1/repos/me/app/issues/1/comments`)).json()) as unknown[];
    const event = (action: string) => ({ ...issueEvent(forgejo, action, { number: 1, title: "Issue 1", state: "open" }), comment });
    await plugin.definition.onWebhook!(delivery(event("created"), undefined, "issue_comment"));
    await plugin.definition.onWebhook!(delivery(event("edited"), undefined, "issue_comment"));
    await harness.runJob("sync-issues");

    expect(copied()).toEqual([expect.stringContaining("Hello")]);
  });

  it("copies a comment the webhook missed, though a newer one came through the webhook first", async () => {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.addIssue("me/app", { number: 1 });
    const harness = await setUp(config, ["me/app"]);
    await harness.runJob("sync-issues");
    const copied = copiedComments(harness);

    forgejo.addComment("me/app", 1, "Missed by the webhook");
    forgejo.addComment("me/app", 1, "Delivered by the webhook");
    const [, delivered] = (await (await fetch(`${BASE_URL}/api/v1/repos/me/app/issues/1/comments`)).json()) as unknown[];
    const event = { ...issueEvent(forgejo, "created", { number: 1, title: "Issue 1", state: "open" }), comment: delivered };
    await plugin.definition.onWebhook!(delivery(event, undefined, "issue_comment"));
    await harness.runJob("sync-issues");

    expect(copied()).toEqual([expect.stringContaining("Delivered by the webhook"), expect.stringContaining("Missed by the webhook")]);
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

describe("work requests from Forgejo", () => {
  const agent = (id: string, urlKey: string) => ({ id, companyId: "co-1", name: urlKey, urlKey, status: "idle" }) as Agent;

  // A project led by "lead", in a company that also has the agent "backend-dev". alice can write to me/app.
  async function setUpRequests(pluginConfig: Record<string, unknown> = config) {
    const forgejo = new FakeForgejo(["me/app"]);
    forgejo.permissions.set("alice", "write");
    const harness = await setUp(pluginConfig, ["me/app"]);
    harness.seed({
      projects: [{ id: "project-1", companyId: "co-1", leadAgentId: "lead" } as Project],
      agents: [agent("lead", "lead"), agent("dev", "backend-dev")],
    });
    const wakeup = vi.spyOn(harness.ctx.issues, "requestWakeup");
    // Each woken task with its assignee, in order.
    const woken = async () =>
      Promise.all(
        wakeup.mock.calls.map(async ([issueId]) => {
          const issue = (await harness.ctx.issues.get(issueId, "co-1"))!;
          return { title: issue.title, assignee: issue.assigneeAgentId, parentId: issue.parentId ?? null };
        }),
      );
    return { forgejo, harness, woken };
  }

  const pull = { number: 7, title: "Add login", body: "", html_url: `${BASE_URL}/me/app/pulls/7`, assignees: null };

  function commentEvent(forgejo: FakeForgejo, body: string, sender = "alice", issue: object = { ...pull, pull_request: {} }) {
    return {
      action: "created",
      repository: forgejo.repositoryJson("me/app"),
      sender: { login: sender },
      issue,
      comment: { id: 1, body, html_url: `${BASE_URL}/me/app/pulls/7#issuecomment-1`, user: { login: sender } },
    };
  }

  it("gives a mentioned agent one task per pull request and wakes it each time", async () => {
    const { forgejo, harness, woken } = await setUpRequests();
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");

    await plugin.definition.onWebhook!(delivery(commentEvent(forgejo, "@backend-dev please fix the tests"), undefined, "issue_comment"));
    await plugin.definition.onWebhook!(delivery(commentEvent(forgejo, "@Backend-Dev and the lint"), undefined, "issue_comment"));

    const task = { title: "Forgejo pull request #7: Add login", assignee: "dev", parentId: null };
    expect(await woken()).toEqual([task, task]);
    expect(createComment.mock.calls[0][1]).toBe(
      `**alice** [mentioned you in Forgejo](${BASE_URL}/me/app/pulls/7#issuecomment-1).\n\n> @backend-dev please fix the tests`,
    );
  });

  it("gives the project's lead agent a review requested from the plugin's account", async () => {
    const { forgejo, woken } = await setUpRequests();
    const payload = { action: "review_requested", repository: forgejo.repositoryJson("me/app"), sender: { login: "alice" }, pull_request: pull, requested_reviewer: { login: "someone" } };

    await plugin.definition.onWebhook!(delivery(payload, undefined, "pull_request"));

    expect(await woken()).toEqual([{ title: "Forgejo pull request #7: Add login", assignee: "lead", parentId: null }]);
  });

  it("assigns an imported issue to the lead agent, and gives a second agent a task under it", async () => {
    const { forgejo, harness, woken } = await setUpRequests();
    forgejo.addIssue("me/app", { number: 1, title: "Broken login" });
    await harness.runJob("sync-issues");
    const [imported] = await harness.ctx.issues.list({ companyId: "co-1" });
    const issue = { number: 1, title: "Broken login", body: "", html_url: `${BASE_URL}/me/app/issues/1`, assignees: [{ login: "someone" }] };

    await plugin.definition.onWebhook!(delivery({ action: "assigned", repository: forgejo.repositoryJson("me/app"), sender: { login: "alice" }, issue }));
    await plugin.definition.onWebhook!(delivery(commentEvent(forgejo, "@backend-dev can you help?", "alice", issue), undefined, "issue_comment"));

    expect(await woken()).toEqual([
      { title: "Broken login", assignee: "lead", parentId: null },
      { title: "Forgejo issue #1: Broken login", assignee: "dev", parentId: imported.id },
    ]);
  });

  it("leaves an imported issue with the person assigned to it, and gives the agent a task under it", async () => {
    const { forgejo, harness, woken } = await setUpRequests();
    forgejo.addIssue("me/app", { number: 1, title: "Broken login" });
    await harness.runJob("sync-issues");
    const [imported] = await harness.ctx.issues.list({ companyId: "co-1" });
    await harness.ctx.issues.update(imported.id, { assigneeUserId: "user-1" }, "co-1");
    const issue = { number: 1, title: "Broken login", body: "", html_url: `${BASE_URL}/me/app/issues/1`, assignees: null };

    await plugin.definition.onWebhook!(delivery(commentEvent(forgejo, "@backend-dev can you help?", "alice", issue), undefined, "issue_comment"));

    expect(await woken()).toEqual([{ title: "Forgejo issue #1: Broken login", assignee: "dev", parentId: imported.id }]);
    expect(await harness.ctx.issues.get(imported.id, "co-1")).toMatchObject({ assigneeUserId: "user-1", assigneeAgentId: null });
  });

  it("skips a mentioned agent Paperclip cannot wake, and still wakes the others", async () => {
    const { forgejo, harness, woken } = await setUpRequests();
    harness.seed({ agents: [{ ...agent("qa", "qa"), status: "paused" } as Agent] });

    await plugin.definition.onWebhook!(delivery(commentEvent(forgejo, "@qa @backend-dev please look"), undefined, "issue_comment"));

    expect(await woken()).toEqual([{ title: "Forgejo pull request #7: Add login", assignee: "dev", parentId: null }]);
  });

  it("quotes a comment on an imported issue when issues are no longer imported", async () => {
    const { forgejo, harness } = await setUpRequests();
    forgejo.addIssue("me/app", { number: 1, title: "Broken login" });
    await harness.runJob("sync-issues");
    harness.ctx.config.get = async () => ({ ...config, syncIssues: false });
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");
    const issue = { number: 1, title: "Broken login", body: "", html_url: `${BASE_URL}/me/app/issues/1`, assignees: null };

    await plugin.definition.onWebhook!(delivery(commentEvent(forgejo, "@backend-dev please fix X", "alice", issue), undefined, "issue_comment"));

    expect(createComment.mock.calls.map(([, body]) => body)).toEqual([expect.stringContaining("> @backend-dev please fix X")]);
  });

  it("ignores requests from people who cannot write to the repository, and from the plugin's own accounts", async () => {
    const { forgejo, woken } = await setUpRequests({ ...config, reviewToken: "review-ref" });
    forgejo.permissions.set("someone", "admin");
    forgejo.permissions.set("reviewer", "admin");

    for (const sender of ["bob", "someone", "reviewer"]) {
      await plugin.definition.onWebhook!(delivery(commentEvent(forgejo, "@backend-dev do this", sender), undefined, "issue_comment"));
    }

    expect(await woken()).toEqual([]);
  });

  it("explains that the token's account must be a repository admin when Forgejo will not say who can write", async () => {
    const { forgejo } = await setUpRequests();
    forgejo.permissions.set("alice", "forbidden");

    await expect(plugin.definition.onWebhook!(delivery(commentEvent(forgejo, "@backend-dev do this"), undefined, "issue_comment"))).rejects.toThrow(
      "must be an admin of me/app",
    );
  });
});
