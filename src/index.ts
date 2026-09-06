import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { App } from "octokit";

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

// Log into git using the GitHub App installation token and pull the target
// repo into the workspace. Container-per-repo design: everything the agent
// touches lives under /workspace.
async function setupRepo(): Promise<string> {
  const appId = requireEnv("GITHUB_APP_ID");
  const installationId = Number(requireEnv("GITHUB_INSTALLATION_ID"));
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const baseBranch = requireEnv("GITHUB_BASE_BRANCH");

  const app = new App({ appId, privateKey: await loadPrivateKey() });
  const installation = await app.getInstallationOctokit(installationId);
  const { token } = (await installation.auth({ type: "installation" })) as {
    token: string;
  };

  const workdir = "/workspace";
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
  } else {
    console.log(`Using existing clone in ${workdir}`);
  }

  await git(token, ["checkout", baseBranch], workdir);
  await git(token, ["pull"], workdir);
  console.log(`Pulled ${owner}/${repo}@${baseBranch}`);

  return workdir;
}

async function main(): Promise<void> {
  // Log into git and pull the repo before anything else.
  const workdir = await setupRepo();
  console.log(`Repo ready in ${workdir}\n`);

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

  // Start claude inside the cloned repo and ask what it can see.
  console.log(`Spawning claude in ${workdir}...`);
  const result = await runAgent({
    task: "Look at the files in this repository and tell me what you see.",
    workdir,
    aiProviderEnv,
  });

  console.log(`\nsession: ${result.sessionId}`);
  console.log(`isError: ${result.isError}`);
  console.log(`result: ${result.result}`);
}

main().catch((err) => {
  console.error("Failed to run agent:", err);
  process.exit(1);
});
