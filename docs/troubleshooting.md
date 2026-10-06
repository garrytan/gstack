# Troubleshooting gstack messages

Find the message you saw, then follow its fix. Every check gstack runs ends in
one of three states:

- **ran**: the check executed. It may still have found problems.
- **not run**: gstack chose not to run it (you turned it off, or nothing applied).
- **unavailable**: gstack tried and could not run it. This is missing coverage,
  never a pass.

A message that is not `ran` has this shape:

```
<check>: not run (<reason>). Fix: <command>
<check> unavailable: <reason> (<detail>). No review ran; this is missing coverage, not a pass. Fix: <command>
<check>: ran, verdict unverified (<reason>). Fix: read the output above
```

Search this page for the words after `unavailable:` or `not run (`. Each
section has a stable link anchor; the reason codes and anchors come from
`lib/gate-outcomes.ts`, and a free test fails if a code has no section here.

---

## Outside reviews (Codex and Claude Code)

Outside reviews send your diff, plan or question to a second AI provider. Their
verdict comes from `lib/outside-review-result.ts`, which prints
`VERDICT: clean|findings|unverified|unavailable`. A `findings` verdict with a
P0 or P1 finding blocks exactly like a native P0/P1. `unverified` and
`unavailable` are missing coverage: /ship and /review continue, show the gap in
the readiness dashboard and the PR body, and never count it as a pass.

<a id="codex-sandbox-unavailable"></a>
### `Codex outside review unavailable: Codex's sandbox could not start here (...)`

**Meaning.** Codex runs every command inside a Linux sandbox (bubblewrap). In
many containers and devcontainers the kernel does not allow unprivileged user
namespaces, so the sandbox cannot start and every command Codex tries fails.
gstack reports this instead of trusting a review that read nothing.
`CODEX_MODE: sandbox_unavailable` is the same condition found by the free
preflight before any paid call.

**What is kept.** Nothing was sent for review, or the review was discarded. Your
code and files are unchanged.

**Fix.** Enable unprivileged user namespaces for the container (for Docker, a
seccomp profile that allows them), or, inside a container you trust, run
Codex without its sandbox for this shell:

```bash
export GSTACK_CODEX_NO_SANDBOX=1
```

**Expected result.** With namespaces enabled, the next review prints
`OUTSIDE_STATUS: completed`. With `GSTACK_CODEX_NO_SANDBOX=1`, every review
prints `WARNING: GSTACK_CODEX_NO_SANDBOX=1: ...` because Codex can then read
and write anything your user can. Only the exact value `1` works, and only from
your shell environment.

<a id="outside-review-commands-failed"></a>
### `... outside review unavailable: the reviewer could not run commands or read the diff (...)`

**Meaning.** The reviewer tried to run commands but none succeeded, or its
answer says it could not run commands or read the diff. A "no issues found"
written after that is not a review.

**What is kept.** Nothing; the answer is shown above but not counted.

**Fix.** Read the reviewer's stderr above, repair what it names, and re-run.

**Expected result.** `OUTSIDE_STATUS: completed` with a `VERDICT:` line.

<a id="outside-review-execution-failed"></a>
### `... outside review unavailable: the reviewer process failed (exit N: ...)`

**Meaning.** The provider CLI exited non-zero. The first stderr line is in the
parentheses.

**What is kept.** Partial output is shown above; it is not counted.

**Fix.** Repair the cause in the provider diagnosis (log in again, fix the
model, check the network), then re-run.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-timeout"></a>
### `... outside review unavailable: the reviewer hit its time limit and was stopped (exit 124)`

**Meaning.** The provider did not finish within its deadline and was stopped.

**What is kept.** Partial output is shown above; it is not counted.

**Fix.** Re-run with a smaller scope, or check the provider's status and your
network.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-empty-response"></a>
### `... outside review unavailable: the reviewer returned no response`

**Meaning.** The provider exited successfully but returned nothing.

**Fix.** Read the stderr above, then re-run.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-refused"></a>
### `... outside review unavailable: the reviewer declined to review`

**Meaning.** The provider answered with a refusal instead of a review.

