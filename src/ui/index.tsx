import { useState, type CSSProperties } from "react";
import {
  copyTextToClipboard,
  KeyValueList,
  Spinner,
  StatusBadge,
  usePluginData,
  type PluginDetailTabProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import type { ConnectionStatus, ForgejoRepository, ProjectRepositories } from "../worker.js";

// Paperclip's theme is Tailwind v4 CSS variables on the host page. Plugins read the variables
// rather than Tailwind classes, because the host stylesheet only contains classes it uses itself.
const space = (steps: number) => `calc(var(--spacing) * ${steps})`;

const styles = {
  stack: { display: "grid", gap: space(4) },
  field: { display: "grid", gap: space(2), maxWidth: "40rem" },
  heading: { margin: 0, fontSize: "var(--text-sm)", fontWeight: "var(--font-weight-semibold)" },
  muted: { margin: 0, fontSize: "var(--text-sm)", color: "var(--muted-foreground)" },
  label: { fontSize: "var(--text-sm)", fontWeight: "var(--font-weight-medium)" },
  select: {
    padding: `${space(2)} ${space(3)}`,
    fontSize: "var(--text-sm)",
    color: "var(--foreground)",
    background: "var(--background)",
    border: "1px solid var(--input)",
    borderRadius: "var(--radius-md)",
  },
  command: {
    margin: 0,
    padding: space(3),
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    background: "var(--muted)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
  },
  button: {
    justifySelf: "start",
    padding: `${space(2)} ${space(3)}`,
    fontSize: "var(--text-sm)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--primary-foreground)",
    background: "var(--primary)",
    border: "none",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
  },
  code: { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" },
} satisfies Record<string, CSSProperties>;

function NotConnected({ reason }: { reason?: string }) {
  return (
    <div style={styles.stack}>
      <StatusBadge status="warning" label="Not connected" />
      {reason && <p style={styles.muted}>{reason}</p>}
    </div>
  );
}

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<ConnectionStatus>("connection", {
    companyId: context.companyId,
  });

  if (loading) return <Spinner size="sm" label="Checking Forgejo connection" />;
  if (error) return <NotConnected reason={`Could not check Forgejo: ${error.message}`} />;
  if (!data?.connected) return <NotConnected reason={data?.reason} />;

  return (
    <KeyValueList
      pairs={[
        { label: "Status", value: <StatusBadge status="ok" label="Connected" /> },
        { label: "Forgejo version", value: data.forgejoVersion },
        { label: "Signed in as", value: data.username },
      ]}
    />
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
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  if (loading) return <Spinner label="Loading Forgejo repositories" />;
  if (error) return <NotConnected reason={`Could not load Forgejo repositories: ${error.message}`} />;
  if (!data?.configured) return <NotConnected reason={data?.reason} />;

  const repository = data.repositories.find((repo) => repo.fullName === selected);
  const command = repository ? workspaceCommand(projectId, repository) : "";

  async function copyCommand() {
    try {
      await copyTextToClipboard(command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div style={styles.stack}>
      {data.linkedWorkspaces.length > 0 && (
        <section style={styles.stack}>
          <h3 style={styles.heading}>Forgejo workspaces in this project</h3>
          <KeyValueList
            pairs={data.linkedWorkspaces.map((workspace) => ({
              label: workspace.name,
              value: <code style={styles.code}>{workspace.repoUrl}</code>,
            }))}
          />
        </section>
      )}

      <section style={styles.field}>
        <label htmlFor="forgejo-repository" style={styles.label}>
          Add a Forgejo repository as a workspace
        </label>
        <select
          id="forgejo-repository"
          style={styles.select}
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setCopyState("idle");
          }}
        >
          <option value="">Choose a repository…</option>
          {data.repositories.map((repo) => (
            <option key={repo.fullName} value={repo.fullName} disabled={repo.linked}>
              {repo.fullName}
              {repo.private ? " (private)" : ""}
              {repo.linked ? " (already a workspace)" : ""}
            </option>
          ))}
        </select>

        {repository && (
          <>
            <p style={styles.muted}>Paperclip does not let plugins create workspaces. Run this command to add it:</p>
            <pre style={styles.command}>{command}</pre>
            <button type="button" style={styles.button} onClick={copyCommand}>
              {copyState === "copied" ? "Copied" : "Copy command"}
            </button>
            {copyState === "failed" && (
              <p role="alert" style={styles.muted}>
                Could not copy. Select the command above and copy it yourself.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
