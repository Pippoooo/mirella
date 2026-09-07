// The single registry of environment variable names. Every env var the
// process reads is named here and only here — downstream code references
// ENV.* constants, never string literals, so a rename happens in one place
// and the harness/MCP-server contract can't drift. Imports nothing: env.ts
// is a leaf every other module may depend on without creating a cycle.

// Provider-neutral names for everything provider-agnostic code reads. The
// GitHub-App auth variables are inherently GitHub-specific (only a GitHub
// provider has App credentials), so their values keep the GITHUB_ prefix —
// but they are still defined here, so this object remains the complete list.
export const ENV = {
  repoOwner: "MIRELLA_REPO_OWNER",
  repoName: "MIRELLA_REPO_NAME",
  baseBranch: "MIRELLA_BASE_BRANCH",
  // Shared credential env var: the orchestrator's git credential helper
  // expands the password from it, and the MCP server receives its
  // installation token through it (see git.ts and harness/claude-code.ts).
  gitToken: "MIRELLA_GIT_TOKEN",
  pollIntervalMs: "MIRELLA_POLL_INTERVAL_MS",
  // Which implementation sits behind each boundary.
  vcsProvider: "MIRELLA_VCS_PROVIDER",
  agentHarness: "MIRELLA_AGENT_HARNESS",
  stateStore: "MIRELLA_STATE_STORE",
  // Secrets are mounted as files, never carried as env values: each secret
  // is given by a *_PATH variable pointing at the mounted file, following
  // the same <SECRET>_PATH pattern (GitHub App key, AI provider auth token).
  githubAppPrivateKeyPath: "GITHUB_APP_PRIVATE_KEY_PATH",
  anthropicAuthTokenPath: "ANTHROPIC_AUTH_TOKEN_PATH",
  // Provider-specific config env vars (GitHub App credentials).
  githubAppId: "GITHUB_APP_ID",
  githubInstallationId: "GITHUB_INSTALLATION_ID",
} as const;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}