# Orchestrator (placeholder)

Not implemented yet — nothing in this directory is functional. This is a
stub for the component that will sit one level above the worker in `src/`.

Its future job:

- Watch the GitHub App's installations for repositories that need a worker.
- For each such repo, create (and scale) a worker — a k8s Pod with its own
  PVC for the repo clone/worktrees — running what `src/index.ts` does today.
- Retire workers whose repos have gone idle.

Until then, the single-process poll loop in `src/index.ts` does all of it
inline: one process watches one repo and runs one agent per issue in a
directory under `/workspace`.