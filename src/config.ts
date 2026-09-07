// Environment loading. Everything the process needs from the outside world is
// read exactly once, here, into plain config objects — nothing downstream
// looks at process.env directly. Every variable is explicitly required: no
// defaults are assumed. Provider-specific credentials (e.g. the GitHub App
// key) are read by the provider implementations themselves — this layer only
// knows which provider/harness/store types are configured.

import { ENV, requireEnv } from "./env.js";

// Container-level layout constant: the mounted volume every issue directory
// hangs off. Shared by git.ts (worktree layout) and store/file-store.ts
// (state file location).
export const WORKSPACE_ROOT = "/workspace";

function pollIntervalMs(): number {
  const value = Number(requireEnv(ENV.pollIntervalMs));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${ENV.pollIntervalMs} must be a positive integer (milliseconds), got: ${process.env[ENV.pollIntervalMs]}`,
    );
  }
  return value;
}

// The repo context every VCS-facing consumer needs: which provider speaks for
// the repo, and which repo/branch to work against. Shared by loadConfig and
// the MCP server, whose env is baked by the harness (see harness/claude-code.ts).
export function readVcsContext(): {
  providerType: string;
  owner: string;
  repo: string;
  baseBranch: string;
} {
  return {
    providerType: requireEnv(ENV.vcsProvider),
    owner: requireEnv(ENV.repoOwner),
    repo: requireEnv(ENV.repoName),
    baseBranch: requireEnv(ENV.baseBranch),
  };
}

// Which implementation sits behind each boundary. All three are explicitly
// configured — no defaults; factories throw on unknown values.
export interface VcsProviderConfig {
  type: string; // e.g. "github"
  owner: string;
  repo: string;
}

export interface AgentHarnessConfig {
  type: string; // e.g. "claude-code"
}

export interface StateStoreConfig {
  type: string; // e.g. "file"
}

export interface AppConfig {
  owner: string;
  repo: string;
  baseBranch: string;
  pollIntervalMs: number;
  vcsProvider: VcsProviderConfig;
  agentHarness: AgentHarnessConfig;
  stateStore: StateStoreConfig;
}

export async function loadConfig(): Promise<AppConfig> {
  const vcs = readVcsContext();
  return {
    owner: vcs.owner,
    repo: vcs.repo,
    baseBranch: vcs.baseBranch,
    pollIntervalMs: pollIntervalMs(),
    vcsProvider: {
      type: vcs.providerType,
      owner: vcs.owner,
      repo: vcs.repo,
    },
    agentHarness: { type: requireEnv(ENV.agentHarness) },
    stateStore: { type: requireEnv(ENV.stateStore) },
  };
}