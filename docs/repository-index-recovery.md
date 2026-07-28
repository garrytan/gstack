# Repository index sync and recovery

This guide is for the repository-index stage of `/sync-gbrain`: committed
source code and tracked Markdown from the current Git worktree into one
worktree-scoped GBrain source.

It is not the cross-machine GStack artifact-sync feature. Artifact sync moves
selected plans, retros, learnings, and profile data from `~/.gstack/` through a
private Git repository; see
[Cross-machine GStack artifact sync](gbrain-sync.md).

## Safety contract

Repository indexing requires GBrain `0.42.71.0` or newer. The wrapper compares
all four numeric version components and refuses missing components,
prerelease/build suffixes, or unrelated prose. This is a paired-release floor:
reconfirm it against the actual released GBrain version before adopting the
gstack change.

The wrapper:

- reads one strict registered-source snapshot before planning;
- resolves relative, absolute, and symlinked paths to canonical filesystem
  identity;
- never fixes path drift by removing and re-adding a source;
- previews one source with strategy `auto`, `--no-pull`, exact target and
  bookmark preconditions, and `--require-clean` when the tree is clean, then
  applies only with the preview's exact immutable `plan_digest`;
- sets `GBRAIN_EMBEDDING_MULTIMODAL=false` in a copied child environment;
- accepts only one schema-1 GBrain JSON document with a recognized terminal
  status;
- re-reads source bookmark and strategy after application, writes the source
  marker through a wrapper-owned non-following atomic replacement, then
  re-reads the strict source snapshot again;
- writes a fail-closed attempt watermark before the first GBrain probe and
  removes any prior receipt, so a failed same-HEAD retry cannot resurrect old
  GREEN evidence;
- writes a bounded, atomic receipt only after every postcondition verifies,
  while the watermark still blocks readers, then clears the watermark to
  reveal the receipt.

Ordinary repository sync can index both code and tracked Markdown. The legacy
flag `/sync-gbrain --code-only` now means “run only the repository-index stage”
and skips GStack memory/artifact stages; it does not mean GBrain
`--strategy code`.

## Two preview assurance levels

### Wrapper dry-run: orchestration only

```bash
/sync-gbrain --dry-run
```

Its heading is exactly:

```text
ORCHESTRATION PREVIEW — unvalidated
```

This mode returns before Git inspection, engine detection, lock acquisition,
source lookup, or a GBrain call. It writes nothing, but it also proves nothing
about the installed version, source, path, bookmark, or content operations.
Machine output uses:

```json
{
  "schema_version": 1,
  "result_kind": "repository_index",
  "status": "preview_ready",
  "reason_code": "blocked_until_version_proven",
  "state_changed": "none",
  "preview_kind": "orchestration_unvalidated"
}
```

Do not copy an executable raw sync command from this preview. First prove the
installed release and source state.

### GBrain dry-run: validated content plan

After version, source, canonical root, target HEAD, and bookmark are known, run
the source-scoped GBrain preview. Read the source id and bookmark from the
just-proven source snapshot. This example collects them without evaluating
pasted text, derives the root and HEAD from Git, validates the expected SHAs,
and quotes every argv value:

```bash
gbrain_repository_preview() {
  unset _GBRAIN_REPAIR_PLAN_DIGEST _GBRAIN_REPAIR_PREVIEW_JSON
  printf 'Source id from the proven snapshot: ' >&2
  IFS= read -r SOURCE_ID
  printf 'Expected bookmark (40 lowercase hex characters or none): ' >&2
  IFS= read -r EXPECTED_BOOKMARK
  REPOSITORY_ROOT=$(git rev-parse --show-toplevel) || return
  TARGET_HEAD=$(git rev-parse --verify HEAD) || return

  printf '%s\n' "$SOURCE_ID" |
    grep -Eq '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$' || {
    printf 'Source id does not match the strict registered-source format.\n' >&2
    return 1
  }
  printf '%s\n' "$TARGET_HEAD" | grep -Eq '^[0-9a-f]{40}$' || {
    printf 'Current HEAD is not a full lowercase SHA.\n' >&2
    return 1
  }
  if [ "$EXPECTED_BOOKMARK" != "none" ]; then
    printf '%s\n' "$EXPECTED_BOOKMARK" | grep -Eq '^[0-9a-f]{40}$' || {
      printf 'Expected bookmark must be a full lowercase SHA or none.\n' >&2
      return 1
    }
  fi

  _GBRAIN_REPAIR_SOURCE_ID=$SOURCE_ID
  _GBRAIN_REPAIR_ROOT=$REPOSITORY_ROOT
  _GBRAIN_REPAIR_TARGET_HEAD=$TARGET_HEAD
  _GBRAIN_REPAIR_EXPECTED_BOOKMARK=$EXPECTED_BOOKMARK
  _GBRAIN_REPAIR_PREVIEW_JSON=$(gbrain sync \
    --strategy auto \
    --source "$SOURCE_ID" \
    --repo "$REPOSITORY_ROOT" \
    --no-pull \
    --expected-target "$_GBRAIN_REPAIR_TARGET_HEAD" \
    --expected-bookmark "$_GBRAIN_REPAIR_EXPECTED_BOOKMARK" \
    --require-clean \
    --no-embed \
    --no-extract \
    --dry-run \
    --json) || return
  printf '%s\n' "$_GBRAIN_REPAIR_PREVIEW_JSON"

  _GBRAIN_REPAIR_PLAN_DIGEST=$(
    printf '%s\n' "$_GBRAIN_REPAIR_PREVIEW_JSON" |
      bun -e '
        const value = JSON.parse(await Bun.stdin.text());
        if (
          value.schema_version !== 1 ||
          value.result_kind !== "gbrain_sync" ||
          value.status !== "dry_run" ||
          value.preview_kind !== "validated_index_plan" ||
          typeof value.plan_digest !== "string" ||
          !/^[0-9a-f]{64}$/.test(value.plan_digest)
        ) process.exit(1);
        process.stdout.write(value.plan_digest);
      '
  ) || {
    printf 'Preview did not return a valid immutable plan_digest.\n' >&2
    unset _GBRAIN_REPAIR_PLAN_DIGEST
    return 1
  }
}

gbrain_repository_apply_preview() {
  if [ -z "${_GBRAIN_REPAIR_PLAN_DIGEST:-}" ] ||
    [ -z "${_GBRAIN_REPAIR_SOURCE_ID:-}" ] ||
    [ -z "${_GBRAIN_REPAIR_ROOT:-}" ] ||
    [ -z "${_GBRAIN_REPAIR_TARGET_HEAD:-}" ] ||
    [ -z "${_GBRAIN_REPAIR_EXPECTED_BOOKMARK:-}" ]; then
    printf 'Run and review gbrain_repository_preview first.\n' >&2
    return 1
  fi
  printf '%s\n' "$_GBRAIN_REPAIR_PLAN_DIGEST" |
    grep -Eq '^[0-9a-f]{64}$' || {
    printf 'Stored preview plan_digest is invalid; preview again.\n' >&2
    unset _GBRAIN_REPAIR_PLAN_DIGEST
    return 1
  }
  CURRENT_ROOT=$(git rev-parse --show-toplevel) || return
  CURRENT_HEAD=$(git rev-parse --verify HEAD) || return
  if [ "$CURRENT_ROOT" != "$_GBRAIN_REPAIR_ROOT" ] ||
    [ "$CURRENT_HEAD" != "$_GBRAIN_REPAIR_TARGET_HEAD" ]; then
    printf 'Repository root or HEAD changed after preview; preview again.\n' >&2
    unset _GBRAIN_REPAIR_PLAN_DIGEST
    return 1
  fi

  if gbrain sync \
      --strategy auto \
      --source "$_GBRAIN_REPAIR_SOURCE_ID" \
      --repo "$_GBRAIN_REPAIR_ROOT" \
      --no-pull \
      --expected-target "$_GBRAIN_REPAIR_TARGET_HEAD" \
      --expected-bookmark "$_GBRAIN_REPAIR_EXPECTED_BOOKMARK" \
      --require-clean \
      --no-embed \
      --no-extract \
      --expected-plan-digest "$_GBRAIN_REPAIR_PLAN_DIGEST" \
      --json; then
    APPLY_STATUS=0
  else
    APPLY_STATUS=$?
  fi
  unset _GBRAIN_REPAIR_PLAN_DIGEST
  return "$APPLY_STATUS"
}

gbrain_repository_preview
```

