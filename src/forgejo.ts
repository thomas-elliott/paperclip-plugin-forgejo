import type { EnvSecretRefBinding, PluginContext, PluginWorkspace } from "@paperclipai/plugin-sdk";

export const NOT_CONFIGURED = "Set the Forgejo URL and access token in the plugin settings.";

// Forgejo may return fewer items than this per page (its MAX_RESPONSE_ITEMS setting), so paging stops on an empty page.
const PAGE_SIZE = 50;

export type Forgejo = {
  baseUrl: string;
  apiUrl: string;
  token: string;
  syncIssues: boolean;
  allowMerge: boolean;
  webhookSecret: EnvSecretRefBinding | null;
};

export type ForgejoRepositoryJson = {
  full_name: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  private: boolean;
  default_branch: string;
};

// Forgejo serves pull requests through its issue endpoints too; `pull_request` is set on those.
export type ForgejoIssueJson = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  html_url: string;
  user: { login: string };
  labels: { name: string }[];
  assignees: { login: string }[] | null;
  pull_request?: { merged: boolean } | null;
  created_at: string;
  updated_at: string;
};

export type ForgejoPullRequestJson = ForgejoIssueJson & {
  draft: boolean;
  merged: boolean;
  mergeable: boolean;
  head: { label: string; ref: string; sha: string };
  base: { label: string; ref: string };
};

// Identifies one issue or pull request as "owner/repo#12". Lower case, because Forgejo treats owner
// and repository names case-insensitively.
export function issueKey(repository: string, number: number) {
  return `${repository.toLowerCase()}#${number}`;
}

export function parseIssueKey(key: string) {
  const [repository, number] = key.split("#");
  return { repository, number: Number(number) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The configured Forgejo address without a trailing slash, or null when it is not set.
export function configuredBaseUrl(config: Record<string, unknown>): string | null {
  return typeof config.baseUrl === "string" && config.baseUrl ? config.baseUrl.replace(/\/+$/, "") : null;
}

export async function connect(ctx: PluginContext, companyId: string): Promise<Forgejo | null> {
  const config = await ctx.config.get(companyId);
  const baseUrl = configuredBaseUrl(config);
  if (!baseUrl || !config.token) return null;

  // Resolve the token on every call: Paperclip forbids caching secret values.
  const token = await ctx.secrets.resolve(config.token as EnvSecretRefBinding, { companyId, configPath: "token" });
  return {
    baseUrl,
    apiUrl: `${baseUrl}/api/v1`,
    token,
    syncIssues: config.syncIssues === true,
    allowMerge: config.allowMerge === true,
    webhookSecret: (config.webhookSecret as EnvSecretRefBinding | undefined) ?? null,
  };
}

// Scheduled jobs and webhooks run without a company, and Paperclip refuses ctx.companies.list() there
// whenever any other plugin call is in progress. Calls naming a company that has saved this plugin's
// settings are allowed, so the plugin keeps its own record of those companies: one entity each, so
// that companies saving at the same moment cannot overwrite each other.
const CONFIGURED_COMPANY = "configured-company";

export async function configuredCompanies(ctx: PluginContext): Promise<string[]> {
  // Paperclip lists 100 entities unless asked for more; no instance has anywhere near this many companies.
  const records = await ctx.entities.list({ entityType: CONFIGURED_COMPANY, scopeKind: "instance", limit: 10_000 });
  return records.flatMap((record) => (record.externalId ? [record.externalId] : []));
}

export async function rememberConfiguredCompany(ctx: PluginContext, companyId: string) {
  await ctx.entities.upsert({ entityType: CONFIGURED_COMPANY, scopeKind: "instance", externalId: companyId, data: {} });
}

type RequestOptions = { withToken?: boolean; method?: string; body?: unknown };

// ctx.http.fetch throws, rather than returning a status, for bad addresses, DNS failures, timeouts and
// blocked private addresses. Turn those into a message the user can act on.
export async function request(ctx: PluginContext, forgejo: Forgejo, path: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.withToken !== false) headers.Authorization = `token ${forgejo.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await ctx.http.fetch(`${forgejo.apiUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new Error(`Could not reach Forgejo at ${forgejo.baseUrl}: ${errorMessage(error)}`);
  }
}

export class ForgejoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Calls the Forgejo API and returns the parsed body, or throws with Forgejo's own explanation.
export async function forgejoJson<T>(ctx: PluginContext, forgejo: Forgejo, path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(ctx, forgejo, path, options);
  const text = await response.text();
  if (!response.ok) {
    // A proxy in front of Forgejo may answer with an HTML page, so Forgejo's JSON message is optional.
    let detail = "";
    try {
      const message = JSON.parse(text)?.message;
      if (typeof message === "string" && message) detail = `: ${message}`;
    } catch {
      // Not JSON; the status says enough.
    }
    throw new ForgejoError(`Forgejo answered HTTP ${response.status} to ${options.method ?? "GET"} ${path}${detail}`, response.status);
  }
  // Some endpoints, such as merge, answer with an empty body.
  return (text ? JSON.parse(text) : undefined) as T;
}

// Fetches every page of a list endpoint.
export async function forgejoPages<T>(ctx: PluginContext, forgejo: Forgejo, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await forgejoJson<T[]>(ctx, forgejo, `${path}${path.includes("?") ? "&" : "?"}limit=${PAGE_SIZE}&page=${page}`);
    // Most lists answer [] past the last page; the pull request file list answers null.
    if (!batch?.length) return items;
    items.push(...batch);
  }
}

