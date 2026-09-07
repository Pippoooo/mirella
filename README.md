# Mirella

Mirella is a self-hosted coding assistant that integrates seamlessly into your VCS and interacts like a real colleague.

You open an issue describing the work. Mirella picks it up, starts a branch, and implements it — then opens a pull request, answers your review comments, and iterates until the work is ready to merge. Everything happens in the conversations your team already uses: issues, comments, reviews. No dashboard, no new workflow — you work with mirella the way you work with any teammate.

Mirella is multi-provider by design. VCS providers, agent harnesses, and state storage sit behind swappable abstractions — the supported combinations today are:

| Boundary | Implementations |
|---|---|
| VCS provider | **GitHub** |
| Agent harness | **Claude Code** |
| Issue state store | **file** |

Supporting more VCSes (GitLab, Gitea, …) and more agent CLIs (opencode, pi, …) is what the architecture exists for: each is a new implementation behind a factory, not a rewrite. See [Extending](#extending).

## How it works

```
your VCS ──poll──▶ mirella orchestrator ──spawn──▶ coding agent (per issue)
   ▲                     │                               │
   │                     ▼                               ▼
   └── comments /   worktree per issue            implements, commits,
       reviews / PRs                               pushes, opens the PR
```

One poll cycle:

1. **Watch** — list open issues carrying the agent label, refreshing the provider's credentials (the GitHub provider mints short-lived App installation tokens).
2. **Prepare** — ensure a single canonical clone at `/workspace/main` plus one git worktree per issue (`mirella/issue-<N>`), reusing worktrees across restarts.
3. **Diff** — fetch the issue's comments plus the change-request conversation (reviews, inline comments), and compute what the agent has not seen yet. Nothing new → no wake-up.
4. **Run** — hand the agent a pure JSON work order (repo, branches, issue, new activity) and resume its previous session, so it continues where it left off with full memory of the conversation.
5. **Record** — persist per-issue state (seen message IDs, session ID) and sleep until the next poll.

The agent writes back through a small MCP server (`vcs-tools`) exposing exactly the conversation primitives it needs: comment on the issue, comment on the change request, open it, update it, add labels. Every operating rule the agent follows — workflow, git rules, communication style — lives in [`CLAUDE.md`](CLAUDE.md), which is baked into the container image.

Rate limits are respected, not hoped around: mirella reads the provider's rate-limit headers on every response (GitHub's `x-ratelimit-remaining` / `x-ratelimit-reset`) and automatically extends its polling interval to the window's reset when quota approaches a safety reserve.

## Architecture

Three boundaries, each behind a factory, with a stable seam for the next implementation:

| Boundary | Interface | Today |
|---|---|---|
| VCS provider | `src/providers/types.ts` | `github.ts` (Octokit, GitHub App auth) |
| Agent harness | `src/harness/types.ts` | `claude-code.ts` (claude CLI) |
| Issue state store | `src/store/types.ts` | `file-store.ts` (JSON per issue) |

Supporting modules: `index.ts` is a thin composition root, `orchestrator.ts` owns the poll loop and cadence policy, `config.ts` reads the environment exactly once (everything explicitly required — no defaults), `env.ts` is the single registry of environment variable names, `payload.ts` holds the pure delta/full-conversation logic, and `agent-env.ts` defines the hardened environment contract for agent processes.

A few deliberate security properties:

- **Secrets are files, never environment values.** The VCS private key and the AI provider token are mounted as files and referenced by `*_PATH` variables. Nothing secret is stored in `.env`.
- **The agent sees only its own credentials.** Agent processes receive an explicit allowlisted baseline (`PATH`, `HOME`, …) plus the credentials map — never the orchestrator's environment.
- **Short-lived tokens everywhere.** The App private key only mints hourly installation tokens; those travel to git and the MCP server per run and expire.
- **Clean attribution.** Commits are authored by the mirella agent identity alone; a `commit-msg` hook and harness settings strip any AI attribution the agent's tooling may add.

## Getting started

### Prerequisites

- Docker (development and production both run through it; no host Node required)
- A GitHub App with repository permissions: **Contents** (read & write), **Issues** (read & write), **Pull requests** (read & write). Webhooks can be disabled — mirella polls, it does not receive events.

### Set up the GitHub provider

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**. Give it a name; no webhook URL needed.
2. Under Permissions, grant the three permissions above, then **Generate private key** and save the `.pem` as `mirella.pem` in the mirella project root.
3. Note the **App ID** from the app settings page, and the **Installation ID** from the URL of the app's installation page.
4. Install the app on the repository mirella should work in.

### Configure

```bash
cp .env.example .env
```

Then fill in `.env`:

