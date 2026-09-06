import { readFile } from "node:fs/promises";
import { App, type Octokit } from "octokit";

type Issue = Awaited<
  ReturnType<Octokit["rest"]["issues"]["listForRepo"]>
>["data"][number];

const AGENT_LABEL = "mirella-agent";

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
  return issues.filter((issue) =>
    (issue.labels ?? []).some(
      (label) =>
        (typeof label === "string" ? label : label.name) === AGENT_LABEL,
    ),
  );
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

  const { data: issues } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
  });

  console.log(`Found ${issues.length} open issue(s) in ${owner}/${repo}\n`);
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

    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issue.number,
    });

    for (const comment of comments) {
      console.log(`\n@${comment.user?.login}:`);
      console.log(`${comment.body}`);
    }
  }

  // await createComment(octokit, owner, repo, 100, "ciao");

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
}

main().catch((err) => {
  console.error("Failed to list issues:", err);
  process.exit(1);
});
