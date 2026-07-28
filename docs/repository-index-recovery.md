# Repository index sync and recovery

This guide is for the repository-index stage of `/sync-gbrain`: committed
source code and tracked Markdown from the current Git worktree into one
worktree-scoped GBrain source.

It is not the cross-machine GStack artifact-sync feature. Artifact sync moves
selected plans, retros, learnings, and profile data from `~/.gstack/` through a
private Git repository; see
[Cross-machine GStack artifact sync](gbrain-sync.md).

## Safety contract

Repository indexing requires GBrain `0.42.70.0` or newer. The wrapper compares
all four numeric version components and refuses missing components,
prerelease/build suffixes, or unrelated prose. This is a paired-release floor:
reconfirm it against the actual released GBrain version before adopting the
gstack change.

The wrapper:

- reads one strict registered-source snapshot before planning;
- resolves relative, absolute, and symlinked paths to canonical filesystem
  identity;
- never fixes path drift by removing and re-adding a source;
- invokes one source with strategy `auto`, `--no-pull`, exact target and
  bookmark preconditions, and `--require-clean` when the tree is clean;
- sets `GBRAIN_EMBEDDING_MULTIMODAL=false` in a copied child environment;
- accepts only one schema-1 GBrain JSON document with a recognized terminal
  status;
- re-reads source bookmark and strategy after application, writes the source
  marker through a wrapper-owned non-following atomic replacement, then
  re-reads the strict source snapshot again;
- writes a bounded, atomic receipt only after every postcondition verifies.

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
the source-scoped GBrain preview. Replace the placeholders with values from the
wrapper/source snapshot:

```bash
gbrain sync \
  --strategy auto \
  --source <source-id> \
  --repo <canonical-repository-root> \
  --no-pull \
  --expected-target <40-character-HEAD> \
  --expected-bookmark <40-character-bookmark-or-none> \
  --require-clean \
  --no-embed \
  --no-extract \
  --dry-run \
  --json
```

This is the recovery-safe content preview. It reads the configured engine and
may use GBrain's transient source-lock lifecycle, but it must not pull Git,
mutate repository files, apply content/bookmark changes, call image providers,
or run extraction/embedding. Review its one-document plan before removing only
`--dry-run` for an explicit repair.

The ordinary wrapper is separate: it recomputes expected state under its own
lock and never claims to apply a stale prior preview.

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
receipt.

## Source and path decisions

| Condition | Result | Persistent effect | Next action |
|---|---|---|---|
| Source absent | `source_registered` | `registry_only` | Run the wrapper again; optionally inspect a validated GBrain content preview first. |
| Stored `.` / relative / absolute / symlink resolves to this root | `equivalent` | No registration rewrite | Continue with expected target/bookmark. |
| Stored path resolves to another directory | `source_path_different` | `none` | Stop. Inspect the source and owner intent; never remove/re-add automatically. |
| Missing, inaccessible, non-directory, or otherwise unprovable path | `source_path_ambiguous` | `none` | Stop and repair filesystem/source metadata under owner review. |
| Windows path contains whitespace or shell metacharacters | `unsupported_path` | `none` | Move/use a safe path or wait for the argv-preserving launcher transport replacement. |
| Source changes during execution | child refusal / `sync_blocked` | Child-reported state | Re-read the source and retry; do not override expected-state guards. |

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

```bash
gstack-gbrain-sync --verify-receipt --json
```

The verifier is read-only and does not contact GBrain. It requires the receipt
to match the live canonical root, attached source id, clean full HEAD, and
tracked-marker state. Never consult a prior receipt after the current
repository invocation exits nonzero, and never use a receipt to turn an
explicit `--no-code` run GREEN.

The receipt binds:

- strict detected and required GBrain versions;
- source id, stored path, canonical root, and `equivalent` identity;
- full Git HEAD, clean-tree state, bookmark before/after, and
  `last_successful_strategy: auto`;
- terminal status and added/modified/deleted/renamed counts;
- at most 100 canonically sorted affected items plus a SHA-256 digest over all
  `<operation>\t<POSIX path>\t<slug>\n` tuples;
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

If GBrain is missing, malformed, or below `0.42.70.0`, stop before source
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
2. Prove GBrain `>= 0.42.70.0`.
3. Prove the source id, canonical path, and current bookmark.
4. Run the validated `auto --no-pull --no-embed --no-extract --dry-run --json`
   command above.
5. Review the affected Markdown operation.
6. Remove only `--dry-run`, run the exact expected-state repair, then run the
   wrapper to attach and produce its trusted receipt.

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
