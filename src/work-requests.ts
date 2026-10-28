import type { Agent, Issue, PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import { ForgejoError, forgejoJson, issueKey, type Forgejo, type ForgejoRepositoryJson } from "./forgejo.js";
import { ISSUE_ORIGIN, oneAtATime, projectsUsing } from "./issue-sync.js";

// A task the plugin created because someone in Forgejo asked an agent for work. originId is
// "<issueKey>:<agentId>": one task per Forgejo issue or pull request and agent.
const REQUEST_ORIGIN = `plugin:${manifest.id}:request` as const;

// Paperclip refuses to wake an agent on an issue in these statuses.
const NOT_WAKEABLE: Issue["status"][] = ["backlog", "done", "cancelled"];

// Paperclip refuses to wake an agent in these statuses, and to assign work to some of them.
const AGENT_NOT_WAKEABLE: Agent["status"][] = ["paused", "pending_approval", "terminated"];

// Forgejo's header for each kind of submitted pull request review.
const REVIEW_EVENTS = ["pull_request_approved", "pull_request_rejected", "pull_request_comment"];

type ForgejoUser = { login: string };
type Thread = { number: number; title: string; body: string; html_url: string; assignees: ForgejoUser[] | null };

// The webhook payload fields read here. Forgejo sends issue, pull_request or both, depending on the event.
export type DeliveryPayload = {
  action: string;
  sender: ForgejoUser;
  repository: ForgejoRepositoryJson;
  issue?: Thread & { pull_request?: unknown };
  pull_request?: Thread;
  requested_reviewer?: ForgejoUser | null;
  comment?: { body: string; html_url: string };
  review?: { content: string };
};

// What a delivery may ask for. `asks` is "assigned" or "review" when someone was assigned or asked
// to review, which is a request only if that someone is the plugin's account, and "mention" when the
// request can only come from a mention in `text`.
type Request = { thread: Thread; isPull: boolean; asks: "assigned" | "review" | "mention"; text: string; link: string };

// Only new descriptions, comments and reviews count: adding a mention by editing does nothing.
function readRequest(event: string, payload: DeliveryPayload): Request | null {
  const { action, issue, pull_request: pull } = payload;
  if (event === "issues" && issue) {
    if (action === "assigned") return { thread: issue, isPull: false, asks: "assigned", text: "", link: issue.html_url };
    if (action === "opened") return { thread: issue, isPull: false, asks: "mention", text: issue.body, link: issue.html_url };
  }
  if (event === "pull_request" && pull) {
    if (action === "assigned") return { thread: pull, isPull: true, asks: "assigned", text: "", link: pull.html_url };
    if (action === "review_requested") return { thread: pull, isPull: true, asks: "review", text: "", link: pull.html_url };
    if (action === "opened") return { thread: pull, isPull: true, asks: "mention", text: pull.body, link: pull.html_url };
  }
  if (event === "issue_comment" && issue && payload.comment && action === "created") {
    return { thread: issue, isPull: Boolean(issue.pull_request), asks: "mention", text: payload.comment.body, link: payload.comment.html_url };
  }
  if (REVIEW_EVENTS.includes(event) && pull && payload.review && action === "reviewed") {
    return { thread: pull, isPull: true, asks: "mention", text: payload.review.content, link: pull.html_url };
  }
  return null;
}

// Whether the request is to the plugin's account, which stands for the project's lead agent.
function asksPluginAccount(request: Request, payload: DeliveryPayload, accounts: string[]) {
  if (request.asks === "assigned") return assigneesInclude(request.thread, accounts);
  if (request.asks === "review") return accounts.includes(payload.requested_reviewer?.login.toLowerCase() ?? "");
  return accounts.some((account) => mentions(request.text, account));
}

function assigneesInclude(thread: Thread, accounts: string[]) {
  return (thread.assignees ?? []).some((user) => accounts.includes(user.login.toLowerCase()));
}

// "@name" as a whole word, the way Forgejo and GitHub recognise mentions.
function mentions(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])@${escaped}(?![\\w-])`, "i").test(text);
}

// The lower-case logins of the plugin's Forgejo accounts: the main one and the reviewer, if set.
async function pluginAccounts(ctx: PluginContext, forgejo: Forgejo): Promise<string[]> {
  const tokens = forgejo.reviewToken ? [forgejo.token, forgejo.reviewToken] : [forgejo.token];
  const users = await Promise.all(tokens.map((token) => forgejoJson<ForgejoUser>(ctx, forgejo, "/user", { token })));
  return users.map((user) => user.login.toLowerCase());
}

// Starting agent work spends budget, so only people who can write to the repository may do it.
async function canStartWork(ctx: PluginContext, forgejo: Forgejo, repository: string, login: string) {
  try {
    const { permission } = await forgejoJson<{ permission: string }>(
      ctx,
      forgejo,
      `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return ["write", "admin", "owner"].includes(permission);
  } catch (error) {
    // Forgejo only tells repository admins what access other people have.
    if (error instanceof ForgejoError && error.status === 403) {
      throw new Error(`The access token's account must be an admin of ${repository} to check who may start agent work.`);
    }
    throw error;
  }
}

