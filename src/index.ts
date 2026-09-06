import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

// One message for the agent. There is no per-item channel field: an item's
// place in the payload IS its channel (issue thread vs pull request), which
// is what routes replies to the right post_* tool. The schema is documented
// for the agent in CLAUDE.md.
interface CommentItem {
  id: number;
  author: string;
  body: string;
}

interface ReviewItem extends CommentItem {
  state: string; // APPROVED / CHANGES_REQUESTED / COMMENTED
}

interface ReviewCommentItem extends CommentItem {
  path: string;
  line: number | null; // null once the comment is outdated and unanchored
}

// The structured work order handed to the agent on each wake-up: where it
// works, the issue it implements, the PR (if any), and the messages to
// process, grouped by channel — everything on a first run, only the delta on
// later ones. Empty sections are simply left out of the JSON (undefined keys
// vanish on stringify).
interface AgentPayload {
  repo: { owner: string; name: string };
  branch: string;
  baseBranch: string;
  // The agent's own directory (its scratch space; mirella also keeps the
  // whole conversation there as conversation.json). Documented in CLAUDE.md.
  agentDir: string;
  issue: {
    number: number;
    title: string;
    // Present on the first run and again whenever the body changed since; a
    // continuation that already knows the body gets neither field.
    body?: string;
    bodyUpdated?: boolean;
  };
  pr?: { number: number; title: string; state: string };
  activity: {
    issue?: { comments: CommentItem[] };
    pr?: {
      comments?: CommentItem[];
      reviews?: ReviewItem[];
      reviewComments?: ReviewCommentItem[];
    };
  };
}

function toCommentItems(comments: IssueComment[]): CommentItem[] {
  return comments.map((comment) => ({
    id: comment.id,
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
  }));
}

function toReviewItems(reviews: Review[]): ReviewItem[] {
  return reviews.filter(reviewWorthShowing).map((review) => ({
    id: review.id,
    author: review.user?.login ?? "unknown",
    state: review.state,
    body: review.body ?? "",
  }));
}

