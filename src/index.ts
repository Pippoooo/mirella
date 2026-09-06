import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { App, type Octokit } from "octokit";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The two halves of mirella live in github.ts (issues, comments, PRs) and
// agent.ts (claude CLI spawning, git auth). Both run their own main() when
// imported, so they serve as reference implementations only — the glue below
// re-implements the pieces it needs, following their patterns.

export interface AgentRunResult {
  result: string;
  sessionId: string;
  isError: boolean;
}

export interface AgentRunParams {
  task: string;
  workdir: string; // must be the ONLY directory this process can see
  sessionId?: string; // pass the previous session_id to resume, omit to start fresh
  aiProviderEnv: Record<string, string>; // e.g. ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL
  mcpConfigPath?: string; // path to a claude --mcp-config JSON file
}

export function runAgent(params: AgentRunParams): Promise<AgentRunResult> {
  const args = [
    "-p",
    params.task,
    // No --cwd flag: the CLI doesn't have one; spawn()'s cwd option
    // already starts claude in the workdir.
    "--output-format",
    "json",
    // Only safe because workdir is an isolated container/mount with no
    // access to other issues' data and no unrestricted network egress.
    "--dangerously-skip-permissions",
  ];
  if (params.sessionId) args.push("--resume", params.sessionId);
  if (params.mcpConfigPath) args.push("--mcp-config", params.mcpConfigPath);

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      cwd: params.workdir,
      env: { ...process.env, ...params.aiProviderEnv },
      // Ignore stdin: claude -p waits up to 3s for piped input otherwise.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => process.stderr.write(chunk));

    proc.on("close", (code) => {
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          result: parsed.result,
          sessionId: parsed.session_id,
          isError: code !== 0 || parsed.is_error === true,
        });
      } catch {
        reject(new Error(`Could not parse claude output:\n${stdout}`));
      }
    });
  });
}

type Issue = Awaited<
  ReturnType<Octokit["rest"]["issues"]["listForRepo"]>
>["data"][number];

type IssueComment = Awaited<
  ReturnType<Octokit["rest"]["issues"]["listComments"]>
>["data"][number];

type PullRequest = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["list"]>
>["data"][number];

type Review = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["listReviews"]>
>["data"][number];

type ReviewComment = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["listReviewComments"]>
>["data"][number];

const AGENT_LABEL = "mirella-agent";
const WORKSPACE_ROOT = "/workspace";
// How often the orchestrator wakes up to check for new activity.
const POLL_INTERVAL_MS = 10_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function loadPrivateKey(): Promise<string> {
  // Preferred: read the PEM from a file (easy to mount into the container).
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    return readFile(path, "utf8");
  }

  // Fallback: inline PEM, with literal "\n" sequences turned back into newlines.
  const key = requireEnv("GITHUB_APP_PRIVATE_KEY");
  return key.replaceAll("\\n", "\n");
}

// Credential helper that feeds the GitHub App installation token to git over
// HTTPS. The token is only expanded at helper-execution time from the child
// env — it never lands in .git/config or on the command line.
const GIT_CREDENTIAL_HELPER =
  '!f() { echo "username=x-access-token"; echo "password=${MIRELLA_GIT_TOKEN}"; }; f';

function git(token: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "git",
      ["-c", `credential.helper=${GIT_CREDENTIAL_HELPER}`, ...args],
      {
        cwd,
        env: { ...process.env, MIRELLA_GIT_TOKEN: token },
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

function issuesWithAgentLabel(issues: Issue[]): Issue[] {
  return issues.filter(
    (issue) =>
      // GitHub returns PRs mixed into issue listings; PRs are handled
      // separately and must not match the agent-label filter.
      !issue.pull_request &&
      (issue.labels ?? []).some(
        (label) =>
          (typeof label === "string" ? label : label.name) === AGENT_LABEL,
      ),
  );
}

// The conversation the agent works from: issue body plus all comments, in the
// order they appear on GitHub.
function formatConversation(issue: Issue, comments: IssueComment[]): string {
  const lines = [
    `# Issue #${issue.number}: ${issue.title}`,
    "",
    issue.body ?? "(no body)",
    "",
    "## Comments",
  ];
  for (const comment of comments) {
    lines.push("", `### @${comment.user?.login}`, comment.body ?? "(no body)");
  }
  return lines.join("\n");
}

interface PrActivity {
  pr: PullRequest;
  comments: IssueComment[];
  reviews: Review[];
  reviewComments: ReviewComment[];
}

// Fetch everything the agent can only see through the PR: the PR conversation
// thread, review summaries, and inline review comments attached to lines.
// Returns undefined when the branch has no PR yet.
async function fetchPrActivity(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<PrActivity | undefined> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    // head filter format is "user:branch"
    head: `${owner}:${branch}`,
    state: "all",
    per_page: 100,
  });
  // Prefer the open PR; fall back to the first listed one so feedback on a
  // closed PR still reaches the agent.
  const pr = prs.find((p) => p.state === "open") ?? prs[0];
  if (!pr) {
    return undefined;
  }

  const [comments, reviews, reviewComments] = await Promise.all([
    // PR conversation comments live in the issues namespace.
    octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
      sort: "updated",
      direction: "asc",
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    }),
  ]);

  return { pr, comments, reviews, reviewComments };
}

