import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A git server over HTTP, as Forgejo serves repositories, through git's own http-backend. It accepts
// only Basic authentication with the given user and token, as Forgejo accepts an access token.
export class GitServer {
  readonly root = mkdtempSync(join(tmpdir(), "git-server-"));
  private server?: Server;
  url = "";

  constructor(
    private login: string,
    private token: string,
  ) {}

  async start() {
    this.server = createServer((request, response) => {
      const expected = `Basic ${Buffer.from(`${this.login}:${this.token}`).toString("base64")}`;
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Forgejo"' }).end();
        return;
      }
      const url = new URL(request.url!, "http://localhost");
      const backend = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: this.root,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: this.login,
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
          GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        },
      });
      request.pipe(backend.stdin);
      // http-backend answers as a CGI script: headers, a blank line, then the body.
      let head = Buffer.alloc(0);
      let headDone = false;
      backend.stdout.on("data", (chunk: Buffer) => {
        if (headDone) return void response.write(chunk);
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        headDone = true;
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.subarray(0, end).toString().split("\r\n")) {
          const [name, ...value] = line.split(": ");
          if (name.toLowerCase() === "status") status = Number(value.join(": ").split(" ")[0]);
          else headers[name] = value.join(": ");
        }
        response.writeHead(status, headers);
        response.write(head.subarray(end + 4));
      });
      backend.stdout.on("end", () => response.end());
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  // A repository whose main branch has one commit, served with partial clones allowed, as Forgejo does.
  createRepository(name: string) {
    const path = join(this.root, `${name}.git`);
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", path]);
    execFileSync("git", ["-C", path, "config", "uploadpack.allowFilter", "true"]);
    const work = mkdtempSync(join(tmpdir(), "git-work-"));
    git(work, "init", "--quiet", "--initial-branch=main");
    commitFile(work, "README.md", "hello\n");
    git(work, "push", "--quiet", path, "main");
    return work;
  }

  // The commit a branch points at, or null when the repository has no such branch.
  branchCommit(name: string, branch: string): string | null {
    try {
      return git(join(this.root, `${name}.git`), "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    } catch {
      return null;
    }
  }

  async stop() {
    await new Promise((resolve) => this.server?.close(resolve));
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", ...args]).toString().trim();
}

export function commitFile(dir: string, file: string, content: string) {
  execFileSync("sh", ["-c", `printf '%s' "$1" > "$2"`, "sh", content, join(dir, file)]);
  git(dir, "add", file);
  git(dir, "commit", "--quiet", "-m", `Change ${file}`);
  return git(dir, "rev-parse", "HEAD");
}
