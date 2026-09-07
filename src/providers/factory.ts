// Factory for the VCS boundary. Each provider owns its own authentication —
// createProvider for the main process (provider-specific credentials read
// from the environment), createTokenProvider for consumers handed an
// already-minted token (the MCP server). Throws on an unknown value — no
// implementation exists yet for anything but the default; the switch
// existing is the point, not the alternatives.

import type { VcsProviderConfig } from "../config.js";
import {
  createGithubProvider,
  createGithubTokenProvider,
} from "./github.js";
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

export async function createTokenProvider(
  config: VcsProviderConfig,
  token: string,
): Promise<VCSProvider> {
  switch (config.type) {
    case "github":
      return createGithubTokenProvider(config, token);
    default:
      throw new Error(`Unknown VCS provider: ${config.type}`);
  }
}