// A COMMENTED review with no body is just the envelope around its inline
// comments (delivered separately) — nothing worth showing on its own.
function reviewWorthShowing(review: Review): boolean {
  return review.state !== "COMMENTED" || Boolean(review.body);
}

function formatReview(review: Review): string {
  return [
    `### @${review.user?.login} [${review.state}]`,
    review.body || "(no body)",
  ].join("\n");
}

function formatReviewComment(reviewComment: ReviewComment): string {
  const line = reviewComment.line ?? reviewComment.original_line ?? "?";
  return [
    `### @${reviewComment.user?.login} on ${reviewComment.path}, file line: ${line}`,
    reviewComment.body ?? "(no body)",
  ].join("\n");
}

// The full PR picture, as shown to an agent that has never seen this PR.
function formatPrActivity(activity: PrActivity): string {
  const lines = [
    "",
    "",
    `## Pull request #${activity.pr.number} (${activity.pr.state}): ${activity.pr.title}`,
    "",
    "### Comments",
  ];
  for (const comment of activity.comments) {
    lines.push("", `### @${comment.user?.login}`, comment.body ?? "(no body)");
  }
  const reviews = activity.reviews.filter(reviewWorthShowing);
  if (reviews.length > 0) {
    lines.push("", "### Reviews");
    for (const review of reviews) {
      lines.push("", formatReview(review));
    }
  }
  if (activity.reviewComments.length > 0) {
    lines.push("", "### Inline review comments");
    for (const reviewComment of activity.reviewComments) {
      lines.push("", formatReviewComment(reviewComment));
    }
  }
  return lines.join("\n");
}

interface IssueUpdate {
  conversation: string;
  hasNew: boolean;
  nextState: IssueState;
}

