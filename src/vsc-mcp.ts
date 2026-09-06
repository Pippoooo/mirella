import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// IMPORTANT: this process talks to Claude Code over stdio — stdout IS the
// JSON-RPC protocol channel. console.log() here would corrupt every message
// after it. All human-readable logging goes to stderr instead.
function log(...args: unknown[]): void {
  console.error("[vcs-tools]", ...args);
}

const server = new McpServer({ name: "vcs-tools", version: "0.1.0" });

server.tool(
  "post_comment",
  "Post a comment on the current issue or pull request.",
  { body: z.string() },
  async ({ body }) => {
    log("post_comment ->", body);
    return { content: [{ type: "text", text: "[MOCK] Comment posted." }] };
  },
);

server.tool(
  "create_pull_request",
  "Open a pull request from the current branch once the work is ready for review.",
  {
    title: z.string(),
    body: z.string(),
    base: z.string().default("main"),
  },
  async ({ title, body, base }) => {
    log("create_pull_request ->", { title, base, body });
    return {
      content: [
        {
          type: "text",
          text: "[MOCK] Opened PR #1: https://github.com/mock/pr/1",
        },
      ],
    };
  },
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
  async (input) => {
    log("update_pull_request ->", input);
    return {
      content: [{ type: "text", text: `[MOCK] Updated PR #${input.number}.` }],
    };
  },
);

server.tool(
  "add_labels",
  "Add one or more labels to the current issue or pull request.",
  { labels: z.array(z.string()) },
  async ({ labels }) => {
    log("add_labels ->", labels);
    return {
      content: [
        { type: "text", text: `[MOCK] Added labels: ${labels.join(", ")}` },
      ],
    };
  },
);

server.connect(new StdioServerTransport());
