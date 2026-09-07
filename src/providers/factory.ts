// Factory for the VCS boundary. Switches on the configured type and throws
// on an unknown value — no implementation exists yet for anything but the
// default; the switch existing is the point, not the alternatives.

import type { VcsProviderConfig } from "../config.js";
import { createGithubProvider } from "./github.js";
import type { VCSProvider } from "./types.js";

export async function createProvider(
  config: VcsProviderConfig,
): Promise<VCSProvider> {
  switch (config.type) {
    case "github":
      return createGithubProvider(config);
    default:
      throw new Error(`Unknown VCS provider: ${config.type}`);
  }
}