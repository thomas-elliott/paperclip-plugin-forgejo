import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import {
  connect,
  errorMessage,
  ForgejoError,
  forgejoJson,
  forgejoPages,
  forgejoText,
  isRepositoryName,
  NOT_CONFIGURED,
  projectRepositoryNames,
  repositoryNameOnServer,
  type Forgejo,
  type ForgejoIssueJson,
  type ForgejoPullRequestJson,
  type ForgejoRepositoryJson,
} from "./forgejo.js";

type Input = {
  repository?: string;
  number?: number;
  query?: string;
  type?: "issues" | "pulls";
  state?: "open" | "closed" | "all";
  limit?: number;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  method?: "merge" | "rebase" | "squash";
  path?: string;
  event?: string;
  commit?: string;
  ref?: string;
  // Checked in the tools that take them, since Paperclip does not check inputs against the schema.
  labels?: unknown;
  assignees?: unknown;
  comments?: unknown;
};

type LineComment = { path: string; line: number; side?: "new" | "old"; body: string };

// Forgejo saves a review with any other event as a draft that only its author can see, so the tool
// sends only these.
const REVIEW_EVENTS: Record<string, string> = { comment: "COMMENT", request_changes: "REQUEST_CHANGES", approve: "APPROVED" };

function isLineComment(value: unknown): value is LineComment {
  const comment = value as Partial<LineComment> | null;
  return (
    typeof comment?.path === "string" &&
    comment.path !== "" &&
    Number.isInteger(comment.line) &&
    comment.line! > 0 &&
    (comment.side === undefined || comment.side === "new" || comment.side === "old") &&
    typeof comment.body === "string" &&
    comment.body !== ""
  );
}

// One file's part of a unified diff. Each part starts at its "diff --git a/<old> b/<new>" line.
function diffOfFile(diff: string, path: string): string | null {
  const parts = diff.split(/^(?=diff --git )/m);
  return (
    parts.find((text) => {
      const header = text.slice(0, text.indexOf("\n"));
      return header.startsWith(`diff --git a/${path} b/`) || header.endsWith(` b/${path}`);
    }) ?? null
  );
}

// Whether a file's diff shows a line: on the "new" side an added or unchanged line, on the "old" side
// a removed or unchanged line. Forgejo accepts comments on other lines but cannot place them in the diff.
function lineInDiff(fileDiff: string, line: number, side: "new" | "old"): boolean {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of fileDiff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (!inHunk) {
      // The file's header, whose "--- a/path" line would otherwise read as a removed line.
    } else if (text.startsWith(" ")) {
      if ((side === "old" ? oldLine : newLine) === line) return true;
      oldLine += 1;
      newLine += 1;
    } else if (text.startsWith("-")) {
      if (side === "old" && oldLine === line) return true;
      oldLine += 1;
    } else if (text.startsWith("+")) {
      if (side === "new" && newLine === line) return true;
      newLine += 1;
    }
  }
  return false;
}

function nameList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && name !== "")) {
    throw new Error(`${field} must be a list of names.`);
  }
  return value;
}

// Forgejo takes label IDs, not names, so look the names up and report any that do not exist.
async function labelIds(ctx: PluginContext, forgejo: Forgejo, repository: string, names: string[]): Promise<number[]> {
  if (names.length === 0) return [];
  type Label = { id: number; name: string };
  const labels = await forgejoPages<Label>(ctx, forgejo, `/repos/${repository}/labels`);
  // An organisation's labels can be used in all its repositories. Forgejo answers 404 when the owner
  // is a user, and 403 when the token lacks the read:organization scope, which it checks first.
  try {
    labels.push(...(await forgejoPages<Label>(ctx, forgejo, `/orgs/${repository.split("/")[0]}/labels`)));
  } catch (error) {
    if (!(error instanceof ForgejoError && (error.status === 404 || error.status === 403))) throw error;
  }
  const unknown = names.filter((name) => !labels.some((label) => label.name === name));
  if (unknown.length > 0) {
    throw new Error(`${repository} has no label ${unknown.join(", ")}. Its labels are: ${labels.map((label) => label.name).join(", ") || "none"}.`);
  }
  return names.map((name) => labels.find((label) => label.name === name)!.id);
}

