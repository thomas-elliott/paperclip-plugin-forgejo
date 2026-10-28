import { vi } from "vitest";

// An in-memory Forgejo serving the API routes the plugin uses, installed as the global fetch
// (the test harness passes ctx.http.fetch straight to it). Shapes follow Forgejo's API, cut down
// to the fields the plugin reads.

export const BASE_URL = "https://git.example.com";

type FakeIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  updatedAt: string;
  isPull?: boolean;
  merged?: boolean;
  draft?: boolean;
};

export class FakeForgejo {
  issues = new Map<string, FakeIssue[]>();
  comments = new Map<string, string[]>(); // keyed "owner/repo#number"
  pullFiles = new Map<string, string[]>(); // keyed "owner/repo#number"
  requests: { method: string; path: string; body: unknown }[] = [];
  // While true, every request fails the way ctx.http.fetch fails when the server cannot be reached.
  unreachable = false;
  // Repositories whose issue list answers HTTP 500.
  broken = new Set<string>();
  // Forgejo can serve SSH under another host name than its web address.
  sshHost = "git.example.com";
  // Answers a request instead of the fake, when it returns a response; for proxies and odd errors.
  override?: (path: string) => Response | undefined;

  constructor(repositories: string[]) {
    for (const name of repositories) this.issues.set(name, []);
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => this.handle(url, init)));
  }

  addIssue(repository: string, issue: Partial<FakeIssue> & { number: number }) {
    this.issues.get(repository)!.push({ title: `Issue ${issue.number}`, body: "", state: "open", updatedAt: "2026-10-01T00:00:00Z", ...issue });
  }

  issue(repository: string, number: number) {
    return this.issues.get(repository)!.find((issue) => issue.number === number);
  }

  // A clock that moves forward one second per change, so no two changes share a timestamp.
  private clock = Date.parse("2026-10-02T00:00:00Z");
  private tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  // Changes an issue the way a person editing it in Forgejo would, which moves its updated_at.
  edit(repository: string, number: number, change: Partial<FakeIssue>) {
    Object.assign(this.issue(repository, number)!, change, { updatedAt: this.tick() });
  }

  repositoryJson(name: string) {
    return {
      full_name: name,
      clone_url: `${BASE_URL}/${name}.git`,
      ssh_url: `git@${this.sshHost}:${name}.git`,
      html_url: `${BASE_URL}/${name}`,
      private: false,
      default_branch: "main",
    };
  }

  private issueJson(repository: string, issue: FakeIssue) {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      html_url: `${BASE_URL}/${repository}/${issue.isPull ? "pulls" : "issues"}/${issue.number}`,
      user: { login: "someone" },
      labels: [],
      assignees: null,
      pull_request: issue.isPull ? { merged: Boolean(issue.merged) } : null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: issue.updatedAt,
      ...(issue.isPull && {
        draft: Boolean(issue.draft),
        merged: Boolean(issue.merged),
        mergeable: true,
        head: { label: "feature", ref: "feature", sha: "abc123" },
        base: { label: "main", ref: "main" },
      }),
    };
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    if (this.unreachable) throw new TypeError("fetch failed");
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path, body });
    const overridden = this.override?.(path);
    if (overridden) return overridden;
    // List endpoints serve everything on page 1, so the plugin's paging stops on page 2.
    const page = Number(searchParams.get("page") ?? 1);

    if (path === "/user/repos") return Response.json(page > 1 ? [] : [...this.issues.keys()].map((name) => this.repositoryJson(name)));

    const match = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)(?:\/(\d+))?(?:\/(merge|comments|files))?$/.exec(path);
    const issues = match && this.issues.get(match[1]);
    if (!match || !issues) return Response.json({ message: "not found" }, { status: 404 });
    const [, repository, kind, number, action] = match;
    const key = `${repository}#${number}`;

    // Forgejo's comment list ignores paging and always returns every comment.
    if (action === "comments") return Response.json((this.comments.get(key) ?? []).map((body, id) => ({ id, body, user: { login: "someone" }, created_at: "2026-10-01T00:00:00Z" })));
    // Forgejo's file list answers null, not [], for a page past the end (routers/api/v1/repo/pull.go).
    if (action === "files") {
      const files = (this.pullFiles.get(key) ?? []).map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0 }));
      return Response.json(page > 1 || files.length === 0 ? null : files);
    }

    if (!number) {
      if (this.broken.has(repository)) return Response.json({ message: "broken" }, { status: 500 });
      const state = searchParams.get("state");
      const listed = issues.filter((issue) => !issue.isPull && (state === "all" || issue.state === state));
      return Response.json(page > 1 ? [] : listed.map((issue) => this.issueJson(repository, issue)));
    }

    const issue = issues.find((candidate) => candidate.number === Number(number) && (kind === "issues" || candidate.isPull));
    if (!issue) return Response.json({ message: "not found" }, { status: 404 });
    if (action === "merge") {
      issue.merged = true;
      issue.state = "closed";
      return new Response(null, { status: 200 });
    }
    if (method === "PATCH") Object.assign(issue, body, { updatedAt: this.tick() });
    return Response.json(this.issueJson(repository, issue));
  }
}
