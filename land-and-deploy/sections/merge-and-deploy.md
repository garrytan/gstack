<!-- AUTO-GENERATED from merge-and-deploy.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 4: Resolve and bind the landing decision

Use one fused authority call. It binds canonical repository identity, live target
head/base, trusted work profile, semantic manifest, requirements, current
evidence, the sole deploy target, and the read-only effect proposal.

Resolve `MERGE_METHOD` from Deploy Configuration, checking GitHub's allowed methods via `gh api repos/{owner}/{repo} --jq '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}'`. With no configured method, prefer squash, then merge, then rebase among allowed methods. If a configured method is disallowed or no method is allowed, stop and ask. Set `MERGE_FLAG` to exactly `--squash`, `--merge`, or `--rebase` accordingly.

The closed provider adapter currently supports squash only. If the resolved
`MERGE_METHOD` is not `squash`, stop before creating the landing intent; never
silently substitute squash or bypass the adapter with `gh pr merge`.

```bash
if [ "${LANDING_RECOVERY:-0}" = "1" ]; then
  LAND_PLAN_LANE=$SHIP_RECOVERY_LANE
else
  LAND_PLAN=$($GSTACK_ANCHOR_INVOCATION gstack-execution-plan resolve \
    --skill land-and-deploy --work-kind release --finish-line merged \
    --lane auto --assert-target-ref "$PR_TARGET_REF" --json) || exit 1
  LAND_PLAN_LANE=$(printf '%s' "$LAND_PLAN" | jq -er .lane) || exit 1
fi
```

Fresh landing freezes the resolver-selected semantic lane; recovery replays the
same lane and subject tree from the durable milestone landing. Caller profile
presence is never a lane classifier.

Stop before any provider mutation if the plan reports a blocker, an ignored
profile policy update, a missing semantic declaration, a target/environment/
binding mismatch, an unsupported topology, or missing evidence. A caller target,
environment class, display name, URL, documentation command, or candidate profile
cannot select the deploy adapter.

For `merge-only`, the sole trusted target must be `trigger=none`. For
`merge-and-deploy`, it must be `github_actions.v1`, `trigger=on_merge`, and the
candidate exact-tree detector must prove the same enabled workflow path, base and
path filters, reachable job, and exact provider environment object.

## Step 5: Preflight and merge once

Every validator required by `LAND_PLAN.evidence_requirements` must first be
current for the exact remote head through `gstack-pr-head-guard inspect` or
`with-worktree`. A paid validator is executed only through
`gstack-effect-scope ensure-paid-validator` with the same PR/base/head/lane
assertions and an explicit current-task authorization. Missing evidence never
becomes an overrideable merge warning.

Revalidate the provider repository, workflow database ID/path/state, environment
database ID/node/name, Actions-read, Deployments-read, PR head/base OIDs, expected
result tree, adapter-registry hash, and topology projection immediately before
merge. Persist a mode-0600 `deploy.operation_intent` before the irreversible call.

