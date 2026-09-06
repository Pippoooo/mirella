# syntax=docker/dockerfile:1

# Base: Debian-based (not Alpine) so native npm modules and harness-bundled
# binaries install cleanly against glibc. Shared by every stage below.
FROM node:22-bookworm-slim AS base

# System tooling: git for worktrees, ssh/curl for remote git and downloads,
# build-essential + python3 because some npm deps compile native addons
# via node-gyp on install.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      openssh-client \
      jq \
      unzip \
      build-essential \
      python3 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. Create /workspace and chown it *before* switching user —
# otherwise Docker creates WORKDIR as root on first reference and the agent
# user silently can't write to its own working directory later.
RUN useradd --create-home --shell /bin/bash agent \
    && mkdir -p /workspace \
    && chown agent:agent /workspace

USER agent
WORKDIR /home/agent

# Keep all global npm installs inside the user's home — no root needed,
# and it stays consistent with the "repo-scoped home" pattern if you ever
# mount $HOME itself instead of just /workspace.
ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global
ENV PATH=/home/agent/.npm-global/bin:$PATH

# --- Agent sandbox: coding-agent harnesses, nothing repo-specific ---
# The repo/worktree volume gets bind-mounted at /workspace at `docker run`
# time. Nothing repo-specific (extra runtimes, etc.) is baked in on purpose;
# that's installed once per repo into the persisted volume, per the
# container-per-repo design.
FROM base AS sandbox
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g opencode-ai@latest
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Headless Claude Code shows a one-time interactive confirmation dialog for
# --dangerously-skip-permissions unless this is pre-accepted. Safe to bake
# in here since this image only ever runs inside an already-isolated
# container with a single repo mounted.
# Empty attribution strings stop the harness from signing its work: no
# "Co-Authored-By: Claude ..." trailer on commits, no "Generated with Claude
# Code" line on PR bodies — commits are authored by the mirella agent
# identity alone.
RUN mkdir -p /home/agent/.claude \
    && echo '{"skipDangerousModePermissionPrompt": true, "attribution": {"commit": "", "pr": ""}}' > /home/agent/.claude/settings.json

# Agent instructions, baked in as Claude Code user-level memory — it is read
# automatically on every claude run, no matter which workdir it starts in.
COPY --chown=agent:agent CLAUDE.md /home/agent/.claude/CLAUDE.md

WORKDIR /workspace
CMD ["bash"]

# --- Mirella app ---
# App dev: all deps (incl. tsx); source is bind-mounted at runtime
# (compose.yaml targets this stage). Inherits the sandbox stage so the app
# can spawn the agent CLIs it drives.
FROM sandbox AS app-dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Do NOT COPY src/ — it comes from the bind mount

# App build: compile TypeScript
FROM app-dev AS app-build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# App runtime: production deps only, compiled output. Deliberately the last
# stage so a plain `docker build` produces the packaged app; build the pure
# agent sandbox with `--target sandbox`.
FROM sandbox AS app-runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=app-build /app/dist ./dist
CMD ["node", "dist/index.js"]