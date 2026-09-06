import { readFile } from "node:fs/promises";
import { App, type Octokit } from "octokit";

type Issue = Awaited<
  ReturnType<Octokit["rest"]["issues"]["listForRepo"]>
>["data"][number];

type PullRequest = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["create"]>
>["data"];

const AGENT_LABEL = "mirella-agent";

// ISO 8601 timestamp of the last successful poll; used as the `since` filter
// for incremental fetching. Undefined on the first poll (full fetch).
let lastPolledAt: string | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function loadPrivateKey(): Promise<string> {
  // Preferred: read the PEM from a file (easy to mount into the container).
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    return readFile(path, "utf8");
  }

  // Fallback: inline PEM, with literal "\n" sequences turned back into newlines.
  const key = requireEnv("GITHUB_APP_PRIVATE_KEY");
  return key.replaceAll("\\n", "\n");
}

async function createComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

function issuesWithAgentLabel(issues: Issue[]): Issue[] {
  return issues.filter(
    (issue) =>
      // GitHub returns PRs mixed into issue listings; PRs are handled
      // separately and must not match the agent-label filter.
      !issue.pull_request &&
      (issue.labels ?? []).some(
        (label) =>
          (typeof label === "string" ? label : label.name) === AGENT_LABEL,
      ),
  );
}

async function createPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseBranch: string,
  issueNumber: number,
  title: string,
): Promise<PullRequest> {
  // Create a branch from the base branch
  const { data: baseRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });

  const headBranch = `mirella/issue-${issueNumber}`;
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${headBranch}`,
    sha: baseRef.object.sha,
  });

  // Create a commit with a dummy file so the PR has commits
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: ".mirella/placeholder",
    message: "mirella: add placeholder file",
    content: Buffer.from("mirella placeholder\n").toString("base64"),
    branch: headBranch,
  });

  // Create PR
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    head: headBranch,
    base: baseBranch,
  });

  // Comment on the original issue to communicate that the PR exists
  await createComment(
    octokit,
    owner,
    repo,
    issueNumber,
    `Opened PR #${pr.number}: ${pr.html_url}`,
  );

  return pr;
}

async function main(): Promise<void> {
  const appId = requireEnv("GITHUB_APP_ID");
  const installationId = Number(requireEnv("GITHUB_INSTALLATION_ID"));
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const baseBranch = requireEnv("GITHUB_BASE_BRANCH");
  const privateKey = await loadPrivateKey();

  if (Number.isNaN(installationId)) {
    console.error("GITHUB_INSTALLATION_ID must be a number");
    process.exit(1);
  }

  const app = new App({ appId, privateKey });

  const octokit = await app.getInstallationOctokit(installationId);

  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    sort: "updated",
    since: lastPolledAt,
    per_page: 100,
  });

  console.log(
    `Found ${issues.length} open issue(s) in ${owner}/${repo}` +
      (lastPolledAt ? ` updated since ${lastPolledAt}` : "") +
      `\n`,
  );
  for (const issue of issues) {
    console.log(`#${issue.number} ${issue.title}`);
  }

  const agentIssues = issuesWithAgentLabel(issues);
  console.log(
    `\n${agentIssues.length} issue(s) labeled "${AGENT_LABEL}" (base branch: ${baseBranch}):`,
  );

  console.log();
  for (const issue of agentIssues) {
    console.log(`#${issue.number} ${issue.title}`);
    console.log(`${issue.body}`);

    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issue.number,
      sort: "updated",
      direction: "asc",
      since: lastPolledAt,
      per_page: 100,
    });

    for (const comment of comments) {
      console.log(`\n@${comment.user?.login}:`);
      console.log(`${comment.body}`);
    }
  }

  // await createComment(octokit, owner, repo, 100, "ciao");

  // await createPullRequest(octokit, owner, repo, baseBranch, 3, "My bot PR 1");

  // Read PR comments
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: 3,
    sort: "updated",
    direction: "asc",
    since: lastPolledAt,
    per_page: 100,
  });

  // Read PR reviews
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: 3,
    per_page: 100,
  });

  // Read inline PR review comments (line-attached feedback)
  const reviewComments = await octokit.paginate(
    octokit.rest.pulls.listReviewComments,
    { owner, repo, pull_number: 3, per_page: 100 },
  );

  console.log();
  console.log(
    `Pull request #3 — ${comments.length} comment(s), ${reviews.length} review(s), ${reviewComments.length} inline review comment(s):`,
  );

  for (const comment of comments) {
    console.log(`\n@${comment.user?.login}:`);
    console.log(`${comment.body}`);
  }

  for (const review of reviews) {
    console.log(
      `\n${review.submitted_at} @${review.user?.login} [${review.state}] #commit:${review.commit_id}:`,
    );
    console.log(`${review.body || "(no body)"}`);
  }

  for (const reviewComment of reviewComments) {
    const line = reviewComment.line ?? reviewComment.original_line ?? "?";
    console.log(
      `\n${reviewComment.created_at} @${reviewComment.user?.login} [${reviewComment.path}:${line}] #commit:${reviewComment.commit_id}:`,
    );
    console.log(`${reviewComment.body}`);
  }

  try {
    await octokit.rest.issues.getLabel({
      owner,
      repo,
      name: AGENT_LABEL,
    });
  } catch (e: any) {
    if (e.status === 404) {
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name: AGENT_LABEL,
        color: "000000",
        description: "use this label to assign mirella to this issue",
      });
    } else {
      throw e;
    }
  }

  // Mark the poll as complete so the next run fetches incrementally
  lastPolledAt = new Date().toISOString();
}

main().catch((err) => {
  console.error("Failed to list issues:", err);
  process.exit(1);
});