function toReviewCommentItems(
  reviewComments: ReviewComment[],
): ReviewCommentItem[] {
  return reviewComments.map((reviewComment) => ({
    id: reviewComment.id,
    author: reviewComment.user?.login ?? "unknown",
    path: reviewComment.path,
    // null once the comment is outdated and no longer anchored to a line
    line: reviewComment.line ?? reviewComment.original_line ?? null,
    body: reviewComment.body ?? "",
  }));
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

interface TaskContext {
  owner: string;
  repo: string;
  baseBranch: string;
  branch: string;
  agentDir: string;
}

// Sections without content are left undefined so they vanish from the JSON
// instead of arriving as empty noise.
function groupActivity(
  issueComments: CommentItem[],
  prComments: CommentItem[],
  reviews: ReviewItem[],
  reviewComments: ReviewCommentItem[],
): AgentPayload["activity"] {
  return {
    issue: issueComments.length > 0 ? { comments: issueComments } : undefined,
    pr:
      prComments.length > 0 || reviews.length > 0 || reviewComments.length > 0
        ? {
            comments: prComments.length > 0 ? prComments : undefined,
            reviews: reviews.length > 0 ? reviews : undefined,
            reviewComments:
              reviewComments.length > 0 ? reviewComments : undefined,
          }
        : undefined,
  };
}

// Assemble a payload: per-run context (repo, branches, agent dir), the
// issue, the PR, and the activity to process. `body` is omitted when the
// agent already knows it (delta runs on an unchanged body).
function buildPayload(
  ctx: TaskContext,
  issue: Issue,
  prActivity: PrActivity | undefined,
  activity: AgentPayload["activity"],
  body?: string,
  bodyUpdated?: boolean,
): AgentPayload {
  return {
    repo: { owner: ctx.owner, name: ctx.repo },
    branch: ctx.branch,
    baseBranch: ctx.baseBranch,
    agentDir: ctx.agentDir,
    issue: {
      number: issue.number,
      title: issue.title,
      ...(body !== undefined ? { body } : {}),
      ...(bodyUpdated ? { bodyUpdated: true } : {}),
    },
    pr: prActivity
      ? {
          number: prActivity.pr.number,
          title: prActivity.pr.title,
          state: prActivity.pr.state,
        }
      : undefined,
    activity,
  };
}

interface IssueUpdate {
  // What the agent is woken with: the whole picture on the first run, only
  // the delta afterwards.
  payload: AgentPayload;
  // The whole conversation — issue with its current body, PR, and every
  // message so far — saved into agentDir on every wake-up so the agent can
  // always consult the full picture.
  conversation: AgentPayload;
  hasNew: boolean;
  nextState: IssueState;
}

// Compute the agent's work order for this poll: everything on the first run
// for an issue, only the delta on later ones (the resumed session still
// remembers the rest). nextState records every id seen in this fetch —
// content that arrives mid-run lands in the next fetch, never lost.
function buildIssueUpdate(
  issue: Issue,
  comments: IssueComment[],
  prActivity: PrActivity | undefined,
  state: IssueState | undefined,
  botLogin: string,
  ctx: TaskContext,
): IssueUpdate {
  const seenComments = new Set(state?.seenCommentIds ?? []);
  const seenReviews = new Set(state?.seenReviewIds ?? []);
  const seenReviewComments = new Set(state?.seenReviewCommentIds ?? []);
  const fresh = state === undefined;

  // Mirella's own comments (summaries, PR announcements) must never count as
  // new activity, or every poll would wake the agent up to its own output.
  const notFromMirella = (comment: IssueComment) =>
    comment.user?.login !== botLogin;

  const prComments = prActivity?.comments ?? [];
  const newIssueComments = comments.filter(
    (comment) => !seenComments.has(comment.id) && notFromMirella(comment),
  );
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
    !fresh &&
    state?.issueBodyHash !== undefined &&
    state.issueBodyHash !== hashText(issue.body ?? "");

  const newIssueCommentItems = toCommentItems(newIssueComments);
  const newPrCommentItems = toCommentItems(newPrComments);
  const newReviewItems = toReviewItems(newReviews);
  const newReviewCommentItems = toReviewCommentItems(newReviewComments);
  const allIssueCommentItems = toCommentItems(comments);
  const allPrCommentItems = toCommentItems(prComments);
  const allReviewItems = toReviewItems(prActivity?.reviews ?? []);
  const allReviewCommentItems = toReviewCommentItems(
    prActivity?.reviewComments ?? [],
  );

  // A delta with nothing in it means no wake-up: everything here was either
  // already seen or written by mirella.
  const hasNew =
    fresh ||
    bodyChanged ||
    newIssueCommentItems.length > 0 ||
    newPrCommentItems.length > 0 ||
    newReviewItems.length > 0 ||
    newReviewCommentItems.length > 0;

  // The wake-up payload: the whole picture on a first run, only the delta on
  // later ones (the resumed session still remembers the rest).
  const payload = fresh
    ? buildPayload(
        ctx,
        issue,
        prActivity,
        groupActivity(
          allIssueCommentItems,
          allPrCommentItems,
          allReviewItems,
          allReviewCommentItems,
        ),
        issue.body ?? "",
      )
    : buildPayload(
        ctx,
        issue,
        prActivity,
        groupActivity(
          newIssueCommentItems,
          newPrCommentItems,
          newReviewItems,
          newReviewCommentItems,
        ),
        // Later runs: the body travels with the payload only when it
        // changed, flagged so the agent knows to re-read it.
        bodyChanged ? (issue.body ?? "") : undefined,
        bodyChanged ? true : undefined,
      );

  // The whole conversation, always complete: current body, PR, and every
  // message so far.
  const conversation = fresh
    ? payload
    : buildPayload(
        ctx,
        issue,
        prActivity,
        groupActivity(
          allIssueCommentItems,
          allPrCommentItems,
          allReviewItems,
          allReviewCommentItems,
        ),
        issue.body ?? "",
      );

  const nextState: IssueState = {
    // Mark everything present in this fetch, bot comments included (they are
    // seen — deliberately ignored).
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

  return { payload, conversation, hasNew, nextState };
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

// Per-issue container layout: /workspace/agent-<N> is the agent's own
// directory — scratch space for anything it wants or needs to write, plus
// the conversation.json mirella keeps current — and the repo clone lives
// inside it at issue-<N>.
function agentDirPath(issueNumber: number): string {
  return join(WORKSPACE_ROOT, `agent-${issueNumber}`);
}

function issueWorkdirPath(issueNumber: number): string {
  return join(agentDirPath(issueNumber), `issue-${issueNumber}`);
}

// Prepare /workspace/agent-N/issue-N: clone (or reuse), bake auth + commit
// identity into the clone's local git config so git processes the agent
// spawns on its own work too, and put it on the issue branch (resumed if it
// already exists on origin, otherwise started fresh from the base branch).
async function prepareIssueWorkdir(
  token: string,
  owner: string,
  repo: string,
  baseBranch: string,
  issueNumber: number,
): Promise<string> {
  const branch = `mirella/issue-${issueNumber}`;
  const workdir = issueWorkdirPath(issueNumber);
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

  // Belt and braces against Claude Code's own commit attribution: the
  // harness setting baked into the image already stops the trailer, but the
  // model can still write one itself. Every commit message passes through
  // this hook, which strips the Co-Authored-By trailer and any generated
  // footer — commits are authored by the mirella agent identity alone.
  const commitMsgHook = join(workdir, ".git", "hooks", "commit-msg");
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
// node_modules with an absolute path: the agent's cwd is the clone
// (/workspace/agent-<N>/issue-<N>), where `npx tsx` would not resolve and
// npx would try to download it from the registry.
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
  // fold them into the payload so re-runs see reviewer feedback.
  const prActivity = await fetchPrActivity(octokit, owner, repo, branch);
  const agentDir = agentDirPath(issue.number);
  const update = buildIssueUpdate(
    issue,
    comments,
    prActivity,
    state,
    botLogin,
    {
      owner,
      repo,
      baseBranch,
      branch,
      agentDir,
    },
  );

  if (!update.hasNew) {
    console.log("no new activity — skipping\n");
    return;
  }

  // Keep the whole conversation where the agent can always consult it: its
  // own directory, outside the clone so git can never pick it up. Written
  // on every wake-up — the file only matters when the agent runs, and this
  // is exactly when its content changed.
  await writeFile(
    join(agentDir, "conversation.json"),
    JSON.stringify(update.conversation, null, 2),
  );

  const mcpConfigPath = await writeMcpConfig({
    token,
    owner,
    repo,
    baseBranch,
    issueNumber: issue.number,
    branch,
  });
  // The task is a pure JSON work order — repo/branch, issue, PR, and the
  // messages to process, with no instructions baked in (every operating rule
  // lives in CLAUDE.md, which is baked into the agent image and read on
  // every run).
  const task = JSON.stringify(update.payload, null, 2);
  console.log(`Task payload:\n${task}`);

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
