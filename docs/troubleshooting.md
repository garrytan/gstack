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

<a id="gstack-doctor"></a>
### Check readiness before a skill runs

Run `~/.claude/skills/gstack/bin/gstack-doctor` (other hosts: `./setup --status`
in your gstack checkout prints the doctor's absolute path). It prints one row
each for the install, state root, Bun, hooks, Codex, the cached Codex model
check, artifacts sync, the browse bundle, the other compiled binaries, the
/cso native helper, Claude Code, the largest session journal and recent
/autoplan guard codes. Each row is `ok`, `warn`,
`not configured` or `fail` with its fix; only `fail` exits non-zero. It makes
no paid call: the Codex rows report the cached model check and its age, and
`--live` runs that check once. Paste its output into bug reports.

---

## Model policy

The [model-policy guide](model-policy.md) explains the two tiers, all six
settings, precedence and the read-only inspection command. A resolved selection
is not proof that the requested provider or model can run.

<a id="model-policy-config"></a>
### Model policy configuration is invalid or unreadable

**Meaning.** The new policy path could not read a coherent configuration or a
configured value is invalid. An unreadable file is not treated as an absent
setting: doing that could silently select the premium default.

**Fix.** Repair the file or key named by the error. `plan_review_tier` accepts
`frontier`, `smart` or `host`; `implementation_tier` accepts `frontier` or
`smart`. Use `gstack-config unset <key>` to restore a default, not an empty
value. A rejected `set` leaves the old value intact. Correct ownership/read
permissions rather than deleting an unrelated state directory.
For a malformed line such as `plan_review_tier = smart`, edit the reported file
and correct or remove that line first: `unset` only removes canonical `key:`
records and cannot repair a misspelled delimiter or quoted key.

**Expected result.** `gstack-models list` or the corresponding `resolve`
command explains the winning source. No outside model call ran on this error.

<a id="model-policy-provider"></a>
### A custom provider needs an explicit model or host mode

**Meaning.** Native settings or environment flags route the reviewer to a
custom endpoint or partner platform. A public API catalog identifier is not
necessarily a valid deployment identifier there. Malformed native provider
configuration also prevents gstack from assuming the public endpoint.

**Fix.** Supply a compatible model for that request, set the provider's gstack
environment override or tier-model setting, or choose
`gstack-config set plan_review_tier host`. Keep credentials in the provider's
normal authentication mechanism, never in a model setting. If the error names
a malformed native configuration, fix that source first.

**Expected result.** Inspection reports an explicit selection or honest
host-managed delegation. It does not certify account entitlement or send a
public default to an inferred custom endpoint.

<a id="model-policy-selection"></a>
### The selected review model could not be used

**Meaning.** The requested model was rejected or the provider could not
complete the review. A model may be nonexistent, unavailable to the account,
retired, or behind a misconfigured endpoint; preserve the provider's evidence
rather than treating all of these as the same diagnosis. No successful outside
review is implied, and gstack does not substitute a different model.

**Fix.** Change the source named in the error. For example, an environment
override beats a tier setting, so editing the tier cannot replace it. Unset or
correct that override, or explicitly name a supported model for the request.
Follow the existing auth, quota, sandbox or timeout repair when that is the
reported failure. Missing usage identity remains unknown, even if inspection
showed a requested ID.

**Expected result.** The next invocation announces its model and source,
checks that same selection and reports the actual provider result. A cached
probe or a native fallback is not a completed outside review.

<a id="model-policy-freshness"></a>
### Model-catalog freshness is unknown, stale or needs an update

**Meaning.** Official evidence changed, a required source could not be
checked, or the retained evidence does not match this catalog and parser.
`unknown/source-unavailable` is not current. A later source failure must not
erase an earlier retirement finding or close its maintenance issue.

**Fix.** Read the failed source and evidence details in the freshness workflow
report and tracking issue. Repair the source parser or publication access when
needed, then run the workflow manually against the default branch. If a model
was superseded or deprecated, follow the [maintainer checklist](model-policy.md#maintainer-update-checklist)
to qualify a replacement or record a supported mitigation. Do not clear the
issue just because a new release has not been adopted yet.

**Expected result.** Complete source checks produce evidence bound to the
current catalog, while unresolved lifecycle findings remain visible. Personal
pins and unrelated PRs are unchanged. Check the workflow's last run date too:
a scheduled job that never runs cannot report its own absence.

#### Repairing `recoveryRequired` state

This flag deliberately keeps the issue open until a maintainer repairs the
record. Another successful fetch alone cannot certify corrupted history.

1. Save the current issue body, including its retained recovery archive, and
   download the latest trustworthy workflow report. Use its `report.state` as
   the starting state; do not invent run IDs, catalog hashes or check dates.
2. Reconcile its `lifecycle` array with the issue's independent lifecycle block
   and any retained archive. Preserve known retirements, deadlines and human
   dispositions. A model currently in the catalog must not keep an old
   `resolvedByCatalog` flag from a previous replacement.
3. In the issue editor, restore valid JSON between the `state:begin` and
   `state:end` marker lines. Put that same lifecycle array between
   `lifecycle:begin` and `lifecycle:end`. Restore the standalone ownership and
   region markers, and leave human text outside the owned region intact.
4. Set `recoveryRequired` to `false` only after that reconciliation. If prior
   successful evidence cannot be verified, set `lastSuccess` to `null` rather
   than making up a fresh success. If lifecycle history cannot be recovered,
   leave the flag set and the issue open for investigation.
5. Run **Model-policy freshness** against the default branch. Only complete,
   current evidence with no unresolved findings can close the issue. A parsing
   or source error leaves it open; do not clear history to manufacture a pass.

## Outside reviews (Codex and Claude Code)

Outside reviews send your diff, plan or question to a second AI provider. Their
verdict comes from `lib/outside-review-result.ts`, which prints
`VERDICT: clean|findings|unverified|unavailable`. A `findings` verdict with a
P0 or P1 finding blocks exactly like a native P0/P1. `unverified` and
`unavailable` are missing coverage: /ship and /review continue, show the gap in
the readiness dashboard and the PR body, and never count it as a pass.

<a id="outside-review-verdict"></a>
### How the verdict is read from a review

- **Severity tags.** `[P0]`-`[P3]` (or Codex's native `P1:` labels). P0 and P1
  block; P2 and P3 are advisory.
- **Severity words in label position.** `Severity: High`, `Priority: low`, a
  line that starts with `High:`, `High —`, `[High]` or `**High**` (after an
  optional heading, bullet or number), a bold `**High**` anywhere, or a table
  cell `| high |`. Critical and High block like P0 and P1; Medium and Low are
  advisory like P2 and P3. Words inside prose do not count: "high-level",
  "low-risk", "a medium-term follow-up" and "no critical findings" are not
  findings.
- **No findings.** A review with no tag and no label is `clean` only when it
  says so explicitly (`NO_FINDINGS`, "no issues", "did not find any bugs").
  Otherwise it is `unverified` (see below), never `clean`.
- **Design proposals** (the design-direction voices in /design-consultation
  and /office-hours) are read with the `proposal` gate: a completed proposal
  needs only its `Recommendation: ... because ...` line.

Outside-review prompts ask the reviewer to label each finding Critical, High,
Medium or Low, so most reviews land on `findings` or `clean`.

<a id="sourced-helper-location"></a>
### `gstack: cannot load gstack-codex-probe` / `gstack: cannot locate <helper> (shell: ...)` / `CODEX_MODE: helper_unavailable`

**Meaning.** Skills run `gstack-codex-probe` as a command, one subcommand per
check, so the shell your agent uses does not matter. `cannot load
gstack-codex-probe` and `CODEX_MODE: helper_unavailable` mean the probe file is
missing or not executable in your install.

`cannot locate <helper> (shell: ...)` comes from a helper that is still loaded
into your shell with `source` (`gstack-egress-lib.sh`, and the Codex probe when
a skill rendered before the upgrade sources it). Such a helper finds its own
directory from bash (`BASH_SOURCE`) or zsh (`%x`). In any other shell (dash,
sh), or when the shell cannot say which file it is reading, it stops instead of
guessing a path. The message names the shell it saw.

**Fix.** For `cannot load`, re-run `./setup` from your gstack checkout (or
`/gstack-upgrade`). For `cannot locate`, run the skill from bash or zsh (the
macOS and Linux defaults), or tell the helper where gstack is installed:

```bash
export GSTACK_ROOT=~/.claude/skills/gstack   # your install dir; it holds bin/
```

If you see `gstack: sourcing gstack-codex-probe is deprecated ...`, a skill
rendered before the upgrade is still sourcing the probe. It keeps working
until a release on or after 2026-10-21; run `/gstack-upgrade` to re-render
your skills now.

**Expected result.** `~/.claude/skills/gstack/bin/gstack-codex-probe select-model exec`
prints `CODEX_SEL: <model>` (and `CODEX_MODEL: <model> (exec; source: ...)` on
stderr) from any shell, and preflights print a `CODEX_MODE` other than
`helper_unavailable`. `gstack-codex-probe help` lists every subcommand.

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

**Meaning.** The review completed but had no severity tag or label and gave
no explicit no-findings conclusion, so no pass or fail can be read from it
([how the verdict is read](#outside-review-verdict)).

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

<a id="codex-quota-exhausted"></a>
### `CODEX_MODE: quota_exhausted` / `MODEL_QUOTA_EXHAUSTED`

**Meaning.** Codex refused the call because the account behind it hit its
usage limit (`You've hit your usage limit`, or `insufficient_quota`). The line
under the marker is Codex's own message, with its reset time and where to buy
more. The model choice is fine. gstack reports outside coverage as
unavailable, never as a pass, and caches the result for 15 minutes, so the
rest of the run (and other skills) make no Codex call. The HINT line says how
many minutes remain.

**Fix.** Wait for the reset time in Codex's message, or add credits or a
higher plan for that account. To use a different account, sign in again:

```bash
codex login
```

To re-check before gstack's 15-minute cache expires (for example, right after
buying credits), skip the cached result for one check, or delete it:

```bash
export GSTACK_CODEX_PROBE_RETRY=1   # unset it again afterwards
# or
rm -f ~/.gstack/.codex-model-probe  # <state root>/.codex-model-probe
```

**Expected result.** After the reset (or after `codex login`, which changes
the auth signature and re-probes at once), `CODEX_MODE: ready`.

<a id="codex-rate-limited"></a>
### `CODEX_MODE: unverified (rate_limited)` / `MODEL_PROBE_RATE_LIMITED` / `unavailable: Codex rate-limited the review`

**Meaning.** Codex answered HTTP 429 (too many requests), which usually clears
within seconds. It is a different state from `quota_exhausted` and is never
cached. At probe time the review still runs, and its own result decides. A 429
during the review itself means that review failed, so coverage is missing,
never a pass.

**Fix.** Re-run the review in a minute. If 429s persist, check the rate limits
for the account or API key on the provider's dashboard.

**Expected result.** `CODEX_MODE: ready`, and the review completes.

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

<a id="setup-hook-does-not-parse"></a>
### `gstack setup: refusing to register hooks that do not parse (Claude Code would block tool calls with them): <file>:<line>: <error>`

**Meaning.** Claude Code runs gstack's hook shims through `/bin/sh`, and a hook
that does not parse exits 2, which blocks the tool call it guards in every
session. Setup parse-checks every hook it registers and every hook a skill's
frontmatter runs (`/autoplan`, `/careful`, `/freeze`, `/guard`, `/investigate`
and `/plan-ceo-review`): the shim, the gstack shell helpers it sources (such as
`careful/bin/hook-extract.sh` and `bin/gstack-state-root.sh`), and the
TypeScript it runs with its local imports. A merge conflict marker line in any
of those files fails as `unresolved merge conflict marker`, even when the file
still parses (markers inside a heredoc, a string or a template literal do).
The TypeScript is bundled from the gstack checkout, so the `tsconfig.json` or
`bunfig.toml` of the project you run it from is never read. It registers the
hooks that parse, skips the ones listed, finishes the rest of the install, and
exits non-zero. Claude Code runs hooks straight from `~/.claude/skills/gstack`,
so a skipped hook that an earlier setup registered, or that a skill runs,
keeps running the broken file until it is fixed. This is a gstack bug, or a
half-applied edit or merge in your checkout: report the printed
`<file>:<line>`.

**Fix.**

```bash
git -C ~/.claude/skills/gstack status   # half-applied edits or merge conflicts?
git -C ~/.claude/skills/gstack checkout -- <file>   # or finish the merge
cd ~/.claude/skills/gstack && ./setup
```

**Expected result.** Setup finishes with exit 0 and no refusal line.

<a id="auto-update-hook-does-not-parse"></a>
### `gstack auto-update: update held (hook-does-not-parse: <file>:<line>: <error>); nothing was installed or changed, and your current hooks keep running. ...`

**Meaning.** Team-mode auto-update fetched a release with a hook that does not
parse or still holds a merge conflict marker (the same check setup runs). It
checked the incoming revision before moving your checkout, so your
checkout, installed skills and registered hooks stay at the current revision.
gstack checks again at the next update check and installs the first release
whose hooks parse. This is a gstack bug: report the printed `<file>:<line>`.

**Fix.** Nothing to do locally. A manual `git pull` followed by `./setup`
cannot be checked before the pull; setup then refuses the broken hook (see the
entry above).

<a id="host-renders-pruned"></a>
### `pruned <dir> (<host> is not installed from this checkout): ...` / `kept <path>: not proven generated (...)` / `host-render backup: <dir> (...)`

**Meaning.** A gstack checkout keeps skills only for the agents installed from
it, listed in `.gstack-installed-hosts` in the checkout (#1694). Older installs
rendered every agent's copy, so a global Claude install carried 632 `SKILL.md`
files (34.7 MB) that Claude Code and Cursor-agent scan. setup removed the copy
for an agent that is not installed from this checkout. Generated files were
moved to the backup directory it printed; links into the checkout were removed;
files it could not prove gstack generated (`kept ...`) were left in place.
`prune.log` in the backup lists every path. The same prune runs once from the
upgrade migration. Agents in the record are never pruned.

**Fix.** Nothing, if you don't use that agent. To get an agent back, install
it from this checkout, which records it and renders its skills:

```bash
./setup --host <name>
```

For an instruction-only agent you render by hand (Hermes, OpenClaw, GBrain),
add its name to `.gstack-installed-hosts` first, then run
`bun run gen:skill-docs --host <name>`. To restore one file, `mv` it back from
the backup. A `kept` file is yours: move or delete it when you no longer need it.
The backup sits in gstack's state root, which no agent scans; delete it once
you are sure you don't need it (about 36 MB for a pre-1.91.65 Claude install).

**Expected result.** The next `./setup` prints no `pruned` line, and
`./setup --status` lists the agents you use.

<a id="cso-windows-msvc-compile"></a>
### `CSO unavailable: its native helper was not built (windows-msvc-compile)`

**Meaning.** Visual Studio's compiler was found but the /cso native helper did
not compile. setup prints the first compiler error. It used to say "install
Visual Studio".

**Fix.** Fix the printed compiler error, then re-run `./setup`.

<a id="cso-build-or-publish-failed"></a>
### `CSO unavailable: the native helper's <stage> step failed (...)` / `CSO publish step failed (...) for <revision>; previous CSO kept: <revision>`

**Meaning.** The /cso native helper is optional. Its build prerequisites were
present, but the `build` step (compiling the helper) or the `publish` step
(swapping the new helper into `bin/` under a lock) failed. setup used to stop
here (#3071); now it finishes everything else and says which step failed. When
an earlier helper was installed and the failed publish restored it, setup
prints `previous CSO kept` and /cso keeps using that helper; otherwise /cso
reports `not assessed`. `interrupted` means the step was killed before it could
record a result. The outcome is in `bin/.gstack-cso-build-result`, and
`gstack-doctor`'s `cso` row reads the same record. The build output is in
`bin/.gstack-cso-build.log`.

**Fix.** Read the log, fix what it reports, then retry from your gstack checkout:

```bash
bun run build:cso && ./setup
```

On Windows, setup and the build use PowerShell 7 (`pwsh`) when it is installed
and fall back to Windows PowerShell 5.1. The root cause of the staged files
vanishing during publish in #3071 is still unknown; attach the log there if you
hit it. CI sets `GSTACK_STRICT_BUILD=1`, which makes these failures fatal so
build regressions cannot hide.

**Expected result.** setup prints no CSO line, and the doctor's `cso` row is
`ok`.

<a id="cso-windows-docker"></a>
### `Docker found at <path>, but native Windows Docker transport is not supported yet; static assessment only.` / `docker.exe at <path> is outside the trusted install locations (...)`

**Meaning.** On Windows, /cso looks for `docker.exe` only under the install
folders Windows reports for Program Files, Program Files (x86) and the Windows
directory, by its real path, with no symlink or junction on the way. A
user-writable directory is untrusted, because the Docker child carries
registry credentials; that refusal cannot be overridden.

Even a trusted `docker.exe` cannot run /cso's isolated containers yet: /cso
admits only a local Unix Docker socket, and Docker Desktop on Windows speaks
over a named pipe. /cso reports this and runs its static assessment only; no
container or runtime check runs.

**Fix.** For runtime checks, run /cso from Linux or macOS (WSL2 counts as
Linux) with a local Docker socket. On Windows, static assessment is the
supported mode; if the refusal named a user directory, install Docker Desktop
under Program Files.

<a id="cso-capacity"></a>
### `Snapshot manifest cap exceeded: ...` / `64 MiB source cap exceeded: ...` / `Symlink or special source file: <path>`

**Meaning.** /cso copies the repository into a private snapshot before any
audit starts, and refuses the whole run when the snapshot would be incomplete
or too large. Each message names the cap that applied:

- **Snapshot manifest cap (16 MiB).** One entry per tracked or nonignored
  untracked file; about 50,000 files fit.
- **64 MiB source cap.** The full size of every such file outside dependency
  and VCS directories counts, including files over 1 MiB whose contents are
  withheld from the audit.
- **Symlinks.** A tracked symlink anywhere in the repository stops the run.

**Fix.** No setting raises these caps. Run /cso on a smaller checkout that
holds the code you want audited and no symlinks. Add your file count or size to
[#2993](https://github.com/garrytan/gstack/issues/2993).

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

## Install check (`gstack-doctor --check`) and the Capy installer

`gstack-doctor --check` prints one `PASS | FAIL | SKIP <id>` row per component
and ends with `gstack: ok <revision> for=<workflow>` (exit 0) or
`gstack: fail <id,id>` (exit 1). Every FAIL row carries a `fix:` clause and one
of the codes below. Read the trailer directly; never pipe `--check` through
`tail` or another command whose exit status would replace the doctor's
(docs/capy-install.md).

<a id="doctor-component-missing"></a>
### `FAIL <id> — <detail>; fix: <command> (COMPONENT_MISSING; ...)`

**Meaning.** A component the selected workflow needs (`--for <skill>`,
`--require <csv>`, or by default every host profile installed from this
checkout) is not installed, not built, not current, or not authenticated. The
row names it: `claude` or `codex` (a host profile missing or stale), `patch`
(the Codex render lacks the model behavioral patch), `codex-cli` (the Codex CLI
is required and absent or not logged in), `browse-bundle`, `browser` (Chromium
does not launch or render), `cso` (the native helper is required and not
built).

**Fix.** Run the command in the row's `fix:` clause. For `browser`, that is
`<checkout>/bin/gstack-browser-ensure`, which installs Chromium on first use
when the installer skipped it (`SKIP browser (lazy; ...)`).

**Expected result.** The row turns `PASS` and the trailer reads `gstack: ok`.

<a id="doctor-runtime-below-minimum"></a>
### `FAIL runtime — bun <version> ... (RUNTIME_BELOW_MINIMUM; ...)`

**Meaning.** The Bun on `PATH` is absent, below gstack's security floor
(1.3.3: older Bun ignores the no-autoload compile flags, see
[bun-too-old](#bun-too-old)) or below the supported minimum (1.4.2, the CI pin
and `engines.bun`). The dashboard (`gstack-doctor` without `--check`) warns on
an untested version; `--check` fails it, because a gate run on an untested
runtime is the incident this check exists for. The default Capy cloud image
ships 1.3.14, so a fresh Capy machine fails here until the installer upgrades
Bun.

**Fix.** `bin/gstack-capy-install` upgrades Bun through setup's
checksum-verified recipe before running `./setup`. By hand: download
`https://bun.sh/install`, verify its SHA-256 against `GSTACK_BUN_INSTALL_SHA`
in `bin/gstack-bun-version.sh`, then `BUN_VERSION=1.4.2 bash <file>` and
re-run `./setup`.

<a id="doctor-project-pin-mismatch"></a>
### `FAIL pins — bun <version> outside engines.bun >=1.4.2 (package.json:<line>; ...) (PROJECT_PIN_MISMATCH; ...)`

**Meaning.** The target project (`--project <path>`, default the git toplevel
of the current directory, never the gstack checkout) pins a Bun or Node
version the running one does not satisfy. Pins come from `package.json`
(`packageManager`, `engines`), `.tool-versions`, `.nvmrc`, `.bun-version` and
`bun-version:` / `node-version:` lines in `.github/workflows/*.yml`. A range
(`>=1.4.2`) and an exact pin are told apart, and a CI pin keeps its platform
lane: a Windows job's pin never fails a Linux run. The dashboard warns; `--check`
fails. The row is `SKIP pins (no bun to evaluate the project pins)` when Bun
is absent, never silent.

**Fix.** Install the pinned version for this platform (the row names each
constraint with its source), or change the project's pin.

<a id="doctor-revision-unmet"></a>
### `FAIL revision — installed <version> (requested <ref>) (REVISION_UNMET; ...)`

**Meaning.** `--revision <ref>` asked the doctor to certify a specific gstack
revision (a VERSION string, tag, branch or commit) and the checkout is at
another. An unmet revision is never `ok`.

**Fix.** Move the checkout: `/gstack-upgrade`, or
`git -C <checkout> fetch origin && git -C <checkout> checkout <ref> && ./setup`.
`bin/gstack-capy-install --revision <ref>` never moves an existing checkout; it
reports `gstack: ok <installed> (requested <ref>; run gstack-upgrade to move)`.

<a id="capy-install-runtime-conflict"></a>
### `gstack-capy-install: Bun conflict: gstack needs >=<minimum>, <project> pins <constraint> (RUNTIME_PIN_CONFLICT; ...)`

**Meaning.** The installer upgrades Bun only when gstack's supported minimum
and the target project's pin agree on a version. Here they do not (for
example the project pins `bun@1.3.14` exactly), so the installer changed
nothing and stopped before `./setup`.

**Fix.** Raise the project's pin to gstack's supported minimum, or install
gstack on a machine whose Bun the project accepts. `--project <path>` names
the project whose pins apply.

<a id="browser-ensure-failed"></a>
### `gstack-browser-ensure: NEEDS_SETUP ... (BROWSER_UNAVAILABLE; ...)`

**Meaning.** The first browser skill run on a machine installed without
Chromium (`SKIP browser (lazy; gstack-browser-ensure installs on first use)`)
tried to install it through `bunx playwright install chromium` under setup's
lock, or Chromium is installed but does not launch.

**Fix.** Read the installer output above: offline or proxied machines need
network access to the Playwright CDN; on Ubuntu 24.04+ an AppArmor
user-namespace error needs `GSTACK_CHROMIUM_NO_SANDBOX=1`; then re-run
`<checkout>/bin/gstack-browser-ensure`. `--with-browser` on the installer
front-loads the install on machines that want it now.

<a id="capy-install-preflight-failed"></a>
### `gstack-capy-install: preflight: <tool> not found (INSTALL_PREFLIGHT_FAILED; ...)`

**Meaning.** The installer checks `git`, `curl`, `node` and `jq` before
`./setup`, and installs Bun when it is absent or below the supported minimum.
One of them is missing, or the Bun install script's checksum did not match
`GSTACK_BUN_INSTALL_SHA` (the download is discarded, nothing runs).

**Fix.** Install the named tool (`apt-get install -y jq`, Node from nodejs.org
or nvm), then re-run `bin/gstack-capy-install`. A checksum mismatch means the
upstream installer changed: update `GSTACK_BUN_INSTALL_SHA` only after
reviewing the new script.

---

## Browser

<a id="browse-runtime-version-skew"></a>
### `[browse] this install's browse CLI (<root>, build <hash>) and the gstack checkout's server bundle (<checkout>, build <hash>) are from different builds, so the server was not started. ...`

**Meaning.** On Windows a host runtime root (`~/.codex/skills/gstack` and the
other env-var hosts) holds a copy of browse with no `node_modules`, so its CLI
starts the server bundle in the gstack checkout recorded in `.source-path`.
The checkout was rebuilt (or updated) without refreshing this runtime root, so
the two builds differ and browse refuses rather than run a mismatched server.

**Fix.** Re-run setup from the checkout named in the message; it rebuilds and
refreshes every runtime root:

```bash
cd <checkout> && ./setup
```

<a id="browse-chain-no-flow"></a>
### `[browse] chain: no flow to run (stdin was empty)` (or `stdin is a terminal`, `stdin could not be read (EAGAIN)`)

**Meaning.** `browse chain` with no arguments runs the JSON flow piped to it.
Nothing arrived, so it exits 1 before starting a browser. It used to exit 0 on
Windows having run nothing.

**Fix.** Pipe the flow, or pass it as an argument:

```bash
echo '[["goto","https://example.com"],["text"]]' | browse chain
browse chain 'goto https://example.com | text'
```

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

## Windows

<a id="windows-smart-app-control"></a>
### `Windows blocked compiled gstack binaries at launch (Smart App Control or another application-control policy, #2595)` / `bash: .../browse.exe: Permission denied`

**Meaning.** Known issue (#2595, #2124). gstack compiles five binaries on your
machine with Bun: `browse`, `find-browse`, `design`, `pdf` and
`gstack-global-discover`. They are unsigned, and a binary built on one machine
never earns the reputation Smart App Control accepts instead of a signature, so
Windows 11 with Smart App Control on refuses to start them. Git Bash reports
that as `Permission denied`, which looks like a file-permission problem but is
code integrity (PowerShell says `An Application Control policy has blocked this
file`). setup now runs each binary's `--version` and names the blocked ones and
the skills that need them: the gstack browser fallback (`/browse`, `/qa`,
`/qa-only`, `/design-review`, `/canary`, `/benchmark`, `/pair-agent`,
`/scrape`, `/make-pdf`), the design binary (`/design-consultation`,
`/design-shotgun`, `/design-html`, `/plan-design-review`) and `/retro global`.
Every other skill works. `gstack-doctor` shows the same state in its
`browse bundle` and `binaries` rows. The exact Windows error text has not been
verified on a Smart App Control machine; setup prints the raw first line beside
its classification.

**Fix.** There is no per-file allowlist for Smart App Control. Today's options:

- Run gstack inside WSL (`wsl --install`, then install gstack in the Linux
  distro). WSL runs gstack's Linux build, which Smart App Control does not check.
- Or turn Smart App Control off in Windows Security > App & browser control >
  Smart App Control settings. On Windows 11 with the April 2026 update you can
  turn it back on later without reinstalling Windows; on older builds turning it
  off is permanent. gstack's binaries stay blocked whenever it is on.

Signed release binaries are the real fix and are tracked in `TODOS.md`. After
Windows allows the binaries, re-run `./setup`; the message goes away.

**Expected result.** setup prints no "Windows blocked" line, and
`gstack-doctor` shows `ok` for `browse bundle` and `binaries`.

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
If the URL is a reviewed, public dev-only value, list it in
[`.gstack-redact-allowlist`](#redact-allowlist).

<a id="redact-allowlist"></a>
### `.gstack-redact-allowlist (<n> entries) suppressed <m> finding(s) in this push`

**Meaning.** The pushed commit carries `.gstack-redact-allowlist` at the repo
root. Each line (after trimming; `#` starts a comment) is one exact matched
span: the whole `postgres://USER:PASSWORD@host:port` URL for
`db.url_with_password`, the key for a key pattern, the address for `pii.email`. A finding is suppressed only when its
matched text equals an entry, so a password alone, a substring, or a different
key still reports and still blocks. The hook reads the file from each pushed
commit, never the working tree, and ignores a file over 64 KiB. Every push that
carries entries prints this line and each suppressed finding's file and line.
It works alongside `gstack.redact.allowEmail`, which stays a local setting.

**Fix.** Nothing, if every listed suppression is the reviewed value. Remove an
entry that no longer applies; rotate a credential that is real.

<a id="redact-version-as-ip"></a>
### `pii.ip_public` MEDIUM on a four-part version number

**Meaning.** The line does not declare the value as a version.

**Fix.** Write it as `version: 1.2.3.4`, `"version": "..."` or `v1.2.3.4`.
MEDIUM findings do not block pushes.

<a id="redact-prepush-email"></a>
### `MEDIUM  pii.email  <file>:<line>` from the pre-push hook

**Meaning.** The pushed lines add an email address that is not yours and not
already in the destination's commit metadata. The hook does not report your
own address (`git config user.email`), addresses listed in
`gstack.redact.allowEmail`, or author and committer addresses (mailmapped too)
from the history of the pushed commits, of the remote tip being replaced, and,
for a new branch pushed to a configured remote, of that remote's tracking refs.
An address only another remote knows still reports. If the hook also printed
`existing-email suppression was limited for this push`, it could not read the
history in 5 seconds, so known authors may be listed too.

**Fix.** Remove the address, or allow it for this repo:
`git config --add gstack.redact.allowEmail <address>`. If it is your own
address, check `git config user.email`. The allowlist only covers `pii.email`;
it never lets a HIGH finding through.

## Unattended runs and artifacts

Workflow commands (`gstack-artifact`, `gstack-gate`, `gstack-autoplan-timing`,
`gstack-review-log --findings`) end each error line with a code in
parentheses, for example `(ARTIFACT_STALE)`. The codes and anchors come from
`lib/result-codes.ts`; grep the code, not the prose. Every such command shares
one exit table: `0` ok, `1` fail, `2` usage, `3` refused or needs a flag. The
artifact contract itself is in [docs/unattended.md](unattended.md).

<a id="artifact-invalid-json"></a>
### `ARTIFACT_INVALID_JSON`

**Meaning.** `run.json`, `timing.json` or another JSON artifact did not parse.

**Fix.** Regenerate the run with the tool that writes it. A manifest is never
hand-edited; a partial write means the writer was interrupted.

<a id="artifact-unsupported-version"></a>
### `ARTIFACT_UNSUPPORTED_VERSION`

**Meaning.** The artifact's `schema_version` is one this gstack does not read
(`gstack-artifact schema <name>` prints the versions it validates).

**Fix.** Upgrade the consumer (`/gstack-upgrade`) or regenerate the run with
this gstack.

<a id="artifact-schema"></a>
### `ARTIFACT_SCHEMA`

**Meaning.** A required field is missing, has the wrong type, or holds a value
outside its enum. The message names the file, row and field.

**Fix.** Compare the row with `gstack-artifact schema <name>` and regenerate it.

<a id="artifact-missing"></a>
### `ARTIFACT_MISSING`

**Meaning.** `run.json` names an artifact that is not in the run directory.

**Fix.** Copy the whole run directory, not single files. If the file was never
written, rerun the phase that writes it.

<a id="artifact-stale"></a>
### `ARTIFACT_STALE`

**Meaning.** The file's bytes no longer hash to the value `run.json` recorded,
so the manifest does not describe this file.

**Fix.** Treat the run as partially rewritten. Regenerate it, or re-bind the
file through the tool that wrote it so the manifest is updated with it.

<a id="artifact-path-escape"></a>
### `ARTIFACT_PATH_ESCAPE`

**Meaning.** An artifact path resolves outside the run directory: a `..`
segment, an absolute path, or a symlink that points elsewhere.

**Fix.** Keep every artifact inside the run directory under a plain relative
name. A run directory is copied as one unit; nothing outside it is part of
the contract.

<a id="artifact-malformed-jsonl"></a>
### `ARTIFACT_MALFORMED_JSONL`

**Meaning.** A JSONL artifact has a line, usually the last, that is not one
JSON object. The writer was interrupted mid-append.

**Fix.** Rerun the phase that writes the file. Do not trim the line by hand;
the row it held is lost either way, and the manifest hash would change.

<a id="artifact-duplicate-id"></a>
### `ARTIFACT_DUPLICATE_ID`

**Meaning.** Two rows in one file share an id.

**Fix.** Ids are run-bound (`<run>-...`) and unique per file. Regenerate the
rows with the tool that assigns them.

<a id="artifact-unbound-id"></a>
### `ARTIFACT_UNBOUND_ID`

**Meaning.** A row id does not start with the run id in `run.json`, so it
could belong to another run.

**Fix.** Regenerate the row with this run's id.

<a id="artifact-dangling-ref"></a>
### `ARTIFACT_DANGLING_REF`

**Meaning.** A task's `findings`, `blocked_by` or `depends_on`, or a decision's
reference, names an id no artifact in this run defines.

**Fix.** Write the referenced finding, decision or task first, or drop the
reference. A `depends_on` entry may also name a `pr` label that another task
in the file carries.

<a id="artifact-dependency-cycle"></a>
### `ARTIFACT_DEPENDENCY_CYCLE`

**Meaning.** Tasks depend on each other in a cycle, so no lane could start.

**Fix.** Break the cycle in `depends_on`. The message lists the ids on it.

<a id="artifact-count-mismatch"></a>
### `ARTIFACT_COUNT_MISMATCH`

**Meaning.** A `counts` value in `run.json` disagrees with the rows in the file
it summarizes (for example `counts.findings: 65` beside 64 rows).

**Fix.** Regenerate `run.json` after the last row was written. A count never
replaces the file; the hash and the rows are the record.

<a id="artifact-run-interrupted"></a>
### `ARTIFACT_RUN_INTERRUPTED`

**Meaning.** `run.json.status` is not terminal, or a voice is still
`running`/`pending`. The artifacts describe an unfinished run.

**Fix.** Resume it (`gstack-autoplan resume --out <dir>`, PR B-runner) or
consume the artifacts as partial and say so.

<a id="artifact-reviewer-missing"></a>
### `ARTIFACT_REVIEWER_MISSING`

**Meaning.** A phase in `required_phases` is absent from `phases`, a voice has
no terminal status, or a completed voice has no bound output file (path and
hash) in `artifacts`.

**Fix.** Finish the phase. A missing voice is missing coverage; the validator
never fills it in as N/A.

<a id="artifact-guard-line-missing"></a>
### `ARTIFACT_GUARD_LINE_MISSING`

**Meaning.** The run says `session_kind: unattended`, but its
`review-record.md` does not carry the `GUARD_NOT_INSTALLED` line, so the
record does not state that publication order was unverified.

**Fix.** Start the run through `gstack-skill-start` (it prints the line) and
keep the line in the review record.

<a id="guard-not-installed"></a>
### `autoplan guard: not enforced by this host; publication order is unverified (GUARD_NOT_INSTALLED)`

**Meaning.** The autoplan publication hook only executes inside Claude Code.
On every other host, and in every `unattended` session, the hook is present
but never runs, so phase publication order rests on the snapshot hashes
recorded per phase rather than on the guard.

**Fix.** Nothing on this host. The line is printed once per run and belongs
in the review record; `gstack-artifact validate` requires it for an
unattended run. On Claude Code a *missing* hook file still denies every
guarded call (a broken install must not pass as an absent one).

<a id="review-status-mismatch"></a>
### `review-log: status mismatch ... (REVIEW_STATUS_MISMATCH)`

**Meaning.** The row handed to `gstack-review-log` claims a `status`,
`unresolved`, `issues_found` or `critical_gaps` that the `--findings` file
contradicts (for example `status: clean` beside open findings). The row was
not written.

**Fix.** Fix the findings file, not the claim, and log again. Omit the claimed
fields and let the row be derived from the file.

<a id="gate-rev-stale"></a>
### `GATE_REV_STALE`

**Meaning.** The reply names a `gate_rev` older than the gate list's current
revision, so it may answer items that changed.

**Fix.** Render the current list (`gstack-gate render <file>`), read it, and
reply with the printed `gate_rev`.

<a id="gate-reply-unparsed"></a>
### `GATE_REPLY_UNPARSED`

**Meaning.** Part of the reply matched no gate item or option. Nothing was
applied; the unparsed tokens are listed.

**Fix.** Reply with `all`, with `<id><option>` tokens (`d3b uc1a`), or with
`all except <tokens>`. A bare `yes` or `no` is ambiguous across multi-option
items and is never guessed.

<a id="execution-unknown"></a>
### `EXECUTION_UNKNOWN`

**Meaning.** `gstack-autoplan` recorded a dispatch intent for an attempt (the
prompt was handed to a reviewer) but no terminal record followed: no `submit`,
no cancellation. The runner was killed, or the parent never came back. The
provider may have finished and charged; snapshot hashes prove which input was
sent, not whether the review completed. The spend ledger keeps the attempt's
reservation.

**Fix.** If the reviewer finished, submit its result with the same attempt id
(`gstack-autoplan submit --out <dir> --phase <p> --voice <v> --result <file>
--model <id> --attempt <id>`); a late result is still bound. If it did not,
redispatch explicitly with `gstack-autoplan next --out <dir> --redispatch
<attempt>`. `resume` and `next` never redispatch an ambiguous attempt on their own.

<a id="run-locked"></a>
### `RUN_LOCKED`

**Meaning.** Another `gstack-autoplan` process holds `<dir>/run.lock` (pid,
host and start time are in the file). Every mutating command takes the lock
for its duration, so two writers never interleave.

**Fix.** Wait for the owner to exit. If its pid is gone (a killed runner),
`gstack-autoplan resume --out <dir>` takes ownership and reconciles open
attempts; a lock whose pid is alive is never stolen.

<a id="run-not-initialized"></a>
### `RUN_NOT_INITIALIZED`

**Meaning.** The `--out` directory has no `run.json` written by
`gstack-autoplan`, so `submit`, `status`, `answer` and `resume` have nothing to
act on.

**Fix.** Start the run with `gstack-autoplan next --plan <file> --out <dir>`;
the first `next` initializes the run (restore point, active plan, manifest).

<a id="phase-not-awaiting"></a>
### `PHASE_NOT_AWAITING`

**Meaning.** `submit` named a phase or voice that is not waiting for a result:
the phase is already closed, not yet opened, or the voice already has a bound
result.

**Fix.** Run `gstack-autoplan status --out <dir>` and submit for the attempt
the last `next` printed (`ATTEMPT: ... phase=<p> voice=<v>`).

<a id="attempt-mismatch"></a>
### `ATTEMPT_MISMATCH`

**Meaning.** The `--attempt` id is not the open attempt for that phase and
voice, or that attempt was already submitted. A result is bound exactly once;
a second submit of the same attempt is refused rather than overwriting the
first.

**Fix.** Pass the attempt id printed by `next` for this voice. To replace a
bound result, reopen the phase through `answer` (a scope-changing choice) or
start a new run.

<a id="result-receipt-missing"></a>
### `RESULT_RECEIPT_MISSING`

**Meaning.** The result file does not begin with the full-read receipt the
prompt asked for: `INPUT: <phase> <snapshot sha256>`. Either the reviewer did
not read the prompt file through EOF, or the result belongs to a different
snapshot (the plan changed between dispatch and submit).

**Fix.** The reviewer's first line must be the INPUT line from its prompt
file. If the plan changed, run `next` again for a fresh snapshot and
redispatch; a result for an older snapshot is never bound to the current phase.

<a id="result-findings-missing"></a>
### `RESULT_FINDINGS_MISSING`

**Meaning.** The result has no valid canonical findings block. Every reviewer
returns, beside its prose, one fenced block:

````
```gstack-findings
{"severity":"High","title":"...","file":"lib/x.ts","line":12,"fix":"..."}
```
````

one JSON object per line with at least `severity` (`Critical`, `High`,
`Medium`, `Low`, `Informational`) and `title`. An empty fence means the
reviewer found nothing; a missing fence or a malformed row means the result
cannot be reconciled and is refused.

**Fix.** Ask the reviewer for the fence (the prompt names it), or add the rows
from its prose yourself and submit again. Reconciliation runs on these rows,
not on the prose; a prose-only review has no completeness check.

<a id="model-family-conflict"></a>
### `MODEL_FAMILY_CONFLICT`

**Meaning.** The outside voice's model is in the same family as the native
reviewer (both Anthropic, both OpenAI, ...), or its family cannot be
determined from the id. Two voices from one family are one voice; the record
says which was which.

**Fix.** Run the outside voice on a model from another family and pass its id
with `--model`. Families recognized: anthropic, openai, google, xai, deepseek,
qwen, zai, moonshot, meta, mistral, minimax. An id the table cannot classify
is refused; name the model fully (`openai/gpt-6-astra`, not `astra`).

<a id="spend-cap-exceeded"></a>
### `SPEND_CAP_EXCEEDED`

**Meaning.** `spent + reserved + next_estimate` would exceed `--spend-cap`.
The ledger (`<dir>/spend.json`) counts unsettled reservations and unknown
charges at their reservation, so a crashed attempt keeps its cost held until
it is settled or released.

**Fix.** Raise `--spend-cap`, settle attempts whose actual cost is known
(`submit --usage-usd <n>`), release attempts that never ran (`gstack-autoplan
release --attempt <id>`), or stop here. Host-dispatched subagent spend is
`unknown`, never zero.

<a id="consensus-missing"></a>
### `CONSENSUS_MISSING`

**Meaning.** `next` for the Eng phase found a closed prior phase without its
consensus record (`<phase>-consensus.md` plus its reconciliation rows), so the
Eng prompt would be sent without that phase's summary.

**Fix.** `gstack-autoplan resume --out <dir>` re-closes the phase through
reconciliation. The Eng dispatch is refused until every closed phase has its
summary; it is never sent partially.

<a id="outside-runner-unavailable"></a>
### `OUTSIDE_RUNNER_UNAVAILABLE`

**Meaning.** `gstack-outside-voice run --runner <r>` cannot run here:
`codex-cli` found no `codex` binary or no login, `api` found neither
`OPENAI_API_KEY` nor `ANTHROPIC_API_KEY` for the model's family, or
`host-subagent` was called without `--result <file> --model <id>`. When
another runner is configured (`--fallback` or `GSTACK_OUTSIDE_RUNNER`), the
line reads `codex-cli unavailable; using <runner>` and the review proceeds on
that runner; it is a full outside voice, not a degraded one. With no other
runner, this is missing coverage.

**Fix.** `gstack-codex-login` logs Codex in from `OPENAI_API_KEY`
(unattended machines); or set the API key and pass `--runner api`; or run the
review on a cross-family subagent and submit its file with `--runner
host-subagent --result <file> --model <id>`.

<a id="reality-row-missing"></a>
### `REALITY_ROW_MISSING`

**Meaning.** `gstack-plan-reality check --phase <p> <review>` found no
`REALITY: <row> …` line for a row the review must carry (every tier 1 row:
`premise-table`, `already-done`, `surface-check`, `binding-decisions`,
`numbers`, `deferred-asks`, `pr-count`; plus the tier 2 rows whose scope was
passed with `--scope`), or a tier 1 row was marked `n/a`. The check prints
`PLAN_REALITY: phase=<p> rows=<n>/<m> missing=<ids> verdict=<v>` and exits
`1`. In an unattended run the verdict is `incomplete` and the phase does not
close; interactively it is `repair`: produce the missing rows and re-check, at
most twice, then warn at the gate with each row still missing.

**Fix.** `gstack-plan-reality rows --phase <p> [--scope <csv>]` prints each
row's check. Work it and end the review with one line per row,
`REALITY: <row> pass|finding <summary> <file:line>`.

<a id="reality-receipt-missing"></a>
### `REALITY_RECEIPT_MISSING`

**Meaning.** A `REALITY:` line names its row and status but carries no
receipt. A receipt is `path:line`, `path:line-line` or a commit sha; it is what
makes the row a check rather than a claim.

**Fix.** Add where the check was made to the line, for example
`REALITY: already-done pass 0 hits since 2026-10-09 for bin/gstack-doctor 91bbd9e`
or `REALITY: surface-check finding bun upgrade --version absent on 1.3.14 bin/gstack-capy-install:52`.
