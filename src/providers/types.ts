// The VCS boundary: everything the orchestrator and the MCP server need from
// the version control system, normalized — no provider SDK type crosses here.

import type { ActivitySnapshot, NormalizedIssue } from "../types.js";

// The identity commits are authored with — provider-supplied, since the
// email domain (and how a bot identity maps to one) differs per host.
export interface CommitIdentity {
  name: string;
  email: string;
}

// How much request quota the VCS gives this process and how much is left.
// resetEpochSeconds is the UTC epoch second at which the window resets.
// undefined = the provider offers no rate-limit information; callers fall
// back to their configured cadence.
export interface RateLimitStatus {
  remaining: number;
  limit: number;
  resetEpochSeconds: number;
}

export interface VCSProvider {
  // Refreshed on every call — installation tokens are short-lived, and a
  // long-lived polling loop will outlive them. botLogin is the app's bot
  // account, used to tell mirella's own comments apart from human feedback.
  getInstallationToken(): Promise<{ token: string; botLogin: string }>;

  // GitHub uses "x-access-token" as username; other providers differ
  // (e.g. GitLab uses "oauth2") — this is why it's provider-supplied,
  // not hardcoded in git.ts.
  getGitCredentials(token: string): { username: string; password: string };

  // The URL git clones/fetches/pushes against. Provider-specific by nature
  // (hosting layout differs) — the orchestrator never builds one itself.
  getRepoUrl(): string;

  // The identity commits are authored with (see CommitIdentity).
  getCommitIdentity(): CommitIdentity;

  // Current rate-limit status, when the provider exposes one — callers use
  // it to respect the host's limits instead of hammering its API.
  getRateLimit(): Promise<RateLimitStatus | undefined>;

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