**Fix.** Re-run; if it declines again, rely on the native review.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-missing-markers"></a>
### `... outside review unavailable: the response lacks the markers this gate requires (...)`

**Meaning.** The answer did not contain what the gate checks: a
`Recommendation: ... because ...` line, a `SCORE:`/`AMBIGUITIES:` pair, or
severity tags.

**Fix.** Re-run the review.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-unverified"></a>
### `... outside review: ran, verdict unverified (...)` / `OUTSIDE_STATUS: unverified` / `GATE: UNVERIFIED`

**Meaning.** The review completed but tagged nothing and gave no explicit
no-findings conclusion, so no pass or fail can be read from it.

**What is kept.** The full answer is shown above.

**Fix.** Read the output above and decide. It is not a pass, and /ship and
/review list it as missing coverage.

<a id="codex-model-unusable"></a>
### `CODEX_MODE: model_unusable` / `MODEL_UNUSABLE`

**Meaning.** Codex rejected the selected model: the account cannot use it
(HTTP 400), the model is retired, or a custom provider's `base_url` is wrong
(HTTP 404). The `CODEX_MODEL:` line names the model and where it came from.

**Fix.** Choose a model your account can use, or correct the provider:

```bash
export GSTACK_CODEX_MODEL=<supported-model>
# or edit model / base_url in ${CODEX_HOME:-~/.codex}/config.toml
```

**Expected result.** `CODEX_MODE: ready`.

<a id="codex-mode-unverified"></a>
### `CODEX_MODE: unverified` / `MODEL_PROBE_INCONCLUSIVE`

**Meaning.** The short model check timed out or hit a network error, so gstack
could not confirm the model works. The review still runs and its own result is
checked.

**Fix.** Nothing now. If the review then fails, its message says why.

<a id="codex-auth-failed"></a>
### `CODEX_MODE: not_authed` / `AUTH_FAILED`

**Meaning.** No Codex credentials were found: no `CODEX_API_KEY`, no
`OPENAI_API_KEY`, no `auth.json`, and no set environment variable named by a
custom provider's `env_key` in `config.toml`.

**Fix.**

```bash
codex login
```

or export the variable your provider's `env_key` names.

**Expected result.** `CODEX_MODE: ready`.

<a id="outside-review-disabled"></a>
### `Codex review skipped (codex_reviews disabled)` / `CODEX_MODE: disabled`

**Meaning.** You turned outside reviews off. This is `not run`, never a pass and
never an outage.

**Fix.** To turn them back on:

```bash
gstack-config set codex_reviews enabled
```

<a id="codex-review-notice"></a>
### `NOTICE: gstack outside reviews send the review prompt and code to Codex (...) using ...`

**Meaning.** Outside reviews are on by default. The first one on a machine
says which provider receives your prompt and code and which login or key pays
for it. It shows once (gstack records `.codex-review-notice-shown` in its state
directory) and never blocks the review.

**Fix.** Nothing, if that is what you want. To stop sending code to Codex:

```bash
gstack-config set codex_reviews disabled
```

**Expected result.** Later reviews print `Codex review skipped (codex_reviews disabled)`
or `CODEX_MODE: disabled`, and /ship and /review show the outside review as not run.

---

## /ship, /review and /document-release

<a id="ship-no-version-source"></a>
### `Shipped without a version change: no version source is configured (no VERSION file, no .gstack/version-path). ...`

**Meaning.** /ship found no version file it owns: there is no `VERSION`, no
`.gstack/version-path`, or release automation (release-please, Changesets,
semantic-release, a workspace monorepo, a placeholder package.json version)
owns the version. This is `not run` for the version bump.

**What is kept.** Everything else ships. No bump, no CHANGELOG version header,
no `vX.Y.Z` PR title prefix.

**Fix.** To have /ship version releases, create `VERSION`, or pin the file:

```bash
echo package.json > .gstack/version-path && git add .gstack/version-path
```

**Expected result.** The next /ship bumps that file and writes a CHANGELOG header.

<a id="ship-version-source-broken"></a>
### `gstack-version-bump: classify: version source is broken: <path> ...`