This is the recovery-safe content preview. It reads the configured engine and
may use GBrain's transient source-lock lifecycle, but it must not pull Git,
mutate repository files, apply content/bookmark changes, call image providers,
or run extraction/embedding. It returns a schema-1
`validated_index_plan` with a 64-character lowercase `plan_digest`. Review its
one-document plan, then invoke `gbrain_repository_apply_preview` in the same
shell for an explicit repair. Never remove `--dry-run` and apply without
passing that exact digest through `--expected-plan-digest`.

The ordinary wrapper is separate: under its own lock it runs the same strict
preview, validates the complete bounded schema, passes the exact digest to
apply, and requires the successful apply result to echo the same digest. It
never claims to apply a stale or different plan.

## Normal flow

Run from the intended worktree:

```bash
/sync-gbrain --code-only
```

The repository stage is terminal on refusal, partial application, or
unverified application. Memory ingest, artifact sync, `.gitignore` changes,
legacy cleanup, reindex, and dream do not continue across that boundary.

### First invocation: source registration

If the source does not exist, a real invocation performs only:

```text
gbrain sources add <source-id> --path <canonical-root> --federated
```

It then stops with exit 2:

```json
{
  "status": "incomplete",
  "reason_code": "source_registered",
  "state_changed": "registry_only"
}
```

No sync or attach occurs. This is intentional: a source cannot have a
bookmark-bound content plan until it exists.

### Second invocation: expected-state sync

Run the same wrapper command again. The strict source snapshot can now bind
`--expected-bookmark <sha|none>`. A clean tree adds `--require-clean`; a dirty
tree may be operationally indexed but cannot receive a trusted clean-HEAD
receipt. Before apply, the wrapper requires a schema-1 `dry_run` plan and binds
apply to its full `plan_digest`.

## Source and path decisions

| Condition | Result | Persistent effect | Next action |
|---|---|---|---|
| Source absent | `source_registered` | `registry_only` | Run the wrapper again; optionally inspect a validated GBrain content preview first. |
| Stored `.` / relative / absolute / symlink resolves to this root | `equivalent` | No registration rewrite | Continue with expected target/bookmark. |
| Stored path resolves to another directory | `source_path_different` | `none` | Stop. Inspect the source and owner intent; never remove/re-add automatically. |
| Missing, inaccessible, non-directory, or otherwise unprovable path | `source_path_ambiguous` | `none` | Stop and repair filesystem/source metadata under owner review. |
| Windows path contains whitespace or shell metacharacters | `unsupported_path` | `none` | Move/use a safe path or wait for the argv-preserving launcher transport replacement. |
| Source changes during execution | child refusal / `sync_blocked` | Child-reported state | Re-read the source and retry; do not override expected-state guards. |
| Plan changes between preview and apply | `plan_changed` | `none` | Review the returned observed/required digests, then preview again; never reuse the prior digest. |

Useful read-only inspection:

```bash
gbrain --version
gbrain sources list --json
git rev-parse --show-toplevel
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=normal
```

## Result and state semantics

For every completed `--json` invocation, the wrapper writes exactly one
schema-1 JSON document on stdout. Its public keys are `result_kind`,
`reason_code`, and `state_changed`. An externally terminated process may not
return a document; absence is always an unverified failure, never success.

| `state_changed` | Meaning |
|---|---|
| `none` | No durable repository-index state changed. |
| `lock_only` | Only transient lifecycle-lock state may have changed. |
| `registry_only` | Source registration changed; content sync and attach did not run. |
| `partial` | Repository-index support metadata or content may have changed, but no full completion proof exists. |
| `applied_unverified` | Content may be complete, but post-sync source, attach, clean-HEAD, or receipt verification failed. Do not imply rollback. |
| `applied_verified` | Content, source marker, bookmark/strategy, clean HEAD, and atomic receipt all verified. |

