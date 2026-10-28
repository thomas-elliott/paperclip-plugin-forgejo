import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { registerAgentTools } from "./agent-tools.js";
import { addressKey, connect, errorMessage, listRepositories, NOT_CONFIGURED, rememberConfiguredCompany, repositoriesUsedBy, repositoryAddressKeys, request } from "./forgejo.js";
import { handleWebhook, onPaperclipIssueUpdated, syncAllCompanies } from "./issue-sync.js";
import { detectObjects, resolveObject } from "./link-status.js";

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

async function checkConnection(ctx: PluginContext, companyId: string): Promise<ConnectionStatus> {
  const forgejo = await connect(ctx, companyId);
  if (!forgejo) return { connected: false, reason: NOT_CONFIGURED };

  try {
    // /version is called without the token: some servers answer 401 to a bad token on every endpoint,
    // which would make a bad token look like an unreachable server.
    const [versionResponse, userResponse] = await Promise.all([
      request(ctx, forgejo, "/version", { withToken: false }),
      request(ctx, forgejo, "/user"),
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
    return { connected: false, reason: errorMessage(error) };
  }
}

async function getProjectRepositories(ctx: PluginContext, companyId: string, projectId: string): Promise<ProjectRepositories> {
  const forgejo = await connect(ctx, companyId);
  if (!forgejo) return { configured: false, reason: NOT_CONFIGURED };

  const [workspaces, repositories] = await Promise.all([
    ctx.projects.listWorkspaces(projectId, companyId),
    listRepositories(ctx, forgejo),
  ]);

  const used = new Set(repositoriesUsedBy(workspaces, repositories));
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
      linked: used.has(repository),
    })),
  };
}

let pluginContext: PluginContext | null = null;

function requireContext(): PluginContext {
  if (!pluginContext) throw new Error("The Forgejo plugin worker has not finished starting.");
  return pluginContext;
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

    registerAgentTools(ctx);
    ctx.jobs.register("sync-issues", () => syncAllCompanies(ctx));
    ctx.events.on("issue.updated", (event) => onPaperclipIssueUpdated(ctx, event));
    pluginContext = ctx;
  },

  // Paperclip calls these without a context, so they use the one setup received.
  // Implementing onConfigChanged also stops Paperclip restarting the worker on every settings save;
  // the plugin reads its settings on every call, so it needs no restart.
  async onConfigChanged(_config, context) {
    if (context?.companyId) await rememberConfiguredCompany(requireContext(), context.companyId);
  },

  async onWebhook(input) {
    await handleWebhook(requireContext(), input);
  },

  async onDetectExternalObjects(params) {
    return detectObjects(requireContext(), params);
  },

  async onResolveExternalObject(params) {
    return resolveObject(requireContext(), params);
  },

  async onHealth() {
    return { status: "ok", message: "Forgejo plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
