import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Forgejo } from "./forgejo.js";

const run = promisify(execFile);

// Paperclip gives a tool call 30 seconds. Stopping git sooner lets the agent see why the push failed,
// rather than Paperclip's timeout.
const TIME_LIMIT_MS = 25_000;

// Pushes the one branch in a git bundle to Forgejo, using the plugin's token, so agents push without
// ever holding it. The bundle holds only commits Forgejo lacks, so git first fetches the repository's
// history without file contents, which the bundle's commits build on.
export async function pushBundle(forgejo: Forgejo, login: string, repository: string, branch: string, bundle: Buffer): Promise<string> {
  const { baseUrl, token } = forgejo;
  const dir = await mkdtemp(join(tmpdir(), "forgejo-push-"));
  const signal = AbortSignal.timeout(TIME_LIMIT_MS);
  const remote = `${baseUrl}/${repository}.git`;
  const env = {
    PATH: process.env.PATH,
    // Paperclip starts plugin workers without HOME, and git should not read anyone's settings anyway.
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // In the environment rather than the arguments, so the token stays out of git's error messages.
    // Sent only to the Forgejo address.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${baseUrl}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${login}:${token}`).toString("base64")}`,
  };
  const git = async (...args: string[]) => {
    try {
      return (await run("git", args, { cwd: dir, env, signal })).stdout.trim();
    } catch (error) {
      if (signal.aborted) throw new Error(`Pushing took longer than ${TIME_LIMIT_MS / 1000} seconds, so it was stopped.`);
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`git ${args[0]} failed: ${stderr || (error as Error).message}`);
    }
  };

  try {
    await git("check-ref-format", `refs/heads/${branch}`).catch(() => {
      throw new Error(`"${branch}" is not a valid branch name.`);
    });
    await writeFile(join(dir, "push.bundle"), bundle);
    await git("clone", "--quiet", "--bare", "--filter=blob:none", remote, "repo");
    const heads = (await git("-C", "repo", "bundle", "list-heads", "../push.bundle")).split("\n").filter(Boolean);
    if (heads.length !== 1) throw new Error(`The bundle must hold exactly one branch; it holds ${heads.length}.`);
    const [commit, ref] = heads[0].split(" ");
    // Checks that Forgejo has every commit the bundle builds on, and adds the bundle's commits.
    await git("-C", "repo", "fetch", "--quiet", "../push.bundle", ref);
    // Not a force push, so git refuses to replace commits already on the branch.
    await git("-C", "repo", "push", "--quiet", remote, `${commit}:refs/heads/${branch}`);
    return commit;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
