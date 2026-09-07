// The GitHub implementation of the VCS boundary: all App/Octokit logic lives
// here and nowhere else — including how this provider authenticates (App
// credentials read from the environment, or a pre-minted token handed to the
// MCP server) and what it knows about rate limits.

import { readFile } from "node:fs/promises";
import { App, Octokit } from "octokit";
import { ENV, requireEnv } from "../env.js";
import type {
  ActivitySnapshot,
  CommentItem,
  NormalizedIssue,
  ReviewCommentItem,
  ReviewItem,
} from "../types.js";
import type {
  CommitIdentity,
  RateLimitStatus,
  VCSProvider,
} from "./types.js";

type Issue = Awaited<
  ReturnType<Octokit["rest"]["issues"]["listForRepo"]>
>["data"][number];

type IssueComment = Awaited<
  ReturnType<Octokit["rest"]["issues"]["listComments"]>
>["data"][number];

type PullRequest = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["list"]>
>["data"][number];

type Review = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["listReviews"]>
>["data"][number];

type ReviewComment = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["listReviewComments"]>
>["data"][number];

// Pull the human-readable part out of an octokit error — RequestError.message
// is often just "Validation Failed" while the useful text sits in the
// response body's errors array.
function errorMessage(err: unknown): string {
  const e = err as {
    message?: string;
    response?: {
      data?: { message?: string; errors?: (string | { message?: string })[] };
    };
  };
  const parts = [e.message ?? String(err)];
  const data = e.response?.data;
  if (data?.errors) {
    for (const item of data.errors) {
      parts.push(typeof item === "string" ? item : (item.message ?? ""));
    }
  } else if (data?.message) {
    parts.push(data.message);
  }
  return parts.filter(Boolean).join(": ");
}

function toCommentItem(comment: IssueComment): CommentItem {
  return {
    id: comment.id,
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
  };
}

function toReviewItem(review: Review): ReviewItem {
  return {
    id: review.id,
    author: review.user?.login ?? "unknown",
    state: review.state,
    body: review.body ?? "",
  };
}

function toReviewCommentItem(reviewComment: ReviewComment): ReviewCommentItem {
  return {
    id: reviewComment.id,
    author: reviewComment.user?.login ?? "unknown",
    path: reviewComment.path,
    // null once the comment is outdated and no longer anchored to a line
    line: reviewComment.line ?? reviewComment.original_line ?? null,
    body: reviewComment.body ?? "",
  };
}

// Everything the agent can only see through the PR, in raw provider shape.
interface PrActivity {
  pr: PullRequest;
  comments: IssueComment[];
  reviews: Review[];
  reviewComments: ReviewComment[];
}

export interface GithubProviderConfig {
  owner: string;
  repo: string;
}

// GitHub App credentials: read the PEM from a file if one is mounted
// (easy to mount into the container), fall back to an inline PEM with
// literal "\n" sequences turned back into newlines.
async function loadPrivateKey(): Promise<string> {
  const path = process.env[ENV.githubAppPrivateKeyPath];
  if (path) {
    return readFile(path, "utf8");
  }
  const key = requireEnv(ENV.githubAppPrivateKey);
  return key.replaceAll("\\n", "\n");
}

// App auth: the provider mints its own short-lived installation tokens from
// the App's private key (the main orchestrator process). All App-specific
// environment reading happens here — the agnostic config layer knows only
// that a "github" provider exists.
export async function createGithubProvider(
  config: GithubProviderConfig,
): Promise<VCSProvider> {
  const appId = requireEnv(ENV.githubAppId);
  const installationId = Number(requireEnv(ENV.githubInstallationId));
  const privateKey = await loadPrivateKey();
  const app = new App({ appId, privateKey });
  const octokit = await app.getInstallationOctokit(installationId);
  return new GithubProvider(config.owner, config.repo, app, octokit);
}

// Token auth: an already-minted installation token handed to the process
// (the MCP server, which gets one explicitly so it does not depend on how
// the agent CLI inherits its environment).
export async function createGithubTokenProvider(
  config: GithubProviderConfig,
  token: string,
): Promise<VCSProvider> {
  return new GithubProvider(
    config.owner,
    config.repo,
    undefined,
    new Octokit({ auth: token }),
  );
}

class GithubProvider implements VCSProvider {
  private botLoginCache: string | undefined;
  private rateLimitCache: RateLimitStatus | undefined;