```bash
if [ "${LANDING_RECOVERY:-0}" != "1" ]; then
  PR_GUARD_JSON=$($GSTACK_ANCHOR_INVOCATION gstack-pr-head-guard assert \
    --pr "$PR_NUMBER" --expected "$PR_HEAD_OID" \
    --expected-base "$PR_BASE_OID" --assert-target-ref "$PR_TARGET_REF" \
    --expected-repository-node "$PR_REPOSITORY_NODE_ID") || exit 1
fi

LANDING_ASSERTIONS=(--assert-ship-receipt "$SHIP_RECEIPT_ID")
if [ "${LANDING_RECOVERY:-0}" = "1" ] && [ -z "${SHIP_PROMOTION_LANE:-}" ] && [ -z "${SHIP_CANARY_LANE:-}" ]; then
  LANDING_ASSERTIONS=(--assert-ship-receipt "$SHIP_RECEIPT_ID" --assert-milestone-block "$SHIP_RECOVERY_BLOCK")
fi
if [ -n "${SHIP_PROMOTION_LANE:-}" ] && [ -n "${SHIP_CANARY_LANE:-}" ]; then
  exit 1
fi
if [ -n "${SHIP_PROMOTION_LANE:-}" ]; then
  [ -n "${SHIP_PROMOTION_BLOCK_ID:-}" ] || exit 1
  LANDING_ASSERTIONS=(--lane "$SHIP_PROMOTION_LANE" --assert-ship-receipt "$SHIP_RECEIPT_ID" \
    --assert-milestone-block "$SHIP_PROMOTION_BLOCK_ID")
elif [ -n "${SHIP_CANARY_LANE:-}" ]; then
  if [ -n "${SHIP_CANARY_PROOF:-}" ]; then
    LANDING_ASSERTIONS=(--lane "$SHIP_CANARY_LANE" --assert-ship-receipt "$SHIP_RECEIPT_ID" \
      --assert-milestone-block "$SHIP_CANARY_BLOCK_ID" --assert-canary-proof "$SHIP_CANARY_PROOF")
  elif [ -n "${SHIP_CANARY_SAMPLE:-}" ]; then
    LANDING_ASSERTIONS=(--lane "$SHIP_CANARY_LANE" --assert-ship-receipt "$SHIP_RECEIPT_ID" \
      --assert-milestone-block "$SHIP_CANARY_BLOCK_ID" --assert-canary-sample "$SHIP_CANARY_SAMPLE")
  else
    exit 1
  fi
fi

LANDING_COMMAND_ARGS=(--skill land-and-deploy --pr "$PR_NUMBER" --expected "$PR_HEAD_OID" \
  --expected-base "$PR_BASE_OID" --assert-target-ref "$PR_TARGET_REF" \
  --expected-repository-node "$PR_REPOSITORY_NODE_ID" --assert-plan-lane "$LAND_PLAN_LANE" \
  "${LANDING_ASSERTIONS[@]}")

if [ "${LANDING_RECOVERY:-0}" = "1" ]; then
  LANDING_COMMAND_ARGS+=(--assert-milestone-landing "$SHIP_RECOVERY_LANDING_ID")
fi

if [ "${LANDING_RECOVERY:-0}" = "1" ]; then
  MERGE_RESULT=$($GSTACK_ANCHOR_INVOCATION gstack-effect-scope provider-merge reconcile \
    "${LANDING_COMMAND_ARGS[@]}") || exit 1
else
  MERGE_RESULT=$($GSTACK_ANCHOR_INVOCATION gstack-effect-scope provider-merge discover \
    --skill land-and-deploy --pr "$PR_NUMBER") || exit 1
  MERGE_STATUS=$(printf '%s' "$MERGE_RESULT" | jq -er '.status') || exit 1
  if [ "$MERGE_STATUS" = "absent" ]; then
    if MERGE_RESULT=$(ECPE_MERGE_AUTHORIZED=1 $GSTACK_ANCHOR_INVOCATION gstack-effect-scope provider-merge direct \
      "${LANDING_COMMAND_ARGS[@]}"); then
      :
    else
      # Response loss is ambiguous. Discovery is read-only and either recovers
      # the exact protected admission or fails closed; never issue another PUT.
      MERGE_RESULT=$($GSTACK_ANCHOR_INVOCATION gstack-effect-scope provider-merge discover \
        --skill land-and-deploy --pr "$PR_NUMBER") || exit 1
    fi
  elif [ "$MERGE_STATUS" != "merged" ]; then
    exit 1
  fi
fi

# `delivery.merged` is emitted only as the protected typed admission returned
# by the fused merge authority. Generic evidence JSONL is not terminal proof.
printf '%s' "$MERGE_RESULT" | jq -e \
  '.status == "merged" and (.deliveryReceiptId | startswith("merged-delivery-")) and
   (.deliveryReceiptBindingSha256 | test("^[0-9a-f]{64}$")) and
   (.landingCheckpointId | test("^[0-9a-f]{64}$")) and
   (.providerBaseAtomicity == "observed_only") and
   (.releaseDriftStatus == "verified" or .releaseDriftStatus == "not_applicable")' >/dev/null || exit 1
```

Never retry or switch merge modes after a non-zero result. Reconcile the same
intent read-only. Cleanup is outside this stage.

### 4a-postfail: Post-failure PR-state check