```ini
MIRELLA_VCS_PROVIDER=github
MIRELLA_AGENT_HARNESS=claude-code
MIRELLA_STATE_STORE=file
MIRELLA_POLL_INTERVAL_MS=10000

MIRELLA_REPO_OWNER=your-org
MIRELLA_REPO_NAME=your-repo
MIRELLA_BASE_BRANCH=main

GITHUB_APP_ID=123456
GITHUB_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY_PATH=./mirella.pem

# Secrets are files — the token goes in this file, not in .env
ANTHROPIC_AUTH_TOKEN_PATH=./anthropic-token

ANTHROPIC_BASE_URL=https://ollama.com
ANTHROPIC_MODEL=glm-5.3-flash:cloud
ANTHROPIC_SMALL_FAST_MODEL=glm-5.3-flash:cloud
```

Every variable is required; there are no defaults to forget about. The first three lines are the provider switchboard — swap a value once an implementation for the other side exists. The AI endpoint can be Anthropic's own or any Anthropic-compatible gateway (`ANTHROPIC_BASE_URL` + token file).

## Running

Mirella runs as a single long-lived process. It takes **no CLI arguments** — the entire interface is the environment file. Both modes run in Docker.

### Development

Docker is the full development wrapper — source is bind-mounted, TypeScript runs under `tsx watch`, and `CLAUDE.md` is mounted live (instruction edits need no rebuild):

```bash
docker compose up -d --build dev
docker compose logs -f dev
```

Common tasks:

```bash
# typecheck
docker compose run --rm dev npx tsc --noEmit

# full build (compiles to dist/)
docker compose run --rm dev npm run build
```

After editing `.env`, recreate the container so compose re-reads it:

```bash
docker compose up -d --force-recreate dev
```

Host-native development also works if you prefer (`npm ci && npm run dev`) but requires Node, git, and the claude CLI on the host — the container path is the supported one.

### Production

Build the runtime image (the last Dockerfile stage: production dependencies, compiled output, agent CLIs included):

```bash
docker build --target app-runtime -t mirella:prod .
```

Run it with the config file and the two secret files mounted:

```bash
docker run -d --name mirella-prod \
  --env-file .env \
  -v "$PWD/mirella.pem:/app/mirella.pem:ro" \
  -v "$PWD/anthropic-token:/app/anthropic-token:ro" \
  -v mirella-workspace:/workspace \
  mirella:prod
```

Notes:

- To override individual values, pass `-e KEY=value` after `--env-file`.
- `/workspace` should be a **named volume** in production: the canonical clone, per-issue worktrees, and per-issue state must persist across restarts.
- Run only one mirella against the same repository — two pollers would race on issue state.
- The `Dockerfile` also builds a `sandbox` target (agent tooling only, no app) for running agents against other repositories.

### Container layout

```
/workspace
├── main/                     # canonical clone, fetched once per poll
└── agent-<N>/                # one directory per issue
    ├── issue-<N>/            # the agent's git worktree
    ├── conversation.json     # full conversation, kept current every wake-up
    └── state.json            # seen-message IDs + session to resume
```

## Using mirella from your VCS

Day to day, you never touch the process, the config, or the logs — mirella works entirely through your VCS's conversations, like everyone else on the team.

**Assign work.** Open an issue describing the change and label it `mirella-agent`. Within one poll cycle, mirella acknowledges on the issue, starts a `mirella/issue-<N>` branch, and begins work.

**Get the change request.** When the work is ready, mirella opens a pull request (merge request, in GitLab terms) and announces it on the issue.

**Review like you would with a human.** Comment on the PR, leave inline comments, or request changes — on the issue or the PR, whichever fits. On its next poll, mirella resumes the same agent session with full memory and responds. Feedback that arrives as several comments gets one consolidated reply; approval with no comments gets silence, not a thank-you note.

**Expect pushback when it matters.** If requirements are ambiguous or a requested change looks wrong, mirella asks one concrete question on the channel the request came from instead of building the wrong thing.

**Merge.** Mirella only ever pushes to `mirella/*` branches — the base branch is never touched directly. Merge the PR when you're satisfied.

## Extending

Each boundary is a switch-plus-throwaway factory; adding an implementation means creating one file and adding a case:

- **New VCS provider** (GitLab, Gitea, …): implement `VCSProvider` in `src/providers/`, register it in `providers/factory.ts`, and read your provider's credentials there — provider-specific auth never touches the agnostic config layer.
- **New agent harness** (opencode, pi, …): implement `AgentRunner` in `src/harness/`, register it in `harness/factory.ts`. Spawn your CLI with `buildAgentEnv(credentials)` from `harness/agent-env.ts` — that is the security boundary that keeps orchestrator secrets out of agent processes.
- **New state store** (Redis, Postgres, …): implement `IssueStateStore` in `src/store/`.

Then set the corresponding `MIRELLA_VCS_PROVIDER` / `MIRELLA_AGENT_HARNESS` / `MIRELLA_STATE_STORE` value. Pure orchestration logic (`payload.ts`, `orchestrator.ts`) is provider- and harness-agnostic by construction and needs no changes.