  constructor(
    private readonly owner: string,
    private readonly repo: string,
    // App-level client — only present with app auth; needed for `GET /app`,
    // which requires the app JWT rather than an installation token.
    private readonly app: App | undefined,
    private readonly octokit: Octokit,
  ) {
    // Record the rate-limit status from every successful response (headers:
    // x-ratelimit-remaining / -limit / -reset, reset as UTC epoch seconds).
    // paginate() returns data only, but every request path — rest methods
    // and paginate's internal requests alike — funnels through this hook,
    // so the cache stays current without extra API calls. Filtered on the
    // resource header: the rate_limit endpoint's own response describes the
    // rate_limit resource (limit ~100), not the core limit this process
    // actually spends.
    this.octokit.hook.after("request", (response) => {
      const h = response.headers as Record<string, string | number | undefined>;
      if (h["x-ratelimit-resource"] !== "core") return;
      const remaining = Number(h["x-ratelimit-remaining"]);
      const limit = Number(h["x-ratelimit-limit"]);
      const reset = Number(h["x-ratelimit-reset"]);
      if (
        !Number.isFinite(remaining) ||
        !Number.isFinite(limit) ||
        limit <= 0 ||
        !Number.isFinite(reset)
      ) {
        return;
      }
      this.rateLimitCache = {
        remaining,
        limit,
        resetEpochSeconds: reset,
      };
    });
  }

  async getInstallationToken(): Promise<{ token: string; botLogin: string }> {
    if (!this.app) {
      throw new Error(
        "getInstallationToken requires app auth; this provider was created with a static token",
      );
    }
    // Refresh on every call — the token expires after ~1h, which a long-lived
    // polling loop will outlive.
    const { token } = (await this.octokit.auth({
      type: "installation",
    })) as { token: string };
    return { token, botLogin: await this.botLogin() };
  }

  // The app's bot account, so mirella's own comments can be told apart from
  // human feedback. Fetched once, cached.
  private async botLogin(): Promise<string> {
    if (this.botLoginCache) return this.botLoginCache;
    const { data: appInfo } =
      await this.app!.octokit.rest.apps.getAuthenticated();
    if (!appInfo?.slug) {
      console.error(
        "Warning: could not determine the app's bot login — mirella's own comments will not be filtered from the conversation.",
      );
    }
    this.botLoginCache = `${appInfo?.slug ?? "unknown"}[bot]`;
    return this.botLoginCache;
  }

  getGitCredentials(token: string): { username: string; password: string } {
    return { username: "x-access-token", password: token };
  }

  getRepoUrl(): string {
    return `https://github.com/${this.owner}/${this.repo}.git`;
  }

  // Constant identity — commits are authored by the mirella agent, on the
  // GitHub no-reply domain (the email is GitHub-specific; other providers
  // will supply their own).
  getCommitIdentity(): CommitIdentity {
    return { name: "mirella-agent", email: "mirella-agent@users.noreply.github.com" };
  }

  // The latest rate-limit status seen on a response; before any request has
  // succeeded in this process, fall back to GET /rate_limit — a free call
  // (it does not count against the core limit).
  async getRateLimit(): Promise<RateLimitStatus | undefined> {
    if (this.rateLimitCache) return this.rateLimitCache;
    const { data } = await this.octokit.rest.rateLimit.get();
    const core = data.resources.core;
    this.rateLimitCache = {
      remaining: core.remaining,
      limit: core.limit,
      resetEpochSeconds: core.reset,
    };
    return this.rateLimitCache;
  }

