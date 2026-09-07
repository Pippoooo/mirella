import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ENV, requireEnv } from "../env.js";
import { createLogger } from "../logger.js";
import { readVcsContext } from "../config.js";
import { createTokenProvider } from "../providers/factory.js";
import type { VCSProvider } from "../providers/types.js";

// IMPORTANT: this process talks to Claude Code over stdio — stdout IS the
// JSON-RPC protocol channel. Anything but JSON-RPC on stdout would corrupt
// every message after it, so the logger is stderr-only (visible via
// `claude --debug` or under ~/.cache/claude-cli-nodejs/, not on the console).
const log = createLogger("vcs-tools", { stderr: true });

// Per-run context, passed as CLI args by the harness when it bakes the MCP
// config (see writeMcpConfig in harness/claude-code.ts): which issue and
// branch this server instance is serving. Required — without them the tools
// would silently target the wrong issue.
const { values } = parseArgs({
  options: {
    issue: { type: "string" },
    branch: { type: "string" },
  },
});
if (!values.issue || !values.branch) {
  throw new Error(
    "vcs-server requires --issue <number> and --branch <name> arguments",
  );
}
const issueNumber = Number(values.issue);
if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
  throw new Error(`--issue must be a positive integer, got: ${values.issue}`);
}
const branch = values.branch;

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
    const vcs = readVcsContext();
    ctx = {
      provider: await createTokenProvider(
        {
          type: vcs.providerType,
          owner: vcs.owner,
          repo: vcs.repo,
        },
        requireEnv(ENV.gitToken),
      ),
      owner: vcs.owner,
      repo: vcs.repo,
      baseBranch: vcs.baseBranch,
      issueNumber,
      branch,
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
    log.error("tool failed:", message);
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
      log.info(
        `post_issue_comment -> ${ctx.owner}/${ctx.repo}#${ctx.issueNumber}`,
      );
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
      log.info(`post_pr_comment -> ${ctx.owner}/${ctx.repo}#${number}`);
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
      log.info(`create_pull_request -> ${ctx.branch} -> ${baseBranch}`);
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
      log.info(`update_pull_request -> PR #${input.number}`, input);
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
      log.info(
        `add_labels -> ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} ${labels.join(", ")}`,
      );
      await ctx.provider.addLabels(ctx.issueNumber, labels);
      return `Added labels: ${labels.join(", ")}`;
    }),
);

server.connect(new StdioServerTransport());