// Compute what the agent should be told this poll: everything on the first
// run for an issue, only the delta on later ones (the resumed session still
// remembers the rest). nextState records every id seen in this fetch —
// content that arrives mid-run lands in the next fetch, never lost.
function buildIssueUpdate(
  issue: Issue,
  comments: IssueComment[],
  prActivity: PrActivity | undefined,
  state: IssueState | undefined,
  botLogin: string,
): IssueUpdate {
  const seenComments = new Set(state?.seenCommentIds ?? []);
  const seenReviews = new Set(state?.seenReviewIds ?? []);
  const seenReviewComments = new Set(state?.seenReviewCommentIds ?? []);

  // Mirella's own comments (summaries, PR announcements) must never count as
  // new activity, or every poll would wake the agent up to its own output.
  const notFromMirella = (comment: IssueComment) =>
    comment.user?.login !== botLogin;

  const newIssueComments = comments.filter(
    (comment) => !seenComments.has(comment.id) && notFromMirella(comment),
  );
  const prComments = prActivity?.comments ?? [];
  const newPrComments = prComments.filter(
    (comment) => !seenComments.has(comment.id) && notFromMirella(comment),
  );
  const newReviews = (prActivity?.reviews ?? []).filter(
    (review) => !seenReviews.has(review.id),
  );
  const newReviewComments = (prActivity?.reviewComments ?? []).filter(
    (reviewComment) => !seenReviewComments.has(reviewComment.id),
  );
  const bodyChanged =
    state !== undefined &&
    state.issueBodyHash !== undefined &&
    state.issueBodyHash !== hashText(issue.body ?? "");

  const nextState: IssueState = {
    // Mark everything present in this fetch, bot comments included (they are
    // processed — deliberately ignored).
    seenCommentIds: [
      ...(state?.seenCommentIds ?? []),
      ...comments.map((c) => c.id),
      ...prComments.map((c) => c.id),
    ],
    seenReviewIds: [
      ...(state?.seenReviewIds ?? []),
      ...(prActivity?.reviews ?? []).map((r) => r.id),
    ],
    seenReviewCommentIds: [
      ...(state?.seenReviewCommentIds ?? []),
      ...(prActivity?.reviewComments ?? []).map((rc) => rc.id),
    ],
    issueBodyHash: hashText(issue.body ?? ""),
  };

  if (state === undefined) {
    // First run for this clone: the agent gets the complete conversation.
    return {
      conversation:
        formatConversation(issue, comments) +
        (prActivity ? formatPrActivity(prActivity) : ""),
      hasNew: true,
      nextState,
    };
  }

  const hasNew =
    newIssueComments.length > 0 ||
    newPrComments.length > 0 ||
    newReviews.length > 0 ||
    newReviewComments.length > 0 ||
    bodyChanged;
  if (!hasNew) {
    return { conversation: "", hasNew: false, nextState };
  }

  const lines = [`# Issue #${issue.number}: ${issue.title}`, ""];
  if (bodyChanged) {
    lines.push("## Issue body was updated", "", issue.body ?? "(no body)", "");
  }
  if (newIssueComments.length > 0) {
    lines.push("## New comments since your last run");
    for (const comment of newIssueComments) {
      lines.push(
        "",
        `### @${comment.user?.login}`,
        comment.body ?? "(no body)",
      );
    }
  }
  if (prActivity) {
    const prLines: string[] = [];
    if (newPrComments.length > 0) {
      prLines.push("", "### New comments");
      for (const comment of newPrComments) {
        lines.push(
          "",
          `### @${comment.user?.login}`,
          comment.body ?? "(no body)",
        );
      }
    }
    const reviews = newReviews.filter(reviewWorthShowing);
    if (reviews.length > 0) {
      prLines.push("", "### New reviews");
      for (const review of reviews) {
        prLines.push("", formatReview(review));
      }
    }
    if (newReviewComments.length > 0) {
      prLines.push("", "### New inline review comments");
      for (const reviewComment of newReviewComments) {
        prLines.push("", formatReviewComment(reviewComment));
      }
    }
    if (prLines.length > 0) {
      lines.push(
        "",
        `## Pull request #${prActivity.pr.number} (${prActivity.pr.state}): ${prActivity.pr.title}`,
        ...prLines,
      );
    }
  }
  return { conversation: lines.join("\n"), hasNew: true, nextState };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-issue memory of what the agent has already been shown. Lives in the
// clone's .git dir: restart-safe, never in git status, dies with the clone
// (a fresh clone means a fresh, fully-informed start). Since claude sessions
// persist across runs, re-sending old messages would only duplicate context
// the agent still remembers — so later runs deliver only the delta.
interface IssueState {
  sessionId?: string;
  seenCommentIds: number[]; // issue comments AND PR conversation comments
  seenReviewIds: number[];
  seenReviewCommentIds: number[];
  issueBodyHash?: string; // detects issue-body edits between polls
}

function stateFilePath(workdir: string): string {
  return join(workdir, ".git", "mirella", "state.json");
}

async function readIssueState(
  workdir: string,
): Promise<IssueState | undefined> {
  // Missing, unreadable, or corrupt → fresh start with the full conversation.
  return readFile(stateFilePath(workdir), "utf8")
    .then((raw) => JSON.parse(raw) as IssueState)
    .catch(() => undefined);
}

async function writeIssueState(
  workdir: string,
  state: IssueState,
): Promise<void> {
  // .git/mirella doesn't exist on a fresh clone — create it first.
  await mkdir(dirname(stateFilePath(workdir)), { recursive: true });
  await writeFile(stateFilePath(workdir), JSON.stringify(state, null, 2));
}

// Tiny FNV-1a — enough to notice that an issue body changed between polls.
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// Run claude, resuming the issue's previous session when there is one. If
// the saved session can no longer be resumed (e.g. it was pruned), fall back
// to a fresh session instead of failing the whole run.
async function runAgentOnIssue(
  params: Omit<AgentRunParams, "sessionId">,
  savedSessionId?: string,
): Promise<AgentRunResult> {
  try {
    return await runAgent({ ...params, sessionId: savedSessionId });
  } catch (err) {
    if (!savedSessionId) throw err;
    console.error(
      `Could not resume session ${savedSessionId} (${(err as Error).message}) — starting a fresh session.`,
    );
    return runAgent(params);
  }
}

// Prepare /workspace/issue-N: clone (or reuse), bake auth + commit identity
// into the clone's local git config so git processes the agent spawns on its
// own work too, and put it on the issue branch (resumed if it already exists
// on origin, otherwise started fresh from the base branch).
async function prepareIssueWorkdir(
  token: string,
  owner: string,
  repo: string,
  baseBranch: string,
  issueNumber: number,
): Promise<string> {
  const branch = `mirella/issue-${issueNumber}`;
  const workdir = join(WORKSPACE_ROOT, `issue-${issueNumber}`);
  await mkdir(workdir, { recursive: true });

  const alreadyCloned = await access(join(workdir, ".git")).then(
    () => true,
    () => false,
  );
  if (!alreadyCloned) {
    console.log(`Cloning ${owner}/${repo} into ${workdir}...`);
    await git(token, [
      "clone",
      `https://github.com/${owner}/${repo}.git`,
      workdir,
    ]);
  }

  await git(
    token,
    ["config", "--local", "credential.helper", GIT_CREDENTIAL_HELPER],
    workdir,
  );
  // `git commit` needs an identity or it refuses to run.
  await git(
    token,
    ["config", "--local", "user.name", "mirella-agent"],
    workdir,
  );
  await git(
    token,
    [
      "config",
      "--local",
      "user.email",
      "mirella-agent@users.noreply.github.com",
    ],
    workdir,
  );

  const remoteBranch = await git(
    token,
    ["ls-remote", "--heads", "origin", branch],
    workdir,
  );
  if (remoteBranch.trim() === "") {
    console.log(`Starting branch ${branch} from origin/${baseBranch}`);
    await git(
      token,
      ["checkout", "-B", branch, `origin/${baseBranch}`],
      workdir,
    );
  } else {
    console.log(`Resuming existing branch ${branch}`);
    await git(token, ["checkout", branch], workdir);
    await git(token, ["pull"], workdir);
  }

  return workdir;
}

// Write a throwaway --mcp-config file pointing at the vcs-tools MCP server
// (src/vsc-mcp.ts), which gives the agent real GitHub write access: comment
// on the issue, open/update PRs, add labels. Lives outside /workspace on
// purpose — it's agent plumbing, not part of the user's repo, and must never
// get swept up by an agent `git add -A`. tsx is resolved from the app's own
// node_modules with an absolute path: the agent's cwd is /workspace/issue-N,
// where `npx tsx` would not resolve and npx would try to download it from
// the registry.
//
// The per-issue context and the installation token ride along in the
// server's env. The token does land in this /tmp file — acceptable because
// the file is outside the repo (an agent `git add -A` can never pick it up),
// the token is short-lived, and the agent process can read its own
// environment anyway. Passing it explicitly also means the server does not
// depend on how claude inherits its environment.
async function writeMcpConfig(params: {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
  issueNumber: number;
  branch: string;
}): Promise<string> {
  const serverPath = join(__dirname, "vsc-mcp.ts");
  const tsxBin = join(__dirname, "..", "node_modules", ".bin", "tsx");
  const configPath = join(
    tmpdir(),
    `mcp-config-issue-${params.issueNumber}-${Date.now()}.json`,
  );
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        "vcs-tools": {
          command: tsxBin,
          args: [serverPath],
          env: {
            MIRELLA_GIT_TOKEN: params.token,
            GITHUB_OWNER: params.owner,
            GITHUB_REPO: params.repo,
            GITHUB_BASE_BRANCH: params.baseBranch,
            MIRELLA_ISSUE_NUMBER: String(params.issueNumber),
            MIRELLA_BRANCH: params.branch,
          },
        },
      },
    }),
  );
  return configPath;
}

