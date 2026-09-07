// The VCS boundary: everything the orchestrator and the MCP server need from
// the version control system, normalized — no provider SDK type crosses here.

import type { ActivitySnapshot, NormalizedIssue } from "../types.js";

// How the provider authenticates.
//
// App auth: the provider mints its own short-lived installation tokens (the
// main orchestrator process). Token auth: an already-minted installation
// token handed to the process in its environment (the MCP server, which gets
// one explicitly so it does not depend on how the agent CLI inherits its
// environment).
export type VcsAuth =
  | { kind: "app"; appId: string; privateKey: string; installationId: number }
  | { kind: "token"; token: string };

export interface VCSProvider {
  // Refreshed on every call — installation tokens are short-lived, and a
  // long-lived polling loop will outlive them. botLogin is the app's bot
  // account, used to tell mirella's own comments apart from human feedback.
  getInstallationToken(): Promise<{ token: string; botLogin: string }>;

  // GitHub uses "x-access-token" as username; other providers differ
  // (e.g. GitLab uses "oauth2") — this is why it's provider-supplied,
  // not hardcoded in git.ts.
  getGitCredentials(token: string): { username: string; password: string };

  listAgentIssues(label: string): Promise<NormalizedIssue[]>;

  // Returns everything payload.ts needs, already normalized: the issue's
  // comments plus, when the branch has a PR, the PR conversation, review
  // summaries, and inline review comments.
  fetchActivity(issueNumber: number, branch: string): Promise<ActivitySnapshot>;

  // Write methods return the URL of what was created or changed.
  postIssueComment(issueNumber: number, body: string): Promise<string>;
  postPrComment(prNumber: number, body: string): Promise<string>;
  createPullRequest(p: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
  updatePullRequest(p: {
    number: number;
    title?: string;
    body?: string;
    state?: "open" | "closed";
  }): Promise<{ number: number; url: string }>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
}