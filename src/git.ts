// Generic git plumbing for the per-issue workspace layout: one canonical
// clone at <workspaceRoot>/main plus one worktree per issue off of it.
// Credentials are passed in as data ({username, password}) — the caller gets
// them from its VCS provider, so nothing provider-specific lives here. The
// password only travels through the child process's environment and a
// credential helper expanded at git-execution time; it never lands in
// .git/config or on a command line.

import { spawn } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "./config.js";
import { ENV } from "./env.js";
import { createLogger } from "./logger.js";

const log = createLogger("git");

export interface GitCredentials {
  username: string;
  password: string;
}

// The env var credential helpers expand the password from — both the
// per-invocation helper below and the one baked into the main clone's local
// config (which is what git processes the agent spawns on its own use).
// The name lives in env.ts, the single env-name registry.
function credentialHelper(username: string): string {
  return `!f() { echo "username=${username}"; echo "password=\${${ENV.gitToken}}"; }; f`;
}

export function git(
  args: string[],
  opts: { cwd?: string; credentials?: GitCredentials } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.credentials) {
      env[ENV.gitToken] = opts.credentials.password;
    }
    const proc = spawn(
      "git",
      opts.credentials
        ? [
            "-c",
            `credential.helper=${credentialHelper(opts.credentials.username)}`,
            ...args,
          ]
        : args,
      {
        cwd: opts.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(`git ${args.join(" ")} failed (exit ${code}):\n${stderr}`),
        );
      }
    });
  });
}

// All issue worktrees hang off this single clone: one fetch, one object
// store, shared by every issue branch. Only this clone is ever fetched from
// directly; everything else is a `git worktree add` off of it.
const MAIN_REPO_PATH = join(WORKSPACE_ROOT, "main");

// Per-issue container layout: /workspace/agent-<N> is the agent's own
// directory — scratch space for anything it wants or needs to write, plus
// the conversation.json mirella keeps current and the state file the issue
// store keeps — and the repo worktree lives inside it at issue-<N>.
export function agentDirPath(issueNumber: number): string {
  return join(WORKSPACE_ROOT, `agent-${issueNumber}`);
}

export function issueWorkdirPath(issueNumber: number): string {
  return join(agentDirPath(issueNumber), `issue-${issueNumber}`);
}

// The branch the agent works on for one issue. Named once here — the
// orchestrator uses it for activity lookups and payloads, the worktree
// layout below for checkout.
export function issueBranchName(issueNumber: number): string {
  return `mirella/issue-${issueNumber}`;
}

// Clone the canonical repo once (it persists on the mounted volume across
// restarts) and keep it fetched. Identity, credential helper, and the
// commit-msg hook are configured here, once — worktrees share the same .git
// directory, so every one of them inherits these automatically. Setting them
// per-worktree (as the old per-issue clone did) would be redundant now.
export async function prepareMainRepo(
  credentials: GitCredentials,
  remoteUrl: string,
  identity: { email: string } = {
    email: "mirella-agent@users.noreply.github.com",
  },
): Promise<void> {
  const alreadyCloned = await access(join(MAIN_REPO_PATH, ".git")).then(
    () => true,
    () => false,
  );

  if (!alreadyCloned) {
    log.info(`Cloning ${remoteUrl} into ${MAIN_REPO_PATH}...`);
    await mkdir(WORKSPACE_ROOT, { recursive: true });
    await git(["clone", remoteUrl, MAIN_REPO_PATH], { credentials });

    await git(
      [
        "config",
        "--local",
        "credential.helper",
        credentialHelper(credentials.username),
      ],
      { cwd: MAIN_REPO_PATH, credentials },
    );
    // `git commit` needs an identity or it refuses to run.
    await git(["config", "--local", "user.name", "mirella-agent"], {
      cwd: MAIN_REPO_PATH,
      credentials,
    });
    await git(["config", "--local", "user.email", identity.email], {
      cwd: MAIN_REPO_PATH,
      credentials,
    });

    // Belt and braces against Claude Code's own commit attribution: the
    // harness setting baked into the image already stops the trailer, but the
    // model can still write one itself. Every commit message passes through
    // this hook, which strips the Co-Authored-By trailer and any generated
    // footer — commits are authored by the mirella agent identity alone.
    // Lives in the shared hooks dir, so it fires for every worktree
    // automatically. (Harness-specific policy living in git plumbing for
    // now — worth threading through the harness boundary if a second
    // harness ever needs different attribution rules.)
    const commitMsgHook = join(MAIN_REPO_PATH, ".git", "hooks", "commit-msg");
    await writeFile(
      commitMsgHook,
      [
        "#!/bin/sh",
        "# Mirella: commits are authored by the mirella agent identity alone —",
        "# strip Claude attribution the agent's tooling may have added.",
        'sed -i \'/co-authored-by:.*claude/Id; /generated with.*claude/Id\' "$1"',
      ].join("\n"),
    );
    await chmod(commitMsgHook, 0o755);
  }

  // Keep origin/<base> (and every origin/mirella/issue-* ref) fresh before
  // cutting or reusing any worktree from it — cheap enough to run every poll.
  await git(["fetch", "origin"], { cwd: MAIN_REPO_PATH, credentials });

  // Drops administrative entries for worktrees whose directory disappeared
  // (e.g. a partially-cleared /workspace volume). Without this, re-adding a
  // worktree at the same branch fails with "already checked out at <path>".
  await git(["worktree", "prune"], { cwd: MAIN_REPO_PATH, credentials });
}

// Prepare /workspace/agent-N/issue-N as a worktree off the single shared
// clone at MAIN_REPO_PATH — not a clone of its own. This is what makes
// per-issue directories cheap: no re-fetch of the whole repo, no
// re-download of objects already known, and — once tooling is installed at
// the container level — no re-installing dependencies from scratch either.
// The worktree is put on the issue branch (attached if it already exists on
// the remote, otherwise started fresh from the base branch).
export async function prepareIssueWorkdir(opts: {
  credentials: GitCredentials;
  remoteUrl: string;
  baseBranch: string;
  issueNumber: number;
}): Promise<string> {
  const { credentials, remoteUrl, baseBranch, issueNumber } = opts;
  const branch = issueBranchName(issueNumber);
  const workdir = issueWorkdirPath(issueNumber);

  await prepareMainRepo(credentials, remoteUrl);

  const worktreeExists = await access(join(workdir, ".git")).then(
    () => true,
    () => false,
  );

  const remoteBranch = await git(["ls-remote", "--heads", "origin", branch], {
    cwd: MAIN_REPO_PATH,
    credentials,
  });
  const branchExistsOnRemote = remoteBranch.trim() !== "";

  if (!worktreeExists) {
    await mkdir(agentDirPath(issueNumber), { recursive: true });

    if (!branchExistsOnRemote) {
      log.info(`Starting branch ${branch} from origin/${baseBranch}`);
      await git(
        ["worktree", "add", "-B", branch, workdir, `origin/${baseBranch}`],
        { cwd: MAIN_REPO_PATH, credentials },
      );
    } else {
      // No explicit start-point: git's checkout DWIM finds the sole
      // matching origin/<branch> and tracks it automatically, same as
      // `git checkout <branch>` would for a plain clone.
      log.info(`Attaching worktree to existing branch ${branch}`);
      await git(["worktree", "add", workdir, branch], {
        cwd: MAIN_REPO_PATH,
        credentials,
      });
    }
  } else if (branchExistsOnRemote) {
    log.info(`Worktree for ${branch} already present — pulling latest`);
    await git(["pull"], { cwd: workdir, credentials });
  }

  return workdir;
}