import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import {
  connect,
  errorMessage,
  forgejoJson,
  forgejoPages,
  isRepositoryName,
  NOT_CONFIGURED,
  projectRepositoryNames,
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
};

type Tool = (call: { ctx: PluginContext; forgejo: Forgejo; repository: () => Promise<string>; input: Input }) => Promise<unknown>;

// Accepts "owner/repo" or a full Forgejo address. Without one, uses the project's only Forgejo repository.
async function resolveRepository(ctx: PluginContext, forgejo: Forgejo, runCtx: ToolRunContext, given: string | undefined) {
  if (given) {
    const path = given.startsWith(forgejo.baseUrl) ? given.slice(forgejo.baseUrl.length) : given;
    const name = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (!isRepositoryName(name)) throw new Error(`"${given}" is not a Forgejo repository. Pass repository as owner/repo.`);
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
    const issue = await forgejoJson<ForgejoIssueJson>(ctx, forgejo, `/repos/${await repository()}/issues`, {
      method: "POST",
      body: { title: input.title, body: input.body ?? "" },
    });
    return issueSummary(issue);
  },

  async update_issue({ ctx, forgejo, repository, input }) {
    // Forgejo's issue endpoint also edits pull requests.
    const issue = await forgejoJson<ForgejoIssueJson>(ctx, forgejo, `/repos/${await repository()}/issues/${input.number}`, {
      method: "PATCH",
      body: { title: input.title, body: input.body, state: input.state },
    });
    return issueSummary(issue);
  },

  async create_pull_request({ ctx, forgejo, repository, input }) {
    const name = await repository();
    const base = input.base ?? (await forgejoJson<ForgejoRepositoryJson>(ctx, forgejo, `/repos/${name}`)).default_branch;
    const pull = await forgejoJson<ForgejoPullRequestJson>(ctx, forgejo, `/repos/${name}/pulls`, {
      method: "POST",
      body: { head: input.head, base, title: input.title, body: input.body ?? "" },
    });
    return pullRequestSummary(pull);
  },

  async get_pull_request({ ctx, forgejo, repository, input }) {
    return pullRequestSummary(await forgejoJson<ForgejoPullRequestJson>(ctx, forgejo, `/repos/${await repository()}/pulls/${input.number}`));
  },

  async list_pull_request_files({ ctx, forgejo, repository, input }) {
    type File = { filename: string; status: string; additions: number; deletions: number };
    const files = await forgejoPages<File>(ctx, forgejo, `/repos/${await repository()}/pulls/${input.number}/files`);
    return files.map(({ filename, status, additions, deletions }) => ({ filename, status, additions, deletions }));
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
        const result = await tool({ ctx, forgejo, repository, input });
        return { content: JSON.stringify(result, null, 2), data: result };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    });
  }
}