// A file path made safe for an API path: the path goes after the endpoint, so "." or ".." parts
// could reach other endpoints with the operator's token. The top folder is "".
function encodeFilePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`"${path}" is not a file path in the repository.`);
  return parts.map(encodeURIComponent).join("/");
}

type Tool = (call: {
  ctx: PluginContext;
  runCtx: ToolRunContext;
  forgejo: Forgejo;
  repository: () => Promise<string>;
  input: Input;
}) => Promise<unknown>;

// Accepts "owner/repo" or a full Forgejo address. Without one, uses the project's only Forgejo repository.
async function resolveRepository(ctx: PluginContext, forgejo: Forgejo, runCtx: ToolRunContext, given: string | undefined) {
  if (given) {
    // A full address, over HTTPS or SSH, has a ":"; "owner/repo" never does.
    const name = given.includes(":") ? repositoryNameOnServer(forgejo.baseUrl, given) : given.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (!name || !isRepositoryName(name)) throw new Error(`"${given}" is not a Forgejo repository. Pass repository as owner/repo.`);
    return name;
  }
  const names = await projectRepositoryNames(ctx, forgejo, runCtx.companyId, runCtx.projectId);
  if (names.length === 1) return names[0];
  throw new Error(
    names.length === 0
      ? "This project uses no Forgejo repository. Pass repository as owner/repo."
      : `This project uses several Forgejo repositories (${names.join(", ")}). Pass repository as owner/repo.`,
  );
}

// Paperclip's pull request card only recognises github.com, so a comment with the link stands in for
// it: link status then shows the pull request's live state on the task. Returns the task's identifier,
// or null when the run has no task to link to.
async function linkToTask(ctx: PluginContext, runCtx: ToolRunContext, pull: ForgejoPullRequestJson): Promise<string | null> {
  const assigned = await ctx.issues.list({ companyId: runCtx.companyId, projectId: runCtx.projectId, assigneeAgentId: runCtx.agentId });
  const task = assigned.find((issue) => issue.checkoutRunId === runCtx.runId || issue.executionRunId === runCtx.runId);
  if (!task) return null;
  await ctx.issues.createComment(task.id, `Opened pull request ${pull.html_url}`, runCtx.companyId);
  return task.identifier ?? task.id;
}

// Agents get a compact view of each item rather than Forgejo's full JSON.
function issueSummary(issue: ForgejoIssueJson) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url,
    author: issue.user.login,
    labels: issue.labels.map((label) => label.name),
    assignees: (issue.assignees ?? []).map((user) => user.login),
    isPullRequest: Boolean(issue.pull_request),
    updatedAt: issue.updated_at,
  };
}

function pullRequestSummary(pull: ForgejoPullRequestJson) {
  return {
    ...issueSummary(pull),
    isPullRequest: true,
    body: pull.body,
    draft: pull.draft,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: pull.head.label,
    headSha: pull.head.sha,
    base: pull.base.ref,
  };
}

