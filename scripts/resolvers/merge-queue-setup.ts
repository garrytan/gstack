import type { TemplateContext } from './types';

/**
 * {{MERGE_QUEUE_SETUP}} — the authoritative, teacher-mode trunk.io merge-queue
 * onboarding. Included by BOTH /setup-deploy (## Merge Configuration) and
 * /land's first-time branch so the guide lives in exactly one place (DRY) and
 * /land can hand-hold inline without making the user stop and run another skill.
 *
 * Grounded in a full read of docs.trunk.io/merge-queue (2026-05): config is
 * server-side (app.trunk.io), the GitHub App is mandatory, trunk posts a
 * "Trunk Merge Queue (<base>)" status check, and the `/trunk merge` PR comment
 * enqueues with zero extra auth.
 */
export function generateMergeQueueSetup(_ctx: TemplateContext): string {
  return `### Set up a merge queue with trunk.io (first-time, hand-held)

**What a merge queue is, in plain English.** Normally you merge one PR, wait for
it to land, merge the next, wait again — babysitting a line of PRs into the base
branch one at a time. A **merge queue** flips that: you *enqueue* each ready PR
and walk away. Trunk tests them (in parallel, and **optimistically** — a later PR
that already contains an earlier change can rescue it from a flaky failure) and
**lands them on the base branch for you**, in a safe order. You queue ten PRs in
a row, close your laptop, and they all make it onto the base branch without you.

That is exactly the workflow this unlocks: \`/land\` on each PR, then go do
something else.

**Before you start:** this needs a trunk.io account (the free tier covers small
teams) and admin access to the GitHub repo. It's a one-time setup. I'll walk each
step and explain *why*, and verify what I can with \`gh\`.

**Step 1 — Create / sign in to trunk.io.**
Open https://app.trunk.io and sign in with GitHub. *(Why: the queue config and
dashboard live in Trunk's web app, not in your repo — there's no \`trunk.yaml\`
merge section to commit.)*

**Step 2 — Install the Trunk GitHub App on this repo.**
In app.trunk.io → **Merge Queue** → **Create New Queue** → install the GitHub
App, select this repo, approve permissions. *(Why: the App is what lets the
\`trunk-io\` bot test on throwaway branches and push the final merge. Mandatory —
nothing works without it.)*
Verify the App can see the repo:
\`\`\`bash
gh api "/repos/<owner>/<repo>/installation" --jq '.app_slug' 2>/dev/null || echo "App not detected yet"
\`\`\`

**Step 3 — Create a queue for this repo + base branch.**
In the same flow, pick this repo and target branch \`<base>\`, click **Create
Queue**. *(Why: a queue is scoped to one branch — you're queuing merges into
\`<base>\`.)*

**Step 4 — Adjust branch protection (3 changes).**
In GitHub → Settings → Branches → the \`<base>\` rule:
- **Allow the \`trunk-io\` bot to push to the protected branch.** *(Why: Trunk's
  bot performs the actual merge; without push rights it can't land anything.)*
- **Disable "Require branches to be up to date before merging."** *(Why: Trunk
  tests each PR against the others in the queue, so GitHub's own up-to-date gate
  would fight it.)*
- **Exclude \`trunk-merge/*\` and \`trunk-temp/*\` from protection.** *(Why: those
  are the throwaway branches Trunk tests on; protecting them blocks testing.)*

**Step 5 — Turn on the optimizations that make "queue many, walk away" real.**
In app.trunk.io → your repo → Merge Queue → Settings, enable:
- **Optimistic Merge Queue** + **Pending Failure Depth ≥ 1** — keeps testing
  later PRs while an earlier one is in "pending failure," and auto-recovers when a
  later PR proves the failure was a flake. *(Why: one flaky PR doesn't stall the
  whole line.)*
- **Parallel** — non-overlapping PRs test in independent lanes at the same time.
  *(Why: throughput; ten unrelated PRs don't go one-at-a-time.)*
- **Batching** — lands compatible PRs together with auto-bisection on failure.
  *(Why: fewer CI runs, and a bad PR doesn't eject the whole batch.)*
- **Merge Method** — pick Squash / Merge Commit / Rebase to match your repo. *(Why:
  it controls what the landed commit looks like; \`/land\` handles all three.)*

**Step 6 — Pick how PRs get enqueued.**
The simplest works immediately: commenting **\`/trunk merge\`** on a PR. \`/land\`
uses that by default — zero extra auth, because the GitHub App is already
installed. *(Optional upgrades: set an "enqueue by label" name in the web UI, run
\`trunk login\` to use the \`trunk\` CLI, or set \`$TRUNK_API_TOKEN\` for the REST
API — \`/land\` will prefer those when present.)*

**Step 7 — Persist the choice so I never ask again.**
I'll write \`Merge queue: trunk\` into a \`## Merge Configuration\` section of
CLAUDE.md. *(Why: \`/land\` reads it and skips detection from then on.)*

**Step 8 — Verify end-to-end.**
Open any test PR and run \`/land\`. You should see a **\`Trunk Merge Queue
(<base>)\`** check appear, move Queued → Testing → Merged, and the PR land on
\`<base>\` without you touching GitHub:
\`\`\`bash
gh pr checks <test-pr> --json name,state | grep -i "Trunk Merge Queue" || echo "no queue check yet — recheck Steps 2-4"
\`\`\`

Full docs: https://docs.trunk.io/merge-queue/getting-started

Once this is done, the payoff: queue up all your ready PRs with \`/land\`, walk
away, and trunk lands them on \`<base>\` for you.`;
}