export function listRepositories(ctx: PluginContext, forgejo: Forgejo): Promise<ForgejoRepositoryJson[]> {
  return forgejoPages<ForgejoRepositoryJson>(ctx, forgejo, "/user/repos");
}

// "owner/repo" with Forgejo's allowed characters. Names go into API paths, so anything else could
// reach other endpoints with the operator's token.
export function isRepositoryName(name: string): boolean {
  const parts = name.split("/");
  return parts.length === 2 && parts.every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..");
}

// The "owner/repo" of a workspace address on the Forgejo server itself, over HTTPS or SSH, or null.
// Forgejo may serve SSH under another host name; only listing every repository recognises those.
export function repositoryNameOnServer(baseUrl: string, address: string): string | null {
  let url: URL;
  try {
    url = new URL(addressKey(address));
  } catch {
    return null;
  }
  const base = new URL(baseUrl);
  if (url.hostname !== base.hostname) return null;
  // Over HTTPS, a Forgejo served under a path such as /git/ puts that path before owner/repo.
  const basePath = base.pathname.replace(/\/+$/, "").toLowerCase();
  const path = url.protocol === "ssh:" || !url.pathname.startsWith(`${basePath}/`) ? url.pathname : url.pathname.slice(basePath.length);
  const name = path.replace(/^\/+/, "");
  return isRepositoryName(name) ? name : null;
}

// Reduces the forms one repository address can take to one key, so a workspace matches whichever
// address it was created with: trailing ".git" or "/", letter case, and scp-style SSH ("git@host:owner/repo").
export function addressKey(address: string): string {
  const scpStyle = /^([^@/\s]+@[^:/\s]+):(.+)$/.exec(address.trim());
  const url = scpStyle ? `ssh://${scpStyle[1]}/${scpStyle[2]}` : address.trim();
  return url.replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
}

export function repositoryAddressKeys(repository: Pick<ForgejoRepositoryJson, "clone_url" | "ssh_url" | "html_url">): string[] {
  return [repository.clone_url, repository.ssh_url, repository.html_url].map(addressKey);
}

// The repositories that some workspace of a project was created from.
export function repositoriesUsedBy<R extends Pick<ForgejoRepositoryJson, "clone_url" | "ssh_url" | "html_url">>(
  workspaces: PluginWorkspace[],
  repositories: R[],
): R[] {
  const workspaceKeys = new Set(workspaces.flatMap((workspace) => (workspace.repoUrl ? [addressKey(workspace.repoUrl)] : [])));
  return repositories.filter((repository) => repositoryAddressKeys(repository).some((key) => workspaceKeys.has(key)));
}

export async function projectRepositoryNames(ctx: PluginContext, forgejo: Forgejo, companyId: string, projectId: string) {
  const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
  const onServer = workspaces.flatMap((workspace) => {
    const name = workspace.repoUrl ? repositoryNameOnServer(forgejo.baseUrl, workspace.repoUrl) : null;
    return name ? [name] : [];
  });
  if (onServer.length > 0) return [...new Set(onServer)];
  // Listing every repository is slow on a large server, so it is only the fallback.
  return repositoriesUsedBy(workspaces, await listRepositories(ctx, forgejo)).map((repository) => repository.full_name);
}
