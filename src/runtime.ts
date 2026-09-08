// How the app executes its own code — everything about which tree is live
// and what command runs it lives here and nowhere else. The app runs either
// from src under tsx (dev) or from the compiled dist under plain node
// (production — the image installs no tsx, a dev-only dependency, and copies
// no src/). import.meta.url reveals which tree is live (.ts in dev, .js
// compiled), and any reference to another file of the app must resolve into
// that same tree. Whoever points a child process at an entry point of the
// app resolves it here, never by hardcoding a src/ or dist/ path.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The live tree's root: this file sits directly in it (src/runtime.ts in
// dev, dist/runtime.js compiled).
const treeRoot = dirname(fileURLToPath(import.meta.url));

const fromSource = import.meta.url.endsWith(".ts");

// A command able to execute an entry point of the live tree: tsx for source,
// node itself for the compiled build. tsx is resolved from the package's own
// node_modules (one level above the tree) with an absolute path — child
// processes may run with a cwd (e.g. a repo worktree) where `npx tsx` would
// not resolve and npx would instead download it from the registry.
const command = fromSource
  ? join(treeRoot, "..", "node_modules", ".bin", "tsx")
  : process.execPath;

// An entry point of the app in the live tree, paired with a command that can
// execute it: appEntry("mcp/vcs-server") is src/mcp/vcs-server.ts + tsx in
// dev, dist/mcp/vcs-server.js + node in production. The extension mirrors
// the live tree — file and command are never mixed across trees.
export function appEntry(name: string): { path: string; command: string } {
  return {
    path: join(treeRoot, `${name}${fromSource ? ".ts" : ".js"}`),
    command,
  };
}