// When someone with write access assigns an issue or pull request to the plugin's account, asks it
// for a review or mentions it, the project's lead agent gets the work. Mentioning an agent by its
// URL key, as @url-key, gives the work to that agent.
export async function startRequestedWork(
  ctx: PluginContext,
  forgejo: Forgejo,
  companyId: string,
  event: string,
  payload: DeliveryPayload,
  deliveryId: string,
) {
  const request = readRequest(event, payload);
  // Most deliveries, and most comments, ask for nothing; returning first saves the lookups below.
  if (!request || (request.asks === "mention" && !request.text.includes("@"))) return;
  const accounts = await pluginAccounts(ctx, forgejo);
  // Ignoring the plugin's own accounts keeps an agent's comment from starting more agent work.
  if (accounts.includes(payload.sender.login.toLowerCase())) return;

  const leadAsked = asksPluginAccount(request, payload, accounts);
  const mentionedAgents = request.text ? (await ctx.agents.list({ companyId })).filter((agent) => mentions(request.text, agent.urlKey)) : [];
  if (!leadAsked && mentionedAgents.length === 0) return;

  const repository = payload.repository.full_name;
  const targets = await projectsUsing(ctx, companyId, [payload.repository]);
  if (targets.length === 0) return;
  if (!(await canStartWork(ctx, forgejo, repository, payload.sender.login))) {
    ctx.logger.info("Ignored a Forgejo request from someone without write access", { repository, sender: payload.sender.login });
    return;
  }

  const key = issueKey(repository, request.thread.number);
  // The project that imported this issue, or else the first project using the repository.
  let imported: Issue | undefined;
  let projectId = targets[0].projectId;
  for (const target of targets) {
    [imported] = await ctx.issues.list({ companyId, projectId: target.projectId, originKind: ISSUE_ORIGIN, originId: key });
    if (imported) {
      projectId = target.projectId;
      break;
    }
  }

  let agents = mentionedAgents;
  if (leadAsked) {
    const leadAgentId = (await ctx.projects.get(projectId, companyId))?.leadAgentId;
    const lead = leadAgentId ? await ctx.agents.get(leadAgentId, companyId) : null;
    if (lead) agents = [lead, ...mentionedAgents.filter((agent) => agent.id !== lead.id)];
    else ctx.logger.warn("A Forgejo request went to the project's lead agent, but the project has none", { projectId, key });
  }
  const skipped = agents.filter((agent) => AGENT_NOT_WAKEABLE.includes(agent.status));
  if (skipped.length > 0) {
    ctx.logger.info("Ignored a Forgejo request to agents that cannot be woken", { key, agents: skipped.map((agent) => `${agent.urlKey} (${agent.status})`) });
    agents = agents.filter((agent) => !skipped.includes(agent));
  }

  await oneAtATime(`request:${projectId}:${key}`, async () => {
    for (const agent of agents) {
      const task = await assignTask(ctx, companyId, projectId, key, request, agent.id, imported);
      if (task.originKind === ISSUE_ORIGIN) imported = task;
      // When issues are imported, the comment copy has already posted the comment on an imported
      // issue, so it is not quoted again.
      const quoted = request.text && !(task.originKind === ISSUE_ORIGIN && event === "issue_comment" && forgejo.syncIssues);
      await ctx.issues.createComment(task.id, requestNote(payload.sender.login, request, quoted ? request.text : ""), companyId);
      // Comments from the plugin do not wake anyone, so the agent is woken here.
      await ctx.issues.requestWakeup(task.id, companyId, { reason: "forgejo_request", idempotencyKey: `forgejo:${deliveryId}:${agent.id}` });
    }
  });
}

// The agent's task for this issue or pull request, assigned to it and ready to wake. An imported
// issue is the task of the agent assigned to it, or of the first agent asked if no agent or person
// is; any other agent gets its own task under it. Paperclip allows only one assignee per issue.
async function assignTask(
  ctx: PluginContext,
  companyId: string,
  projectId: string,
  key: string,
  request: Request,
  agentId: string,
  imported: Issue | undefined,
): Promise<Issue> {
  const ownTask = imported && (imported.assigneeAgentId === agentId || (!imported.assigneeAgentId && !imported.assigneeUserId));
  const [existing] = ownTask ? [imported] : await ctx.issues.list({ companyId, projectId, originKind: REQUEST_ORIGIN, originId: `${key}:${agentId}` });
  if (!existing) {
    const kind = request.isPull ? "pull request" : "issue";
    return ctx.issues.create({
      companyId,
      projectId,
      parentId: imported?.id,
      title: `Forgejo ${kind} #${request.thread.number}: ${request.thread.title}`,
      description: `Forgejo ${kind}: ${request.thread.html_url}\n\n${request.thread.body}`,
      status: "todo",
      assigneeAgentId: agentId,
      originKind: REQUEST_ORIGIN,
      originId: `${key}:${agentId}`,
    });
  }
  if (existing.assigneeAgentId === agentId && !NOT_WAKEABLE.includes(existing.status)) return existing;
  return ctx.issues.update(existing.id, { assigneeAgentId: agentId, ...(NOT_WAKEABLE.includes(existing.status) && { status: "todo" }) }, companyId);
}

function requestNote(sender: string, request: Request, quote: string) {
  const what = { assigned: "assigned this to you", review: "asked you for a review", mention: "mentioned you" }[request.asks];
  const note = `**${sender}** [${what} in Forgejo](${request.link}).`;
  return quote ? `${note}\n\n${quote.replace(/^/gm, "> ")}` : note;
}
