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
import { startRequestedWork, type DeliveryPayload } from "./work-requests.js";

// Paperclip only lets a plugin use origins under its own ID. originId is an issueKey.
export const ISSUE_ORIGIN = `plugin:${manifest.id}:issue` as const;

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

type ForgejoCommentJson = {
  id: number;
  body: string;
  html_url: string;
  // The issue's web address, or "" for a comment on a pull request.
  issue_url: string;
  user: { login: string };
  updated_at: string;
};

// The ID of the newest Forgejo comment copied to a Paperclip issue. Forgejo comment IDs only go up,
// so a comment with a higher ID has not been copied yet.
function lastCopiedCommentKey(issueId: string) {
  return { scopeKind: "issue" as const, scopeId: issueId, stateKey: "forgejo-last-comment" };
}

// Copies the comments newer than the last one copied, oldest first. Callers hold the issue's turn in
// oneAtATime, so the webhook and the sync job cannot both copy the same comment.
async function copyNewComments(ctx: PluginContext, companyId: string, issueId: string, comments: ForgejoCommentJson[]) {
  const lastCopied = ((await ctx.state.get(lastCopiedCommentKey(issueId))) as number | null) ?? 0;
  const newComments = comments.filter((comment) => comment.id > lastCopied).sort((a, b) => a.id - b.id);
  for (const comment of newComments) {
    await ctx.issues.createComment(issueId, `**${comment.user.login}** [commented in Forgejo](${comment.html_url}):\n\n${comment.body}`, companyId);
    // Saved after each comment, so a failure part-way does not copy the earlier ones again.
    await ctx.state.set(lastCopiedCommentKey(issueId), comment.id);
  }
}

// Webhooks and the sync job run in the same worker process. Chaining the work for one issue keeps
// two of them from importing or updating it at the same time.
const queues = new Map<string, Promise<unknown>>();

export async function oneAtATime(key: string, work: () => Promise<void>) {
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(key, run);
  try {
    await run;
  } finally {
    if (queues.get(key) === run) queues.delete(key);
  }
}

function issueTurn(target: Target, number: number) {
  return `${target.projectId}:${issueKey(target.repository, number)}`;
}