  async listAgentIssues(label: string): Promise<NormalizedIssue[]> {
    const issues = await this.octokit.paginate(
      this.octokit.rest.issues.listForRepo,
      {
        owner: this.owner,
        repo: this.repo,
        state: "open",
        per_page: 100,
      },
    );
    return issues
      .filter(
        (issue) =>
          // GitHub returns PRs mixed into issue listings; PRs are handled
          // separately and must not match the agent-label filter.
          !issue.pull_request &&
          (issue.labels ?? []).some(
            (l) => (typeof l === "string" ? l : l.name) === label,
          ),
      )
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
      }));
  }

  async fetchActivity(
    issueNumber: number,
    branch: string,
  ): Promise<ActivitySnapshot> {
    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        sort: "updated",
        direction: "asc",
        per_page: 100,
      },
    );

    // Reviews and inline comments only exist on the PR, not on the issue —
    // fold them into the snapshot so re-runs see reviewer feedback.
    const prActivity = await this.fetchPrActivity(branch);

    return {
      issueComments: comments.map(toCommentItem),
      pr: prActivity
        ? {
            number: prActivity.pr.number,
            title: prActivity.pr.title,
            state: prActivity.pr.state,
            comments: prActivity.comments.map(toCommentItem),
            reviews: prActivity.reviews.map(toReviewItem),
            reviewComments: prActivity.reviewComments.map(toReviewCommentItem),
          }
        : undefined,
    };
  }

  // Fetch everything the agent can only see through the PR: the PR
  // conversation thread, review summaries, and inline review comments
  // attached to lines. Returns undefined when the branch has no PR yet.
  private async fetchPrActivity(
    branch: string,
  ): Promise<PrActivity | undefined> {
    const { data: prs } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      // head filter format is "user:branch"
      head: `${this.owner}:${branch}`,
      state: "all",
      per_page: 100,
    });
    // Prefer the open PR; fall back to the first listed one so feedback on a
    // closed PR still reaches the agent.
    const pr = prs.find((p) => p.state === "open") ?? prs[0];
    if (!pr) {
      return undefined;
    }

    const [comments, reviews, reviewComments] = await Promise.all([
      // PR conversation comments live in the issues namespace.
      this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner: this.owner,
        repo: this.repo,
        issue_number: pr.number,
        sort: "updated",
        direction: "asc",
        per_page: 100,
      }),
      this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
        owner: this.owner,
        repo: this.repo,
        pull_number: pr.number,
        per_page: 100,
      }),
      this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, {
        owner: this.owner,
        repo: this.repo,
        pull_number: pr.number,
        per_page: 100,
      }),
    ]);

    return { pr, comments, reviews, reviewComments };
  }

  // Wraps an API call so failures carry the human-readable part of the
  // underlying error (see errorMessage) while keeping the HTTP status for
  // callers that branch on it.
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const wrapped: Error & { status?: number } = new Error(
        errorMessage(err),
      );
      if (typeof status === "number") wrapped.status = status;
      throw wrapped;
    }
  }

  async postIssueComment(issueNumber: number, body: string): Promise<string> {
    return this.call(async () => {
      const { data } = await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body,
      });
      return data.html_url;
    });
  }

  // PR conversation comments go through the issues endpoint — a PR is an
  // issue to that API.
  async postPrComment(prNumber: number, body: string): Promise<string> {
    return this.postIssueComment(prNumber, body);
  }

  async createPullRequest(p: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }> {
    try {
      return await this.call(async () => {
        const { data: pr } = await this.octokit.rest.pulls.create({
          owner: this.owner,
          repo: this.repo,
          title: p.title,
          body: p.body,
          head: p.branch,
          base: p.base,
        });
        return { number: pr.number, url: pr.html_url };
      });
    } catch (err) {
      // 422 usually means "No commits between base and head" — tell the
      // agent how to fix it instead of leaving a cryptic error.
      if ((err as { status?: number }).status === 422) {
        throw new Error(
          `${(err as Error).message} (does ${p.branch} have commits on origin? commit and push first)`,
        );
      }
      throw err;
    }
  }

  async updatePullRequest(p: {
    number: number;
    title?: string;
    body?: string;
    state?: "open" | "closed";
  }): Promise<{ number: number; url: string }> {
    return this.call(async () => {
      const { data: pr } = await this.octokit.rest.pulls.update({
        owner: this.owner,
        repo: this.repo,
        pull_number: p.number,
        title: p.title,
        body: p.body,
        state: p.state,
      });
      return { number: pr.number, url: pr.html_url };
    });
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.call(async () => {
      try {
        await this.octokit.rest.issues.addLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          labels,
        });
      } catch (err) {
        // GitHub rejects labels that don't exist yet — create them, then
        // retry once (createLabel 422s if it already exists; that's fine).
        const status = (err as { status?: number }).status;
        if (status !== 404 && status !== 422) throw err;
        for (const label of labels) {
          await this.octokit.rest.issues
            .createLabel({ owner: this.owner, repo: this.repo, name: label })
            .catch(() => {});
        }
        await this.octokit.rest.issues.addLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          labels,
        });
      }
    });
  }
}