**Meaning.** The pinned version file does not exist, is empty, unreadable, or
contains no parsable version. /ship stops instead of inventing `0.0.0.0`.

**What is kept.** Nothing was written.

**Fix.** Repair that file, or correct `--version-path` / `.gstack/version-path`.

**Expected result.** `gstack-version-bump classify` prints the current version.

<a id="review-base-stale"></a>
### `BASE_REFRESH: stale <rev>` / `Base coverage: stale at <rev>`

**Meaning.** /review could not fetch the base branch (offline, no credentials,
or a read-only `.git` such as Codex's sandbox), so it reviewed against your
local `origin/<base>` at `<rev>`.

**Fix.** Run `git fetch origin <base>` outside the sandbox and rerun /review if
the base has moved.

<a id="review-fingerprint-tmpdir"></a>
### `gstack-wtree: cannot create a temp index under <dir>; set TMPDIR to a writable directory` / `gstack-review-log: cannot create a private object directory under <dir>; no working-tree fingerprint. Set TMPDIR to a writable directory.`

**Meaning.** /review fingerprints the working tree in a private temporary
object directory (Codex's sandbox keeps `.git` read-only). The temp directory
could not be created, so this review has no fingerprint and later steps cannot
reuse its evidence.

**Fix.** `export TMPDIR=<a writable directory>`, then run /review again.

<a id="review-fingerprint-stage"></a>
### `gstack-wtree: cannot stage the working tree: <git error>`

**Meaning.** The fingerprint's objects could not be written. Standalone
`gstack-wtree` writes into the repository's object store.

**Fix.** Run it through /review (`gstack-review-log` supplies a private object
directory), or make `.git/objects` writable.

<a id="plan-audit-not-run"></a>
### `Plan completion audit: not run (no plan is bound to this branch and no docs/designs/ file matches). Fix: ...`

**Meaning.** /ship and /review audit a PR against the plan bound to its branch
(plan mode, /autoplan, or a `Plan: <path>` line in the PR body). With none bound
and no matching `docs/designs/` file, they no longer pick the newest unrelated
plan; the audit is `not run`.

**Fix.** Add `Plan: docs/designs/<file>.md` to the PR body, or run /autoplan.

**Expected result.** The next /ship or /review prints the audit against that plan.

<a id="learnings-bun-missing"></a>
### `gstack-learnings-search: bun not found on PATH, so learnings could not be read. Fix: ...`

**Meaning.** Learnings search (and `gstack-timeline-read`, "the timeline") needs
Bun. It exits 127 instead of looking like "no learnings".

**Fix.** Install Bun from https://bun.sh, then `cd <gstack checkout> && ./setup`.

**Expected result.** Skills print your prior learnings again.

<a id="learnings-unavailable"></a>
### `LEARNINGS: unavailable (<first stderr line>)`

**Meaning.** A skill's learnings lookup failed (often Bun is missing). Skills
used to show nothing here, which looked like "no learnings".

**What is kept.** Your learnings file is untouched; the skill continues without them.

**Fix.** Read the reason in parentheses. If it names Bun, install it and re-run
`./setup`.

<a id="log-tmpdir-unwritable"></a>
### `gstack-learnings-log: could not create a temp file in <dir>, so the learning was not recorded. Fix: ...`

**Meaning.** The learnings, question and preference logs write through a temp
file in `${TMPDIR:-/tmp}`. A sandbox that blocks it used to drop the entry silently.

**Fix.** `export TMPDIR=<a writable directory>` and log again.

<a id="plan-tune-not-calibrated"></a>
### `CALIBRATION: not calibrated: no recorded signals`

**Meaning.** Your logged answers matched no psychographic signal, so /plan-tune
has nothing to calibrate from. It no longer says "calibrated".

**Fix.** Answer more registered questions, then `gstack-developer-profile --derive`.

<a id="skill-start-former-bucket"></a>
### `gstack: earlier data for this project is in projects/<slug> (a worktree's old bucket). Merge it: ...`

**Meaning.** Linked worktrees now share the main checkout's project identity.
Learnings and checkpoints a worktree wrote under its own old bucket still exist.

**Fix.** Merge them (logs are de-duplicated, conflicts listed, nothing overwritten):

```bash
gstack-slug --adopt-legacy --from <slug>
```

Or stop the reminder: `gstack-slug --adopt-legacy --dismiss <slug>`.

---

## Design skills

<a id="design-not-available"></a>
### `DESIGN_NOT_AVAILABLE: <path> --version exited <code>` (or `timed out after 10s`, `is not installed`, `no timeout/gtimeout/perl ...`)

**Meaning.** Design skills now run `"$D" --version` with a 10-second deadline
before claiming `DESIGN_READY`. Exit 137 means macOS killed the binary at launch
(a bad code signature); setup prints the same condition as
`design unavailable: <bin> is killed at launch (exit 137) after re-signing`.

**What is kept.** Nothing was generated or spent.

**Fix.** Re-run setup, which rebuilds and re-signs the binary:

```bash
cd <gstack checkout> && ./setup
```

If the message names a missing timeout tool, install coreutils (`gtimeout`) or perl.

**Expected result.** The next design skill prints `DESIGN_READY`.

<a id="design-image-model-invalid"></a>
### `GSTACK_DESIGN_IMAGE_MODEL="<value>" is not a gpt-image model name (expected something like gpt-image-2); fix it or unset it to use gpt-image-2`

**Meaning.** The design binary refuses an image tool model override that is not
a `gpt-image-*` model name, before sending any request.

**Fix.** `export GSTACK_DESIGN_IMAGE_MODEL=gpt-image-2` (or another gpt-image
model your key can use), or `unset GSTACK_DESIGN_IMAGE_MODEL`.

<a id="design-taste-profile-unavailable"></a>
### `TASTE_PROFILE_UNAVAILABLE: could not resolve the project slug (gstack-slug failed). Fix: run ./setup.`

**Meaning.** /design-consultation and /design-shotgun load your taste profile.
This says it could not be found, instead of acting as if you had none.

**Fix.** `cd <gstack checkout> && ./setup`.

<a id="design-variant-save-failed"></a>
### `cannot save paid image to <path>: <code> (<cause>). Image bytes were received; saved a recovery copy to <tmp path>. Fix: ...`

**Meaning.** The paid image generation succeeded but writing it to the output
path failed (disk, permissions, or every name through `-999` taken). gstack never
buys the same image twice and never overwrites an existing image.

**What is kept.** The image, at the printed recovery path in your temp directory.

**Fix.** Follow the printed fix (free disk space, make the folder writable, or
pick a new `--output`), then copy the recovery file to where you want it.

---

## Codex and other env-var hosts

<a id="gstack-no-install-found"></a>
### `gstack: no install found (tried <path>). Fix: ./setup --host <host> from your gstack checkout; ./setup --status shows it.`

**Meaning.** On Codex, Factory, OpenCode, Cursor, Copilot and Kiro every bash
block finds gstack on its own: an exported `GSTACK_ROOT` (with `bin/` and
`lib/`), then a repo-local install, then the host's global install
(`$CODEX_HOME/skills/gstack` on Codex). None existed.

**Fix.**

```bash
cd <gstack checkout> && ./setup --host codex   # or your host
./setup --status
```

**Expected result.** `./setup --status` lists the install and says the router is
a real file and its section links resolve.

<a id="setup-status-router-symlink"></a>
### `router is a symlink, which Codex skips` / `section links: N of M broken (first: ...)`

**Meaning.** `./setup --status` checks each registered install. Codex ignores a
symlinked SKILL.md, and a broken section link means a carved skill cannot load
its next step.

**Fix.** `cd <source> && ./setup --host <host>` (the command is printed).

<a id="setup-skill-copy-saved"></a>
### `saved your edited <path> to <backup> (setup rewrites gstack's SKILL.md copies on every run)`

**Meaning.** Installed router and nested SKILL.md files are now real copies,
rewritten by every setup. Your hand edit was saved first.

**What is kept.** Your edit, at `<backup>`. Move the customization into your own skill.

<a id="setup-skill-copy-backup-failed"></a>
### `error: could not back up an edited SKILL.md copy under <root>; the previous runtime root is unchanged`

**Fix.** Fix permissions on `<state root>/backups`, then `./setup --host <host>`.

<a id="upgrade-not-a-checkout"></a>
### `ERROR: <dir> is not a gstack checkout; nothing was changed. Re-run Step 2.` / `INSTALL_DIR is not set: re-run Step 2 ...`

**Meaning.** /gstack-upgrade now checks, before any git command, that it is
inside gstack's own checkout. A block ran without the path Step 2 printed, so it
stopped instead of touching your project.

**Fix.** Run Step 2 again and prefix the block with `INSTALL_DIR=<printed path>`.

<a id="skill-over-size-limit"></a>
### `<host>/<skill>/SKILL.md is <bytes> bytes, over the 160,000-byte limit. Fix: carve sections with usesLazySections() for this skill.`

**Meaning.** For contributors: hosts read at most 160,000 bytes of one SKILL.md.
`bun run gen:skill-docs` fails in the repo and warns under `--install-root`.

---

## Setup and auto-update

<a id="bun-too-old"></a>
### `gstack needs Bun 1.3.3 or newer (1.4.2 recommended); found <version> at <path>. Nothing was installed or changed.`

**Meaning.** Bun older than 1.3.3 silently ignores the build flags that stop
gstack's compiled tools from reading a project's `.env`, so setup refuses it
before writing anything. The same link appears on two warnings that do not stop
setup: `warning: gstack is tested on Bun 1.4.2 (CI pin); found <version>` (1.3.3
up to 1.4.2 works but is untested) and `warning: could not read the Bun version
(...)` (setup continued; check `bun --version`).

**Fix.**

```bash
bun upgrade
./setup
```

**Expected result.** `bun --version` prints 1.4.2 or newer and setup finishes
with no Bun warning.

<a id="auto-update-bun-too-old"></a>
### `gstack auto-update: update held (bun-too-old: found Bun <version> at <path>; gstack <version> needs <floor> or newer); nothing was installed or changed. Fix now: ...`

**Meaning.** Team-mode auto-update fetched a release whose setup needs a newer
Bun than the one setup would run. It left your checkout and installed skills at
the current revision and prints this line once per session start. (An older
auto-updater running its first update cannot make this check.)

**Fix.** `bun upgrade`; the next session start resumes the update. To update
now: `bun upgrade && cd <gstack checkout> && git pull --ff-only && ./setup`.

<a id="auto-update-incomplete"></a>
### `gstack auto-update: setup did not finish (<reason>); installed skills may be out of date. gstack retries automatically. Fix now: cd <dir> && ./setup`

**Meaning.** The pull worked but setup (or migrations) failed. gstack no longer
says "just upgraded". It retries after 1 hour, then 6, then 24, and prints this
line once per session start. A `(bun not found on PATH)` reason means install
Bun first.

**What is kept.** The previous install stays active.

**Fix.** Run the printed command.

<a id="auto-update-pull-failed"></a>
### `gstack auto-update: git pull did not finish (exit N: ...); gstack is not updating. Fix now: ...`

**Fix.** `cd <gstack checkout> && git pull --ff-only && ./setup`.

<a id="cso-windows-msvc-compile"></a>
### `CSO unavailable: its native helper was not built (windows-msvc-compile)`

**Meaning.** Visual Studio's compiler was found but the /cso native helper did
not compile. setup prints the first compiler error. It used to say "install
Visual Studio".

**Fix.** Fix the printed compiler error, then re-run `./setup`.

<a id="conductor-auq-hook-removed"></a>
### `removed the AskUserQuestion preference hook: it breaks Conductor's native AskUserQuestion (#2207). ...`

**Meaning.** In Conductor, setup no longer installs the plan-tune
question-preference hook and removes one it added before. The other plan-tune
hooks stay.

**Fix.** To keep it anyway: `gstack-config set plan_tune_hooks yes`, then `./setup`.

<a id="browse-extension-id-invalid"></a>
### `Error: browse_extension_id '<v>' is not a Chrome extension ID ... Existing value left unchanged.`

**Fix.** Copy the 32-letter ID (letters a to p) from `chrome://extensions`, then
`gstack-config set browse_extension_id <id>`.

---

## Browser

<a id="browse-chromium-path-failed"></a>
### `Chromium at GSTACK_CHROMIUM_PATH=<path> failed to launch: ...`

**Meaning.** Headless browse and make-pdf now use `GSTACK_CHROMIUM_PATH`
(NixOS, macOS 13). That binary could not start.

**Fix.** Point `GSTACK_CHROMIUM_PATH` at a working Chromium, or
`unset GSTACK_CHROMIUM_PATH` to use gstack's bundled one.

<a id="browse-profile-in-use"></a>
### `Headed Chromium profile <dir> is in use by Chromium PID <pid> (started by PID <ppid>: <name>). ...`

**Meaning.** Headed browse keeps one profile per project
(`<project>/.gstack/chromium-profile`). A live browser owns this one, and
browse never kills it. `... is locked by PID <pid> on another host (<host>)`
means the lock came from another machine through a synced folder.

**Fix.** Close that browser, or `export CHROMIUM_PROFILE=<another dir>`. For the
other-host case, stop it there, or remove `<dir>/SingletonLock` once you are
sure nothing uses it.

<a id="browse-profile-per-project"></a>
### `[browse] Headed browse now keeps a profile per project ...`

**Meaning.** First use copies your logins from `~/.gstack/chromium-profile`
when no browser is using it; otherwise it starts fresh and prints how to import.
`browse profiles` lists them, `browse profiles prune --days 30` removes idle ones.

<a id="browse-blocked-address"></a>
### `Blocked: <host> is a cloud metadata or link-local address` / `... resolves to a cloud metadata or link-local address`

**Meaning.** Browse refuses 169.254.0.0/16 (including container credential
endpoints), 100.100.100.200, fe80::/10 and fc00::/7 in every numeric spelling,
including after a redirect or a page-driven navigation. The tab is reset to
`about:blank` and the command fails. This cannot be overridden.

<a id="browse-forbidden-origin"></a>
### `forbidden origin` from the sidebar terminal

**Meaning.** The terminal accepts only gstack's extension. A self-built or forked
extension has a different ID. `BROWSE_EXTENSION_ID` is no longer read.

**Fix.** `gstack-config set browse_extension_id <your 32-letter id>`.

<a id="browse-type-selector-hint"></a>
### `hint: "<word>" looks like a CSS selector`

**Meaning.** Bare `browse type <text>` types into the focused element. The first
word looked like a selector, so it was typed as text.

**Fix.** `browse type --selector '<sel>' <text>` (put text that starts with `--`
after `--`).

<a id="browse-server-node-missing"></a>
### `server-node.mjs not found. Run bun run build` (Windows)

**Fix.** `cd <gstack checkout> && bun run build`.

<a id="freeze-helpers-out-of-date"></a>
### `[freeze] Hook helpers out of date (partial upgrade?)`

**Meaning.** `check-freeze.sh` and `hook-extract.sh` come from different gstack versions.

**Fix.** `cd <gstack checkout> && ./setup` (or `/unfreeze`).

<a id="browse-chromium-pid-unrecorded"></a>
### `[browse] Could not record the Chromium PID (CDP SystemInfo.getProcessInfo: <error>); browse stop cannot reap a surviving Chromium.`

**Meaning.** For a headless Chromium it launched, browse reads the browser's
process id over CDP so `browse stop` can kill a browser that outlives the
server. That read failed or took longer than 2 seconds, so this session's
browser is not recorded. Browsers gstack did not launch are never recorded or
killed.

**Fix.** After `browse stop`, check for a leftover browser with
`ps aux | grep -i chrom` and end it with `kill <pid>`.

---

## Memory and gbrain

Every message below is also in [docs/gbrain-sync-errors.md](gbrain-sync-errors.md)
with more detail, along with the per-page ingest messages (`FAILED`,
`re-queued`, `quarantined`, reconcile progress, kept-on-this-machine notices).

<a id="gbrain-db-unreachable"></a>
### `database host unreachable (<code> <host>); your gbrain config is unchanged. Fix: check network or VPN, then re-run /sync-gbrain.`

**Meaning.** A DNS or connection error reaching your gbrain database. It used to
look like a broken config, and setup stripped brain features while offline.

**Fix.** Restore the network or VPN, then `/sync-gbrain`.

<a id="memory-ingest-unattributed-failures"></a>
### `[memory-ingest] ERR: gbrain reported N failure(s) it did not attribute to a staged page ... Refusing to advance state.`

**What is kept.** Nothing is marked saved, so nothing is lost. After three such
runs gstack bisects the batch and quarantines the page that breaks it.

**Fix.** Re-run `/sync-gbrain`.

<a id="memory-reconcile-not-run"></a>
### `[memory-ingest] reconcile: not run (...)`

**Meaning.** After upgrading, gstack re-checks transcripts it had marked saved
and re-imports the ones missing from your brain. That check needs a local gbrain.

**Fix.** `/setup-gbrain`, then `gstack-memory-ingest --reconcile` (`--dry-run` to preview).

<a id="memory-ingest-locked"></a>
### `[memory-ingest] ERR: another memory ingest (pid <N>) is writing <state file>; not run.`

**Fix.** Wait for it to finish, then re-run `/sync-gbrain`.

<a id="memory-ingest-state-unsaved"></a>
### `[memory-ingest] ERR: could not save ingest state <path>: <error>.`

**Fix.** Fix permissions or free disk space under your gstack state root, then `/sync-gbrain`.

<a id="gbrain-artifacts-not-indexed"></a>
### `curated artifacts pushed to git, but gbrain source <id> has 0 indexed pages. Fix: gbrain sync --source <id>, then re-run /sync-gbrain`

**Fix.** `gbrain sync --source <id>`, then `/sync-gbrain`.

<a id="gbrain-dream-skipped"></a>
### `dream: skipped — the installed gbrain cannot run only the resolve_symbol_edges phase, and the full dream cycle costs about 35 minutes ...`

**Meaning.** `/sync-gbrain --dream` (and `--full`'s auto-build) now runs only the
call-graph phase. Your gbrain cannot scope it, so nothing ran.

**Fix.** `gstack-gbrain-install`, then `/sync-gbrain --dream`. Or run the full
cycle yourself: `gbrain dream --source <id>`.

<a id="gbrain-cycle-freshness-unknown"></a>
### `call graph for <source>: unknown: installed gbrain does not expose cycle_freshness`

**Fix.** `gstack-gbrain-install`.

<a id="gbrain-path-unavailable"></a>
### `[gbrain-sync] gbrain source <id>: path unavailable (<path>); gstack skips it.`

**Meaning.** A deleted worktree's code source. gstack never removes it on its own.

**Fix.** Preview, then remove the ones gstack can prove belonged to this machine:

```bash
gstack-gbrain-sync --prune-gone-worktrees --dry-run
gstack-gbrain-sync --prune-gone-worktrees
```

---

## Eval reports and pass-rates

These come from the paid eval census reports and `bun run eval:pass-rates`.
The walkthrough for a red census is [docs/evals/census-red.md](evals/census-red.md).

<a id="pass-rates-unknown-flag"></a>
### `eval:pass-rates: unknown flag <flag>` / `eval:pass-rates: unknown case <id> (not an E2E, judge or paid test file id)`

**Meaning.** The flag or case id is not recognized. The command exits 2 before
fetching anything.

**Fix.** `bun run eval:pass-rates --help` lists the flags. `--case` takes a
registry id from `test/helpers/touchfiles-data.ts` or a paid test file path.

<a id="failure-cause-newer"></a>
### `unknown failure_cause "<x>" (written by a newer gstack; update this checkout to read it)`

**Meaning.** A trial record names a failure cause this checkout does not know.
A newer gstack wrote it.

**Fix.** `git pull` (or rebase your branch onto `main`), then rerun the command.

<a id="paid-case-several-owners"></a>
### `--case <id>: registered by <file>, <file>; it needs exactly one`

**Meaning.** More than one paid test file registers the case, so
`test-paid-shards.ts --case` cannot pick one file.

**Fix.** Run the red shard's file directly; the report's `after a repair:` line
prints it: `EVALS=1 EVALS_TIER=<tier> bun test <file>`.

<a id="evidence-too-large"></a>
### `evidence: <artifact> too large to fetch (<N> MB)`

**Meaning.** The slice artifact holding this red's transcript is over 64 MB, so
`eval:pass-rates --run` does not download it.

**Fix.** Download it from the run page, or
`gh api repos/<owner>/<repo>/actions/artifacts/<artifact id>/zip > slice.zip`.

<a id="headroom-alarm"></a>
### `[headroom] <case> session <key>: max <s> of <s> (<pct>) over <n> sample(s), above the 85% cap. Cut work in the skill or fixture; budgets are never raised ...`

**Meaning.** `eval:pass-rates --gate` (the weekly report) found a case whose
slowest session used more than 85% of the timeout it armed. It is one timeout
away from a red.

**Fix.** Cut work in the skill or fixture. Budgets are never raised. Check the
case with `bun run eval:pass-rates --headroom --case <id>`.

<a id="cost-unknown"></a>
### `cost unknown (no billing captured for any of <N> trial(s))` / `cost $<x> known + <N> of <M> trial(s) cost unknown`

**Meaning.** PTY and Codex sessions record no billing, so their cost is
unknown. Only the known sum is shown.

**Fix.** None needed; this is informational.

<a id="cause-provider-stall"></a>
### `· cause provider_stall: no stream event for <N>s ...`

**Meaning.** The session streamed partial messages, then received no event of
any kind for at least 120 seconds while a model request was in flight and no
tool, permission prompt, hook or subagent was outstanding. Under EVAL_POLICY v1
it is still a failed trial.

**Fix.** Inspect it with `bun run eval:pass-rates --run <run id> --case <id>`.
A paid rerun happens only after a repair.

<a id="overlay-wrong-answer"></a>
### Overlay record with `taskCorrect: false` and `answerError` (contract v4)

**Meaning.** The trial completed with a wrong answer. Under overlay contract v4
that is a valid measurement in the comparison; only an overlay-ON wrong answer
fails the case.

**Fix.** Read `answerError` in the trial JSON. No rerun is needed.

<a id="detector-corpora-stale"></a>
### `[detector-corpora] <N> stale entries (refresh from a current census when one fails)`

**Meaning.** Some replay-corpus entries came from an older input series of
their case. This is informational; the corpus still replays them.

**Fix.** When that case goes red in a census, add the new capture to its corpus
and check it with `bun test test/detector-corpus-<case>.test.ts`.

<a id="auq-substance-panel"></a>
### `recommendation substance median <x> < 4 over samples [<a>,<b>,<c>] (boilerplate/weak)`

**Meaning.** The auq-matrix case scores each captured question's recommendation
with a 3-sample judge panel; fewer than 2 of the 3 samples reached 4, so their
median was below 4.

**Fix.** Read the logged samples and the captured question. A fix goes in the
skill text, followed by one diagnostic run of auq-matrix.

---

## Push guard (redaction)

<a id="redact-postgres-default-pair"></a>
### `db.url_with_password` HIGH on a default `postgres`/`postgres` login whose host is a service name like `@db` (pre-push BLOCKED)

**Meaning.** The default `postgres:postgres` pair is exempt only on `localhost`
or `127.0.0.1`. A service name like `@db` says nothing about where the URL ends
up deployed, so it still blocks.

**Fix.** Use `postgres://postgres:postgres@localhost:5432/...` in local and CI
config, or read the URL from an env var. If the credential is real, rotate it.
Bypass once: `GSTACK_REDACT_PREPUSH=skip git push`.

<a id="redact-version-as-ip"></a>
### `pii.ip_public` MEDIUM on a four-part version number

**Meaning.** The line does not declare the value as a version.

**Fix.** Write it as `version: 1.2.3.4`, `"version": "..."` or `v1.2.3.4`.
MEDIUM findings do not block pushes.
