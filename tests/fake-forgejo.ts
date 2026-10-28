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

type FakeComment = { id: number; body: string; updatedAt: string };

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
  comments = new Map<string, FakeComment[]>(); // keyed "owner/repo#number"
  pullFiles = new Map<string, string[]>(); // keyed "owner/repo#number"
  pullDiffs = new Map<string, string>(); // keyed "owner/repo#number"
  reviews = new Map<string, FakeReview[]>(); // keyed "owner/repo#number"
  requests: { method: string; path: string; query: Record<string, string>; body: unknown; token?: string }[] = [];
  // The token of the account that opened every pull request, which Forgejo does not let approve them.
  // The harness resolves a secret reference to "resolved:<reference>".
  pullAuthorToken = "resolved:token-ref";
  // Each user's access to every repository, for the collaborator permission endpoint. Anyone not
  // listed can read. Set to "forbidden" to answer as Forgejo does when the token's account is not an admin.
  permissions = new Map<string, string>();
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

  // Comment IDs count up across the whole server, as in Forgejo.
  private nextCommentId = 100;
  addComment(repository: string, number: number, body: string) {
    const key = `${repository}#${number}`;
    this.comments.set(key, [...(this.comments.get(key) ?? []), { id: this.nextCommentId++, body, updatedAt: this.tick() }]);
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

  private commentJson(repository: string, number: number, comment: FakeComment) {
    const issue = this.issue(repository, number)!;
    const page = `${BASE_URL}/${repository}/${issue.isPull ? "pulls" : "issues"}/${number}`;
    return {
      id: comment.id,
      body: comment.body,
      html_url: `${page}#issuecomment-${comment.id}`,
      issue_url: issue.isPull ? "" : page,
      user: { login: "someone" },
      created_at: comment.updatedAt,
      updated_at: comment.updatedAt,
    };
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    if (this.unreachable) throw new TypeError("fetch failed");
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const token = new Headers(init?.headers).get("Authorization")?.replace(/^token /, "");
    this.requests.push({ method, path, query: Object.fromEntries(searchParams), body, token });
    const overridden = this.override?.(path);
    if (overridden) return overridden;
    // List endpoints serve everything on page 1, so the plugin's paging stops on page 2.
    const page = Number(searchParams.get("page") ?? 1);

    const review = this.handleReview(path, method, body, token, page);
    if (review) return review;

    // The main token belongs to the account that opens pull requests; any other token to the reviewer.
    if (path === "/user") return Response.json({ login: token === this.pullAuthorToken ? "someone" : "reviewer" });
    const permission = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/.exec(path);
    if (permission) {
      const access = this.permissions.get(permission[1]) ?? "read";
      if (access === "forbidden") return Response.json({ message: "forbidden" }, { status: 403 });
      return Response.json({ permission: access });
    }

    if (path === "/user/repos") return Response.json(page > 1 ? [] : [...this.issues.keys()].map((name) => this.repositoryJson(name)));

    const match = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)(?:\/(\d+))?(?:\/(merge|comments|files))?$/.exec(path);
    const issues = match && this.issues.get(match[1]);
    if (!match || !issues) return Response.json({ message: "not found" }, { status: 404 });
    const [, repository, kind, number, action] = match;
    const key = `${repository}#${number}`;

    // The repository's comments, those updated at or after since, with paging.
    if (action === "comments" && !number) {
      const since = searchParams.get("since");
      const all = [...this.comments].flatMap(([commentKey, comments]) => {
        const [commentRepository, commentNumber] = commentKey.split("#");
        if (commentRepository !== repository) return [];
        return comments.filter((comment) => !since || Date.parse(comment.updatedAt) >= Date.parse(since)).map((comment) => this.commentJson(repository, Number(commentNumber), comment));
      });
      return Response.json(page > 1 ? [] : all.sort((a, b) => a.id - b.id));
    }
    // Forgejo's comment list for one issue ignores paging and always returns every comment.
    if (action === "comments") return Response.json((this.comments.get(key) ?? []).map((comment) => this.commentJson(repository, Number(number), comment)));
    // Forgejo's file list answers null, not [], for a page past the end (routers/api/v1/repo/pull.go).
    if (action === "files") {
      const files = (this.pullFiles.get(key) ?? []).map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0 }));
      return Response.json(page > 1 || files.length === 0 ? null : files);
    }

    if (!number && kind === "pulls" && method === "POST") {
      const pull = { number: issues.length + 1, title: body.title, body: body.body, state: "open" as const, updatedAt: this.tick(), isPull: true };
      issues.push(pull);
      return Response.json(this.issueJson(repository, pull), { status: 201 });
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
