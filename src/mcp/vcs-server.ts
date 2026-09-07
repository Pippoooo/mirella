import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createProvider } from "../providers/factory.js";
import type { VCSProvider } from "../providers/types.js";

// IMPORTANT: this process talks to Claude Code over stdio — stdout IS the
// JSON-RPC protocol channel. console.log() here would corrupt every message
// after it. All human-readable logging goes to stderr instead (visible via
// `claude --debug` or under ~/.cache/claude-cli-nodejs/, not on the console).
function log(...args: unknown[]): void {
  console.error("[vcs-tools]", ...args);
}

// Context the orchestrator bakes into this process's environment for each
// run (see writeConfig in harness/claude-code.ts): which repo/issue/branch
// the agent is working on, and the installation token to write with.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

interface Context {
  provider: VCSProvider;
  owner: string;
  repo: string;
  baseBranch: string;
  issueNumber: number;
  branch: string;
}

let context: Context | undefined;

async function getContext(): Promise<Context> {
  let ctx = context;
  if (!ctx) {
    // The provider comes from the same factory the main process uses — the
    // only difference is auth: this process is handed a short-lived
    // installation token in its environment instead of App credentials, so
    // it does not depend on how claude inherits its environment.
    const owner = requireEnv("GITHUB_OWNER");
    const repo = requireEnv("GITHUB_REPO");
    ctx = {
      provider: await createProvider({
        type: process.env.VCS_PROVIDER ?? "github",
        owner,
        repo,
        auth: { kind: "token", token: requireEnv("MIRELLA_GIT_TOKEN") },
      }),
      owner,
      repo,
      baseBranch: requireEnv("GITHUB_BASE_BRANCH"),
      issueNumber: Number(requireEnv("MIRELLA_ISSUE_NUMBER")),
      branch: requireEnv("MIRELLA_BRANCH"),
    };
    context = ctx;
  }
  return ctx;
}

// Wraps every tool so failures come back to the agent as tool output instead
// of crashing the server (which would take all the tools down with it). The
// provider already enriches its errors with the human-readable part of the
// underlying API response — this just turns whatever escaped into a message.
async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
      const ctx = await getContext();
      log(`post_issue_comment -> ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}`);
      return `Comment posted: ${await ctx.provider.postIssueComment(ctx.issueNumber, body)}`;
    }),
);

server.tool(
  "post_pr_comment",
  "Post a comment on a pull request's discussion.",
  { number: z.number(), body: z.string() },
  async ({ number, body }) =>
    run(async () => {
      const ctx = await getContext();
      log(`post_pr_comment -> ${ctx.owner}/${ctx.repo}#${number}`);
      return `Comment posted: ${await ctx.provider.postPrComment(number, body)}`;
    }),
);

server.tool(
  "create_pull_request",
  "Open a pull request from the current branch once the work is ready for review.",
  { title: z.string(), body: z.string(), base: z.string().optional() },
  async ({ title, body, base }) =>
    run(async () => {
      const ctx = await getContext();
      const baseBranch = base ?? ctx.baseBranch;
      log(`create_pull_request -> ${ctx.branch} -> ${baseBranch}`);
      const pr = await ctx.provider.createPullRequest({
        branch: ctx.branch,
        base: baseBranch,
        title,
        body,
      });
      // Announce the PR on the original issue.
      await ctx.provider.postIssueComment(
        ctx.issueNumber,
        `Opened PR #${pr.number}: ${pr.url}`,
      );
      return `Opened PR #${pr.number}: ${pr.url}`;
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
      const ctx = await getContext();
      log(`update_pull_request -> PR #${input.number}`, input);
      const pr = await ctx.provider.updatePullRequest({
        number: input.number,
        title: input.title,
        body: input.body,
        state: input.state,
      });
      return `Updated PR #${pr.number}: ${pr.url}`;
    }),
);

server.tool(
  "add_labels",
  "Add one or more labels to the current issue.",
  { labels: z.array(z.string()) },
  async ({ labels }) =>
    run(async () => {
      const ctx = await getContext();
      log(
        `add_labels -> ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} ${labels.join(", ")}`,
      );
      await ctx.provider.addLabels(ctx.issueNumber, labels);
      return `Added labels: ${labels.join(", ")}`;
    }),
);

server.connect(new StdioServerTransport());