import { useState } from "react";
import {
  copyTextToClipboard,
  usePluginData,
  type PluginDetailTabProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import type { ConnectionStatus, ForgejoRepository, ProjectRepositories } from "../worker.js";

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

// Plugins may not create project workspaces, so the tab builds the CLI command for the user to run.
function workspaceCommand(projectId: string, repository: ForgejoRepository): string {
  const payload = JSON.stringify({
    name: repository.fullName.split("/").pop(),
    sourceType: "git_repo",
    repoUrl: repository.cloneUrl,
  });
  return `npx paperclipai project-workspace create ${projectId} --api-base ${window.location.origin} --payload-json '${payload}'`;
}

export function ProjectRepositoryTab({ context }: PluginDetailTabProps) {
  const projectId = context.entityId;
  const { data, loading, error } = usePluginData<ProjectRepositories>("projectRepositories", {
    companyId: context.companyId,
    projectId,
  });
  const [selected, setSelected] = useState("");
  const [copied, setCopied] = useState(false);

  if (loading) return <div>Loading Forgejo repositories…</div>;
  if (error) return <div>Could not load Forgejo repositories: {error.message}</div>;
  if (!data?.configured) return <div>Forgejo is not connected. {data?.reason}</div>;

  const repository = data.repositories.find((repo) => repo.fullName === selected);
  const command = repository ? workspaceCommand(projectId, repository) : "";

  async function copyCommand() {
    await copyTextToClipboard(command);
    setCopied(true);
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {data.linkedWorkspaces.length > 0 && (
        <section>
          <h3>Forgejo workspaces in this project</h3>
          <ul>
            {data.linkedWorkspaces.map((workspace) => (
              <li key={workspace.repoUrl}>
                {workspace.name}: <code>{workspace.repoUrl}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ display: "grid", gap: "0.5rem" }}>
        <label htmlFor="forgejo-repository">Add a Forgejo repository as a workspace</label>
        <select
          id="forgejo-repository"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setCopied(false);
          }}
        >
          <option value="">Choose a repository…</option>
          {data.repositories.map((repo) => (
            <option key={repo.fullName} value={repo.fullName}>
              {repo.fullName}
              {repo.private ? " (private)" : ""}
            </option>
          ))}
        </select>

        {repository && (
          <>
            <p>Paperclip does not let plugins create workspaces. Run this command to add it:</p>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{command}</pre>
            <button type="button" onClick={copyCommand}>
              {copied ? "Copied" : "Copy command"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
