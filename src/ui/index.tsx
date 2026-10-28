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
    padding: `${space(2)} ${space(3)}`,
    fontSize: "var(--text-sm)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--primary-foreground)",
    background: "var(--primary)",
    border: "none",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
  },
  actions: { display: "flex", gap: space(2) },
  // Overrides the colours of `button`.
  secondaryButton: { color: "var(--foreground)", background: "var(--background)", border: "1px solid var(--border)" },
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

function workspacePayload(repository: ForgejoRepository) {
  return { name: repository.fullName.split("/").pop(), sourceType: "git_repo", repoUrl: repository.cloneUrl };
}

// Plugins may not create project workspaces, so the tab offers the CLI command as the supported route.
function workspaceCommand(projectId: string, repository: ForgejoRepository): string {
  const payload = JSON.stringify(workspacePayload(repository));
  return `npx paperclipai project-workspace create ${projectId} --api-base ${window.location.origin} --payload-json '${payload}'`;
}

// Unsupported: plugin UI runs inside Paperclip's page, so it can call the endpoint the CLI uses with the viewer's
// session. This is not part of the plugin API and may break when Paperclip changes.
async function createWorkspace(projectId: string, repository: ForgejoRepository): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workspacePayload(repository)),
  });
  if (response.ok) return;

  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const detail = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
  throw new Error(detail);
}

export function ProjectRepositoryTab({ context }: PluginDetailTabProps) {
  const projectId = context.entityId;
  const { data, loading, error, refresh } = usePluginData<ProjectRepositories>("projectRepositories", {
    companyId: context.companyId,
    projectId,
  });
  const [selected, setSelected] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [addState, setAddState] = useState<{ status: "idle" | "adding" } | { status: "failed"; reason: string }>({
    status: "idle",
  });

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

  async function addWorkspace() {
    if (!repository) return;
    setAddState({ status: "adding" });
    try {
      await createWorkspace(projectId, repository);
      setSelected("");
      setAddState({ status: "idle" });
      refresh();
    } catch (failure) {
      setAddState({ status: "failed", reason: failure instanceof Error ? failure.message : String(failure) });
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
            setAddState({ status: "idle" });
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
            <div style={styles.actions}>
              <button type="button" style={styles.button} onClick={addWorkspace} disabled={addState.status === "adding"}>
                {addState.status === "adding" ? "Adding…" : "Add (experimental)"}
              </button>
              <button type="button" style={{ ...styles.button, ...styles.secondaryButton }} onClick={copyCommand}>
                {copyState === "copied" ? "Copied" : "Copy command"}
              </button>
            </div>
            {addState.status === "failed" && (
              <p role="alert" style={styles.muted}>
                Paperclip did not add the workspace: {addState.reason}. Run the command below instead.
              </p>
            )}
            {copyState === "failed" && (
              <p role="alert" style={styles.muted}>
                Could not copy. Select the command below and copy it yourself.
              </p>
            )}
            <p style={styles.muted}>
              Add uses an unsupported API and may break after updates. Otherwise run the command in your terminal:
            </p>
            <pre style={styles.command}>{command}</pre>
          </>
        )}
      </section>
    </div>
  );
}
