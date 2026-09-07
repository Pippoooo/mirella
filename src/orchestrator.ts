// Mirella orchestrator: the poll loop and per-issue wiring. Everything
// provider-, harness-, and store-specific sits behind the three boundaries —
// this module owns the orchestration policy (label, poll cadence, what gets
// written where) but knows none of the implementations: no URLs, no env
// prefixes, no provider SDK types.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ENV } from "./env.js";
import {
  agentDirPath,
  issueBranchName,
  prepareIssueWorkdir,
} from "./git.js";
import type { AgentRunner } from "./harness/types.js";
import { createLogger } from "./logger.js";
import { buildIssueUpdate } from "./payload.js";
import type { VCSProvider } from "./providers/types.js";
import type { IssueStateStore } from "./store/types.js";
import type { NormalizedIssue } from "./types.js";

const log = createLogger("orchestrator");

// Issues carrying this label are the ones the agent works on.
const AGENT_LABEL = "mirella-agent";

interface PollDeps {
  provider: VCSProvider;
  harness: AgentRunner;
  store: IssueStateStore;
  owner: string;
  repo: string;
  baseBranch: string;
  repoUrl: string;
  aiProviderEnv: Record<string, string>;
  botLogin: string;
  pollIntervalMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One poll: read all open labeled issues and run the agent on the ones with
// new activity.
async function pollIssues(deps: PollDeps): Promise<void> {
  const { baseBranch } = deps;
  // Refresh the installation token every cycle — it expires after ~1h,
  // which a long-lived polling loop will outlive.
  const { token } = await deps.provider.getInstallationToken();

  const issues = await deps.provider.listAgentIssues(AGENT_LABEL);
  log.info(
    `\n=== Poll: ${issues.length} open issue(s) labeled "${AGENT_LABEL}" (base branch: ${baseBranch}) ===`,
  );

  for (const issue of issues) {
    try {
      await processIssue(deps, token, issue);
    } catch (err) {
      // One broken issue must not stall the others (or the polling loop).
      log.error(`Issue #${issue.number} failed:`, err);
    }
  }
}

async function processIssue(
  deps: PollDeps,
  token: string,
  issue: NormalizedIssue,
): Promise<void> {
  const { owner, repo, baseBranch, aiProviderEnv, repoUrl } = deps;
  const branch = issueBranchName(issue.number);
  log.info(`=== Issue #${issue.number}: ${issue.title} ===`);

  const workdir = await prepareIssueWorkdir({
    credentials: deps.provider.getGitCredentials(token),
    remoteUrl: repoUrl,
    baseBranch,
    issueNumber: issue.number,
  });
  const state = await deps.store.read(issue.number);
  const snapshot = await deps.provider.fetchActivity(issue.number, branch);
  const agentDir = agentDirPath(issue.number);
  const update = buildIssueUpdate(issue, snapshot, state, deps.botLogin, {
    owner,
    repo,
    baseBranch,
    branch,
    agentDir,
  });

  if (!update.hasNew) {
    log.info("no new activity — skipping\n");
    return;
  }

  // Keep the whole conversation where the agent can always consult it: its
  // own directory, outside the worktree so git can never pick it up.
  // Written on every wake-up — the file only matters when the agent runs,
  // and this is exactly when its content changed.
  await writeFile(
    join(agentDir, "conversation.json"),
    JSON.stringify(update.conversation, null, 2),
  );

  const mcpConfigPath = await deps.harness.writeConfig({
    token,
    owner,
    repo,
    baseBranch,
    issueNumber: issue.number,
    branch,
  });
  // The task is a pure JSON work order — repo/branch, issue, PR, and the
  // messages to process, with no instructions baked in (every operating rule
  // lives in CLAUDE.md, which is baked into the agent image and read on
  // every run).
  const task = JSON.stringify(update.payload, null, 2);
  log.info(`Task payload:\n${task}`);

  log.info(`Spawning agent in ${workdir}...`);
  const result = await deps.harness.run({
    task,
    workdir,
    aiProviderEnv: { ...aiProviderEnv, [ENV.gitToken]: token },
    mcpConfigPath,
  });
  await deps.store.write(issue.number, {
    ...update.nextState,
    sessionId: result.sessionId,
  });

  log.info(`\nsession: ${result.sessionId}`);
  log.info(`isError: ${result.isError}`);
  log.info(`result: ${result.result}\n`);
}

// The orchestrator's whole life: poll, sleep, repeat. A failed poll
// (network, rate limit) must not kill the loop.
export async function runOrchestrator(deps: PollDeps): Promise<void> {
  log.info(
    `Watching ${deps.owner}/${deps.repo} as ${deps.botLogin}, polling every ${deps.pollIntervalMs / 1000}s`,
  );
  while (true) {
    try {
      await pollIssues(deps);
    } catch (err) {
      log.error("Poll failed:", err);
    }
    await sleep(deps.pollIntervalMs);
  }
}