const tools: Record<string, Tool> = {
  async search_issues({ ctx, forgejo, repository, input }) {
    const query = new URLSearchParams({
      type: input.type ?? "issues",
      state: input.state ?? "open",
      limit: String(input.limit ?? 20),
    });
    if (input.query) query.set("q", input.query);
    const issues = await forgejoJson<ForgejoIssueJson[]>(ctx, forgejo, `/repos/${await repository()}/issues?${query}`);
    return issues.map(issueSummary);
  },

  async get_issue({ ctx, forgejo, repository, input }) {
    const issue = await forgejoJson<ForgejoIssueJson>(ctx, forgejo, `/repos/${await repository()}/issues/${input.number}`);
    return { ...issueSummary(issue), body: issue.body };
  },

  async list_comments({ ctx, forgejo, repository, input }) {
    type Comment = { id: number; user: { login: string }; body: string; created_at: string };
    // Forgejo ignores paging here and always returns every comment.
    const comments = await forgejoJson<Comment[]>(ctx, forgejo, `/repos/${await repository()}/issues/${input.number}/comments`);
    return comments.map((comment) => ({ id: comment.id, author: comment.user.login, body: comment.body, createdAt: comment.created_at }));
  },

  async add_comment({ ctx, forgejo, repository, input }) {
    const comment = await forgejoJson<{ id: number; html_url: string }>(ctx, forgejo, `/repos/${await repository()}/issues/${input.number}/comments`, {
      method: "POST",
      body: { body: input.body },
    });
    return { id: comment.id, url: comment.html_url };
  },

  async create_issue({ ctx, forgejo, repository, input }) {
    const labels = nameList(input.labels, "labels");
    const assignees = nameList(input.assignees, "assignees");
    const name = await repository();
    const issue = await forgejoJson<ForgejoIssueJson>(ctx, forgejo, `/repos/${name}/issues`, {
      method: "POST",
      body: { title: input.title, body: input.body ?? "", labels: await labelIds(ctx, forgejo, name, labels ?? []), assignees },
    });
    return issueSummary(issue);
  },

  async update_issue({ ctx, forgejo, repository, input }) {
    const labels = nameList(input.labels, "labels");
    const assignees = nameList(input.assignees, "assignees");
    const name = await repository();
    // Set labels first, so the issue returned by the edit below shows them.
    if (labels) {
      await forgejoJson(ctx, forgejo, `/repos/${name}/issues/${input.number}/labels`, {
        method: "PUT",
        body: { labels: await labelIds(ctx, forgejo, name, labels) },
      });
    }
    // Forgejo's issue endpoint also edits pull requests, including closing and reopening them.
    const issue = await forgejoJson<ForgejoIssueJson>(ctx, forgejo, `/repos/${name}/issues/${input.number}`, {
      method: "PATCH",
      body: { title: input.title, body: input.body, state: input.state, assignees },
    });
    return issueSummary(issue);
  },

  async list_branches({ ctx, forgejo, repository }) {
    type Branch = { name: string; commit: { id: string }; protected: boolean };
    const branches = await forgejoPages<Branch>(ctx, forgejo, `/repos/${await repository()}/branches`);
    return branches.map((branch) => ({ name: branch.name, commit: branch.commit.id, protected: branch.protected }));
  },

  async read_file({ ctx, forgejo, repository, input }) {
    type Entry = { name: string; path: string; type: string; size: number; content?: string | null };
    const encodedPath = encodeFilePath(input.path ?? "");
    const query = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
    const name = await repository();
    let found: Entry | Entry[];
    try {
      // Forgejo answers with a list for a directory.
      found = await forgejoJson<Entry | Entry[]>(ctx, forgejo, `/repos/${name}/contents${encodedPath && `/${encodedPath}`}${query}`);
    } catch (error) {
      if (!(error instanceof ForgejoError && error.status === 404)) throw error;
      const where = input.ref ? `at ${input.ref}` : "on the default branch";
      throw new Error(`${name} has no file or directory ${input.path ?? "/"} ${where}. Check the path, and the ref with list_branches.`);
    }
    if (Array.isArray(found)) return { type: "dir", entries: found.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type })) };
    if (found.type !== "file") throw new Error(`${found.path} is a ${found.type}, not a file.`);
    // Forgejo leaves out the content of files too large for its API.
    if (!found.content) {
      if (found.size === 0) return { type: "file", path: found.path, content: "" };
      throw new Error(`${found.path} is too large for Forgejo to return (${found.size} bytes).`);
    }
    const bytes = Buffer.from(found.content, "base64");
    if (bytes.includes(0)) throw new Error(`${found.path} is a binary file (${found.size} bytes), so it cannot be shown as text.`);
    return { type: "file", path: found.path, content: bytes.toString("utf8") };
  },

  async create_pull_request({ ctx, runCtx, forgejo, repository, input }) {
    const name = await repository();
    const base = input.base ?? (await forgejoJson<ForgejoRepositoryJson>(ctx, forgejo, `/repos/${name}`)).default_branch;
    const pull = await forgejoJson<ForgejoPullRequestJson>(ctx, forgejo, `/repos/${name}/pulls`, {
      method: "POST",
      body: { head: input.head, base, title: input.title, body: input.body ?? "" },
    });
    // The pull request is open by now, so a failure to link it must not fail the tool.
    let linkedTask: string | null = null;
    try {
      linkedTask = await linkToTask(ctx, runCtx, pull);
    } catch (error) {
      ctx.logger.warn("Could not link a pull request to its task", { url: pull.html_url, error: errorMessage(error) });
    }
    return { ...pullRequestSummary(pull), linkedTask };
  },

  async get_pull_request({ ctx, forgejo, repository, input }) {
    return pullRequestSummary(await forgejoJson<ForgejoPullRequestJson>(ctx, forgejo, `/repos/${await repository()}/pulls/${input.number}`));
  },

  async list_pull_request_files({ ctx, forgejo, repository, input }) {
    type File = { filename: string; status: string; additions: number; deletions: number };
    const files = await forgejoPages<File>(ctx, forgejo, `/repos/${await repository()}/pulls/${input.number}/files`);
    return files.map(({ filename, status, additions, deletions }) => ({ filename, status, additions, deletions }));
  },

  async get_pull_request_diff({ ctx, forgejo, repository, input }) {
    const name = await repository();
    const pull = await forgejoJson<ForgejoPullRequestJson>(ctx, forgejo, `/repos/${name}/pulls/${input.number}`);
    const diff = await forgejoText(ctx, forgejo, `/repos/${name}/pulls/${input.number}.diff`);
    if (!input.path) return { commit: pull.head.sha, diff };
    const fileDiff = diffOfFile(diff, input.path);
    if (fileDiff === null) {
      const files = await forgejoPages<{ filename: string }>(ctx, forgejo, `/repos/${name}/pulls/${input.number}/files`);
      throw new Error(`Pull request ${input.number} does not change ${input.path}. It changes: ${files.map((file) => file.filename).join(", ")}.`);
    }
    return { commit: pull.head.sha, diff: fileDiff };
  },

  async review_pull_request({ ctx, forgejo, repository, input }) {
    const event = REVIEW_EVENTS[input.event ?? ""];
    if (!event) throw new Error(`event must be one of ${Object.keys(REVIEW_EVENTS).join(", ")}.`);
    if (input.event === "approve" && !forgejo.allowApprove) {
      throw new Error("Approving is turned off. An operator can allow it in the Forgejo plugin settings; until then, comment or request changes.");
    }
    const given = input.comments ?? [];
    if (!Array.isArray(given) || !given.every(isLineComment)) {
      throw new Error("comments must be a list of { path, line, side, body }, with line a whole number above zero and side new or old.");
    }
    const comments = given.map((comment) => ({ ...comment, side: comment.side ?? "new" }));

    const name = await repository();
    const pull = await forgejoJson<ForgejoPullRequestJson>(ctx, forgejo, `/repos/${name}/pulls/${input.number}`);
    if (pull.head.sha !== input.commit) {
      throw new Error(`Pull request ${input.number} has changed since ${input.commit}: its latest commit is ${pull.head.sha}. Read the diff again and review that.`);
    }
    if (comments.length > 0) {
      const diff = await forgejoText(ctx, forgejo, `/repos/${name}/pulls/${input.number}.diff`);
      const outside = comments.filter((comment) => {
        const fileDiff = diffOfFile(diff, comment.path);
        return fileDiff === null || !lineInDiff(fileDiff, comment.line, comment.side);
      });
      if (outside.length > 0) {
        const lines = outside.map((comment) => `${comment.path} line ${comment.line} (${comment.side})`).join(", ");
        throw new Error(`These comments are on lines the diff does not show: ${lines}. Comment only on lines in the diff, or put the remark in the review body.`);
      }
    }

    type Review = { id: number; state: string; html_url: string; commit_id: string };
    try {
      const review = await forgejoJson<Review>(ctx, forgejo, `/repos/${name}/pulls/${input.number}/reviews`, {
        method: "POST",
        token: forgejo.reviewToken ?? undefined,
        body: {
          event,
          body: input.body ?? "",
          commit_id: input.commit,
          // Forgejo takes a line in the changed file as new_position, and a removed line as old_position.
          comments: comments.map((comment) => ({
            path: comment.path,
            body: comment.body,
            new_position: comment.side === "old" ? 0 : comment.line,
            old_position: comment.side === "old" ? comment.line : 0,
          })),
        },
      });
      return { id: review.id, state: review.state, url: review.html_url, commit: review.commit_id };
    } catch (error) {
      // Forgejo's words are "approve your own pull is not allowed" and "reject your own pull is not allowed".
      if (error instanceof ForgejoError && error.status === 422 && error.message.includes("your own pull")) {
        const fix = forgejo.reviewToken
          ? "The reviewer account set in the plugin settings opened this pull request."
          : "An operator can set a reviewer access token in the Forgejo plugin settings, so reviews come from another account.";
        throw new Error(`${error.message}. Forgejo does not let the account that opened a pull request approve it or request changes. ${fix} Until then, post a comment review.`);
      }
      throw error;
    }
  },

  async list_reviews({ ctx, forgejo, repository, input }) {
    type Review = {
      id: number;
      user: { login: string } | null;
      state: string;
      body: string;
      commit_id: string;
      stale: boolean;
      dismissed: boolean;
      official: boolean;
      comments_count: number;
      submitted_at: string;
    };
    // Forgejo gives a line in the changed file as position, and a removed line as original_position.
    type Comment = { path: string; position: number; original_position: number; body: string; user: { login: string }; resolver: unknown };
    const name = await repository();
    const reviews = await forgejoPages<Review>(ctx, forgejo, `/repos/${name}/pulls/${input.number}/reviews`);
    return Promise.all(
      reviews.map(async (review) => {
        const comments =
          review.comments_count > 0
            ? await forgejoJson<Comment[]>(ctx, forgejo, `/repos/${name}/pulls/${input.number}/reviews/${review.id}/comments`)
            : [];
        return {
          id: review.id,
          // A review requested from a team has no user.
          author: review.user?.login ?? null,
          state: review.state,
          body: review.body,
          commit: review.commit_id,
          stale: review.stale,
          dismissed: review.dismissed,
          // Whether the review counts under branch protection, such as towards required approvals.
          official: review.official,
          submittedAt: review.submitted_at,
          comments: comments.map((comment) => ({
            path: comment.path,
            line: comment.position || comment.original_position,
            side: comment.position ? "new" : "old",
            author: comment.user.login,
            body: comment.body,
            resolved: Boolean(comment.resolver),
          })),
        };
      }),
    );
  },

  async get_pull_request_checks({ ctx, forgejo, repository, input }) {
    type Status = { context: string; status: string; description: string; target_url: string };
    const name = await repository();
    const pull = await forgejoJson<ForgejoPullRequestJson>(ctx, forgejo, `/repos/${name}/pulls/${input.number}`);
    const combined = await forgejoJson<{ state: string; statuses: Status[] | null }>(ctx, forgejo, `/repos/${name}/commits/${pull.head.sha}/status`);
    return {
      commit: pull.head.sha,
      // Forgejo reports "" when no check has reported on the commit.
      state: combined.state || "none",
      checks: (combined.statuses ?? []).map((status) => ({
        name: status.context,
        state: status.status,
        description: status.description,
        url: status.target_url,
      })),
    };
  },

  async merge_pull_request({ ctx, forgejo, repository, input }) {
    if (!forgejo.allowMerge) {
      throw new Error("Merging is turned off. An operator can allow it in the Forgejo plugin settings; until then, ask a person to merge.");
    }
    const name = await repository();
    await forgejoJson(ctx, forgejo, `/repos/${name}/pulls/${input.number}/merge`, { method: "POST", body: { Do: input.method ?? "merge" } });
    return pullRequestSummary(await forgejoJson<ForgejoPullRequestJson>(ctx, forgejo, `/repos/${name}/pulls/${input.number}`));
  },
};

export function registerAgentTools(ctx: PluginContext) {
  for (const declaration of manifest.tools ?? []) {
    const tool = tools[declaration.name];
    ctx.tools.register(declaration.name, declaration, async (params, runCtx): Promise<ToolResult> => {
      try {
        const forgejo = await connect(ctx, runCtx.companyId);
        if (!forgejo) return { error: NOT_CONFIGURED };
        const input = (params ?? {}) as Input;
        // Paperclip does not check tool inputs against the declared schema.
        const required = (declaration.parametersSchema.required as (keyof Input)[] | undefined) ?? [];
        const missing = required.filter((field) => input[field] === undefined || input[field] === null || input[field] === "");
        if (missing.length > 0) return { error: `Missing ${missing.join(", ")}.` };
        // Like the repository, the number goes into API paths.
        if (input.number !== undefined && !(Number.isInteger(input.number) && input.number > 0)) {
          return { error: "number must be a whole number above zero." };
        }
        const repository = () => resolveRepository(ctx, forgejo, runCtx, input.repository);
        const result = await tool({ ctx, runCtx, forgejo, repository, input });
        return { content: JSON.stringify(result, null, 2), data: result };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    });
  }
}