interface PollDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
  baseBranch: string;
  aiProviderEnv: Record<string, string>;
  botLogin: string;
}

// One poll: read all open labeled issues and run the agent on the ones with
// new activity.
async function pollIssues(deps: PollDeps): Promise<void> {
  const { octokit, owner, repo, baseBranch } = deps;
  // Refresh the installation token every cycle — it expires after ~1h,
  // which a long-lived polling loop will outlive.
  const { token } = (await deps.octokit.auth({ type: "installation" })) as {
    token: string;
  };

  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  const agentIssues = issuesWithAgentLabel(issues);
  console.log(
    `\n=== Poll: ${agentIssues.length} open issue(s) labeled "${AGENT_LABEL}" (base branch: ${baseBranch}) ===`,
  );

  for (const issue of agentIssues) {
    try {
      await processIssue(deps, token, issue);
    } catch (err) {
      // One broken issue must not stall the others (or the polling loop).
      console.error(`Issue #${issue.number} failed:`, err);
    }
  }
}

async function processIssue(
  deps: PollDeps,
  token: string,
  issue: Issue,
): Promise<void> {
  const { octokit, owner, repo, baseBranch, aiProviderEnv, botLogin } = deps;
  const branch = `mirella/issue-${issue.number}`;
  console.log(`=== Issue #${issue.number}: ${issue.title} ===`);

  const workdir = await prepareIssueWorkdir(
    token,
    owner,
    repo,
    baseBranch,
    issue.number,
  );
  const state = await readIssueState(workdir);

  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issue.number,
    sort: "updated",
    direction: "asc",
    per_page: 100,
  });

  // Reviews and inline comments only exist on the PR, not on the issue —
  // fold them into the conversation so re-runs see reviewer feedback.
  const prActivity = await fetchPrActivity(octokit, owner, repo, branch);
  const update = buildIssueUpdate(issue, comments, prActivity, state, botLogin);

  if (!update.hasNew) {
    console.log("no new activity — skipping\n");
    return;
  }
  console.log(update.conversation);

  const mcpConfigPath = await writeMcpConfig({
    token,
    owner,
    repo,
    baseBranch,
    issueNumber: issue.number,
    branch,
  });
  const task = [
    update.conversation,
    "",
    "## Your job",
    `You are in a git clone of ${owner}/${repo}, already on branch ${branch}.`,
    "1. Implement the issue described above, taking every comment into account.",
    "2. Commit your work with a message that references the issue number.",
    `3. Push the branch to origin with: git push -u origin ${branch}`,
    "4. After pushing, use the vcs-tools MCP server's post_comment tool to post a short summary of the work you did.",
    "5. When the work is ready for review, open a PR with the vcs-tools create_pull_request tool — it announces the PR on this issue.",
  ].join("\n");

  console.log(`Spawning claude in ${workdir}...`);
  const result = await runAgentOnIssue(
    {
      task,
      workdir,
      aiProviderEnv: { ...aiProviderEnv, MIRELLA_GIT_TOKEN: token },
      mcpConfigPath,
    },
    state?.sessionId,
  );
  await writeIssueState(workdir, {
    ...update.nextState,
    sessionId: result.sessionId,
  });

  console.log(`\nsession: ${result.sessionId}`);
  console.log(`isError: ${result.isError}`);
  console.log(`result: ${result.result}\n`);
}

