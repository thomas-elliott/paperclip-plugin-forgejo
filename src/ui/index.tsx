import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { ConnectionStatus } from "../worker.js";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<ConnectionStatus>("connection", {
    companyId: context.companyId,
  });

  if (loading) return <div>Checking Forgejo connection…</div>;
  if (error) return <div>Could not check Forgejo: {error.message}</div>;
  if (!data?.connected) return <div>Forgejo is not connected. {data?.reason}</div>;

  return (
    <div>
      Connected to Forgejo {data.forgejoVersion} as <strong>{data.username}</strong>
    </div>
  );
}
