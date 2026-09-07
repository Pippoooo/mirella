// The Claude Code implementation of the agent-harness boundary: everything
// about the claude CLI — how it is spawned, its flags, its MCP config file,
// its AI-provider env contract — lives here and nowhere else.

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, requireEnv } from "../env.js";
import { createLogger } from "../logger.js";
import { buildAgentEnv } from "./agent-env.js";
import type {
  AgentRunParams,
  AgentRunResult,
  AgentRunner,
  RunContext,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const log = createLogger("claude-code");

// The AI API provider the claude CLI talks to is configured through
// ANTHROPIC_* variables: base URL and model overrides are non-secret config
// and pass through the environment; the auth token is a secret and is read
// ONLY from a mounted file (path given via ENV.anthropicAuthTokenPath),
// injected here as ANTHROPIC_AUTH_TOKEN. This is the claude harness's own
// contract — no other module needs to know the prefix.
const ANTHROPIC_PREFIX = "ANTHROPIC_";

// Variables that must not pass through to the agent: the secret-valued ones
// (dropped even if present in the environment — the file's content replaces
// them) and the loader's own *_PATH variable, which is orchestrator
// plumbing, not something the CLI consumes.
const NON_AGENT_ANTHROPIC_VARS = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  ENV.anthropicAuthTokenPath,
]);

async function collectAnthropicCredentials(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const credentials = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        key.startsWith(ANTHROPIC_PREFIX) && !NON_AGENT_ANTHROPIC_VARS.has(key),
    ),
  ) as Record<string, string>;
  const tokenPath = requireEnv(ENV.anthropicAuthTokenPath);
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) {
    log.warn(
      `Auth token file ${tokenPath} is empty — the agent will not be able to authenticate.`,
    );
  }
  credentials.ANTHROPIC_AUTH_TOKEN = token;
  return credentials;
}

// Spawn the claude CLI headless in the workdir and parse its JSON result.
function runAgent(params: AgentRunParams): Promise<AgentRunResult> {
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
      // Only the explicit baseline + credentials reach the agent — never the
      // orchestrator's own environment (see buildAgentEnv).
      env: buildAgentEnv(params.credentials),
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

// Write a throwaway --mcp-config file pointing at the vcs-tools MCP server
// (src/mcp/vcs-server.ts), which gives the agent real VCS write access:
// comment on the issue, open/update PRs, add labels. Lives outside /workspace
// on purpose — it's agent plumbing, not part of the user's repo, and must
// never get swept up by an agent `git add -A`. tsx is resolved from the
// app's own node_modules with an absolute path: the agent's cwd is the
// worktree (/workspace/agent-<N>/issue-<N>), where `npx tsx` would not
// resolve and npx would try to download it from the registry.
//
// The server's context is split by sensitivity: per-run facts (issue number,
// branch) go on the command line; configuration (repo, base branch) and the
// installation token go through its environment — credentials must never
// appear in argv, where `ps` would expose them. Passing them explicitly also
// means the server does not depend on how claude inherits its environment.
// The token does land in this /tmp file — acceptable because the file is
// outside the repo (an agent `git add -A` can never pick it up), the token
// is short-lived, and the agent process can read its own environment anyway.
async function writeMcpConfig(ctx: RunContext): Promise<string> {
  const serverPath = join(__dirname, "..", "mcp", "vcs-server.ts");
  const tsxBin = join(__dirname, "..", "..", "node_modules", ".bin", "tsx");
  const configPath = join(
    tmpdir(),
    `mcp-config-issue-${ctx.issueNumber}-${Date.now()}.json`,
  );
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        "vcs-tools": {
          command: tsxBin,
          args: [
            serverPath,
            "--issue",
            String(ctx.issueNumber),
            "--branch",
            ctx.branch,
          ],
          env: {
            [ENV.gitToken]: ctx.token,
            [ENV.repoOwner]: ctx.owner,
            [ENV.repoName]: ctx.repo,
            [ENV.baseBranch]: ctx.baseBranch,
            [ENV.vcsProvider]: ctx.providerType,
          },
        },
      },
    }),
  );
  return configPath;
}

export function createClaudeCodeHarness(): AgentRunner {
  return {
    credentialsFromEnv: collectAnthropicCredentials,

    // Run claude, resuming the issue's previous session when there is one.
    // If the saved session can no longer be resumed (e.g. it was pruned),
    // fall back to a fresh session instead of failing the whole run.
    async run(params: AgentRunParams): Promise<AgentRunResult> {
      try {
        return await runAgent(params);
      } catch (err) {
        if (!params.sessionId) throw err;
        log.warn(
          `Could not resume session ${params.sessionId} (${(err as Error).message}) — starting a fresh session.`,
        );
        const { sessionId: _saved, ...fresh } = params;
        return runAgent(fresh);
      }
    },

    async writeConfig(ctx: RunContext): Promise<string> {
      return writeMcpConfig(ctx);
    },
  };
}