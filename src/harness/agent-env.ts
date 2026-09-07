// The agent-process environment contract, shared by every harness
// implementation. Nothing harness-specific lives here: whichever CLI is
// spawned, the agent and everything IT spawns may see exactly the baseline
// below plus the credentials map its caller passes — never the
// orchestrator's own environment (App credentials, repo config, the rest of
// the .env contents).

// Variables the agent process always needs, whatever harness runs it: where
// executables live (git, node, the harness CLI and its Bash tool), where its
// config and temp files go, and locale basics. Anything a harness genuinely
// needs beyond this list goes on it explicitly — never by inheriting the
// whole environment.
const BASELINE_ENV_VARS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "TERM",
  "SHELL",
] as const;

// Baseline + credentials, nothing else. Every harness spawns its CLI with
// this.
export function buildAgentEnv(
  credentials: Record<string, string>,
): NodeJS.ProcessEnv {
  const baseline: Record<string, string> = {};
  for (const name of BASELINE_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) baseline[name] = value;
  }
  return { ...baseline, ...credentials };
}