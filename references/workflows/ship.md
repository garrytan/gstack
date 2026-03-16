# gstack-ship

Use this mode for deterministic shell-driven release steps on a ready feature branch.

## Contract

- Goal: converge the branch with main, run the repo’s canonical validation, and prepare the branch for review or merge
- Default posture: execute, do not brainstorm
- Scope: deterministic shell steps only; avoid host-specific slash-command assumptions

## Workflow

1. Refuse to ship directly from `main`.
2. Inspect the diff and recent commits.
3. Sync with `origin/main`.
4. Run the repository’s existing validation commands. Prefer documented wrappers over ad hoc command chains.
5. Run `gstack-review` logic if a pre-landing review has not been done.
6. If the repo uses versioning or changelog files, update them only when the project’s conventions require it.
7. Push and open or update a PR when the repo is configured for that flow.

## Operating rules

- Stop on merge conflicts, broken validation, or missing release prerequisites.
- Use user input only when a real release decision is required.
- Keep the output brief: branch state, validation results, and next release artifact.
