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

type FakeReview = {
  id: number;
  login: string;
  event: string;
  body: string;
  commit_id: string;
  comments: { path: string; body: string; new_position: number; old_position: number }[];
};

export class FakeForgejo {
  issues = new Map<string, FakeIssue[]>();
  comments = new Map<string, string[]>(); // keyed "owner/repo#number"
  pullFiles = new Map<string, string[]>(); // keyed "owner/repo#number"
  pullDiffs = new Map<string, string>(); // keyed "owner/repo#number"
  reviews = new Map<string, FakeReview[]>(); // keyed "owner/repo#number"
  requests: { method: string; path: string; body: unknown; token?: string }[] = [];
  // The token of the account that opened every pull request, which Forgejo does not let approve them.
  // The harness resolves a secret reference to "resolved:<reference>".
  pullAuthorToken = "resolved:token-ref";
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
    const token = new Headers(init?.headers).get("Authorization")?.replace(/^token /, "");
    this.requests.push({ method, path, body, token });
    const overridden = this.override?.(path);
    if (overridden) return overridden;
    // List endpoints serve everything on page 1, so the plugin's paging stops on page 2.
    const page = Number(searchParams.get("page") ?? 1);

    const review = this.handleReview(path, method, body, token, page);
    if (review) return review;

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

  private reviewJson(review: FakeReview) {
    return {
      id: review.id,
      user: { login: review.login },
      state: review.event,
      body: review.body,
      commit_id: review.commit_id,
      stale: false,
      dismissed: false,
      official: true,
      comments_count: review.comments.length,
      submitted_at: "2026-10-01T00:00:00Z",
      html_url: `${BASE_URL}/review/${review.id}`,
    };
  }

  // A pull request's diff, and its reviews with their line comments.
  private handleReview(path: string, method: string, body: Omit<FakeReview, "id" | "login">, token: string | undefined, page: number) {
    const match = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\.diff|\/reviews)(?:\/(\d+)\/comments)?$/.exec(path);
    if (!match) return undefined;
    const [, repository, number, kind, reviewId] = match;
    const key = `${repository}#${number}`;
    if (kind === ".diff") return new Response(this.pullDiffs.get(key) ?? "", { headers: { "Content-Type": "text/plain" } });

    const reviews = this.reviews.get(key) ?? [];
    if (reviewId) {
      const review = reviews.find((candidate) => candidate.id === Number(reviewId))!;
      // Forgejo gives a line in the changed file as position, and a removed line as original_position.
      return Response.json(
        review.comments.map((comment) => ({
          path: comment.path,
          position: comment.new_position,
          original_position: comment.old_position,
          body: comment.body,
          user: { login: review.login },
          resolver: null,
        })),
      );
    }
    if (method === "POST") {
      const login = token === this.pullAuthorToken ? "someone" : "reviewer";
      if (login === "someone" && body.event === "APPROVED") {
        return Response.json({ message: "approve your own pull is not allowed" }, { status: 422 });
      }
      const review = { ...body, id: reviews.length + 1, login };
      this.reviews.set(key, [...reviews, review]);
      return Response.json(this.reviewJson(review));
    }
    return Response.json(page > 1 ? [] : reviews.map((review) => this.reviewJson(review)));
  }
}
