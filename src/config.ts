// Environment loading. Everything the process needs from the outside world is
// read exactly once, here, into plain config objects — nothing downstream
// looks at process.env directly. Variable names come from env.ts, the single
// registry.

import { readFile } from "node:fs/promises";
import { ENV, requireEnv } from "./env.js";
import type { VcsAuth } from "./providers/types.js";

// Container-level layout constant: the mounted volume every issue directory
// hangs off. Shared by git.ts (worktree layout) and store/file-store.ts
// (state file location).
export const WORKSPACE_ROOT = "/workspace";

export async function loadPrivateKey(): Promise<string> {
  // Preferred: read the PEM from a file (easy to mount into the container).
  const path = process.env[ENV.githubAppPrivateKeyPath];
  if (path) {
    return readFile(path, "utf8");
  }

  // Fallback: inline PEM, with literal "\n" sequences turned back into newlines.
  const key = requireEnv(ENV.githubAppPrivateKey);
  return key.replaceAll("\\n", "\n");
}

// How often the orchestrator wakes up to check for new activity.
const DEFAULT_POLL_INTERVAL_MS = 10_000;

function pollIntervalMs(): number {
  const raw = process.env[ENV.pollIntervalMs];
  if (raw === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${ENV.pollIntervalMs} must be a positive integer (milliseconds), got: ${raw}`,
    );
  }
  return value;
}

// The repo context every VCS-facing consumer needs: which provider speaks for
// the repo, and which repo/branch to work against. Shared by loadConfig and
// the MCP server, whose env is baked by the harness (see harness/claude-code.ts).
export function readVcsContext(env: NodeJS.ProcessEnv = process.env): {
  providerType: string;
  owner: string;
  repo: string;
  baseBranch: string;
} {
  return {
    providerType: env[ENV.vcsProvider] ?? "github",
    owner: requireEnv(ENV.repoOwner),
    repo: requireEnv(ENV.repoName),
    baseBranch: requireEnv(ENV.baseBranch),
  };
}

// Which implementation sits behind each boundary. All three default to
// today's behavior and no alternative exists yet — the switch existing is the
// point, not the alternatives. Factories throw on unknown values.
export interface VcsProviderConfig {
  type: string; // "github"
  owner: string;
  repo: string;
  auth: VcsAuth;
}

export interface AgentHarnessConfig {
  type: string; // "claude-code"
}

export interface StateStoreConfig {
  type: string; // "file"
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
      auth: {
        kind: "app",
        appId: requireEnv(ENV.githubAppId),
        privateKey: await loadPrivateKey(),
        installationId: Number(requireEnv(ENV.githubInstallationId)),
      },
    },
    agentHarness: { type: process.env[ENV.agentHarness] ?? "claude-code" },
    stateStore: { type: process.env[ENV.stateStore] ?? "file" },
  };
}