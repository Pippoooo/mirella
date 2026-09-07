// Normalized domain types shared across the three boundaries (VCS provider,
// agent harness, issue state store). Nothing here may reference Octokit, the
// claude CLI, or concrete file paths — those are implementation details
// behind their boundaries.

// An issue as the orchestrator sees it: exactly what payload logic needs,
// stripped of everything provider-specific (labels, PR flags, ...) that only
// the provider's own filtering touches.
export interface NormalizedIssue {
  number: number;
  title: string;
  body: string;
}

// One message for the agent. There is no per-item channel field: an item's
// place in the payload IS its channel (issue thread vs pull request), which
// is what routes replies to the right post_* tool. The schema is documented
// for the agent in CLAUDE.md.
export interface CommentItem {
  id: number;
  author: string;
  body: string;
}

export interface ReviewItem extends CommentItem {
  state: string; // APPROVED / CHANGES_REQUESTED / COMMENTED
}

export interface ReviewCommentItem extends CommentItem {
  path: string;
  line: number | null; // null once the comment is outdated and unanchored
}

// Everything fetchActivity returns for one issue, already normalized: the
// issue's own comments, and — when the branch has a PR — the PR conversation,
// review summaries, and inline review comments. Reviews arrive unfiltered;
// payload.ts decides what is worth showing.
export interface ActivitySnapshot {
  issueComments: CommentItem[];
  pr?: {
    number: number;
    title: string;
    state: string;
    comments: CommentItem[];
    reviews: ReviewItem[];
    reviewComments: ReviewCommentItem[];
  };
}

// The structured work order handed to the agent on each wake-up: where it
// works, the issue it implements, the PR (if any), and the messages to
// process, grouped by channel — everything on a first run, only the delta on
// later ones. Empty sections are simply left out of the JSON (undefined keys
// vanish on stringify).
export interface AgentPayload {
  repo: { owner: string; name: string };
  branch: string;
  baseBranch: string;
  // The agent's own directory (its scratch space; mirella also keeps the
  // whole conversation there as conversation.json). Documented in CLAUDE.md.
  agentDir: string;
  issue: {
    number: number;
    title: string;
    // Present on the first run and again whenever the body changed since; a
    // continuation that already knows the body gets neither field.
    body?: string;
    bodyUpdated?: boolean;
  };
  pr?: { number: number; title: string; state: string };
  activity: {
    issue?: { comments: CommentItem[] };
    pr?: {
      comments?: CommentItem[];
      reviews?: ReviewItem[];
      reviewComments?: ReviewCommentItem[];
    };
  };
}

// Per-issue memory of what the agent has already been shown, plus the session
// to resume. The file store keeps it beside conversation.json in the agent's
// own directory — see store/file-store.ts. Since agent sessions persist
// across runs, re-sending old messages would only duplicate context the
// agent still remembers — so later runs deliver only the delta.
export interface IssueState {
  sessionId?: string;
  seenCommentIds: number[]; // issue comments AND PR conversation comments
  seenReviewIds: number[];
  seenReviewCommentIds: number[];
  issueBodyHash?: string; // detects issue-body edits between polls
}