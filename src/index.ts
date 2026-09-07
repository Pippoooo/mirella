// Composition root: wire the configured implementations of the three
// boundaries to the orchestrator and run it. Everything provider-,
// harness-, and store-specific enters here and nowhere else — no URLs, no
// AI-provider prefixes, no poll cadence.

import { loadConfig } from "./config.js";
import { createHarness } from "./harness/factory.js";
import { createProvider } from "./providers/factory.js";
import { createIssueStateStore } from "./store/factory.js";
import { runOrchestrator } from "./orchestrator.js";

async function main(): Promise<void> {
  const config = await loadConfig();

  const provider = await createProvider(config.vcsProvider);
  const harness = createHarness(config.agentHarness);
  const store = createIssueStateStore(config.stateStore);

  // The app's bot account, so mirella's own comments can be told apart from
  // human feedback.
  const { botLogin } = await provider.getInstallationToken();

  await runOrchestrator({
    provider,
    harness,
    store,
    owner: config.owner,
    repo: config.repo,
    baseBranch: config.baseBranch,
    repoUrl: provider.getRepoUrl(),
    vcsProviderType: config.vcsProvider.type,
    commitIdentity: provider.getCommitIdentity(),
    // The harness owns its AI-provider env contract — which credentials its
    // CLI needs and how they are spelled. Secrets come from mounted files.
    aiProviderEnv: await harness.credentialsFromEnv(process.env),
    botLogin,
    pollIntervalMs: config.pollIntervalMs,
  });
}

main().catch((err) => {
  console.error("Failed to run agent:", err);
  process.exit(1);
});