Universal invariant: after any non-zero direct adapter exit, do not retry or
change merge strategy. The mutation path is one head-CAS direct squash request
and never enables auto-merge. A transport failure is ambiguous because the
provider may have accepted the request before the response was lost. Re-read
provider state through the compiled provider adapter before deciding anything.

The adapter's frozen read shape is equivalent to
`gh pr view --json state,mergeCommit,mergedAt,mergedBy`; this notation documents
the provider fields and is not permission to bypass the installed anchor.

- When `state == "MERGED"`, obtain the observed revision from the frozen
  `gh pr view --json mergeCommit -q .mergeCommit.oid` projection, verify its
  result tree, append `observed_merge_sha` check-first, and continue to §4a.
  Branch and worktree cleanup are outside landing. Continue without deleting, moving, pruning,
  or otherwise changing any checkout or ref.
- When `state == "OPEN"`, re-read the frozen
  `gh pr view --json autoMergeRequest` projection. If auto-merge is enabled or merge queue is in use,
  report the provider-owned pending state; otherwise
  report the original failure. In either case, do not mutate.
- When `state == "CLOSED"`, STOP and report the immutable provider state.

never issue a second merge mutation after a non-zero exit. The same prohibition
applies after a timeout, malformed response, interrupted client, or process
restart.

### 4a: Merge queue detection

This compatibility seam is read-only. In profile mode the compiled provider
adapter owns queue detection and correlation. A queue or provider-pending result
does not authorize a second mutation, change the expected head/base OIDs, or
extend any deadline.

### Provider binding and access snapshot

Before the irreversible call, bind all of the following into the operation
intent. Each value comes from a provider object or trusted profile field; none
may be inferred from a display label or documentation:

- canonical host and repository selector plus repository node ID;
- PR number, exact head OID, exact base OID, and normalized target ref;
- expected result tree, semantic-manifest hash, work-profile hash, and registry
  hash;
- workflow database ID, exact tracked workflow path, enabled state, and trigger
  projection;
- environment database ID, node ID, exact name, and environment class;
- successful Actions-read and Deployments-read capability probes;
- frozen run-discovery deadline and provider query cursor.

Repository WRITE or ADMIN role is not a substitute for endpoint access. A 403,
missing object, path/ID mismatch, or deleted-and-recreated environment blocks
before merge. For a first deployment, a successful empty deployment list is a
valid read probe; do not manufacture an ID merely to test another endpoint.

### Exact trigger applicability

The candidate workflow must be an enabled push workflow whose branch and path
filters include this exact base and sorted changed-path set. Evaluate ordered
include/ignore rules using provider-compatible semantics. A tag-only workflow,
wrong branch, excluded path, dynamic filter, or ambiguous expression is
`on_merge_trigger_not_applicable` and blocks before merge.

At least one statically reachable job must bind the exact frozen environment
name. Dynamic environment expressions and conditions that cannot be proven are
`deploy_topology_unsupported`. A candidate workflow can confirm a trusted
binding but can never create or replace the provider workflow/environment IDs.
A trusted `none.v1` target plus a new workflow therefore remains unsupported.

### Durable operation-intent phases

Create the mode-0600 intent outside the repository before merge. Its stable ID
is derived from canonical repository, PR, expected OIDs/tree, sole target,
environment, policy/registry hashes, deadline, and cursor. Fsync both the record
and parent directory. On restart, locate the same ID and reconcile its current
phase before any provider operation.

The supported phases are monotonic:

1. `prepared` — immutable inputs and preflight proof are durable;
2. `merge_requested` — the sole request boundary was entered;
3. `merge_observed` — provider merge SHA and verified result tree are durable;
4. `deployment_correlated` — one exact workflow run/attempt is bound;
5. `deployed` — the joined workflow, environment, deployment, and status proof
   is durable; or
6. `failed | unknown` — one linked terminal incident is durable.

Check-first append semantics make a repeated read return the existing phase and
ID. A crash between a provider response and append must be recovered by exact
provider state, never by repeating the effect. Conflicting records, wrong OIDs,
or a phase regression are terminal integrity failures.

### Natural run discovery

The adapter dispatch count is always zero. Correlate only a workflow run whose
workflow database ID matches the frozen binding and whose head SHA equals the
observed provider merge SHA. The branch name, tag, current default-branch tip,
commit message, or newest run is never an identity key.

