// The Claude Code implementation of the agent-harness boundary: everything
// about the claude CLI — how it is spawned, its flags, its MCP config file —
// lives here and nowhere else.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_PASSWORD_ENV } from "../git.js";
import type {
  AgentRunParams,
  AgentRunResult,
  AgentRunner,
  RunContext,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Write a throwaway --mcp-config file pointing at the vcs-tools MCP server
// (src/mcp/vcs-server.ts), which gives the agent real VCS write access:
// comment on the issue, open/update PRs, add labels. Lives outside /workspace
// on purpose — it's agent plumbing, not part of the user's repo, and must
// never get swept up by an agent `git add -A`. tsx is resolved from the
// app's own node_modules with an absolute path: the agent's cwd is the
// worktree (/workspace/agent-<N>/issue-<N>), where `npx tsx` would not
// resolve and npx would try to download it from the registry.
//
// The per-issue context and the installation token ride along in the
// server's env. The token does land in this /tmp file — acceptable because
// the file is outside the repo (an agent `git add -A` can never pick it up),
// the token is short-lived, and the agent process can read its own
// environment anyway. Passing it explicitly also means the server does not
// depend on how claude inherits its environment.
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
          args: [serverPath],
          env: {
            [GIT_PASSWORD_ENV]: ctx.token,
            GITHUB_OWNER: ctx.owner,
            GITHUB_REPO: ctx.repo,
            GITHUB_BASE_BRANCH: ctx.baseBranch,
            MIRELLA_ISSUE_NUMBER: String(ctx.issueNumber),
            MIRELLA_BRANCH: ctx.branch,
          },
        },
      },
    }),
  );
  return configPath;
}

export function createClaudeCodeHarness(): AgentRunner {
  return {
    // Run claude, resuming the issue's previous session when there is one.
    // If the saved session can no longer be resumed (e.g. it was pruned),
    // fall back to a fresh session instead of failing the whole run.
    async run(params: AgentRunParams): Promise<AgentRunResult> {
      try {
        return await runAgent(params);
      } catch (err) {
        if (!params.sessionId) throw err;
        console.error(
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