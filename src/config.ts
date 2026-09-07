// Environment loading. Everything the process needs from the outside world is
// read exactly once, here, into plain config objects — nothing downstream
// looks at process.env directly.

import { readFile } from "node:fs/promises";
import type { VcsAuth } from "./providers/types.js";

// Container-level layout constant: the mounted volume every issue directory
// hangs off. Shared by git.ts (worktree layout) and store/file-store.ts
// (state file location).
export const WORKSPACE_ROOT = "/workspace";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export async function loadPrivateKey(): Promise<string> {
  // Preferred: read the PEM from a file (easy to mount into the container).
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    return readFile(path, "utf8");
  }

  // Fallback: inline PEM, with literal "\n" sequences turned back into newlines.
  const key = requireEnv("GITHUB_APP_PRIVATE_KEY");
  return key.replaceAll("\\n", "\n");
}

// Pass through every ANTHROPIC_* variable the container has (loaded from .env
// by compose): API key, base URL, model override, etc.
function aiProviderEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("ANTHROPIC_")),
  ) as Record<string, string>;
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
  aiProviderEnv: Record<string, string>;
  vcsProvider: VcsProviderConfig;
  agentHarness: AgentHarnessConfig;
  stateStore: StateStoreConfig;
}

export async function loadConfig(): Promise<AppConfig> {
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  return {
    owner,
    repo,
    baseBranch: requireEnv("GITHUB_BASE_BRANCH"),
    aiProviderEnv: aiProviderEnv(),
    vcsProvider: {
      type: process.env.VCS_PROVIDER ?? "github",
      owner,
      repo,
      auth: {
        kind: "app",
        appId: requireEnv("GITHUB_APP_ID"),
        privateKey: await loadPrivateKey(),
        installationId: Number(requireEnv("GITHUB_INSTALLATION_ID")),
      },
    },
    agentHarness: { type: process.env.AGENT_HARNESS ?? "claude-code" },
    stateStore: { type: process.env.STATE_STORE ?? "file" },
  };
}