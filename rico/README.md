# Rico

Rico is the Slack runtime that routes incoming events into the gstack agent
workflow, stores run state locally, and mirrors generated artifacts to disk.

## Required env vars

Set these before starting the runtime:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`

`SLACK_SIGNING_SECRET` is used to verify Slack request signatures. `SLACK_BOT_TOKEN`
is used for Slack API calls, including messages, file uploads, and approval
actions.

## Local run

From the repo root:

```bash
bun run dev:rico
```

The runtime listens on `PORT` if set, otherwise it defaults to `3000`.

## Test

From the repo root:

```bash
bun run test:rico
```

## Local artifacts

Rico stores its local state under `.gstack/rico/` in the current working
directory.

- Database: `.gstack/rico/rico.sqlite`
- Artifact mirror: `.gstack/rico/artifacts/`
- Artifact metadata sidecars: `.gstack/rico/artifacts/__rico_meta__/...`

Artifacts are written under `projectId/goalId/fileName`, and the metadata
sidecar records the source path plus byte size for each file.

## Approval flow

Rico treats protected actions as human-approved work. When a request is
classified as an external message, spend, data deletion, or deployment, the
runtime marks it as `awaiting_human_approval` and posts a Slack message with
Approve and Reject buttons.

- Approving updates the approval row, appends a matching goal transition, and
  moves the goal to `approved`.
- Rejecting updates the approval row, appends the goal transition, and moves
  the goal to `rejected`.
- Stale callbacks are rejected, so a decision cannot be overwritten after the
  approval has already been resolved.
