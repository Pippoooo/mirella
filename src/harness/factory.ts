// Factory for the agent-harness boundary. Switches on the configured type
// and throws on an unknown value — no implementation exists yet for anything
// but the default; the switch existing is the point, not the alternatives.

import type { AgentHarnessConfig } from "../config.js";
import { createClaudeCodeHarness } from "./claude-code.js";
import type { AgentRunner } from "./types.js";

export function createHarness(config: AgentHarnessConfig): AgentRunner {
  switch (config.type) {
    case "claude-code":
      return createClaudeCodeHarness();
    default:
      throw new Error(`Unknown agent harness: ${config.type}`);
  }
}