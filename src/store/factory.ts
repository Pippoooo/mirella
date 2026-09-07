// Factory for the issue-state boundary. Switches on the configured type and
// throws on an unknown value — no implementation exists yet for anything but
// the default; the switch existing is the point, not the alternatives.

import type { StateStoreConfig } from "../config.js";
import { createFileStateStore } from "./file-store.js";
import type { IssueStateStore } from "./types.js";

export function createIssueStateStore(
  config: StateStoreConfig,
): IssueStateStore {
  switch (config.type) {
    case "file":
      return createFileStateStore();
    default:
      throw new Error(`Unknown issue state store: ${config.type}`);
  }
}