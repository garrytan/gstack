# GStack 2 upgrade and rollback

Skill placement and the optional runtime have different lifecycles. Do not
reintroduce host-specific setup by coupling them. Standard skill installation
remains Markdown-only; runtime dependencies are never smuggled into that path.

## Skill updates

Install and update the canonical Agent Skills source with the same standard
installer that placed it:

```bash
npx skills add time-attack/gstack
```

Use that installer's update/remove commands and scope. It owns project/global
placement, host destination paths, and selected-skill choices. GStack must not
re-detect hosts during an update or enroll a host/skill the user did not
previously select.

Before accepting an update, list the source and confirm that the defaults are
still exactly `plan`, `design`, `qa`, `debug`, `review`, and `ship`. Pure
judgment must remain usable even if the optional runtime update fails.

## 1.x command migration

The complete old-to-new map is [SKILL-MIGRATION.md](./SKILL-MIGRATION.md).
Opt-in compatibility aliases are retained for two minor releases or 90 days
from the 2.0 release, whichever policy the release notes identify. Each alias:

1. prints the canonical replacement;
2. routes to the exact preserved specialist module;
3. contains no copied judgment; and
4. stays outside default skill discovery.

Examples:

```text
/office-hours       -> /plan --mode product
/plan-eng-review    -> /plan --mode eng
/design-review      -> /design --mode live-review
/qa-only            -> /qa --mode report
/investigate        -> /debug --mode investigate
/cso                -> /review --mode security
/land-and-deploy    -> /ship --mode land
```

Existing safe preferences may migrate. Context.dev choice and data-egress
consent must never be inferred from legacy browser, telemetry, service, or
update-check settings. Leave Context network mode off until the user explicitly
selects it.

## Initial managed runtime install

From a reviewed repository checkout, install only the optional runtime and
local capability bundle with:

```bash
./setup
```

Skill placement remains a separate standard-installer operation. `./setup`
resolves a symlinked source checkout, installs frozen production-only
dependencies, and invokes `runtime/install.js`. The installer copies an explicit allowlist
into an immutable version, rejects internal symlinks and path escapes, records
size/mode/SHA-256 for every file, validates capability targets, smoke-tests the
CLI, then atomically activates it. Stable POSIX and Windows launchers are
written under `$GSTACK_HOME/bin` (default `~/.gstack/bin`), alongside
`runtime-install.json`, which distinguishes managed paths from preserved
config, secrets, projects, and plans.

Twenty-one focused installer tests pass with 307 assertions. They cover paths
with spaces, a symlinked source root, internal-link rejection, runtime-only
builder selection, production dependency closure, failed build/validation/
smoke rollback, interrupted recovery, launchers, manifests, wrapper neutrality,
and state-preserving uninstall.

The current managed-bundle audit records 107 components, 1,830 files,
459,056,031 bytes, and 50 launchers. The Sharp/ngrok closure is included. The
development-only Claude Agent SDK and Hugging Face sidecar are excluded; the
Hugging Face package is development-only. Setup therefore installs neither its
inference runtime nor model weights and reports the L4 capability unavailable.

A separate clean Linux arm64 container smoke copied the source through a path
with spaces, installed only frozen production dependencies with the development
SDK absent, rebuilt runtime capabilities without Git history or skill
regeneration, passed setup/doctor/version/design/PDF checks, completed a local
browser journey and Sharp full-page screenshot, and uninstalled while
preserving state. Non-Darwin bundles omit the physical-iOS capability. Native
Windows execution remains a separate gate; source-level Windows launchers are
not native evidence.

## Runtime upgrade transaction

The candidate runtime intentionally does not combine “download arbitrary code”
with activation. Give it a reviewed staged directory and an explicit version:

```bash
gstack upgrade --source /path/to/verified-runtime --version 2.0.1
```

The transaction is:

```text
validate version and source
  -> lock upgrade state
  -> recover any interrupted pending transaction
  -> copy to a unique stage directory
  -> write stage metadata
  -> run verification when supplied
  -> atomically rename stage to immutable version directory
  -> write pending pointer with last-known-good
  -> run health check
  -> atomically mark pointer active
```

If copy/verification fails, the stage directory is removed and the active
pointer is unchanged. If health fails, the previous pointer is restored and
the command returns `UPGRADE_ROLLED_BACK`. If the process dies after writing a
pending pointer, the next upgrade/cleanup/doctor path recovers the last known
good version before selection.

The runtime uses one per-user version store, not one copy per AI host. Skill
install failure and runtime install failure are independent; neither may erase
the other.

## Manual rollback

Inspect health first:

```bash
gstack doctor
gstack doctor --json
```

Roll back to the retained last-known-good version:

```bash
gstack upgrade --rollback
```

Rollback validates that the retained directory exists, optionally health-checks
it in the library call, atomically switches the pointer, and retains the version
rolled back from as the next fallback. If no fallback exists it fails with an
actionable error rather than choosing an arbitrary directory.

Runtime state schemas migrate forward only. If a state or migration marker is
newer than the running runtime, stop with `STATE_NEWER_THAN_RUNTIME` or
`MIGRATION_NEWER_THAN_RUNTIME`; never downgrade or rewrite the newer data.

## Recovery after interruption

1. Do not delete `~/.gstack/versions/current.json` while diagnosing.
2. Run `gstack doctor --json` and preserve the output with secrets removed.
3. Run `gstack cleanup --dry-run` to preview only stale managed temporaries.
4. Retry the upgrade command. It recovers a pending pointer before staging.
5. If the candidate remains unhealthy, use `gstack upgrade --rollback`.
6. Inspect the current worktree's run state with `gstack state inspect`.
7. Resume only the named/current-worktree run. An external effect left
   `uncertain` must be reconciled; do not clear the marker and repeat it blindly.

Cleanup skips symlinks and user-named data, and removes only recognized stale
runtime temporaries/locks. `--dry-run` is non-mutating.

## Uninstall

Use the standard installer to remove skills. Separately, remove managed runtime
versions while preserving configuration, secrets, and project history:

```bash
gstack uninstall
```

Purge all runtime state only after reviewing the path and accepting data loss:

```bash
gstack uninstall --purge --yes
```

The runtime refuses unsafe roots such as the filesystem root or home directory.
It does not remove host skills, browser profiles, unrelated apps, repositories,
or iPhone data.

## Evidence state

Focused candidate tests cover the managed installer plus atomic activation,
failed-health rollback, interrupted-pointer recovery, manual rollback,
newer-schema refusal, and non-mutating cleanup preview. The standard installer
matrix separately passed 470/470 checks across six hosts, 16 installs, scopes,
selections, and two removals; its artifact is
[`evals/installation/install-matrix.json`](../../evals/installation/install-matrix.json).
The runtime installer is green at 21 pass / 0 fail and 307 assertions, and the
current 107-component bundle audit is recorded. The clean Linux Dev Container
install/uninstall smoke passed. Interrupted network acquisition/stage at OS
level, a passing live v3 host run, actual host UI execution, native-host Linux,
and native Windows runs remain gates. See
[TEST-EVIDENCE.md](./TEST-EVIDENCE.md).
