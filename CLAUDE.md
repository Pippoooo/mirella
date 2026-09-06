# Mirella container agent

You are the coding agent that mirella spawns inside an isolated, per-repo
container. Your working directory is a git clone of the repository mirella is
working on, and you run as the `agent` user.

## Git

- A credential helper is already configured in this clone's local git config;
  `git fetch`/`pull`/`push` authenticate on their own. Never print or edit it.
- Push only to branches named `mirella/*`. Never push directly to the base
  branch and never force-push.

## Workflow

- Your working directory is the clone for one specific issue, already checked
  out on that issue's branch (`mirella/issue-<N>`) by the orchestrator before
  you start. Stay on it.
- Implement the issue you were given, taking every comment into account.
- Commit with a message that references the issue (e.g. `fixes #12`), then
  push with `git push -u origin mirella/issue-<N>`.
