// Mirella orchestrator: the poll loop and per-issue wiring. Everything
// provider-, harness-, and store-specific sits behind the three factories —
// this file knows the orchestration policy (label, branch naming, poll
// cadence, what gets written where) but not how any boundary is implemented.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createHarness } from "./harness/factory.js";
import type { AgentRunner } from "./harness/types.js";
import { GIT_PASSWORD_ENV, agentDirPath, prepareIssueWorkdir } from "./git.js";
import { buildIssueUpdate } from "./payload.js";
import { createProvider } from "./providers/factory.js";
import type { VCSProvider } from "./providers/types.js";
import { createIssueStateStore } from "./store/factory.js";
import type { IssueStateStore } from "./store/types.js";
import type { NormalizedIssue } from "./types.js";

const AGENT_LABEL = "mirella-agent";
// How often the orchestrator wakes up to check for new activity.
const POLL_INTERVAL_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PollDeps {
  provider: VCSProvider;
  harness: AgentRunner;
  store: IssueStateStore;
  owner: string;
  repo: string;
  baseBranch: string;
  aiProviderEnv: Record<string, string>;
  botLogin: string;
}

// One poll: read all open labeled issues and run the agent on the ones with
// new activity.
async function pollIssues(deps: PollDeps): Promise<void> {
  const { baseBranch } = deps;
  // Refresh the installation token every cycle — it expires after ~1h,
  // which a long-lived polling loop will outlive.
  const { token } = await deps.provider.getInstallationToken();

  const issues = await deps.provider.listAgentIssues(AGENT_LABEL);
  console.log(
    `\n=== Poll: ${issues.length} open issue(s) labeled "${AGENT_LABEL}" (base branch: ${baseBranch}) ===`,
  );

  for (const issue of issues) {
    try {
      await processIssue(deps, token, issue);
    } catch (err) {
      // One broken issue must not stall the others (or the polling loop).
      console.error(`Issue #${issue.number} failed:`, err);
    }
  }
}

async function processIssue(
  deps: PollDeps,
  token: string,
  issue: NormalizedIssue,
): Promise<void> {
  const { owner, repo, baseBranch, aiProviderEnv } = deps;
  const branch = `mirella/issue-${issue.number}`;
  console.log(`=== Issue #${issue.number}: ${issue.title} ===`);

  const workdir = await prepareIssueWorkdir({
    credentials: deps.provider.getGitCredentials(token),
    remoteUrl: `https://github.com/${owner}/${repo}.git`,
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
    console.log("no new activity — skipping\n");
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
  console.log(`Task payload:\n${task}`);

  console.log(`Spawning agent in ${workdir}...`);
  const result = await deps.harness.run({
    task,
    workdir,
    aiProviderEnv: { ...aiProviderEnv, [GIT_PASSWORD_ENV]: token },
    mcpConfigPath,
  });
  await deps.store.write(issue.number, {
    ...update.nextState,
    sessionId: result.sessionId,
  });

  console.log(`\nsession: ${result.sessionId}`);
  console.log(`isError: ${result.isError}`);
  console.log(`result: ${result.result}\n`);
}

async function main(): Promise<void> {
  const config = await loadConfig();

  const provider = await createProvider(config.vcsProvider);
  const harness = createHarness(config.agentHarness);
  const store = createIssueStateStore(config.stateStore);

  if (Object.keys(config.aiProviderEnv).length === 0) {
    console.error(
      "Warning: no ANTHROPIC_* variables in the environment — claude will not be able to authenticate.",
    );
  }

  // The app's bot account, so mirella's own comments can be told apart from
  // human feedback.
  const { botLogin } = await provider.getInstallationToken();

  console.log(
    `Watching ${config.owner}/${config.repo} as ${botLogin}, polling every ${POLL_INTERVAL_MS / 1000}s`,
  );

  const deps: PollDeps = {
    provider,
    harness,
    store,
    owner: config.owner,
    repo: config.repo,
    baseBranch: config.baseBranch,
    aiProviderEnv: config.aiProviderEnv,
    botLogin,
  };
  while (true) {
    try {
      await pollIssues(deps);
    } catch (err) {
      // A failed poll (network, rate limit) must not kill the loop.
      console.error("Poll failed:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("Failed to run agent:", err);
  process.exit(1);
});