async function main(): Promise<void> {
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const baseBranch = requireEnv("GITHUB_BASE_BRANCH");

  const app = new App({
    appId: requireEnv("GITHUB_APP_ID"),
    privateKey: await loadPrivateKey(),
  });
  const octokit = await app.getInstallationOctokit(
    Number(requireEnv("GITHUB_INSTALLATION_ID")),
  );

  // Pass through every ANTHROPIC_* variable the container has (loaded from .env
  // by compose): API key, base URL, model override, etc.
  const aiProviderEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("ANTHROPIC_")),
  ) as Record<string, string>;

  if (Object.keys(aiProviderEnv).length === 0) {
    console.error(
      "Warning: no ANTHROPIC_* variables in the environment — claude will not be able to authenticate.",
    );
  }

  // The app's bot account, so mirella's own comments can be told apart from
  // human feedback. `GET /app` needs app-level auth (JWT), not the
  // installation token, so it goes through app.octokit.
  const { data: appInfo } = await app.octokit.rest.apps.getAuthenticated();
  if (!appInfo?.slug) {
    console.error(
      "Warning: could not determine the app's bot login — mirella's own comments will not be filtered from the conversation.",
    );
  }
  const botLogin = `${appInfo?.slug ?? "unknown"}[bot]`;

  console.log(
    `Watching ${owner}/${repo} as ${botLogin}, polling every ${POLL_INTERVAL_MS / 1000}s`,
  );

  const deps: PollDeps = {
    octokit,
    owner,
    repo,
    baseBranch,
    aiProviderEnv,
    botLogin,
  };
  while (true) {
    try {
      await pollIssues(deps);
    } catch (err) {
      // A failed poll (network, rate limit) must not kill the loop.
      console.error("Poll failed:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("Failed to run agent:", err);
  process.exit(1);
});
