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

const AGENT_LABEL = "mirella-agent";
const WORKSPACE_ROOT = "/workspace";

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

// Feedback that lives on the PR rather than the issue: the PR conversation
// thread, review summaries (approve / request changes), and inline review
// comments attached to lines. Returns "" when the branch has no PR yet, so
// first runs look unchanged.
async function fetchPrFeedback(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
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
    return "";
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

  const lines = [
    "",
    "",
    `## Pull request #${pr.number} (${pr.state}): ${pr.title}`,
    "",
    "### Comments",
  ];
  for (const comment of comments) {
    lines.push("", `### @${comment.user?.login}`, comment.body ?? "(no body)");
  }
  lines.push("", "### Reviews");
  for (const review of reviews) {
    // Commented reviews with no body are empty shells around inline comments
    // (shown below) — skip them.
    if (review.state === "COMMENTED" && !review.body) continue;
    lines.push(
      "",
      `### @${review.user?.login} [${review.state}]`,
      review.body || "(no body)",
    );
  }
  lines.push("", "### Inline review comments");
  for (const reviewComment of reviewComments) {
    const line = reviewComment.line ?? reviewComment.original_line ?? "?";
    lines.push(
      "",
      `### @${reviewComment.user?.login} on ${reviewComment.path}:${line}`,
      reviewComment.body ?? "(no body)",
    );
  }
  return lines.join("\n");
}

// Claude sessions are scoped to the cwd they started in, so each issue
// workdir keeps its own session history (issue-6 never sees issue-5's). The
// session id of the last run is stored inside the clone's .git dir: it
// belongs to this clone, never shows up in git status, and dies with it.
function sessionFilePath(workdir: string): string {
  return join(workdir, ".git", "mirella", "session-id");
}

async function readSessionId(workdir: string): Promise<string | undefined> {
  return readFile(sessionFilePath(workdir), "utf8")
    .then((value) => value.trim() || undefined)
    .catch(() => undefined);
}

async function writeSessionId(
  workdir: string,
  sessionId: string,
): Promise<void> {
  // .git/mirella doesn't exist on a fresh clone — create it first.
  await mkdir(dirname(sessionFilePath(workdir)), { recursive: true });
  await writeFile(sessionFilePath(workdir), `${sessionId}\n`);
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
  const { token } = (await octokit.auth({ type: "installation" })) as {
    token: string;
  };

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

  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  const agentIssues = issuesWithAgentLabel(issues);
  console.log(
    `${agentIssues.length} open issue(s) labeled "${AGENT_LABEL}" (base branch: ${baseBranch})\n`,
  );

  for (const issue of agentIssues) {
    console.log(`=== Issue #${issue.number}: ${issue.title} ===`);

    const branch = `mirella/issue-${issue.number}`;

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
    const prFeedback = await fetchPrFeedback(octokit, owner, repo, branch);
    const conversation = formatConversation(issue, comments) + prFeedback;
    console.log(conversation);

    const workdir = await prepareIssueWorkdir(
      token,
      owner,
      repo,
      baseBranch,
      issue.number,
    );

    const mcpConfigPath = await writeMcpConfig({
      token,
      owner,
      repo,
      baseBranch,
      issueNumber: issue.number,
      branch,
    });
    const task = [
      conversation,
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
    const savedSessionId = await readSessionId(workdir);
    const result = await runAgentOnIssue(
      {
        task,
        workdir,
        aiProviderEnv: { ...aiProviderEnv, MIRELLA_GIT_TOKEN: token },
        mcpConfigPath,
      },
      savedSessionId,
    );
    await writeSessionId(workdir, result.sessionId);

    console.log(`\nsession: ${result.sessionId}`);
    console.log(`isError: ${result.isError}`);
    console.log(`result: ${result.result}\n`);
  }
}

main().catch((err) => {
  console.error("Failed to run agent:", err);
  process.exit(1);
});
