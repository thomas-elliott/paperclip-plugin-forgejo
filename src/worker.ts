import { definePlugin, runWorker, type EnvSecretRefBinding, type PluginContext } from "@paperclipai/plugin-sdk";

export type ConnectionStatus =
  | { connected: true; forgejoVersion: string; username: string }
  | { connected: false; reason: string };

async function checkConnection(ctx: PluginContext, companyId: string): Promise<ConnectionStatus> {
  const config = await ctx.config.get(companyId);
  if (typeof config.baseUrl !== "string" || !config.baseUrl || !config.token) {
    return { connected: false, reason: "Set the Forgejo URL and access token in the plugin settings." };
  }

  const apiUrl = `${config.baseUrl.replace(/\/+$/, "")}/api/v1`;
  // Resolve the token on every call: Paperclip forbids caching secret values.
  const token = await ctx.secrets.resolve(config.token as EnvSecretRefBinding, { companyId, configPath: "token" });
  const headers = { Authorization: `token ${token}`, Accept: "application/json" };

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

const plugin = definePlugin({
  // Config is read fresh on every call, so one worker can safely serve several companies.
  multiCompanyConfig: true,

  async setup(ctx) {
    ctx.data.register("connection", async (params) => {
      return checkConnection(ctx, String(params.companyId ?? ""));
    });
  },

  async onHealth() {
    return { status: "ok", message: "Forgejo plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
