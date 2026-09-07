// Pure domain logic: turning a normalized issue + activity snapshot into the
// agent's work order and the orchestrator's bookkeeping state. Operates only
// on the types in types.ts — no provider SDK types, no harness details, no
// file paths.

import type {
  ActivitySnapshot,
  AgentPayload,
  CommentItem,
  IssueState,
  NormalizedIssue,
  ReviewCommentItem,
  ReviewItem,
} from "./types.js";

// Where the agent works this issue: repo, branches, and its own directory.
export interface TaskContext {
  owner: string;
  repo: string;
  baseBranch: string;
  branch: string;
  agentDir: string;
}

export interface IssueUpdate {
  // What the agent is woken with: the whole picture on the first run, only
  // the delta afterwards.
  payload: AgentPayload;
  // The whole conversation — issue with its current body, PR, and every
  // message so far — saved into agentDir on every wake-up so the agent can
  // always consult the full picture.
  conversation: AgentPayload;
  hasNew: boolean;
  nextState: IssueState;
}

// Sections without content are left undefined so they vanish from the JSON
// instead of arriving as empty noise.
function groupActivity(
  issueComments: CommentItem[],
  prComments: CommentItem[],
  reviews: ReviewItem[],
  reviewComments: ReviewCommentItem[],
): AgentPayload["activity"] {
  return {
    issue: issueComments.length > 0 ? { comments: issueComments } : undefined,
    pr:
      prComments.length > 0 || reviews.length > 0 || reviewComments.length > 0
        ? {
            comments: prComments.length > 0 ? prComments : undefined,
            reviews: reviews.length > 0 ? reviews : undefined,
            reviewComments:
              reviewComments.length > 0 ? reviewComments : undefined,
          }
        : undefined,
  };
}

// Assemble a payload: per-run context (repo, branches, agent dir), the
// issue, the PR, and the activity to process. `body` is omitted when the
// agent already knows it (delta runs on an unchanged body).
function buildPayload(
  ctx: TaskContext,
  issue: NormalizedIssue,
  snapshot: ActivitySnapshot,
  activity: AgentPayload["activity"],
  body?: string,
  bodyUpdated?: boolean,
): AgentPayload {
  return {
    repo: { owner: ctx.owner, name: ctx.repo },
    branch: ctx.branch,
    baseBranch: ctx.baseBranch,
    agentDir: ctx.agentDir,
    issue: {
      number: issue.number,
      title: issue.title,
      ...(body !== undefined ? { body } : {}),
      ...(bodyUpdated ? { bodyUpdated: true } : {}),
    },
    pr: snapshot.pr
      ? {
          number: snapshot.pr.number,
          title: snapshot.pr.title,
          state: snapshot.pr.state,
        }
      : undefined,
    activity,
  };
}

// A COMMENTED review with no body is just the envelope around its inline
// comments (delivered separately) — nothing worth showing on its own. The
// provider delivers reviews unfiltered; what reaches the payload is decided
// here.
function reviewWorthShowing(review: ReviewItem): boolean {
  return review.state !== "COMMENTED" || Boolean(review.body);
}

// Tiny FNV-1a — enough to notice that an issue body changed between polls.
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// Compute the agent's work order for this poll: everything on the first run
// for an issue, only the delta on later ones (the resumed session still
// remembers the rest). nextState records every id seen in this fetch —
// content that arrives mid-run lands in the next fetch, never lost.
export function buildIssueUpdate(
  issue: NormalizedIssue,
  snapshot: ActivitySnapshot,
  state: IssueState | undefined,
  botLogin: string,
  ctx: TaskContext,
): IssueUpdate {
  const seenComments = new Set(state?.seenCommentIds ?? []);
  const seenReviews = new Set(state?.seenReviewIds ?? []);
  const seenReviewComments = new Set(state?.seenReviewCommentIds ?? []);
  const fresh = state === undefined;

  // Mirella's own comments (summaries, PR announcements) must never count as
  // new activity, or every poll would wake the agent up to its own output.
  const notFromMirella = (comment: CommentItem) => comment.author !== botLogin;

  const prComments = snapshot.pr?.comments ?? [];
  const newIssueComments = snapshot.issueComments.filter(
    (comment) => !seenComments.has(comment.id) && notFromMirella(comment),
  );
  const newPrComments = prComments.filter(
    (comment) => !seenComments.has(comment.id) && notFromMirella(comment),
  );
  const newReviews = (snapshot.pr?.reviews ?? []).filter(
    (review) => !seenReviews.has(review.id),
  );
  const newReviewComments = (snapshot.pr?.reviewComments ?? []).filter(
    (reviewComment) => !seenReviewComments.has(reviewComment.id),
  );
  const bodyChanged =
    !fresh &&
    state?.issueBodyHash !== undefined &&
    state.issueBodyHash !== hashText(issue.body);

  const newReviewItems = newReviews.filter(reviewWorthShowing);
  const allIssueCommentItems = snapshot.issueComments;
  const allPrCommentItems = prComments;
  const allReviewItems = (snapshot.pr?.reviews ?? []).filter(
    reviewWorthShowing,
  );
  const allReviewCommentItems = snapshot.pr?.reviewComments ?? [];

  // A delta with nothing in it means no wake-up: everything here was either
  // already seen or written by mirella.
  const hasNew =
    fresh ||
    bodyChanged ||
    newIssueComments.length > 0 ||
    newPrComments.length > 0 ||
    newReviewItems.length > 0 ||
    newReviewComments.length > 0;

  // The wake-up payload: the whole picture on a first run, only the delta on
  // later ones (the resumed session still remembers the rest).
  const payload = fresh
    ? buildPayload(
        ctx,
        issue,
        snapshot,
        groupActivity(
          allIssueCommentItems,
          allPrCommentItems,
          allReviewItems,
          allReviewCommentItems,
        ),
        issue.body,
      )
    : buildPayload(
        ctx,
        issue,
        snapshot,
        groupActivity(
          newIssueComments,
          newPrComments,
          newReviewItems,
          newReviewComments,
        ),
        // Later runs: the body travels with the payload only when it
        // changed, flagged so the agent knows to re-read it.
        bodyChanged ? issue.body : undefined,
        bodyChanged ? true : undefined,
      );

  // The whole conversation, always complete: current body, PR, and every
  // message so far.
  const conversation = fresh
    ? payload
    : buildPayload(
        ctx,
        issue,
        snapshot,
        groupActivity(
          allIssueCommentItems,
          allPrCommentItems,
          allReviewItems,
          allReviewCommentItems,
        ),
        issue.body,
      );

  const nextState: IssueState = {
    // Mark everything present in this fetch, bot comments included (they are
    // seen — deliberately ignored).
    seenCommentIds: [
      ...(state?.seenCommentIds ?? []),
      ...snapshot.issueComments.map((c) => c.id),
      ...prComments.map((c) => c.id),
    ],
    seenReviewIds: [
      ...(state?.seenReviewIds ?? []),
      ...(snapshot.pr?.reviews ?? []).map((r) => r.id),
    ],
    seenReviewCommentIds: [
      ...(state?.seenReviewCommentIds ?? []),
      ...(snapshot.pr?.reviewComments ?? []).map((rc) => rc.id),
    ],
    issueBodyHash: hashText(issue.body),
  };

  return { payload, conversation, hasNew, nextState };
}