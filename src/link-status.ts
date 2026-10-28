import type {
  DetectExternalObjectsParams,
  DetectExternalObjectsResult,
  PluginContext,
  PluginExternalObjectResolveResult,
  PluginExternalObjectResolvedSnapshot,
  ResolveExternalObjectParams,
} from "@paperclipai/plugin-sdk";
import { configuredBaseUrl, connect, errorMessage, ForgejoError, forgejoJson, isRepositoryName, issueKey, parseIssueKey, type ForgejoIssueJson, type ForgejoPullRequestJson } from "./forgejo.js";

const PROVIDER_KEY = "forgejo";

type ObjectType = "issue" | "pull_request";
type ForgejoLink = { repository: string; number: number; objectType: ObjectType };

// Matches the same five minutes Paperclip uses for GitHub links.
const TTL_SECONDS = 300;

// Recognises <baseUrl>/<owner>/<repo>/issues/<n> and <baseUrl>/<owner>/<repo>/pulls/<n>, ignoring
// anything after the number such as "/files" or a comment anchor.
function parseForgejoLink(baseUrl: string, url: string): ForgejoLink | null {
  const prefix = `${baseUrl.toLowerCase()}/`;
  if (!url.toLowerCase().startsWith(prefix)) return null;
  const match = /^([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)(?:[/?#]|$)/.exec(url.slice(prefix.length));
  if (!match || !isRepositoryName(match[1])) return null;
  return { repository: match[1], number: Number(match[3]), objectType: match[2] === "pulls" ? "pull_request" : "issue" };
}

export async function detectObjects(ctx: PluginContext, params: DetectExternalObjectsParams): Promise<DetectExternalObjectsResult> {
  // Reads the address directly: connect() would also resolve the token secret, for every link.
  const baseUrl = configuredBaseUrl(await ctx.config.get(params.companyId));
  if (!baseUrl) return { detections: [] };

  const detections = params.urls.flatMap((candidate) => {
    const link = parseForgejoLink(baseUrl, candidate.sanitizedCanonicalUrl);
    if (!link) return [];
    return [
      {
        urlIdentityHash: candidate.canonicalIdentityHash,
        providerKey: PROVIDER_KEY,
        objectType: link.objectType,
        externalId: issueKey(link.repository, link.number),
        displayKey: `${link.repository}#${link.number}`,
        iconKey: link.objectType === "pull_request" ? "git-pull-request" : "circle-dot",
        confidence: "exact" as const,
      },
    ];
  });
  return { detections };
}

function issueSnapshot(issue: ForgejoIssueJson): PluginExternalObjectResolvedSnapshot {
  const open = issue.state === "open";
  return {
    displayTitle: issue.title,
    iconKey: "circle-dot",
    statusKey: issue.state,
    statusLabel: open ? "Open" : "Closed",
    statusIconKey: open ? "circle-dot" : "circle",
    statusCategory: open ? "open" : "closed",
    statusTone: open ? "info" : "muted",
    isTerminal: !open,
    ttlSeconds: TTL_SECONDS,
  };
}

function pullRequestSnapshot(pull: ForgejoPullRequestJson): PluginExternalObjectResolvedSnapshot {
  const base = { displayTitle: pull.title, iconKey: "git-pull-request", ttlSeconds: TTL_SECONDS };
  if (pull.merged) {
    return { ...base, statusKey: "merged", statusLabel: "Merged", statusIconKey: "git-merge", statusCategory: "succeeded", statusTone: "success", isTerminal: true };
  }
  if (pull.state === "closed") {
    return { ...base, statusKey: "closed", statusLabel: "Closed", statusIconKey: "x-circle", statusCategory: "closed", statusTone: "muted", isTerminal: true };
  }
  if (pull.draft) {
    return { ...base, statusKey: "draft", statusLabel: "Draft", statusIconKey: "git-pull-request", statusCategory: "waiting", statusTone: "warning", isTerminal: false };
  }
  return { ...base, statusKey: "open", statusLabel: "Open", statusIconKey: "git-pull-request", statusCategory: "open", statusTone: "info", isTerminal: false };
}

export async function resolveObject(ctx: PluginContext, params: ResolveExternalObjectParams): Promise<PluginExternalObjectResolveResult> {
  const forgejo = await connect(ctx, params.companyId);
  if (!forgejo) return { ok: false, liveness: "auth_required", errorCode: "not_configured", errorMessage: "The Forgejo plugin is not configured." };

  const { repository, number } = parseIssueKey(params.externalId);
  try {
    if (params.objectType === "pull_request") {
      const pull = await forgejoJson<ForgejoPullRequestJson>(ctx, forgejo, `/repos/${repository}/pulls/${number}`);
      return { ok: true, snapshot: pullRequestSnapshot(pull) };
    }
    const issue = await forgejoJson<ForgejoIssueJson>(ctx, forgejo, `/repos/${repository}/issues/${number}`);
    return { ok: true, snapshot: issueSnapshot(issue) };
  } catch (error) {
    // Forgejo answers 404 both for deleted items and for private ones the token cannot see.
    if (error instanceof ForgejoError && error.status === 404) {
      return {
        ok: true,
        snapshot: { statusKey: "not_found", statusLabel: "Not found", statusIconKey: "archive", statusCategory: "archived", statusTone: "muted", isTerminal: true, ttlSeconds: TTL_SECONDS },
      };
    }
    const message = errorMessage(error);
    if (error instanceof ForgejoError && (error.status === 401 || error.status === 403)) {
      return { ok: false, liveness: "auth_required", errorCode: `http_${error.status}`, errorMessage: message };
    }
    return { ok: false, liveness: "unreachable", errorCode: "unreachable", errorMessage: message };
  }
}