Before the frozen discovery deadline, zero matches is retryable `pending` with
bounded backoff. At or after that same deadline, zero or multiple matches is
terminal `unknown`. A fresh process resumes the original deadline and cursor;
it does not grant more time. A unique failed or cancelled run is terminal
`failed`. A unique success advances only to `workflow_succeeded`, not deployed.

### Joined deployment proof

After workflow success, requery the environment endpoint and require database
ID, node ID, and name to equal the preflight object. Then require exactly one
deployment with `sha == observed_merge_sha` and the frozen environment name,
and exactly one successful terminal deployment-status object for that
deployment ID.

Name-only equality is insufficient because an environment can be deleted and
recreated under the same label. A skipped deployment job, missing deployment,
wrong SHA/environment, duplicate deployment, or nonterminal status remains
pending until the frozen deadline and becomes a typed incident afterward.
Endpoint denial after merge is `deploy_status_unreadable`; it is not evidence
of success or ordinary missing evidence.

### Canary evidence

A health check exists only when the trusted target references a compiled
`health_target_id`. The checker owns its URL template, method, redirect policy,
timeouts, body limits, response validation, and redaction. Human operations
notes cannot supply any of those executable fields.

Canary success is recorded against the exact deploy-operation ID and observed
merge SHA. A failed canary is likewise content-free and stable; reports may
name only its canonical ID and typed reason. Secrets, response bodies, headers,
and arbitrary endpoints never enter evidence or model context.

### Rollback boundary

Provider rollback, mutable-ref dispatch, and direct Git are unsupported in v1.
For a provider-backed target the sole compiled recovery method is
`git-revert-pr`. It requires the exact failed-canary/deploy chain and a separate
rollback intent before any Git effect.

The helper-owned checkout computes one expected revert tree and commit, uses an
operation-key-derived branch, creates the remote ref if absent, and opens one PR
for the exact head/base. It stops at the opened PR. Landing that PR is a later
operation with a fresh grant. Recovery recognizes intent-only, local-commit,
remote-ref, PR-opened, and record-appended phases and never duplicates a commit,
push, or PR.

### Reporting contract

Report facts from the final reconciled record: operation-intent ID, target and
environment IDs, adapter/topology/profile/manifest hashes, observed merge SHA,
workflow run and attempt, deployment and status IDs, canary ID when present,
terminal state, and typed incident. State explicitly when a value remains
pending or unknown. Never collapse `workflow_succeeded` into `deployed`, and
never describe a guessed URL, mutable ref, latest run, or display name as proof.

## Step 6: Observe natural on-merge deployment

The adapter dispatch count must remain zero. After the provider returns the real
merge commit, append the `observed_merge_sha` checkpoint to the same operation
intent and correlate only a unique natural workflow run/attempt for that SHA.
Resume the original discovery deadline and cursor after restart; never extend the
deadline or query by a mutable branch/tag.

`deployed` requires all of:

1. the workflow run succeeded for `observed_merge_sha`;
2. the live environment database ID, node ID, and name still equal preflight;
3. one unique deployment has that SHA and frozen environment name; and
4. one unique terminal successful deployment-status object belongs to it.

Before the frozen deadline, no match is `pending`. At the deadline, zero or
multiple matches is terminal `unknown`. A skipped job, missing deployment,
environment replacement, or unreadable status becomes a durable typed incident,
never guessed success.

## Step 7: Canary and rollback boundary

Run a canary only when the trusted optional `health_target_id` resolves to a
compiled read-only checker. Provider rollback, caller commands, direct Git, and
workflow dispatch are unsupported in v1.

When a unique failed canary exists, rollback resolution derives the original
PR/target/environment chain internally. The only provider-backed v1 method is a
helper-owned `git-revert-pr` flow with its own rollback intent and exact grants;
it stops after opening the rollback PR. A later merge requires a fresh land grant.

## Step 8: Report

Report the operation-intent ID, target ID, environment database ID, adapter and
topology hashes, observed merge SHA, unique run/deployment/status identities,
terminal state, and any incident. Do not claim deployed from workflow success
alone and do not offer cleanup as part of landing.
