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
// (src/vsc-mcp.ts). Lives outside /workspace on purpose — it's agent
// plumbing, not part of the user's repo, and must never get swept up by an
// agent `git add -A`. tsx is resolved from the app's own node_modules with an
// absolute path: the agent's cwd is /workspace/issue-N, where `npx tsx`
// would not resolve and npx would try to download it from the registry.
async function writeMcpConfig(): Promise<string> {
  const serverPath = join(__dirname, "vsc-mcp.ts");
  const tsxBin = join(__dirname, "..", "node_modules", ".bin", "tsx");
  const configPath = join(tmpdir(), `mcp-config-${Date.now()}.json`);
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        "vcs-tools": { command: tsxBin, args: [serverPath] },
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

  const mcpConfigPath = await writeMcpConfig();

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

    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issue.number,
      sort: "updated",
      direction: "asc",
      per_page: 100,
    });
    const conversation = formatConversation(issue, comments);

    const workdir = await prepareIssueWorkdir(
      token,
      owner,
      repo,
      baseBranch,
      issue.number,
    );

    const branch = `mirella/issue-${issue.number}`;
    const task = [
      conversation,
      "",
      "## Your job",
      `You are in a git clone of ${owner}/${repo}, already on branch ${branch}.`,
      "1. Implement the issue described above, taking every comment into account.",
      "2. Commit your work with a message that references the issue number.",
      `3. Push the branch to origin with: git push -u origin ${branch}`,
      "4. After pushing, use the vcs-tools MCP server's post_comment tool to post a short summary of the work you did.",
    ].join("\n");

    console.log(`Spawning claude in ${workdir}...`);
    const result = await runAgent({
      task,
      workdir,
      aiProviderEnv: { ...aiProviderEnv, MIRELLA_GIT_TOKEN: token },
      mcpConfigPath,
    });

    console.log(`\nsession: ${result.sessionId}`);
    console.log(`isError: ${result.isError}`);
    console.log(`result: ${result.result}\n`);
  }
}

main().catch((err) => {
  console.error("Failed to run agent:", err);
  process.exit(1);
});
