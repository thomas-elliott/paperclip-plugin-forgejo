import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Issue, PluginContext, PluginEvent, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import {
  configuredCompanies,
  connect,
  errorMessage,
  ForgejoError,
  forgejoJson,
  forgejoPages,
  issueKey,
  listRepositories,
  parseIssueKey,
  repositoriesUsedBy,
  type Forgejo,
  type ForgejoIssueJson,
  type ForgejoRepositoryJson,
} from "./forgejo.js";

// Paperclip only lets a plugin use origins under its own ID. originId is an issueKey.
const ISSUE_ORIGIN = `plugin:${manifest.id}:issue` as const;

// Each import is recorded, because Paperclip leaves hidden issues out of issues.list: without the
// record, an issue someone hid would be imported again.
const IMPORTED_ISSUE = "imported-issue";

const CLOSED_STATUSES: Issue["status"][] = ["done", "cancelled"];

type ForgejoState = ForgejoIssueJson["state"];
type Target = { companyId: string; projectId: string; repository: string };

function description(issue: ForgejoIssueJson) {
  return `Forgejo issue: ${issue.html_url}\n\n${issue.body}`;
}

function fingerprint(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

// What the plugin last agreed with Forgejo for one Paperclip issue:
// - state: the open or closed state both sides last shared. A status change is copied only when one
//   side moves away from it, so the plugin's own updates never echo back.
// - descriptionFingerprint: the description the plugin last wrote. Paperclip's issues.list cuts
//   descriptions to 1,200 characters, so comparing against it would rewrite long issues every sync.
type SyncRecord = { state: ForgejoState; descriptionFingerprint: string };

function syncRecordKey(issueId: string) {
  return { scopeKind: "issue" as const, scopeId: issueId, stateKey: "forgejo-sync" };
}

async function syncRecord(ctx: PluginContext, issueId: string) {
  return (await ctx.state.get(syncRecordKey(issueId))) as SyncRecord | null;
}

async function setSyncRecord(ctx: PluginContext, issueId: string, record: SyncRecord | null) {
  if (record) await ctx.state.set(syncRecordKey(issueId), record);
  else await ctx.state.delete(syncRecordKey(issueId));
}

async function closeInForgejo(ctx: PluginContext, forgejo: Forgejo, issue: Issue, record: SyncRecord) {
  const { repository, number } = parseIssueKey(issue.originId as string);
  await forgejoJson(ctx, forgejo, `/repos/${repository}/issues/${number}`, { method: "PATCH", body: { state: "closed" } });
  await setSyncRecord(ctx, issue.id, { ...record, state: "closed" });
}

// Webhooks and the sync job run in the same worker process. Chaining the work for one issue keeps
// two of them from importing or updating it at the same time.
const queues = new Map<string, Promise<unknown>>();

async function oneAtATime(key: string, work: () => Promise<void>) {
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(key, run);
  try {
    await run;
  } finally {
    if (queues.get(key) === run) queues.delete(key);
  }
}

// Brings one Paperclip issue in line with its Forgejo issue, importing it if it was never imported.
// Title and description follow Forgejo. A close in Forgejo closes the Paperclip issue and a reopen
// reopens it. A close in Paperclip that did not reach Forgejo is sent again.
async function applyForgejoIssue(ctx: PluginContext, forgejo: Forgejo, target: Target, issue: ForgejoIssueJson, existing: Issue | undefined) {
  const key = issueKey(target.repository, issue.number);
  await oneAtATime(`${target.projectId}:${key}`, async () => {
    const descriptionFingerprint = fingerprint(description(issue));

    if (!existing) {
      if (issue.state === "closed") return;
      // Also covers an import that finished while this one waited its turn.
      const imported = await ctx.entities.list({ entityType: IMPORTED_ISSUE, scopeKind: "project", scopeId: target.projectId, externalId: key });
      if (imported.length > 0) return;
      const created = await ctx.issues.create({
        companyId: target.companyId,
        projectId: target.projectId,
        title: issue.title,
        description: description(issue),
        status: "todo",
        originKind: ISSUE_ORIGIN,
        originId: key,
      });
      await ctx.entities.upsert({ entityType: IMPORTED_ISSUE, scopeKind: "project", scopeId: target.projectId, externalId: key, data: { issueId: created.id } });
      await setSyncRecord(ctx, created.id, { state: "open", descriptionFingerprint });
      return;
    }

    const record = await syncRecord(ctx, existing.id);
    const closedInPaperclip = CLOSED_STATUSES.includes(existing.status);
    const patch: Parameters<PluginContext["issues"]["update"]>[1] = {};
    if (existing.title !== issue.title) patch.title = issue.title;
    if (record?.descriptionFingerprint !== descriptionFingerprint) patch.description = description(issue);
    if (issue.state !== record?.state) {
      if (issue.state === "closed" && !closedInPaperclip) patch.status = "done";
      if (issue.state === "open" && closedInPaperclip) patch.status = "todo";
    }

    const next: SyncRecord = { state: issue.state, descriptionFingerprint };
    if (Object.keys(patch).length > 0) {
      // Saved before the update: Paperclip may deliver issue.updated before update() returns, and
      // the event handler must already see the new agreement, or it would send Forgejo a close.
      await setSyncRecord(ctx, existing.id, next);
      try {
        await ctx.issues.update(existing.id, patch, target.companyId);
      } catch (error) {
        await setSyncRecord(ctx, existing.id, record);
        throw error;
      }
    } else if (issue.state !== record?.state) {
      await setSyncRecord(ctx, existing.id, next);
    }

    // Both sides last agreed on open, so Paperclip closed it and Forgejo never heard.
    if (record?.state === "open" && issue.state === "open" && closedInPaperclip) await closeInForgejo(ctx, forgejo, existing, next);
  });
}

async function syncedIssues(ctx: PluginContext, companyId: string, projectId: string, id?: string) {
  return ctx.issues.list({ companyId, projectId, originKind: ISSUE_ORIGIN, originId: id });
}

// Syncs one repository into every project of a company that uses it, fetching its issues once.
async function syncRepository(ctx: PluginContext, forgejo: Forgejo, repository: string, targets: Target[]) {
  const openIssues = await forgejoPages<ForgejoIssueJson>(ctx, forgejo, `/repos/${repository}/issues?state=open&type=issues`);
  const prefix = `${repository.toLowerCase()}#`;

  for (const target of targets) {
    const synced = new Map(
      (await syncedIssues(ctx, target.companyId, target.projectId))
        .filter((issue) => issue.originId?.startsWith(prefix))
        .map((issue) => [issue.originId as string, issue]),
    );

    for (const issue of openIssues) {
      const key = issueKey(repository, issue.number);
      await applyForgejoIssue(ctx, forgejo, target, issue, synced.get(key));
      synced.delete(key);
    }

    // What is left was open last time but is no longer in Forgejo's open list: closed, or deleted.
    for (const [key, existing] of synced) {
      if ((await syncRecord(ctx, existing.id))?.state !== "open") continue;
      try {
        const issue = await forgejoJson<ForgejoIssueJson>(ctx, forgejo, `/repos/${repository}/issues/${parseIssueKey(key).number}`);
        await applyForgejoIssue(ctx, forgejo, target, issue, existing);
      } catch (error) {
        // A deleted issue is left as it is in Paperclip.
        if (!(error instanceof ForgejoError && error.status === 404)) throw error;
      }
    }
  }
}

// The projects that use a repository, each with the repository name as Forgejo spells it.
// listWorkspaces is called per project rather than reading project.workspaces, because only it
// returns the workspace fields Paperclip has cleaned for plugins.
async function projectsUsing(ctx: PluginContext, companyId: string, repositories: ForgejoRepositoryJson[]): Promise<Target[]> {
  const targets: Target[] = [];
  for (const project of await ctx.projects.list({ companyId })) {
    const workspaces = await ctx.projects.listWorkspaces(project.id, companyId);
    for (const repository of repositoriesUsedBy(workspaces, repositories)) {
      targets.push({ companyId, projectId: project.id, repository: repository.full_name });
    }
  }
  return targets;
}

// A failure in one repository or company does not stop the others. The job still fails at the end,
// listing every failure, so Paperclip shows the run as failed.
export async function syncAllCompanies(ctx: PluginContext) {
  const failures: string[] = [];
  for (const companyId of await configuredCompanies(ctx)) {
    try {
      const forgejo = await connect(ctx, companyId);
      if (!forgejo?.syncIssues) continue;
      const byRepository = new Map<string, Target[]>();
      for (const target of await projectsUsing(ctx, companyId, await listRepositories(ctx, forgejo))) {
        byRepository.set(target.repository, [...(byRepository.get(target.repository) ?? []), target]);
      }
      for (const [repository, repositoryTargets] of byRepository) {
        try {
          await syncRepository(ctx, forgejo, repository, repositoryTargets);
        } catch (error) {
          failures.push(`${repository} in company ${companyId}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      failures.push(`company ${companyId}: ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Forgejo issue sync failed for ${failures.join("; ")}`);
}

// When a synced issue is closed in Paperclip, close it in Forgejo. Reopening in Paperclip does not
// reopen it in Forgejo.
export async function onPaperclipIssueUpdated(ctx: PluginContext, event: PluginEvent) {
  if (event.entityType !== "issue" || !event.entityId) return;
  const issue = await ctx.issues.get(event.entityId, event.companyId);
  if (!issue || issue.originKind !== ISSUE_ORIGIN || !issue.originId || !CLOSED_STATUSES.includes(issue.status)) return;

  const forgejo = await connect(ctx, event.companyId);
  const record = await syncRecord(ctx, issue.id);
  if (!forgejo?.syncIssues || record?.state !== "open") return;
  // If this fails, the next sync sends the close again.
  await closeInForgejo(ctx, forgejo, issue, record);
}

function header(input: PluginWebhookInput, name: string): string | undefined {
  const value = input.headers[name] ?? input.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// Forgejo signs the raw body with HMAC-SHA256 and sends the hex digest.
function signatureMatches(secret: string, rawBody: string, signature: string | undefined) {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type IssueEventPayload = { action: string; issue: ForgejoIssueJson; repository: ForgejoRepositoryJson };

// Returns whether this company's webhook secret signed the delivery, after handling it if so.
async function deliverToCompany(ctx: PluginContext, companyId: string, input: PluginWebhookInput): Promise<boolean> {
  const forgejo = await connect(ctx, companyId);
  if (!forgejo?.webhookSecret) return false;
  const secret = await ctx.secrets.resolve(forgejo.webhookSecret, { companyId, configPath: "webhookSecret" });
  const signature = header(input, "x-forgejo-signature") ?? header(input, "x-gitea-signature");
  if (!signatureMatches(secret, input.rawBody, signature)) return false;

  const event = header(input, "x-forgejo-event") ?? header(input, "x-gitea-event");
  const payload = JSON.parse(input.rawBody) as IssueEventPayload;
  if (event !== "issues" || !forgejo.syncIssues || payload.issue.pull_request || payload.action === "deleted") return true;
  for (const target of await projectsUsing(ctx, companyId, [payload.repository])) {
    const [existing] = await syncedIssues(ctx, companyId, target.projectId, issueKey(target.repository, payload.issue.number));
    await applyForgejoIssue(ctx, forgejo, target, payload.issue, existing);
  }
  return true;
}

// Webhook deliveries carry no company, so each company whose webhook secret signs the body gets the
// event. A company whose settings fail, such as a deleted secret, does not stop the others.
export async function handleWebhook(ctx: PluginContext, input: PluginWebhookInput) {
  let delivered = false;
  const failures: string[] = [];
  for (const companyId of await configuredCompanies(ctx)) {
    try {
      if (await deliverToCompany(ctx, companyId, input)) delivered = true;
    } catch (error) {
      failures.push(`company ${companyId}: ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) ctx.logger.error("Forgejo webhook failed for some companies", { failures });
  // Failing makes Paperclip record the delivery as failed, which shows a misconfigured secret.
  if (!delivered) {
    throw new Error(
      failures.length > 0
        ? `The Forgejo webhook could not be handled: ${failures.join("; ")}`
        : "The webhook signature does not match any company's Forgejo webhook secret.",
    );
  }
}
