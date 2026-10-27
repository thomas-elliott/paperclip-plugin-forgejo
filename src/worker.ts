import { definePlugin, runWorker, type EnvSecretRefBinding, type PluginContext } from "@paperclipai/plugin-sdk";

export type ConnectionStatus =
  | { connected: true; forgejoVersion: string; username: string }
  | { connected: false; reason: string };

// `linked` means a workspace in the current project already uses this repository.
export type ForgejoRepository = { fullName: string; cloneUrl: string; private: boolean; linked: boolean };

export type ProjectRepositories =
  | { configured: false; reason: string }
  | {
      configured: true;
      // Workspaces of this project whose address belongs to one of the user's Forgejo repositories.
      linkedWorkspaces: { name: string; repoUrl: string }[];
      repositories: ForgejoRepository[];
    };

type ForgejoRepositoryJson = { full_name: string; clone_url: string; ssh_url: string; html_url: string; private: boolean };

const NOT_CONFIGURED = "Set the Forgejo URL and access token in the plugin settings.";

// Forgejo may return fewer items than this per page (its MAX_RESPONSE_ITEMS setting), so paging stops on an empty page.
const PAGE_SIZE = 50;

type Forgejo = { baseUrl: string; apiUrl: string; token: string };

async function connect(ctx: PluginContext, companyId: string): Promise<Forgejo | null> {
  const config = await ctx.config.get(companyId);
  if (typeof config.baseUrl !== "string" || !config.baseUrl || !config.token) return null;

  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  // Resolve the token on every call: Paperclip forbids caching secret values.
  const token = await ctx.secrets.resolve(config.token as EnvSecretRefBinding, { companyId, configPath: "token" });
  return { baseUrl, apiUrl: `${baseUrl}/api/v1`, token };
}

// ctx.http.fetch throws, rather than returning a status, for bad addresses, DNS failures, timeouts and
// blocked private addresses. Turn those into a message the user can act on.
async function request(ctx: PluginContext, forgejo: Forgejo, path: string, options: { withToken: boolean }) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.withToken) headers.Authorization = `token ${forgejo.token}`;
  try {
    return await ctx.http.fetch(`${forgejo.apiUrl}${path}`, { headers });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach Forgejo at ${forgejo.baseUrl}: ${detail}`);
  }
}

async function checkConnection(ctx: PluginContext, companyId: string): Promise<ConnectionStatus> {
  const forgejo = await connect(ctx, companyId);
  if (!forgejo) return { connected: false, reason: NOT_CONFIGURED };

  try {
    // /version is called without the token: some servers answer 401 to a bad token on every endpoint,
    // which would make a bad token look like an unreachable server.
    const [versionResponse, userResponse] = await Promise.all([
      request(ctx, forgejo, "/version", { withToken: false }),
      request(ctx, forgejo, "/user", { withToken: true }),
    ]);
    if (!versionResponse.ok) {
      return { connected: false, reason: `Forgejo did not respond at ${forgejo.apiUrl} (HTTP ${versionResponse.status}).` };
    }
    if (!userResponse.ok) {
      return { connected: false, reason: `Forgejo rejected the access token (HTTP ${userResponse.status}).` };
    }
    const { version } = (await versionResponse.json()) as { version: string };
    const { login } = (await userResponse.json()) as { login: string };
    return { connected: true, forgejoVersion: version, username: login };
  } catch (error) {
    return { connected: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function listRepositories(ctx: PluginContext, forgejo: Forgejo): Promise<ForgejoRepositoryJson[]> {
  const repositories: ForgejoRepositoryJson[] = [];
  for (let page = 1; ; page += 1) {
    const response = await request(ctx, forgejo, `/user/repos?limit=${PAGE_SIZE}&page=${page}`, { withToken: true });
    if (!response.ok) throw new Error(`Forgejo could not list repositories (HTTP ${response.status}).`);

    const batch = (await response.json()) as ForgejoRepositoryJson[];
    if (batch.length === 0) return repositories;
    repositories.push(...batch);
  }
}

// Reduces the forms one repository address can take to one key, so a workspace matches whichever
// address it was created with: trailing ".git" or "/", letter case, and scp-style SSH ("git@host:owner/repo").
function addressKey(address: string): string {
  const scpStyle = /^([^@/\s]+@[^:/\s]+):(.+)$/.exec(address.trim());
  const url = scpStyle ? `ssh://${scpStyle[1]}/${scpStyle[2]}` : address.trim();
  return url.replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
}

function repositoryAddressKeys(repository: ForgejoRepositoryJson): string[] {
  return [repository.clone_url, repository.ssh_url, repository.html_url].map(addressKey);
}

async function getProjectRepositories(ctx: PluginContext, companyId: string, projectId: string): Promise<ProjectRepositories> {
  const forgejo = await connect(ctx, companyId);
  if (!forgejo) return { configured: false, reason: NOT_CONFIGURED };

  const [workspaces, repositories] = await Promise.all([
    ctx.projects.listWorkspaces(projectId, companyId),
    listRepositories(ctx, forgejo),
  ]);

  const workspaceKeys = new Set(workspaces.flatMap((workspace) => (workspace.repoUrl ? [addressKey(workspace.repoUrl)] : [])));
  const repositoryKeys = new Set(repositories.flatMap(repositoryAddressKeys));

  return {
    configured: true,
    linkedWorkspaces: workspaces
      .filter((workspace) => workspace.repoUrl && repositoryKeys.has(addressKey(workspace.repoUrl)))
      .map((workspace) => ({ name: workspace.name, repoUrl: workspace.repoUrl as string })),
    repositories: repositories.map((repository) => ({
      fullName: repository.full_name,
      cloneUrl: repository.clone_url,
      private: repository.private,
      linked: repositoryAddressKeys(repository).some((key) => workspaceKeys.has(key)),
    })),
  };
}

const plugin = definePlugin({
  // Config is read fresh on every call, so one worker can safely serve several companies.
  multiCompanyConfig: true,

  async setup(ctx) {
    ctx.data.register("connection", async (params) => {
      return checkConnection(ctx, String(params.companyId ?? ""));
    });
    ctx.data.register("projectRepositories", async (params) => {
      return getProjectRepositories(ctx, String(params.companyId ?? ""), String(params.projectId ?? ""));
    });
  },

  async onHealth() {
    return { status: "ok", message: "Forgejo plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