Only GBrain child statuses `synced`, `first_sync`, and `up_to_date` can proceed
to post-apply verification. `partial`, `blocked_by_failures`, a nonzero
unstructured exit, malformed/multiple JSON, wrong producer, or unknown status
cannot attach or produce GREEN.

## Trusted receipt

After a clean verified run, the wrapper atomically writes:

```text
~/.gstack/.gbrain-repository-index-receipt.json
```

Before consuming it, bind that persisted evidence to the live worktree:

```text
/sync-gbrain --verify-receipt --json
```

The verifier is read-only and does not contact GBrain. It checks the wrapper
lock and attempt watermark both before and after rebinding the receipt to the
live canonical root, attached source id, clean full HEAD, and tracked-marker
state. An active wrapper returns `receipt_in_progress`. A newer attempt that
did not reach GREEN leaves its watermark and returns `receipt_superseded`;
do not delete that watermark to resurrect historical evidence—run the wrapper
again and let a fully verified result replace it. Never use a receipt to turn
an explicit `--no-code` run GREEN.

The receipt binds:

- strict detected and required GBrain versions;
- source id, stored path, canonical root, and `equivalent` identity;
- full Git HEAD, clean-tree state, bookmark before/after, and
  `last_successful_strategy: auto`;
- terminal status and added/modified/deleted/renamed counts;
- the full immutable `plan_digest` shared by preview and successful apply;
- at most 100 canonically sorted affected items plus a SHA-256 digest over all
  `<operation>\t<POSIX path>\t<slug>\t<rename source path or empty>\n`
  tuples;
- tracked-Markdown/code counters when supplied by GBrain;
- zero image operations and disabled multimodal admission;
- embedding, extraction, and search-readiness evidence without overclaiming.

`image_operations_applied: 0` means this invocation admitted no new image work. It does
not claim that the pre-existing corpus has no image pages. A recovery run with
`--no-embed --no-extract` is content-current but reports semantic phases as
deferred and `search_ready: false`.

Page count alone is never a trusted repository receipt.

## Recovery branches

### Unsupported or mixed versions

If GBrain is missing, malformed, or below `0.42.71.0`, stop before source
mutation. Upgrade GBrain first, then re-run the validated preview and wrapper.
New gstack with old GBrain must refuse; old gstack with fixed GBrain does not
gain this wrapper contract automatically.

Until both compatible releases are installed, use repository files and `rg`.
Do not use the previously unsafe raw preview path.

### Partial or blocked child result

Do not attach, run cleanup, or declare GREEN. Inspect the structured reason and
source bookmark. Fix the named file/lock/precondition and retry the same
source-scoped command. Never use `--skip-failed`, break-lock, or destructive
source changes as an automatic recovery.

### Applied but unverified

`applied_unverified` means the child may already have changed index content.
There is no automatic rollback. Fix the failing postcondition—source
bookmark/strategy reread, `.gbrain-source` attach, clean HEAD, or receipt
write—and re-run verification against the same current state.

### Known missing tracked Markdown after the fixed release

1. Commit or otherwise establish the exact intended HEAD.
2. Prove GBrain `>= 0.42.71.0`.
3. Prove the source id, canonical path, and current bookmark.
4. Run `gbrain_repository_preview` above, which performs the validated
   `auto --no-pull --no-embed --no-extract --dry-run --json` command and
   captures its strict `plan_digest`.
5. Review the affected Markdown operation.
6. In the same shell, run `gbrain_repository_apply_preview`. It keeps the
   validated variables and quoted argv and supplies the exact digest through
   `--expected-plan-digest`; a changed plan refuses before mutation. Then run
   the wrapper to attach and produce its trusted receipt.

### Rollback

Reverting gstack changes does not remove or restore derived GBrain content.
Reverting GBrain does not make an old wrapper safe. Roll back the owning
release if required, keep the source registration intact, and use files plus
`rg` until an owner-authorized fixed-version reconciliation is available.

Never force a remove/re-add to simulate rollback: that destroys the identity
and bookmark evidence needed to understand what happened.

## When to repeat

Run `/sync-gbrain` after committed source-code changes or tracked Markdown
changes that should be searchable. A trusted receipt is HEAD-bound; later
commits make it historical evidence, not proof of the new tree.
