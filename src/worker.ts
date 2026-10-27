import { definePlugin, runWorker, type EnvSecretRefBinding, type PluginContext } from "@paperclipai/plugin-sdk";

export type ConnectionStatus =
  | { connected: true; forgejoVersion: string; username: string }
  | { connected: false; reason: string };

export type ForgejoRepository = { fullName: string; cloneUrl: string; private: boolean };

export type ProjectRepositories =
  | { configured: false; reason: string }
  | {
      configured: true;
      // Workspaces of this project that already point at this Forgejo server.
      linkedWorkspaces: { name: string; repoUrl: string }[];
      repositories: ForgejoRepository[];
    };

const NOT_CONFIGURED = "Set the Forgejo URL and access token in the plugin settings.";

// Forgejo caps page size at 50 by default.
const PAGE_SIZE = 50;

type Forgejo = { baseUrl: string; apiUrl: string; headers: Record<string, string> };

async function connect(ctx: PluginContext, companyId: string): Promise<Forgejo | null> {
  const config = await ctx.config.get(companyId);
  if (typeof config.baseUrl !== "string" || !config.baseUrl || !config.token) return null;

  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  // Resolve the token on every call: Paperclip forbids caching secret values.
  const token = await ctx.secrets.resolve(config.token as EnvSecretRefBinding, { companyId, configPath: "token" });
  return { baseUrl, apiUrl: `${baseUrl}/api/v1`, headers: { Authorization: `token ${token}`, Accept: "application/json" } };
}

async function checkConnection(ctx: PluginContext, companyId: string): Promise<ConnectionStatus> {
  const forgejo = await connect(ctx, companyId);
  if (!forgejo) return { connected: false, reason: NOT_CONFIGURED };
  const { apiUrl, headers } = forgejo;

  // /version needs no login, so a failure here means Forgejo is unreachable rather than the token being wrong.
  const versionResponse = await ctx.http.fetch(`${apiUrl}/version`, { headers });
  if (!versionResponse.ok) {
    return { connected: false, reason: `Forgejo did not respond at ${apiUrl} (HTTP ${versionResponse.status}).` };
  }
  const { version } = (await versionResponse.json()) as { version: string };

  const userResponse = await ctx.http.fetch(`${apiUrl}/user`, { headers });
  if (!userResponse.ok) {
    return { connected: false, reason: `Forgejo rejected the access token (HTTP ${userResponse.status}).` };
  }
  const { login } = (await userResponse.json()) as { login: string };

  return { connected: true, forgejoVersion: version, username: login };
}

async function listRepositories(ctx: PluginContext, forgejo: Forgejo): Promise<ForgejoRepository[]> {
  const repositories: ForgejoRepository[] = [];
  for (let page = 1; ; page += 1) {
    const response = await ctx.http.fetch(`${forgejo.apiUrl}/user/repos?limit=${PAGE_SIZE}&page=${page}`, {
      headers: forgejo.headers,
    });
    if (!response.ok) throw new Error(`Forgejo could not list repositories (HTTP ${response.status}).`);

    const batch = (await response.json()) as { full_name: string; clone_url: string; private: boolean }[];
    repositories.push(...batch.map((repo) => ({ fullName: repo.full_name, cloneUrl: repo.clone_url, private: repo.private })));
    if (batch.length < PAGE_SIZE) return repositories;
  }
}

async function getProjectRepositories(ctx: PluginContext, companyId: string, projectId: string): Promise<ProjectRepositories> {
  const forgejo = await connect(ctx, companyId);
  if (!forgejo) return { configured: false, reason: NOT_CONFIGURED };

  const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
  const linkedWorkspaces = workspaces
    .filter((workspace) => workspace.repoUrl?.startsWith(`${forgejo.baseUrl}/`))
    .map((workspace) => ({ name: workspace.name, repoUrl: workspace.repoUrl as string }));

  return { configured: true, linkedWorkspaces, repositories: await listRepositories(ctx, forgejo) };
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
