import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "octokit";
import { z } from "zod";

// IMPORTANT: this process talks to Claude Code over stdio — stdout IS the
// JSON-RPC protocol channel. console.log() here would corrupt every message
// after it. All human-readable logging goes to stderr instead (visible via
// `claude --debug` or under ~/.cache/claude-cli-nodejs/, not on the console).
function log(...args: unknown[]): void {
  console.error("[vcs-tools]", ...args);
}

// Context the orchestrator bakes into this process's environment for each
// run (see writeMcpConfig in index.ts): which repo/issue/branch the agent is
// working on, and the GitHub App installation token to write with.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

interface Context {
  octokit: Octokit;
  owner: string;
  repo: string;
  baseBranch: string;
  issueNumber: number;
  branch: string;
}

let context: Context | undefined;

function getContext(): Context {
  if (!context) {
    context = {
      octokit: new Octokit({ auth: requireEnv("MIRELLA_GIT_TOKEN") }),
      owner: requireEnv("GITHUB_OWNER"),
      repo: requireEnv("GITHUB_REPO"),
      baseBranch: requireEnv("GITHUB_BASE_BRANCH"),
      issueNumber: Number(requireEnv("MIRELLA_ISSUE_NUMBER")),
      branch: requireEnv("MIRELLA_BRANCH"),
    };
  }
  return context;
}

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

// Wraps every tool so failures come back to the agent as tool output instead
// of crashing the server (which would take all the tools down with it).
async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    const message = errorMessage(err);
    log("tool failed:", message);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}

const server = new McpServer({ name: "vcs-tools", version: "0.1.0" });

// Issue and PR conversation comments go through the same issues endpoint —
// they are separate tools so the agent picks the channel explicitly instead
// of defaulting to the issue.
server.tool(
  "post_issue_comment",
  "Post a comment on the issue mirella is working on.",
  { body: z.string() },
  async ({ body }) =>
    run(async () => {
      const ctx = getContext();
      log(`post_issue_comment -> ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}`);
      const { data } = await ctx.octokit.rest.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.issueNumber,
        body,
      });
      return `Comment posted: ${data.html_url}`;
    }),
);

server.tool(
  "post_pr_comment",
  "Post a comment on a pull request's discussion.",
  { number: z.number(), body: z.string() },
  async ({ number, body }) =>
    run(async () => {
      const ctx = getContext();
      log(`post_pr_comment -> ${ctx.owner}/${ctx.repo}#${number}`);
      const { data } = await ctx.octokit.rest.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: number,
        body,
      });
      return `Comment posted: ${data.html_url}`;
    }),
);

server.tool(
  "create_pull_request",
  "Open a pull request from the current branch once the work is ready for review.",
  { title: z.string(), body: z.string(), base: z.string().optional() },
  async ({ title, body, base }) =>
    run(async () => {
      const ctx = getContext();
      const baseBranch = base ?? ctx.baseBranch;
      log(`create_pull_request -> ${ctx.branch} -> ${baseBranch}`);
      // No branch/dummy-commit setup here: the agent pushes real commits to
      // its branch before opening the PR (github.ts only needed the
      // placeholder commit because it created PRs with no branch work).
      try {
        const { data: pr } = await ctx.octokit.rest.pulls.create({
          owner: ctx.owner,
          repo: ctx.repo,
          title,
          body,
          head: ctx.branch,
          base: baseBranch,
        });
        // Announce the PR on the original issue, like github.ts does.
        await ctx.octokit.rest.issues.createComment({
          owner: ctx.owner,
          repo: ctx.repo,
          issue_number: ctx.issueNumber,
          body: `Opened PR #${pr.number}: ${pr.html_url}`,
        });
        return `Opened PR #${pr.number}: ${pr.html_url}`;
      } catch (err) {
        // 422 usually means "No commits between base and head" — tell the
        // agent how to fix it instead of leaving a cryptic error.
        if ((err as { status?: number }).status === 422) {
          throw new Error(
            `${errorMessage(err)} (does ${ctx.branch} have commits on origin? commit and push first)`,
          );
        }
        throw err;
      }
    }),
);

server.tool(
  "update_pull_request",
  "Update the title, body, or state of an existing pull request.",
  {
    number: z.number(),
    title: z.string().optional(),
    body: z.string().optional(),
    state: z.enum(["open", "closed"]).optional(),
  },
  async (input) =>
    run(async () => {
      const ctx = getContext();
      log(`update_pull_request -> PR #${input.number}`, input);
      const { data: pr } = await ctx.octokit.rest.pulls.update({
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: input.number,
        title: input.title,
        body: input.body,
        state: input.state,
      });
      return `Updated PR #${pr.number}: ${pr.html_url}`;
    }),
);

server.tool(
  "add_labels",
  "Add one or more labels to the current issue.",
  { labels: z.array(z.string()) },
  async ({ labels }) =>
    run(async () => {
      const ctx = getContext();
      log(
        `add_labels -> ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} ${labels.join(", ")}`,
      );
      try {
        await ctx.octokit.rest.issues.addLabels({
          owner: ctx.owner,
          repo: ctx.repo,
          issue_number: ctx.issueNumber,
          labels,
        });
      } catch (err) {
        // GitHub rejects labels that don't exist yet — create them, then
        // retry once (createLabel 422s if it already exists; that's fine).
        const status = (err as { status?: number }).status;
        if (status !== 404 && status !== 422) throw err;
        for (const label of labels) {
          await ctx.octokit.rest.issues
            .createLabel({ owner: ctx.owner, repo: ctx.repo, name: label })
            .catch(() => {});
        }
        await ctx.octokit.rest.issues.addLabels({
          owner: ctx.owner,
          repo: ctx.repo,
          issue_number: ctx.issueNumber,
          labels,
        });
      }
      return `Added labels: ${labels.join(", ")}`;
    }),
);

server.connect(new StdioServerTransport());
