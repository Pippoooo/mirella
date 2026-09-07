// The agent-harness boundary: how the orchestrator runs a coding agent and
// hands it its tooling. Nothing here may leak details of a specific CLI —
// those live in the implementation.

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
  mcpConfigPath?: string;
}

// Per-run facts the harness needs to wire up its tooling: which repo, issue,
// and branch the agent is working on, and the credentials to write with.
export interface RunContext {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
  issueNumber: number;
  branch: string;
}

export interface AgentRunner {
  // Runs the agent on the task. Resume-fallback logic included: when the
  // saved session can no longer be resumed (e.g. it was pruned), fall back
  // to a fresh session instead of failing the whole run.
  run(params: AgentRunParams): Promise<AgentRunResult>;

  // Prepare whatever per-run config file the harness needs (tool servers,
  // permissions, ...). Return undefined for harnesses that need no config
  // file at all — don't assume every harness wants one.
  writeConfig(ctx: RunContext): Promise<string | undefined>;
}