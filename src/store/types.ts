// The issue-state boundary: per-issue orchestrator memory — what the agent
// has already been shown, and the session to resume. Keyed by issue number
// only; where the state lives is the store's business, not the caller's.

import type { IssueState } from "../types.js";

export interface IssueStateStore {
  read(issueNumber: number): Promise<IssueState | undefined>;
  write(issueNumber: number, state: IssueState): Promise<void>;
}