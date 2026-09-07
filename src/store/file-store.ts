// The file-based implementation of the issue-state boundary: one JSON file
// per issue.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDirPath } from "../git.js";
import type { IssueState } from "../types.js";
import type { IssueStateStore } from "./types.js";

// Per-issue state lives beside conversation.json in the agent's own
// directory (agent-N/), deliberately OUTSIDE the git worktree:
// workdir/.git is a plain text file there (a pointer at the shared git
// dir), not a directory, so a path under workdir/.git would throw ENOTDIR.
// Restart-safe, never in git status, dies with the agent dir.
function stateFilePath(issueNumber: number): string {
  return join(agentDirPath(issueNumber), "state.json");
}

export function createFileStateStore(): IssueStateStore {
  return {
    // Missing, unreadable, or corrupt → fresh start with the full
    // conversation.
    async read(issueNumber: number): Promise<IssueState | undefined> {
      return readFile(stateFilePath(issueNumber), "utf8")
        .then((raw) => JSON.parse(raw) as IssueState)
        .catch(() => undefined);
    },

    async write(issueNumber: number, state: IssueState): Promise<void> {
      // The agent dir already exists by now (the worktree was created inside
      // it) — mkdir is just belt and braces.
      await mkdir(agentDirPath(issueNumber), { recursive: true });
      await writeFile(stateFilePath(issueNumber), JSON.stringify(state, null, 2));
    },
  };
}