// Brings one Paperclip issue in line with its Forgejo issue, importing it if it was never imported.
// Title and description follow Forgejo. A close in Forgejo closes the Paperclip issue and a reopen
// reopens it. A close in Paperclip that did not reach Forgejo is sent again.
async function applyForgejoIssue(ctx: PluginContext, forgejo: Forgejo, target: Target, issue: ForgejoIssueJson, existing: Issue | undefined) {
  const key = issueKey(target.repository, issue.number);
  await oneAtATime(issueTurn(target, issue.number), async () => {
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
      // Forgejo's comment list for one issue ignores paging and returns every comment.
      const comments = await forgejoJson<ForgejoCommentJson[]>(ctx, forgejo, `/repos/${target.repository}/issues/${issue.number}/comments`);
      await copyNewComments(ctx, target.companyId, created.id, comments);
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
async function syncRepository(ctx: PluginContext, forgejo: Forgejo, companyId: string, repository: string, targets: Target[]) {
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

  await copyMissedComments(ctx, forgejo, companyId, repository, targets);
}

// Where the last catch-up stopped in a repository's comments: the newest updated_at it saw, by
// Forgejo's clock, so a difference between the two servers' clocks cannot skip a comment.
function commentsSeenUntilKey(companyId: string, repository: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: `forgejo-comments-seen-until:${repository.toLowerCase()}` };
}

// Copies comments the webhook missed, such as those made while it was not set up, fetching the
// repository's comments once for every project. The first catch-up reads every comment.
async function copyMissedComments(ctx: PluginContext, forgejo: Forgejo, companyId: string, repository: string, targets: Target[]) {
  const seenUntilKey = commentsSeenUntilKey(companyId, repository);
  const seenUntil = (await ctx.state.get(seenUntilKey)) as string | null;
  const since = seenUntil ? `?since=${encodeURIComponent(seenUntil)}` : "";
  const comments = await forgejoPages<ForgejoCommentJson>(ctx, forgejo, `/repos/${repository}/issues/comments${since}`);

  const byNumber = new Map<number, ForgejoCommentJson[]>();
  for (const comment of comments) {
    const number = /\/issues\/(\d+)$/.exec(comment.issue_url)?.[1];
    if (number) byNumber.set(Number(number), [...(byNumber.get(Number(number)) ?? []), comment]);
  }
  for (const target of targets) {
    for (const [number, issueComments] of byNumber) {
      const [existing] = await syncedIssues(ctx, target.companyId, target.projectId, issueKey(target.repository, number));
      if (existing) await oneAtATime(issueTurn(target, number), () => copyNewComments(ctx, target.companyId, existing.id, issueComments));
    }
  }

  let newest = seenUntil;
  for (const comment of comments) {
    if (!newest || Date.parse(comment.updated_at) > Date.parse(newest)) newest = comment.updated_at;
  }
  if (newest) await ctx.state.set(seenUntilKey, newest);
}

// The projects that use a repository, each with the repository name as Forgejo spells it.
// listWorkspaces is called per project rather than reading project.workspaces, because only it
// returns the workspace fields Paperclip has cleaned for plugins.
export async function projectsUsing(ctx: PluginContext, companyId: string, repositories: ForgejoRepositoryJson[]): Promise<Target[]> {
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
          await syncRepository(ctx, forgejo, companyId, repository, repositoryTargets);
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

// Forgejo sends "issues" events for changes to an issue and "issue_comment" events for its comments.
type IssueEventPayload = { action: string; issue: ForgejoIssueJson; repository: ForgejoRepositoryJson; comment?: ForgejoCommentJson };

// Returns whether this company's webhook secret signed the delivery, after handling it if so.
async function deliverToCompany(ctx: PluginContext, companyId: string, input: PluginWebhookInput): Promise<boolean> {
  const forgejo = await connect(ctx, companyId);
  if (!forgejo?.webhookSecret) return false;
  const secret = await ctx.secrets.resolve(forgejo.webhookSecret, { companyId, configPath: "webhookSecret" });
  const signature = header(input, "x-forgejo-signature") ?? header(input, "x-gitea-signature");
  if (!signatureMatches(secret, input.rawBody, signature)) return false;

  const event = header(input, "x-forgejo-event") ?? header(input, "x-gitea-event") ?? "";
  const payload = JSON.parse(input.rawBody) as IssueEventPayload & DeliveryPayload;
  // Synced first, so a request on a new issue finds it imported.
  if (forgejo.syncIssues) await syncFromDelivery(ctx, forgejo, companyId, event, payload);
  const deliveryId = header(input, "x-forgejo-delivery") ?? header(input, "x-gitea-delivery") ?? input.requestId;
  await startRequestedWork(ctx, forgejo, companyId, event, payload, deliveryId);
  return true;
}

async function syncFromDelivery(ctx: PluginContext, forgejo: Forgejo, companyId: string, event: string, payload: IssueEventPayload) {
  const issueChanged = event === "issues" && payload.action !== "deleted";
  // Edited and deleted comments are not copied.
  const newComment = event === "issue_comment" && payload.action === "created" ? payload.comment : undefined;
  if ((!issueChanged && !newComment) || payload.issue.pull_request) return;

  for (const target of await projectsUsing(ctx, companyId, [payload.repository])) {
    const [existing] = await syncedIssues(ctx, companyId, target.projectId, issueKey(target.repository, payload.issue.number));
    if (newComment && existing) {
      await oneAtATime(issueTurn(target, payload.issue.number), () => copyNewComments(ctx, companyId, existing.id, [newComment]));
    } else {
      // Importing an issue also copies its comments, including a new one.
      await applyForgejoIssue(ctx, forgejo, target, payload.issue, existing);
    }
  }
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
