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

The [model-policy guide](model-policy.md) explains the two tiers, all seven
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

- **Severity tags.** `[P0]`-`[P3]`, Codex's native `P1:` labels, and a P0-P3
  label at the start of a line after an optional heading, bullet, number or
  bold: `**P1 — x**`, `**P1** — x`, `1. P2 — x`, `P2 —`, `### P1`, or a table
  cell `| P1 |`. P0 and P1 block; P2 and P3 are advisory. A P0-P3 token in that
  label position that none of these forms reads (`## P1/P2 findings`) makes the
  review [`unverified`](#outside-review-unparsed-severity), never `clean`. Code
  fences and inline code are quotes, not labels.
- **Severity words in label position.** `Severity: High`, `Priority: low`, a
  line that starts with `High:`, `High —`, `[High]` or `**High**` (after an
  optional heading, bullet or number), a bold `**High**` anywhere, or a table
  cell `| high |`. Critical and High block like P0 and P1; Medium and Low are
  advisory like P2 and P3. Words inside prose do not count: "high-level",
  "low-risk", "a medium-term follow-up" and "no critical findings" are not
  findings.
- **Every review gate.** These rules apply to every gate that summarises a
  review, including the `execution` gate behind `/codex` consult and challenge.
  A reply whose last `Verdict:` line says `not ready` is `findings` and exits
  3 even when readable advisory severities (P2 or P3) were parsed; `FINDINGS:`
  names the highest one. A not-ready reply with no readable severity still
  prints `FINDINGS: unspecified` and exits 3.
- **No findings.** A review with no tag and no label is `clean` only when its
  conclusion says so: the last sentence (or its last ", and" clause), or the
  `because` clause of its `Recommendation:` line, opens with `NO_FINDINGS`,
  "No issues found", "I found no actionable regressions" or "I did not find
  any bugs", with no "but", "however", "except", "other than" or "elsewhere".
  When other prose comes first, anything after that statement except a
  predicate ("were found", "is evident") or a colon explanation must scope it
  to the change as a whole ("in this change", "in the staged changes"); "No
  issues in the parser." does not conclude the review. A "no issues" phrase
  anywhere else in the reply does not count. Otherwise the review is
  `unverified` (see below), never `clean`. A `/codex` consult
  answer with no severity labels at all is not a review summary and stays
  `clean`.
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

<a id="outside-review-unparsed-severity"></a>
### `... outside review: ran, verdict unverified (the review labels a finding with a P0-P3 severity in a form the parser cannot read (line N: "..."))` / `REASON: unparsed_severity`

**Meaning.** The reply starts a line with a P0-P3 token, the place a finding's
label goes, but in a form gstack does not read as one severity, for example
`## P1/P2 findings` or `- P2/P3 nits`. gstack will not guess which severity
applies, so the verdict is unverified instead of `clean`. The quoted line in
parentheses (also printed as `UNPARSED:`) is the first such label. When the
same reply also has a readable P0 or P1 finding, that finding blocks
(`VERDICT: findings`, exit 3) and the unparsed line is still printed.

**What is kept.** The full reply is shown above.

**Fix.** Read the quoted line and the reply, and decide; it is not a pass.
Re-run the review and ask the reviewer to label each finding `[P1] <title>` or
`P1: <title>`. To re-check a saved or corrected reply, run from your gstack
checkout:

```bash
bun lib/outside-review-result.ts --verdict execution reply.md
```

(use `review` or `structured` for those gates).

**Expected result.** `VERDICT: findings` or `VERDICT: clean` with a P0-P3
`FINDINGS:` value, and no `UNPARSED:` line.

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

<a id="outside-review-consent-missing"></a>
### `outside review: not run (outside reviews are turned off ... ). Fix: gstack-config set codex_reviews enabled ...` / `OUTSIDE_STATUS: not_run reason=consent_missing`

**Meaning.** The send itself refused. `gstack-codex-probe run-with-timeout`,
`gstack-claude-code`, `gstack-outside-voice` and the unattended
`gstack-autoplan` runner read `codex_reviews` before they send repository
content to an outside model. When it is `disabled`, or when the config file
exists but cannot be read (or holds a value other than `enabled` or
`disabled`), they print this line, start no CLI and make no API request. An
unset `codex_reviews` means the default, `enabled`, and the first send on a
machine prints the [notice](#codex-review-notice) below. A review you ask for by
name (`/codex`, `/claude-code`) passes `--user-invoked` and still runs. This is
`not run`, never a pass and never an outage; `/autoplan` records it as the
phase's outside outcome (`status: disabled`, `outcome: not_run`,
`reason: consent_missing`).

**Fix.** To allow outside reviews again:

```bash
gstack-config set codex_reviews enabled
gstack-config get --stored codex_reviews   # enabled, disabled, unset, or unreadable (exit 2)
```

If the stored read exits 2, fix the permissions or the malformed
`codex_reviews` line in the `config.yaml` it names, then re-run.

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

<a id="plan-eng-review-not-persisted"></a>
### `PERSISTED: no` / `PERSIST: gstack-review-log '{...}'` / `no saved Eng Review: run the PERSIST: line ...`

**Meaning.** /plan-eng-review ran where the caller forbids writes (for example
a delegating agent keeps the reviewer read-only, so it cannot edit the plan it
judges). The review completed: it ends `DONE` with `PERSISTED: no`, records
telemetry `success`, and returns the full report and decision ledger in its
reply. Nothing was saved, so /ship's readiness dashboard has no Eng Review
record and reports NOT CLEARED with "no saved Eng Review". A real failure (a
permitted save that failed, stale evidence) still ends `BLOCKED`.

**What is kept.** The reply holds the complete report; its last line is the
review-log command with this review's values.

**Fix.** From the reviewed repository, run the reply's last line without the
`PERSIST: ` prefix:

```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"plan-eng-review",...}'
```

Or rerun /plan-eng-review where it may write its report and log.

**Expected result.** `gstack-review-read` lists the `plan-eng-review` entry and
/ship's dashboard shows the Eng Review row (CLEAR when its status is `clean`).

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

<a id="artifact-case-collision"></a>
### `ARTIFACTS_SYNC: attention: case-collision held=<N> names=<names>. Artifact paths differ only by letter case, ...`

**Meaning.** The artifacts repo holds paths that differ only by letter case,
such as `projects/MyApp/` and `projects/myapp/`. A Mac or Windows disk stores
them as one file, so git there would stage a write under the other spelling,
and sync would report success while one spelling stays modified and the other
machines read stale data (#3220). Sync now holds every queued file under such a
path instead of staging it: the file stays queued, everything else keeps
syncing, and the status is `collision` rather than `ok`. When only one
spelling is tracked, that spelling keeps syncing and only the new alias is
held; when neither is tracked yet, both wait. `<names>` are the colliding folder or file names; `gstack-brain-sync
--status` lists the held paths in `message`. A local commit that would push a
new alias to the remote (two machines created both spellings at once) is
refused with status `error` and kept locally.

Nothing is repaired automatically. Slug resolution and skill start are
unaffected; only the sync holds files.

**Fix.** Keep one spelling, by hand, on one machine:

1. Choose the spelling to keep: the one `gstack-slug` prints in that project
   today. If the project resolves to different spellings (a remote URL typed
   two ways, a folder reached as `~/code/MyApp` and `~/code/myapp`), make it
   stable first: fix the remote URL's case, or set `GSTACK_PROJECT_SLUG`.
2. Fold the other spelling's tracked files into the kept one. Read both
   spellings from git, because a Mac's working tree shows only one of them,
   and the working files too, because they hold the held, unsynced writes.
   This loop covers the dropped spelling's tracked files and its untracked
   ones (held writes that never synced). It folds JSONL logs (concatenated,
   duplicate lines dropped) and prints every other file for you to decide:

   ```bash
   cd ~/.gstack
   keep=projects/MyApp; drop=projects/myapp
   { git -c core.ignorecase=false ls-files -- "$drop"; git -c core.ignorecase=false ls-files --others -- "$drop"; } | sort -u | while IFS= read -r f; do
     rel=${f#"$drop"/}
     case "$rel" in *.jsonl) ;; *) echo "decide by hand: $f"; continue ;; esac
     { git show ":$keep/$rel"; git show ":$f"; cat "$keep/$rel" "$f"; } 2>/dev/null | awk '!seen[$0]++' > "$HOME/.gstack-fold.tmp"
     mkdir -p "$keep/$(dirname "$rel")" && mv "$HOME/.gstack-fold.tmp" "$keep/$rel"
     git -c core.ignorecase=false add -f -- "$keep/$rel"
     git -c core.ignorecase=false rm -q --cached --ignore-unmatch -- "$f"
     echo "folded: $keep/$rel"
   done
   ```

   For each file it prints (Markdown, JSON snapshots such as
   `decisions.active.json`), compare `git show ":$keep/<file>"` with
   `git show ":$drop/<file>"`, write the content to keep to `"$keep/<file>"`,
   then run the same `git -c core.ignorecase=false add -f -- "$keep/<file>"`
   and `git -c core.ignorecase=false rm -q --cached --ignore-unmatch -- "$drop/<file>"`. Never
   concatenate a JSON snapshot. Then commit and push:

   ```bash
   git -c core.ignorecase=false commit -m "repair: fold $drop into $keep"
   git push origin HEAD
   ```

   On Linux the two folders are separate on disk: after the commit, check
   that `git -c core.ignorecase=false ls-files --others -- "$drop"` lists
   nothing you have not folded or moved, then remove the dropped folder
   (`rm -r "$drop"`). On a Mac or Windows they are the same folder, so do
   not remove anything.
3. Clear the held records of the dropped spelling and queue the kept files:
   `gstack-brain-sync --skip-file <dropped path>` for each held path that
   `--status` lists, then `gstack-brain-enqueue <kept path>` for each
   `folded:` line and each file you moved by hand, and
   `gstack-brain-sync --once`.
4. On every other machine, let the next skill start pull the repair (or run
   `git -C ~/.gstack pull`). The line disappears once no tracked path
   differs only by case.

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
On Windows (Git Bash) with `INSTALL_DIR` set correctly, older /gstack-upgrade
text compared two spellings of the same path and refused anyway; recover with
`cd <install dir> && git pull --ff-only --autostash && ./setup` (see
[the hook false positive](#setup-hook-does-not-parse)).

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

<a id="bun-version-unreadable"></a>
### `bun-version-unreadable: could not read the version of Bun at <path> (bun --version printed '<output>'); gstack <version> needs <floor> or newer (BUN_VERSION_UNREADABLE)`

**Meaning.** Before moving the checkout, the auto-updater and `/gstack-upgrade`
compare the Bun that setup would run with the incoming release's security
floor. `bun --version` printed something that is not a version (shown, with
control characters removed), so the comparison could not run and the update was
held: nothing was installed or changed. `/gstack-upgrade` prints the same text
after `BUN_VERSION_UNREADABLE:`. Earlier releases read an unreadable version,
and every version under zsh, as "not below the floor" and went ahead (#3195).

**Fix.** Reinstall Bun; `bun upgrade` may not run on a broken install. In Git
Bash or a macOS/Linux terminal:

```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

**Expected result.** `bun --version` prints a version such as `1.4.2`, and the
next session start (or `/gstack-upgrade`) updates.

**Fixed in.** The first release after v1.91.101.0 (#3195).

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

**On Windows (Git Bash), from 1.91.31: a false positive.** If every
TypeScript hook fails with `bun could not bundle the TypeScript entry` (the
question-log, question-preference, auq-error-fallback and timeline-stop hooks,
`/autoplan`'s publication hook and `/plan-ceo-review`'s mode-handoff hook),
your hooks are fine. Git Bash handed Bun its paths as `C:/…` while the checker
looked them up as `/c/…` (#3088, #3100); the checker on main reads both
spellings. The same Git Bash spelling made `/gstack-upgrade` stop with
`ERROR: <dir> is not a gstack checkout; nothing was changed.` One recovery
covers both: update by hand, then run setup from the update.

```bash
cd ~/.claude/skills/gstack && git pull --ff-only --autostash && ./setup
```

Use your install directory if it is not `~/.claude/skills/gstack` (`./setup
--status` prints it). Expected result: setup finishes with exit 0 and no
refusal line, and later auto-updates go through.

**Meaning, everywhere else.** Claude Code runs gstack's hook shims through
`/bin/sh`, and a hook that does not parse exits 2, which blocks the tool call
it guards in every session. Setup parse-checks every hook it registers and
every hook a skill's frontmatter runs (`/autoplan`, `/careful`, `/freeze`,
`/guard`, `/investigate` and `/plan-ceo-review`): the shim, the gstack shell
helpers it sources (such as `careful/bin/hook-extract.sh` and
`bin/gstack-state-root.sh`), and the TypeScript it runs with its local imports.
A merge conflict marker line in any of those files fails as `unresolved merge
conflict marker`, even when the file still parses (markers inside a heredoc, a
string or a template literal do). The TypeScript is bundled from the gstack
checkout, so the `tsconfig.json` or `bunfig.toml` of the project you run it
from is never read. It registers the hooks that parse, skips the ones listed,
finishes the rest of the install, and exits non-zero. Claude Code runs hooks
straight from `~/.claude/skills/gstack`, so a skipped hook that an earlier
setup registered, or that a skill runs, keeps running the broken file until it
is fixed. This is a gstack bug, or a half-applied edit or merge in your
checkout: report the printed `<file>:<line>`.

**Fix.**

```bash
git -C ~/.claude/skills/gstack status   # half-applied edits or merge conflicts?
git -C ~/.claude/skills/gstack checkout -- <file>   # or finish the merge
cd ~/.claude/skills/gstack && ./setup
```

**Expected result.** Setup finishes with exit 0 and no refusal line.

<a id="auto-update-hook-does-not-parse"></a>
### `gstack auto-update: update held (hook-does-not-parse: <file>:<line>: <error>); nothing was installed or changed, and your current hooks keep running. ...`

**On Windows (Git Bash), from 1.91.31: a false positive.** If the held
reason is `<hook>.ts:1: bun could not bundle the TypeScript entry`, the
release is fine: your installed checker misread Git Bash's `C:/…` paths
(#3088, #3100), and the auto-updater checks every release with it, so it
holds every release until you update once by hand. Recovery (this also clears
`/gstack-upgrade`'s `is not a gstack checkout` refusal):

```bash
cd ~/.claude/skills/gstack && git pull --ff-only --autostash && ./setup
```

Use your install directory if it is not `~/.claude/skills/gstack`. Expected
result: setup finishes with exit 0, the next session start prints no held
line, and later updates install on their own.

**Meaning, everywhere else.** Team-mode auto-update fetched a release with a
hook that does not parse or still holds a merge conflict marker (the same
check setup runs). It checked the incoming revision before moving your
checkout, so your checkout, installed skills and registered hooks stay at the
current revision. The incoming release's own `bin/gstack-hook-check` decides,
so a checker bug in your install cannot hold later releases; your installed
checker decides only when the incoming one crashes, prints nothing or prints
a report it cannot verify. gstack checks again at the next update check and
installs the first release whose hooks parse. This is a gstack bug: report the
printed `<file>:<line>`.

**Fix.** Wait for the next release. A manual `git pull` followed by `./setup`
cannot be checked before the pull; setup then refuses the broken hook (see the
entry above).

<a id="auto-update-hook-check-unavailable"></a>
### `gstack auto-update: update held (hook-check-unavailable: <reason>); nothing was installed or changed, and your current hooks keep running. ... Fix now (in a terminal; Git Bash on Windows): cd '<dir>' && git fetch origin && bash bin/gstack-ff-update . '@{upstream}' && ./setup ...`

**Meaning.** Neither the incoming release's hook checker nor your installed
one gave a verified report on the incoming hooks (a crash, no output, an
unreadable report, or no Bun to bundle the TypeScript hooks), or the incoming
revision could not be extracted for the check (`cannot extract the incoming
revision: <git's error>`), so the auto-updater cannot tell whether moving your
checkout would break Claude Code tool calls. It left your checkout, skills and
hooks at the current revision. The `<reason>` names what each checker did.

**Fix.** Run the printed command. `bin/gstack-ff-update` moves the checkout
without losing a local edit (see
[shelved edits](#auto-update-rescued-edits)), and setup checks every hook it
registers and says what is wrong (for example that Bun is missing).

On Windows, if the reason is `git archive of the incoming revision failed`,
your updater predates the fix for #3184: see
[the held-install recovery](#auto-update-held-install-recovery).

<a id="auto-update-held-install-recovery"></a>
### `HELD hook-check-unavailable: git archive of the incoming revision failed` / `gstack auto-update: update held (hook-check-unavailable: git archive of the incoming revision failed) ...` / `gstack auto-update: setup did not finish (bun not found on PATH) ...` on Windows

**Meaning.** From 1.91.89.0 to the release that fixed #3184, the auto-updater
extracted each incoming release with `git archive | tar` before checking its
hooks. Git for Windows' MSYS `tar` cannot create the `connect-chrome` symlink
because it comes before its target in the archive, so every release was held
(`~/.gstack/analytics/session-update.log` shows the `HELD` line), and a stale
`setup did not finish (bun not found on PATH)` line could hide the hold. Your
installed updater cannot deliver its own fix, and the old `/gstack-upgrade`
can leave conflict markers when a local edit conflicts. The recovery fetches
the new `bin/gstack-ff-update` from the new revision into a private temp
directory and runs it. It works on a clean install, an install with local
edits that conflict, an install that already has unmerged files, and a
prefix-mode install: regenerable `SKILL.md` and `sections/*.md` edits are
re-rendered by setup, and every other edit is kept in a rescue ref (the
command prints it; see [shelved edits](#auto-update-rescued-edits)).

**Fix, in Git Bash** (use your install directory if it is not
`~/.claude/skills/gstack`):

<!-- form:recovery-gitbash -->
```bash
cd ~/.claude/skills/gstack && git fetch origin main && d=$(mktemp -d) && git show FETCH_HEAD:bin/gstack-ff-update > "$d/gstack-ff-update" && bash "$d/gstack-ff-update" . FETCH_HEAD; s=$?; rm -rf "$d"; [ "$s" = 0 ] && ./setup
```

**Fix, in Windows PowerShell 5.1** (it runs the same script through Git's
`bash.exe`, then `.\setup.ps1`):

<!-- form:recovery-powershell -->
```powershell
Set-Location -LiteralPath "$HOME\.claude\skills\gstack" -ErrorAction Stop; $gb = Join-Path (git --exec-path) '..\..\..\bin\bash.exe'; & $gb -c 'set -f; IFS=; git fetch origin main && d=$(mktemp -d) && git show FETCH_HEAD:bin/gstack-ff-update > $d/gstack-ff-update && bash $d/gstack-ff-update . FETCH_HEAD; s=$?; rm -rf -- $d; exit $s'; if ($LASTEXITCODE -eq 0) { .\setup.ps1 }
```

**In Claude Code**, ask it to run the Git Bash form above.

**Expected result.** The script prints `ok <old> <new>` or
`rescued <old> <new> refs/gstack/rescue/<oid> unmerged=<0|1>`, setup
finishes with exit 0, the next session start prints no held line, and later
updates install on their own.

**Trying an unreleased fix, and going back.** A fix branch can be tried
before it ships; auto-update pauses while a detached revision is checked out.
Replace `<branch>` with the branch named in the issue.

<!-- form:trial-gitbash -->
```bash
cd ~/.claude/skills/gstack && git checkout -- 'SKILL.md' '*/SKILL.md' '*/sections/*.md' && git fetch origin <branch> && git checkout --detach FETCH_HEAD && ./setup
```

<!-- form:trial-powershell -->
```powershell
Set-Location -LiteralPath "$HOME\.claude\skills\gstack" -ErrorAction Stop; $gb = Join-Path (git --exec-path) '..\..\..\bin\bash.exe'; & $gb -c 'set -f; git checkout -- SKILL.md */SKILL.md */sections/*.md && git fetch origin <branch> && git checkout --detach FETCH_HEAD'; if ($LASTEXITCODE -eq 0) { .\setup.ps1 }
```

To go back to the released version (this also resumes auto-update):

<!-- form:goback-gitbash -->
```bash
cd ~/.claude/skills/gstack && git checkout -- 'SKILL.md' '*/SKILL.md' '*/sections/*.md' && git checkout main && ./setup
```

<!-- form:goback-powershell -->
```powershell
Set-Location -LiteralPath "$HOME\.claude\skills\gstack" -ErrorAction Stop; $gb = Join-Path (git --exec-path) '..\..\..\bin\bash.exe'; & $gb -c 'set -f; git checkout -- SKILL.md */SKILL.md */sections/*.md && git checkout main'; if ($LASTEXITCODE -eq 0) { .\setup.ps1 }
```

<a id="auto-update-unmerged-files"></a>
### `gstack auto-update: update held (unmerged-files: <n> unmerged file(s) in the install (first: <path>)); an earlier merge, rebase or stash pop left conflicts in the install, and an update would bury them. Fix now (...): cd '<dir>' && git fetch origin && bash bin/gstack-ff-update . '@{upstream}' && ./setup ...`

**Meaning.** Your gstack checkout has unmerged files: conflict markers from a
merge, rebase or `git stash pop` of your own, or from an auto-updater older
than the fix for this (its `merge --autostash` left markers in place when a
local edit conflicted). The background updater never moves a checkout with
unmerged files, and it prints no "setup did not finish" fix while they exist,
because setup would run over the markers.

**Fix.** Run the printed command. It saves everything first, the unmerged
files included, in a rescue ref labelled "needs manual resolution", then
moves the checkout to the release and runs setup. Read the rescue with the
commands under [shelved edits](#auto-update-rescued-edits). To resolve the
conflict yourself instead, finish or abort your merge (`git -C '<dir>' merge
--abort`, `git -C '<dir>' checkout -- <file>`); gstack retries at the next
check.

<a id="auto-update-autostash-unrecoverable"></a>
### `gstack auto-update: update held (autostash-unrecoverable: <reason>); your local edits are where they were and nothing was installed. Look first: git -C '<dir>' status --short. Fix now (...)` / `autostash-unrecoverable: <reason>`

**Meaning.** `bin/gstack-ff-update` refused to move the checkout and changed
nothing. The `<reason>` says why: an untracked file is where the release
puts a tracked one (`git refused to update ...: would be overwritten`), a
file changed while the update ran, another git command held the index lock
(`index.lock exists`), or a rescue ref of that name already names another
commit.

**Fix.** Run the `status` command the line prints, move the listed untracked
file out of the way (or wait for the other git command to finish), then run
the printed `Fix now` command. Nothing needs restoring: your edits are still
in the working tree.

<a id="auto-update-rescued-edits"></a>
### `gstack auto-update: your local edits in the install (<files>) conflicted with an update, so they were saved in refs/gstack/rescue/<oid> and the install runs the update. ...` / `rescued <old> <new> refs/gstack/rescue/<oid> unmerged=<0|1>`

**Meaning.** You had edited tracked files in your gstack checkout, and the
release changed the same lines (or you had staged changes or unmerged files).
Instead of leaving conflict markers in the checkout Claude Code runs hooks
from, `bin/gstack-ff-update` saved your edits as one commit,
`refs/gstack/rescue/<oid>`, and moved the checkout to the release. The
rescue's first parent is the revision you had, so it holds only your changes;
its second parent holds what you had staged. Edits that did not conflict stay
in place, and regenerable `SKILL.md` and `sections/*.md` edits (skill prefix,
gbrain blocks) are re-rendered by setup instead of being rescued. The
session-start line repeats once a day until you delete the ref.

**Fix.** Inspect first:

```bash
git -C ~/.claude/skills/gstack show --stat 'refs/gstack/rescue/<oid>'
```

To keep your edits, export only your changes and apply them in a scratch
checkout (never with `stash apply` in the install):

```bash
git -C ~/.claude/skills/gstack diff 'refs/gstack/rescue/<oid>^' 'refs/gstack/rescue/<oid>' > ~/gstack-local-edits.patch
git clone https://github.com/garrytan/gstack.git ~/gstack-scratch && cd ~/gstack-scratch && git apply -3 ~/gstack-local-edits.patch
```

A rescue labelled "needs manual resolution" holds files that were already
unmerged: their content can contain conflict markers to resolve. Delete the
ref when you are done (this also stops the daily line):

```bash
git -C ~/.claude/skills/gstack update-ref -d 'refs/gstack/rescue/<oid>'
```

<a id="setup-runtime-root-contains-checkout"></a>
### `gstack setup: refusing to replace <root> for <host>: this runtime directory contains the source checkout setup runs from (<checkout>), so replacing it would delete the checkout. Nothing was changed.`

**Meaning.** Setup installs Codex, Factory, OpenCode, Cursor, Copilot and
Antigravity by building a runtime root (such as `~/.cursor/skills/gstack`) and
swapping it in for the old one, and Kiro by writing into `~/.kiro/skills/gstack`.
Your gstack checkout lives at that root or inside it, so the swap would delete
the checkout (#3084), and Kiro would link the checkout into itself. Setup refuses before
writing anything. `./setup --status` and `gstack-doctor` suggest the move for
that host instead of `./setup --host <host>`.

**Fix.** Move the checkout out, then run setup from its new place. Setup
prints the exact commands. When `~/.claude/skills/gstack` is a symlink to the
checkout, the checkout takes the symlink's place:

```bash
rm ~/.claude/skills/gstack && mv ~/.cursor/skills/gstack ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --host claude && ./setup --host cursor
```

Otherwise move it anywhere outside the host's skills directory:

```bash
mv ~/.cursor/skills/gstack ~/gstack && cd ~/gstack && ./setup --host cursor
```

**Expected result.** Both setups finish with exit 0, and `./setup --status`
lists each host as `current`.

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

**Fix.** No setting raises these caps. For the 64 MiB source cap, rerun with
`--paths` set to the comma-separated repo-relative directories you want audited
(for example `--paths src/core,src/mcp`). Paths outside them are never
captured or assessed and do not count toward the cap; snapshot and history
coverage then read **partial**, the report counts every skipped path, and the run's
snapshot manifest lists each one, so the verdict says what was not audited.
With `--diff`, every changed path outside dependency directories must be inside
`--paths`, or the run is refused. Do not audit a hand-trimmed copy: /cso would treat it as the whole
repository and report nothing as skipped. `--paths` does not lower the
manifest cap or the 100,000-entry limit, because every skipped path still has a
manifest entry (about 50,000 files fit). Symlinks must be removed. Add your
file count or size to
[#2993](https://github.com/garrytan/gstack/issues/2993).

<a id="cso-scanner-invalid-output"></a>
### `INVALID_OUTPUT: Scanner report is malformed, unsupported, or exceeds structural limits.` (Semgrep on a real repository)

**Meaning.** Before the first release after v1.91.101.0, /cso redacted a
scanner's JSON report by splicing an unquoted `<REDACTED-...>` marker over any
bare number that looked like a phone number or card number, such as Semgrep's
`"max_memory_bytes":1145427776` or an epoch timestamp. The report then failed to
parse and the scanner was recorded as not assessed (#3185). Now a redacted
number becomes the quoted string `"<REDACTED-...>"` and the report parses. A
redaction that would cross JSON tokens still withholds the payload
(`REDACTION_FAILED`).

**Fix.** Update gstack (`/gstack-upgrade`), then run /cso again. If this code
still appears, the scanner itself emitted malformed JSON; report the scanner
and version at https://github.com/garrytan/gstack/issues.

**Fixed in.** The first release after v1.91.101.0 (#3185).

<a id="cso-orbstack-argv0"></a>
### `unsupported argv0 "docker-tools"` (OrbStack's `docker` under /cso)

**Meaning.** /cso runs the canonical path of `docker` (symlinks resolved), and
OrbStack's `docker` is a symlink to one multicall binary, `docker-tools`, that
decides what to be from the name it was started as. Started under its real name
it refused, so Docker isolation and every scanner were reported missing
(#3187). /cso now starts the same verified binary with the name `docker`,
including in its cleanup watchdog.

**Fix.** Update gstack (`/gstack-upgrade`), then run `gstack-doctor`; its `cso`
row should pass with OrbStack running.

**Fixed in.** The first release after v1.91.101.0 (#3187).

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
constraint with its source), or change the project's pin. On Capy the row's
fix is the exact bootstrapper command, `bash <skill>/scripts/install.sh`
(the same command without `--check`): it installs the pinned Bun when the pin
names a verified version and ends `gstack: ok`, or stops with
`RUNTIME_PIN_CONFLICT` naming the pin to raise.

<a id="doctor-revision-unmet"></a>
### `FAIL revision — installed <version> (requested <ref>) (REVISION_UNMET; ...)`

**Meaning.** `--revision <ref>` asked the doctor to certify a specific gstack
revision (a VERSION string, tag, branch or commit) and the checkout is at
another. An unmet revision is never `ok`.

**Fix.** Move the checkout: `<checkout>/bin/gstack-upgrade` (the tip of the default
branch; `/gstack-upgrade` interactively), or
`git -C <checkout> fetch origin && git -C <checkout> checkout <ref> && ./setup`.
`bin/gstack-capy-install --revision <ref>` never moves an existing checkout; it
reports `gstack: ok <installed> (requested <ref>; run <checkout>/bin/gstack-upgrade to move)`.

<a id="capy-install-runtime-conflict"></a>
### `gstack-capy-install: Bun conflict: gstack needs >=<minimum>, <project> pins <constraint> (RUNTIME_PIN_CONFLICT; ...)`

**Meaning.** The installer installs one verified Bun archive: gstack's
supported minimum, or the project's exact pin when that pin is above the
minimum and listed in the message's `verified archives:`. Here the two do not
meet (for example the project pins `bun@1.3.14`, or a version gstack has no
verified archive for), so the installer changed nothing and stopped before
`./setup`.

**Fix.** Pin a verified version in the project, upgrade gstack to a release
that verifies the pinned version, or install gstack on a machine whose Bun the
project accepts. `--project <path>` names
the project whose pins apply.

<a id="browser-ensure-failed"></a>
### `gstack-browser-ensure: NEEDS_SETUP ... (BROWSER_UNAVAILABLE; ...)`

**Meaning.** The first browser skill run on a machine installed without
Chromium (`SKIP browser (lazy; gstack-browser-ensure installs on first use)`)
tried to install it through `bun x playwright install chromium` under setup's
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

<a id="capy-install-launch-file-unwritable"></a>
### `gstack: fail launch-file — could not write the launch file <path>; fix: ... (LAUNCH_FILE_UNWRITABLE)`

**Meaning.** The doctor passed, but `bin/gstack-capy-install` could not write
the launch file (`GSTACK_LAUNCH_FILE`, the sourceable mode-0600 copy of the
`GSTACK_LAUNCH` assignments beside the install verdict). The file is part of the
ok verdict: without it a caller would be left with only the line and the
re-typing path that leaked an environment in GSTA-96, so the run fails instead.
The directory under the state root is unwritable, or a temp file could not be
moved into place.

**Fix.** Make the verdict directory writable, or set `GSTACK_STATE_ROOT` to a
writable directory, then re-run `bin/gstack-capy-install`.

<a id="project-floor-unmet"></a>
### `WARN floor — installed <v> is below the floor <f> that <project>/.gstack/ship-policy.json declares (min_gstack_version); fix: ... (PROJECT_FLOOR_UNMET)` / trailer note `floor=<f> (<file>)`

**Meaning.** The project you work in declares the oldest gstack it wants its
crew on, as `min_gstack_version` in its `.gstack/ship-policy.json` (the same
key `gstack-ship-queue` validates; a file holding only that key is valid), and
this machine's checkout is older. One commit in the project replaces a
crew-wide "upgrade to <v>" broadcast: every machine's next session check says
so and names the command. It is a project rule, not a security minimum, so
the row is a WARN and the trailer stays `gstack: ok` with a `floor=<f>
(<file>)` note and a `fix:` note; only the supported minimum
(`REVISION_BELOW_MINIMUM`) fails a session for being old.

**Fix.** Run the fix before the first workflow: on Capy, `bash
<skill>/scripts/install.sh --for <skill>` fast-forwards a clean checkout to
origin and reinstalls in one step (`SELF_UPGRADE: done`); elsewhere
`bin/gstack-upgrade`. If the floor is above gstack's latest release, lower it
in the project.

<a id="project-node-pin-unmet"></a>
### `WARN pins — node <v> outside <pin> (<file>); node read from <path> (node pin only; bun pins pass); fix: ... (PROJECT_NODE_PIN_UNMET)`

**Meaning.** The project's Node pin is not met by the Node first on PATH (a
Capy image's Node behind the pin, say), while every Bun pin is met. gstack's
own commands run on Bun, and the project's tests usually select their Node
themselves (nvm, the CI matrix), so this is advisory: the trailer stays ok. A
Bun pin that is unmet, with or without a Node gap, is still `FAIL pins`
(`PROJECT_PIN_MISMATCH`).

**Fix.** When this machine will run the project's tests, run the row's fix: the
Capy skill installer installs an exact pin into gstack's runtime store and
launches it through the `GSTACK_LAUNCH` PATH; otherwise `nvm install <pin>`
and put it first on PATH. A range pin (`>=24.22.1`) needs a Node you install
yourself; or change the pin in the project.

<a id="upgrade-skipped"></a>
### `WARN behind — installed <v> is <n> commits behind origin (latest <ver>) and the session-start upgrade was skipped: <reason>; fix: <command> (UPGRADE_SKIPPED|UPGRADE_BUSY|UPGRADE_REFUSED)` / trailer note `behind=<n> (latest: <ver>); upgrade skipped: <reason> (<CODE>); fix: <command>`

**Meaning.** An install-mode session start above the supported minimum found
the checkout behind origin and could not fast-forward it: the checkout is
dirty, diverged or pinned (`UPGRADE_REFUSED`), another live session holds a
lease (`UPGRADE_BUSY`), or `bin/gstack-upgrade` is missing
(`UPGRADE_SKIPPED`). Nothing was changed, the doctor certified the installed
revision, and the trailer stays `gstack: ok` with the notes above: a gap
above the minimum is never a hard fail. The verdict records the installed
revision, so a lane that is behind reports it (`behind=` rides every report).

**Fix.** When the lane needs the newer gstack (a `floor=` note, or a fix that
landed upstream), clear the named cause and run the fix: `bin/gstack-upgrade`
after the refusal is resolved, or the Capy skill installer again once the
lease holder finishes. Below the supported minimum the bootstrapper fails
`revision` instead (`REVISION_BELOW_MINIMUM`).

<a id="upgrade-refused"></a>
### `gstack-upgrade: <cause>; nothing was changed; fix: <command> (UPGRADE_REFUSED)`

**Meaning.** `bin/gstack-upgrade` moves a checkout only by fast-forward to the
tip of its remote default branch. It refused before changing anything: the
directory is not a gstack checkout, HEAD is detached or on another branch (a
pin), a tracked file is modified, a local commit is not on the remote branch,
the incoming release's Bun floor is above the Bun on PATH, or another updater
holds `<state root>/.setup-lock`. It never stashes, resets or discards.

**Fix.** Resolve the named cause with the printed command (commit or move the
listed changes, check out the default branch, move local commits to another
branch), then re-run `bin/gstack-upgrade`. A reinstall that failed after the
fast-forward is completed by the next run (`reinstall pending from <version>`).

<a id="upgrade-busy"></a>
### `gstack-upgrade: live gstack sessions hold this installation: pid <p> (<age>m), ...; nothing was changed; fix: ... (UPGRADE_BUSY)`

**Meaning.** Several agents share this checkout (Capy subagents on one
machine, say). Each session start writes a workflow lease,
`<git dir>/gstack-leases/<harness pid>` (`bin/gstack-lease touch`, from
`bin/gstack-skill-start`), and `bin/gstack-upgrade` refused before changing
anything because a lease whose pid is alive and not in its own process
ancestry exists: fast-forwarding would change gstack under a session
mid-workflow. Leases older than 120 minutes are pruned; a lease whose
process has exited never blocks, and neither does a stale one: each lease
records its process's start identity, so a pid reused after a reboot or a
machine wake (GBRA-105's lease named pid 379, which had become dbus-daemon)
is reclaimed instead of blocking. The upgrader's own session (the pid chain it
runs under) never counts for `bin/gstack-upgrade` run by hand. A Capy install
in install mode (`bin/gstack-capy-session`) counts it while that lease is under
120 minutes old: an install run from inside a workflow that holds the lease
(/ship's docs step, #3571) prints `SELF_UPGRADE: skipped (a gstack run in this
session holds a workflow lease on this installation: pid <p> (<age>m
<command>), so the upgrade waits until the lease is 120 minutes old; fix:
<checkout>/bin/gstack-upgrade once the run ends (UPGRADE_BUSY))` and leaves the
checkout where the run started. Each `gstack-skill-start` renews the lease.

**Fix.** Wait for those sessions to finish (`bin/gstack-lease list` shows
every lease with its age and `alive|dead|stale`; a holder is named as
`pid <p> (<age>m <command>)`), then re-run `bin/gstack-upgrade`. For the
session's own run, run the printed `bin/gstack-upgrade` after the run ends.
When you know they are idle, `GSTACK_UPGRADE_FORCE=1 bin/gstack-upgrade`
proceeds. At a Capy session start the same refusal appears as
`SELF_UPGRADE: skipped (live gstack sessions hold this installation: ...)`,
the doctor adds `WARN behind — … (UPGRADE_BUSY)` and the trailer stays
`gstack: ok … (behind=<n> (latest: <v>); upgrade skipped: … (UPGRADE_BUSY); fix: …)`:
the installed revision is above the supported minimum, so the session is
certified and the note names the fix.

<a id="upgrade-fetch-failed"></a>
### `gstack-upgrade: could not reach origin (...) (UPGRADE_FETCH_FAILED)`

**Meaning.** The remote default branch could not be listed or fetched (offline,
proxy, credentials), so `--check` cannot say whether the checkout is current.
It never reports `current` without the fetch.

**Fix.** Check network access to the checkout's origin
(`git -C <checkout> remote -v`), then re-run.

<a id="revision-below-minimum"></a>
### `gstack: fail revision — installed <v> is below the supported minimum <m> (<cause>); fix: ... (REVISION_BELOW_MINIMUM)`

**Meaning.** `capy/support.env` on the remote default branch declares the
oldest revision whose installer, trailer and fix lines are honest
(`GSTACK_MIN_REVISION`), and this checkout is older. The Capy skill
bootstrapper reads it from `FETCH_HEAD`, so even a checkout that predates the
file learns it. `--check` only reports (`fast-forward available`); install
mode fast-forwards a clean, unpinned checkout, reinstalls and rechecks under
one lock. The cause names why nothing moved: `pinned by --revision`, `pinned:
HEAD is detached`, `tracked files changed: <files>`, `diverged: ...` or
`auto-upgrade disabled` (`GSTACK_CAPY_AUTO_UPGRADE=0`). `gstack-doctor --check
--min-revision <m>` fails the revision row the same way.

**Fix.** Run the fix clause: the bootstrapper without `--check`, or
`<checkout>/bin/gstack-upgrade`. For a pin, drop `--revision` or pin a
revision at or above the minimum. An interrupted install after the
fast-forward leaves the trailer `fail`; the next install run completes it.

<a id="capy-wrapper-stale"></a>
### `FAIL wrapper — ... (CAPY_WRAPPER_STALE)` / `WARN wrapper — ...; owner action: ...` / `gstack-capy-skill: owner action — Drive copy is wrapper <n>, minimum <m>; ...`

**Meaning.** The Capy skill folder is older than the checkout's
`GSTACK_CAPY_MIN_WRAPPER` (`capy/support.env`). The doctor's `wrapper` row
decides by the active wrapper's provenance (`GSTACK_CAPY_WRAPPER_REV` and
`GSTACK_CAPY_WRAPPER_PATH`, exported by the bootstrapper): a current active
wrapper passes, and a stale Drive copy elsewhere is a `WARN` row, an owner
action that never fails the run. Without provenance (a direct
`gstack-doctor --check`, or a pre-bootstrapper copy with no
`GSTACK_CAPY_WRAPPER=` line, which reads as wrapper 0) it reads the Drive
copies (`~/.capy/drive/*/skills/gstack/scripts/install.sh`, or only
`GSTACK_CAPY_WRAPPER_PATH` when set), listing each with its revision: every
copy a bootstrapper below the minimum is `WARN wrapper — every Capy skill copy
is below the minimum wrapper <m> (it still works): ...` with the owner action,
and it fails only when a copy is pre-bootstrapper (wrapper 0), which cannot
hand over at all. A stale active wrapper is a `WARN` too: an older copy still
works (`capy/support.env`). `bin/gstack-upgrade` runs the
installer with the checkout's own copy as the active wrapper and never leaves
a pending reinstall when the wrapper row is the only failure.

**Fix.** This session: run the checkout's own copy,
`bash <checkout>/capy/skill/gstack/scripts/install.sh --check --for <skill>`;
it carries current provenance, so it certifies with the stale Drive copy left
unchanged. Owner: copy `<checkout>/capy/skill/gstack/` over the Drive skill
folder (on Capy, the user-scope Drive `skills/gstack/`), or have Capy re-sync
it. The message recurs every session until the Drive copy changes. Agents never
write the skill folder.

<a id="bun-resolution-drift"></a>
### `FAIL runtime — bun resolution drifted: recorded bun <v> at <path> (<rule>), now <current>; changed: <what>; fix: ... (BUN_RESOLUTION_DRIFT)`

**Meaning.** Install and `--check` resolve Bun through one contract
(`gstack_bun_resolve` in `bin/gstack-bun-version.sh`, twinned by `resolveBun`
in `lib/pregate/runtime.ts`): the project's exact pin and gstack's install
default in the runtime store (`<state root>/runtimes/bun/<version>/bun`),
`$BUN_INSTALL/bin`, `~/.bun/bin`, then PATH; the first Bun that satisfies
gstack's minimum and every project pin wins. Install records the pick in the
install verdict for this checkout and project (`bun_path`, `bun_version`,
`bun_rule`). The recorded Bun is gone, reports another version (replaced in
place), or no longer satisfies gstack's minimum and the project's pins. A
different candidate that would now resolve first (a store Bun another
project's install published, a changed `BUN_INSTALL`) is not drift: `--check`
keeps the recorded Bun, prints `note: the recorded bun ... stays certified`
and names the installer run that records the new pick. The pregate's lanes and
guards (`lib/pregate/runtime.ts`) and the workflow start refuse with this code
when the Bun the verdict recorded is gone or changed.

**Fix.** Run the row's fix: the installer, which records the current pick, or,
when nothing eligible remains, re-downloads a verified Bun into the store. The
next `--check` passes.

<a id="bun-install-version-invalid"></a>
### `gstack-capy-install: GSTACK_BUN_INSTALL_VERSION=<v> is not a verified Bun at or above gstack's supported minimum ...; fix: ... (BUN_INSTALL_VERSION_INVALID)`

**Meaning.** `GSTACK_BUN_INSTALL_VERSION` overrides the Bun the installer
downloads when no exact project pin decides (`GSTACK_BUN_DEFAULT`, 1.4.4). It
must be listed in `GSTACK_BUN_VERIFIED` (a SHA-256-verified archive) and sit at
or above the supported minimum (`GSTACK_BUN_TESTED`). Nothing was installed.

**Fix.** Unset the variable, or set it to one of the verified versions the
message lists.

<a id="install-unverified"></a>
### `INSTALL: fail verdict — <detail>; fix: ... (INSTALL_UNVERIFIED)`

**Meaning.** On a Capy machine (`GSTACK_CAPY=1`, set by the `GSTACK_LAUNCH`
line), an unattended or spawned workflow starts only with a passing install
verdict (`<state root>/install-verdicts/<sha256 of the checkout path>/<sha256
of the project directory, or none>.json`, named as `GSTACK_INSTALL_VERDICT`)
for this checkout, its current HEAD and a
workflow at least as wide as the one starting: a verdict for `--for autoplan`
does not cover `qa`'s browser, and a planning-only pins SKIP does not cover a
workflow that runs the repo's tests. `gstack-skill-start` printed this row and
`GSTACK_RESULT: skill=<s> status=refused run=-`, exit 3. The same start refuses
an unattended run whose Bun on PATH is below the supported minimum
(`INSTALL: fail runtime ... (RUNTIME_BELOW_MINIMUM)`) on any host.

**Fix.** Run the Capy skill installer (`scripts/install.sh --for <workflow>`)
from the project directory the workflow will run in, since the verdict is
keyed by that directory (GSTA-85), and launch with the `GSTACK_LAUNCH` line it
prints. A verdict file that exists but cannot be read (`the install verdict at
<file> is unreadable or has an unsupported schema_version`) is repaired the
same way, by rerunning the installer.
`GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1` admits anyway (printed as
`INSTALL_VERDICT: overridden`); record it as a deviation.

---

## Capy: approvals, Captain briefs and PR screenshots

These come from the commands gstack's Capy adaptations add: `gstack-approvals` (the
per-thread approval record), `gstack-owner-brief render --captain` (the plan ask in
the before/after shape) and `gstack-pr-shots` (before/after images for a PR body).
The guide is `capy/skill/gstack/captain.md`.

<a id="approval-record-invalid"></a>
### `gstack-approvals: ... (APPROVAL_RECORD_INVALID)`

**Meaning.** A row is missing a required field (`--ask`, `--words`, `--scope`,
`--by`), holds a value outside its enum (`--outcome approved|rejected|pending|standing`,
a `--date` that is not a real `YYYY-MM-DD` day) or exceeds a length cap (ask, scope and
pending 300 characters, words 2,000). Exit 2. Nothing was written.

**Fix.** Rerun with every required flag inside the caps the line names.

<a id="approval-record-secret"></a>
### `gstack-approvals: ... (APPROVAL_RECORD_SECRET)`

**Meaning.** A field matched gstack's secret scanner (the same one the push guard
uses). The line names the field and the detector rule, never the matched text. Exit 3.
Nothing was written, locally or to the Drive mirror.

**Fix.** Record the words with the secret replaced by `[redacted]`, or ask the person to
restate them. Rotate the secret if it was real.

<a id="approval-record-no-branch"></a>
### `gstack-approvals: ... (APPROVAL_RECORD_NO_BRANCH)`

**Meaning.** The record is kept per branch (one Capy thread ships one branch), and
HEAD is detached or the working directory is not a git repository. Exit 3.
From `import --autoplan <dir> --stack <b1,b2,...>` it means a listed branch exists
neither locally nor on origin; the line names it, and no branch's record was written.

**Fix.** Check out the branch the work ships from, or pass `--branch <name>`. For
`--stack`, correct or fetch the named branch and import again.

<a id="approval-record-unavailable"></a>
### `gstack-approvals: ... (APPROVAL_RECORD_UNAVAILABLE)`

**Meaning.** There is no record on this machine, the state root is ephemeral (a Capy
machine), and no Drive mirror could be resolved, so "no approvals" cannot be told apart
from "the record was lost with the old machine". `render` still prints the section, with
"Record unavailable on this machine" instead of "No approvals recorded". Exit 1.

**Fix.** Run where the record lives, copy the rows back from the thread's report, or make
a Drive mirror resolvable: `GSTACK_APPROVALS_DIR`, an `approvals/` directory in the one
mounted Captain drive (`~/.capy/drive/captain-*/approvals`, readable by the whole crew), or one
`~/.capy/drive/project-user-*` folder. `gstack-approvals path` prints which rule chose the mirror
and, as `READ_ALSO:`, the other roots it still reads (a row mirrored before the Captain created
`approvals/` stays visible).

<a id="approval-record-write-failed"></a>
### `gstack-approvals: ... (APPROVAL_RECORD_WRITE_FAILED)`

**Meaning.** The local record or its Drive mirror could not be written; the line names
the path and the error. A failed local append wrote nothing. A failed mirror write
leaves the local row in place. Exit 1.

**Fix.** Make the named directory writable, then rerun `gstack-approvals sync` to mirror again.

<a id="approval-import-unanswered"></a>
### `gstack-approvals import: ... (APPROVAL_IMPORT_UNANSWERED)`

**Meaning.** The autoplan run has no answered gate (every decision is still pending),
so there is nothing to import. Exit 3.

**Fix.** Answer the gate (`gstack-autoplan answer ... --by human|agent:<id>`), then
import again. Imports are idempotent, so a retry never records an answer twice.

<a id="captain-brief-incomplete"></a>
### `gstack-owner-brief render --captain: ... (CAPTAIN_BRIEF_INCOMPLETE)`

**Meaning.** The plan is missing at least one section the brief needs: `## Before → after`,
`## Why it matters`, `## What caused this work`, `## Big decisions`, and `## ELI5` (alias
`## In plain words`) on a run whose `gate.json` carries an `eli5` field (gstack 1.91.305 and
later; older runs render as before). The brief still prints,
but it opens with "Not ready for approval" and has no reply invitation. Exit 1.

**Fix.** Add the named sections to the plan (`gstack-autoplan revise --plan <file>` if
the run is reviewing it) and render again. `--allow-incomplete` exits 0 for a preview,
but the text still says it is not ready.

<a id="pr-shots-input-not-found"></a>
### `gstack-pr-shots: ... (PR_SHOTS_INPUT_NOT_FOUND)`

**Meaning.** An input is missing: a `--before/--after` file, the `--base` ref, the
`--path` at both the base and the working tree, or the `--heading` on both sides. Exit 3.

**Fix.** Check the ref, path or heading named on the line.

<a id="pr-shots-input-refused"></a>
### `gstack-pr-shots: ... (PR_SHOTS_INPUT_REFUSED)`

**Meaning.** An input was refused before anything was rendered, because PR images
are public. It matched the secret scanner (the line names the side, line and rule),
is binary, exceeds 512 KiB, lies outside the repository and the state root, or names a
ref starting with `-`. Exit 3.

**Fix.** Take the secret out of the capture, or picture a tracked text file.

<a id="pr-shots-identical"></a>
### `gstack-pr-shots: ... (PR_SHOTS_IDENTICAL)`

**Meaning.** Before and after are the same text, so there is no change to picture. Exit 1.

**Fix.** Picture a file or section this branch changed (`git diff --stat origin/<base>...HEAD`).

<a id="pr-shots-render-failed"></a>
### `gstack-pr-shots: ... (PR_SHOTS_RENDER_FAILED)`

**Meaning.** A browser was available but rendering `shot.html` failed; the line names the
renderer's error. `shot.html` and `text.md` are still written. Exit 1. With no browser at
all the command prints `SHOT_PNG: unavailable (...)` and exits 0 instead.

**Fix.** Screenshot `shot.html` with your own browser at 880 px wide, or use `text.md`.

## /ship token budget and fresh-context handoffs (gstack-ship-budget)

The flow, the BUDGET line field by field and the meters are in [ship-budget.md](ship-budget.md).
Exit 2 lines go to stderr; exit 3 lines (a stop) go to stdout with the STOP, RECOVER and
GSTACK_RESULT lines.

<a id="budget-cap-reached"></a>
### `gstack-ship-budget: ... (BUDGET_CAP_REACHED)`

**Meaning.** The next step, or the first reader of a dispatch batch, would push used + open
reservations + unknown charges + its projection + the tail and stop reserve past the admission
cap, so it did not start. Exit 3. A batch that partly fits is not refused: `check` admits the
largest prefix that fits and prints `ADMIT: k of n (remaining=<roles>)`. `gstack-review-log --start` prints the same code (exit 1) for a dispatch
after the run stopped. The cap admits work; it cannot stop a turn already running, so the
overshoot is bounded by the misprojection of work admitted before the stop.

**Fix.** The run ended status=incomplete with a resumable record. Raising the cap is the
owner's call: run the printed `RECOVER:` line; its resume needs
`--approved-by <who> --words "<their words>"`.

<a id="budget-reading-missing"></a>
### `gstack-ship-budget: ... (BUDGET_READING_MISSING)`

**Meaning.** The run's meter is the agent's own Capy jam counter, a cap is set, and the command got no
`--reading`. Exit 2. No gstack binary can call Capy's API, so the agent reads it.

**Fix.** In the execute program that runs the command, read
`(await tools.thread.get({ thread_id: "<your own jam id>" })).cost.tokens` and pass it as `--reading <n>`.

<a id="budget-reading-rejected"></a>
### `gstack-ship-budget: ... (BUDGET_READING_REJECTED)`

**Meaning.** The reading breaks the run's meter contract: it is lower than the last reading
of the same epoch, `--prior-reading` or `--dispatched-at` is above `--reading`, or `--reading` went to a meter that
reads its own source (Claude Code journals, the estimate). Exit 2; nothing changed.

**Fix.** Pass the counter the run started with (the BUDGET line names meter, unit and epoch).
A different meter opens a new epoch that keeps prior usage:
`gstack-ship-budget resume --run <id> --meter <m>`.

<a id="budget-meter-unavailable"></a>
### `gstack-ship-budget: ... (BUDGET_METER_UNAVAILABLE)`

**Meaning.** A cap is set and no meter is readable: no `--reading`, no bound Claude Code
session, no `--meter estimate`; or a `--session`/`--nonce` matched zero or several journals.
The line names what it tried. Exit 2.

**Fix.** Capy: `--reading <n>`. Claude Code: `--session <id>`, or echo the nonce the line prints
once and rerun with `--nonce <value>`. Elsewhere, with the owner's consent, `--meter estimate`.

<a id="budget-ledger-invalid"></a>
### `gstack-ship-budget: ... (BUDGET_LEDGER_INVALID)`

**Meaning.** The ledger (`<state root>/ship-runs/<run>/budget.json`), the record's
gstack-budget block, a handoff brief's block or a checkpoint is missing, unparseable, from
another schema version, or not bound to the run (identity or sha256 mismatch). The line names
the path, the schema version and the parse location. Exit 2.

**Fix.** After a machine change, `gstack-ship-budget resume --run <id>` restores the ledger and
record from the Drive checkpoint. Otherwise rebuild:
`resume --record <path> --rebuild-from-record --reading <n>`; open reservations are charged as unknown.

<a id="budget-check-skipped"></a>
### `gstack-review-log: ... (BUDGET_CHECK_SKIPPED)` / `gstack-ship-budget: ... role=<r> step=<s> started=<t> spend=unknown (BUDGET_CHECK_SKIPPED)`

**Meaning.** Under a cap, `gstack-review-log --start` got no reservation id, an id from another run
or a step reservation (mismatched), or an id already used (one-shot); it refused before the
dispatch (exit 1, nothing captured). From `close`: a review-log row of this run had no
reservation before it started; one line per dispatch, and the run ends status=incomplete (exit 3).

**Fix.** Run `gstack-ship-budget check --run <id> --step <s> --next dispatch:<roles>` before the
batch and pass the printed id once with `--reservation`. A reservation is never created after the
fact: the owner accepts the unreserved spend with `close --approved-by <who> --words "<their words>"`
or the dispatches rerun under reservations.

<a id="handoff-pin-moved"></a>
### `gstack-ship-budget: ... (HANDOFF_PIN_MOVED)`

**Meaning.** `verify-handoff` found the brief no longer matches its tree: HEAD, the merge base
with the base ref, the working-tree fingerprint (`gstack-wtree`) or the reviewed tree moved, or the
brief's sha256 is not the one the parent recorded. Each line names the pin with its expected
and actual value. Main moving alone keeps the merge base and never refuses. Exit 3; the child
wrote its return with status=refused.

**Fix.** The parent reconciles the refusal and regenerates the handoff at the current tree
(`gstack-ship-budget handoff ...`) or stops. The reconcile stops the run (`reason=child_refused`): every check refuses until a regenerated child reconciles complete or the owner runs `gstack-ship-budget resume`.

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

<a id="browse-no-active-page"></a>
### `No active page. Use "browse goto <url>" first.` (after the last tab was closed outside browse)

**Meaning.** When every tab was closed outside browse (the headed window's tabs
closed by hand, or a page that closed itself), earlier releases failed every
later command this way, `status` and `stop` included, until the daemon was
killed (#3167). Now `status` and `stop` answer without opening a tab, and any
other command opens one new blank tab first and prints
`[browse] warning: every tab was closed outside browse, so this command ran on a new blank tab; open your page again with: browse goto <url>`.

**Fix.** `browse goto <url>` to open your page again.

**Fixed in.** The first release after v1.91.101.0 (#3167).

<a id="browse-tab-unrecoverable"></a>
### ``browse: every tab was closed outside browse and a new one could not be opened, because the browser or its context is gone (<cause>); fix: run `browse restart` ... (BROWSE_TAB_UNRECOVERABLE)``

**Meaning.** Every tab was closed outside browse and the browser, or its
context, is gone too, so browse could not open a tab to run the command.
`browse status` and `browse stop` still answer.

**Fix.** `browse restart` (`$B restart` inside a gstack skill), then run the
command again.

**Fixed in.** The first release after v1.91.101.0 (#3167).

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

<a id="setup-ps1-unexpected-eof"></a>
### `setup: -c: line 1: unexpected EOF while looking for matching '"'` / `setup: -c: line 2: syntax error: unexpected end of file` from `.\setup.ps1`

**Meaning.** Windows PowerShell 5.1 (`powershell.exe`, the default PowerShell
on Windows) passes arguments to native programs the legacy way and strips
the double quotes inside them. Until the release that fixed #3130,
`setup.ps1` handed Git Bash a `bash -c` script with double quotes in it, so
bash read a broken script and nothing was installed. PowerShell 7.3 and newer
were not affected.

**Fix.** Update gstack (in Git Bash: `cd ~/.claude/skills/gstack && git pull
--ff-only`), then run `.\setup.ps1` again: its script no longer holds a
double quote. Until then, run `./setup` from Git Bash, or `.\setup.ps1` from
PowerShell 7 (`pwsh`).

<a id="setup-ps1-empty-argument"></a>
### `setup.ps1: argument N is empty; setup takes no empty arguments. Nothing was installed or changed. (SETUP_PS1_EMPTY_ARGUMENT; ...)`

**Meaning.** One of the arguments you gave `.\setup.ps1` is an empty string
(for example `''` or an unset variable such as `$hostName`). setup takes no
empty arguments, and the way `setup.ps1` hands arguments to Git Bash under
Windows PowerShell 5.1 cannot carry one, so it refuses before running
anything.

**Fix.** Drop the empty argument, or give it a value:

```powershell
.\setup.ps1 --host codex
```

---

<a id="chromium-install-exit-127"></a>
### `Chromium bootstrap: chromium-install — <bun> x playwright install chromium exited 127 (command not found); install Bun from bun.sh (winget Bun ships no bunx), or skip with ./setup --no-browser (Git Bash) or .\setup.ps1 --no-browser (PowerShell)`

**Meaning.** setup (or `bin/gstack-browser-ensure`, as `BROWSER_UNAVAILABLE
<bun> x playwright install chromium exited 127 (command not found)`) could
not run the Playwright installer: the shell found no command to run. Until
the release that fixed #3131, setup called `bunx`, which a Bun installed with
winget does not ship, and reported the failure as `exited 127 (offline,
proxy, or blocked download?)`. It now runs `bun x` through the Bun it
resolved, so exit 127 means that Bun itself, or a command it starts, is
missing. Skills that do not need a browser are installed either way.

**Fix.** Install Bun from https://bun.sh (it ships `bun` and `bunx`), then
run setup again. To install without the browser for now, in Git Bash:

```bash
./setup --no-browser
```

or in Windows PowerShell:

```powershell
.\setup.ps1 --no-browser
```

---

<a id="bash-unavailable"></a>
### `gstack: no Git Bash found to run gstack's bash scripts on Windows (tried ...); fix: ... (BASH_UNAVAILABLE)`

**Meaning.** Windows cannot run a shebang script, so gstack hands its bash
scripts (`gstack-wtree`, `gstack-slug`, the hooks' bins, `bash -c` commands in
regen and pregate selection manifests) to Git Bash. It looks in this order and
the message lists every candidate it tried with the reason it was rejected:

1. `GSTACK_GIT_BASH` (or the older name `GSTACK_BASH`; when both are set and
   differ, `GSTACK_GIT_BASH` wins and a one-line warning says so). A value
   that does not exist is refused, not skipped.
2. bash next to `git --exec-path` (finds scoop, per-user and portable Git).
3. `C:\Program Files\Git`, `C:\Program Files (x86)\Git`,
   `%LOCALAPPDATA%\Programs\Git` and scoop's `git\current`.
4. A `bash` on PATH, only when `uname -s` reports MSYS or MINGW. WSL's
   `bash.exe` in `System32` or `WindowsApps` is never used: it reads
   `C:\...` paths as Linux paths. A PATH bash that is neither (Cygwin, for
   example) is no longer used either.

Before #3197 these commands spawned the scripts directly, so `gstack-restamp`
refused with `cannot fingerprint the working tree ()` and `gstack-gate-diff`
and `gstack-evidence` silently dropped the fingerprint.

**Fix.** Install Git for Windows (`winget install --id Git.Git -e` in
PowerShell), or point gstack at your bash.exe for good. An `export` in Git Bash
reaches only that shell, so set it where Claude Code reads it:

- Windows PowerShell 5.1 or PowerShell 7, then restart Claude Code:

  ```powershell
  [Environment]::SetEnvironmentVariable('GSTACK_GIT_BASH', 'C:\Program Files\Git\bin\bash.exe', 'User')
  ```

- Or the `env` block of `~/.claude/settings.json`:

  ```json
  { "env": { "GSTACK_GIT_BASH": "C:/Program Files/Git/bin/bash.exe" } }
  ```

The hooks cache the bash they found in `<state root>/cache/windows-bash.json`
(keyed by `git.exe`'s path and modification time, rechecked before use); the
override is never cached.

**Expected result.** `gstack-restamp --dry-run` prints its diff and
`gstack-gate-diff` records a candidate ending in a tree id instead of
`+nowtree`.

<a id="gate-error-no-base"></a>
### `GATE_ERROR=no_base`

**Meaning.** `gstack-gate-diff` could not resolve the base it diffs against
(`GATE_ERROR=no_base ref=<ref> fix=<git command>` is its only stdout line,
exit 2). The ref is not a commit in this checkout: a shallow clone (CI's
default `fetch-depth: 1`), a remote branch never fetched
(`origin/main` with no `refs/remotes/origin/main`), or a `--commit` whose
first parent is missing from a shallow history. The tool never guesses a
base, because an empty diff against a wrong or absent base would read as "no
gate edits" and pass review. `gstack-diff-scope` prints `SCOPE_ERROR=no_base`
(all flags false, exit 2) for the same cause.

**Fix.** Run the command the line prints. It is built for this checkout:
`git fetch origin +<branch>:refs/remotes/origin/<branch>` for an unfetched
branch, `git fetch --unshallow origin <refspec>` or
`git fetch --deepen=50 origin` when the clone is shallow. In a workflow, check
out with `fetch-depth: 0` (or fetch the base explicitly) before the step that
runs `gstack-gate-diff` or `gstack-diff-scope`.

**Expected result.** `gstack-gate-diff <base>` prints `GATE_SUMMARY:` and
`gstack-diff-scope` prints its `SCOPE_*` flags without an error line.

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

<a id="memory-ingest-transcript-checkout"></a>
### `[memory-ingest] kept N transcript page(s) for <repo> on this machine: gbrain source <id> ...`

On a managed gbrain brain (0.60+), an import lands only in a source bound to a
checkout this host owns, so gstack binds each transcript source to its own
checkout, `<state root>/gbrain-transcript-sources/<id>/`, before importing.
The partition stays on this machine, unstamped, and imports on a later run when:

- **held by another owner**: the source is bound to another host or another
  directory. gstack never takes it over. Inspect it with
  `gbrain sources writer status --source <id> --json`; the owner releases it
  (`gbrain sources writer transfer prepare <id>` on the owning host) or you
  re-bind it here with `gbrain sources set-path <id> <checkout>`.
- **the state root is ephemeral** (`GSTACK_EPHEMERAL=1`): a binding would point
  at a directory that vanishes with the machine. Run with a durable root:
  `GSTACK_STATE_ROOT=<durable directory> gstack-memory-ingest --bulk`.
- **bound to gstack's checkout, but it is missing or not active**: restore the
  checkout from a backup of the state root, or follow `gbrain doctor --json`.
- **could not bind**: the message carries gbrain's refusal; inspect the source
  with the writer status command above.

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
unknown. So is a trial in a multi-case shard whose result records are named by
a display label rather than the case id, because no record can be attributed
to it (a one-case shard's records are its case's). Only the known sum is
shown. A train verdict's `ATTEMPT:` line reports the same as `cost=$<x> known
+ <n> of <m> case(s) cost unknown`, a bare `cost=$<x>` only when every case
in the train record is priced, and no cost at all when none is.

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

**Meaning.** The line does not declare the value as a version. When the
text goes through `gstack-post` from inside the repository, four-part versions
equal to the root `VERSION` or to a `## [x.y.z.w]` / `## vx.y.z.w` CHANGELOG.md heading are
exempt wherever they appear, so there the finding means the quad is not a
release of this repository (or the post ran outside the checkout).

**Fix.** Write it as `version: 1.2.3.4`, `"version": "..."` or `v1.2.3.4`.
MEDIUM findings do not block pushes.

<a id="redact-run-id-as-phone"></a>
### `pii.phone.e164` MEDIUM on a receipt token or a GitHub Actions run id

**Meaning.** An all-digit identifier reads as a phone number: a 12-hex receipt
sha that happens to be all digits (a `tree`, `head`, `gated_tree` or
`predecessor` value), or an 11-digit GitHub Actions run id written somewhere
`gstack-post` cannot tell from a number. `gstack-post` allowlists only the
exact tokens it finds in these positions:

- a 12-digit value right after `tree`, `gated_tree`, `head` or `predecessor`
  with `=` or a space (`tree=704992822996`, `tree 704992822996`);
- an 11-digit id inside an `/actions/runs/<id>` URL or as that link's text;
- an 11-digit id right after a run word on the same line, with an optional
  `:`, `#` or `=` between: `run`, `runs`, `screen`, `screens`, `gate`,
  `gates`, `backstop`, `bisect`, `rerun`, `dispatched`, `dispatch`,
  `failed`, `passed` (`failed 40269992077 | rerun passed 40287239206`,
  `gate 40323989742`, `run #19368712345`); a generic word such as `id`,
  `job`, `attempt` or `workflow` exempts nothing. This position is exempt in
  the scanner itself (`isCiRunIdentifier` in `lib/redact-patterns.ts`), so
  `gstack-approvals add`, `gstack-decision-trail` and the pregate secrets
  check accept it too, not only `gstack-post`. A national number written
  without its `+` right after a run word reads as a run id there; that is the
  accepted residual of the ruling that a run id is not a phone number;
- every 11-digit id chained after an allowlisted one through `, `, ` and `,
  ` & `, ` or ` or ` / `, optionally with a `(#1234)` between
  (`screen 40269992077 (#3434) and 40275443393 (#3453)`).

A bare 11-digit number with none of that context, a 10-digit national number
and an E.164 `+14155551234` still report, so the finding means the id stands
without a run word (`the id is 40269992077`, `40269992077 failed`) or follows
a word that is not one (`see 40323989742`).

Separately, the scanner skips a bare number that is exactly a power of two
from 2^30 through 2^49, one less than such a power, or one of eleven 32-bit
hash and PRNG constants (Knuth's multiplicative hash, the golden-ratio
constant, the glibc and Numerical Recipes LCGs, FNV-1a, MurmurHash2 and 3, the
MT19937 seeder and the largest 32-bit prime; `isNumericConstant` in
`lib/redact-patterns.ts`). Only the exact digits with no separator are exempt:
the same digits with a `+`, spaces, dashes, dots or parentheses still report.

**Fix.** Write the id next to a run word (`run 40269992077`) or as an
`/actions/runs/` link. For anything else, rerun with `--confirm <token>`
using the `TOKEN:` line the refusal printed; MEDIUM findings do not block
pushes.

<a id="gstack-post-pr-body-merge"></a>
### `gstack-post pr-body` kept sections the body file did not contain

**Meaning.** `pr-body` merges the file into the PR's current body by `## `
section instead of overwriting it: a section in the file replaces the
same-titled section (title compared case-insensitively), the
````gstack-ship-receipt```` block is a section of its own so a receipt
rewrite replaces only the receipt, sections the file does not rewrite stay in
place, new sections are appended after them, and a current body with no
`## ` headings is kept as the leading text. One stderr line names what was
replaced, kept and added (`gstack-post: pr-body merged by section: replaced
What changed; kept ship receipt, Why, Approvals; added Tests`). A body file
holding only its first section therefore no longer wipes the rest of the PR.
The redaction scan runs on the merged bytes, so a MEDIUM or HIGH finding can
come from a kept section; the `RULE:` line's `LINE:` is in the merged text.
When the current body cannot be read (`gh pr view --json body` fails) nothing
is posted, exit 3. When the current body holds a title the file rewrites more
than once (an earlier description pasted below a `---` under the new one, as
on gstack-evals#19), the file's section matches no single copy, so nothing is
posted, exit 64: `gstack-post: the PR's current body holds "What changed" more
than once, so the file's copy matches no single section; nothing was posted.
Rerun with --replace and the whole body`. Merging would replace one copy and
keep the stale other beside it.

**Fix.** Nothing, when the kept sections are wanted. To overwrite the whole
body with the file, rerun with `--replace`. To drop a section, post the body
with `--replace` or edit it on the host. For the duplicate-title refusal, write
the whole body you want (keep the earlier description under a title of its own,
such as `## Original description`, if it should stay) and post it with
`--replace`.

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

A filename with an `@` in the package@version style is not an address and
never reports: the part after the `@` is a version or tag (one dotless label
or a dotted version, never a domain name) followed by file extensions no
top-level domain uses, or a dotted all-digit version followed by
an extension that doubles as a top-level domain (`looksLikeAtFilename` in
`lib/redact-patterns.ts`). A file named after a real address, an address at an
all-digit domain and an address whose top-level domain doubles as a file
extension still report.

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

**Fix.** Reply with `rec` (alias `all`), with `rec except <tokens>`, with
`<id><option>` tokens (`d3b uc1a`), or with `as-is` (the plan as written). A
bare `yes` or `no` is ambiguous across multi-option items and is never guessed.

<a id="answer-by-required"></a>
### `ANSWER_BY_REQUIRED`

**Meaning.** `gstack-autoplan answer` ran in an unattended run without
`--by`, or with a value that is neither `human` nor `agent:<id>`. The
artifacts must say who answered a gate: an owner typing tokens and an agent
relaying or deciding them look identical in `decisions.jsonl` otherwise.
Nothing was applied.

**Fix.** Re-run with `--by human` when the owner typed the tokens, or
`--by agent:<thread or id>` when an agent relays or decides. The value is
recorded as `answered_by` on every decision row the reply answers and in the
review record's gate line.

## Queue-aware ship: policy, restamp, tree receipt, ship receipt

`gstack-ship-policy`, `gstack-restamp`, `gstack-tree-receipt`,
`gstack-ship-receipt` and `gstack-evidence bundle|ancestor` share the exit
table above and end each error line with a code in parentheses. The policy
file is described in [docs/ship-policy.md](ship-policy.md); the queue flow in
[docs/ship-policy.md#stamp-at-merge](ship-policy.md#stamp-at-merge).

<a id="policy-source-unavailable"></a>
### `policy source unavailable — fix: git fetch origin <base> --depth=1 (POLICY_SOURCE_UNAVAILABLE)`

**Meaning.** The policy is read from the committed copy on `origin/<base>`,
and that ref does not resolve here (a shallow or detached gate checkout, or a
fetch that never happened). The tool exits 3 and never falls back to the
working-tree file silently. For `gstack-pregate` the same refusal covers a base
`.gstack/pregate.json` git cannot read (a timeout, an oversized blob, a missing
or corrupt object) that `git ls-tree` cannot confirm is absent; it never falls
through to the user-owned file. It also refuses when Bun loaded a `.env` file
from the working directory (a bare `bun gstack-pregate`), since a branch could
then pick the user policy: run `gstack-pregate` directly or as
`bun --no-env-file`. `gstack-ship-queue ready` under a train policy fetches
`origin/<base>` first and refuses with this code, quoting git's error, when
that fetch fails. `gstack-restamp`'s `stamp_paths` stage refuses with it when
the diff that tells the base's added lines from the branch's own cannot run
(`cannot diff <since>..<base> for the stamp_paths stage (<git's first stderr
line>); nothing written`), since an empty diff would read as "the base added
nothing" and move the base's lines again.

**Fix.** `git fetch origin <base> --depth=1`, then rerun. To run against the
branch's own file deliberately, pass `--policy-from head --allow-repo-commands`;
the receipt then says `policy: head (unreviewed)`.

`--base` names a branch on `origin`. A commit SHA, a tag or another remote's
ref (`upstream/main` in a fork clone) never resolves as `origin/<base>`, and
fetching it cannot create that ref, so pass a branch that exists on `origin`
(`git branch -r --list 'origin/*'` lists them). `gstack-pregate` says so in
its fix instead of suggesting the fetch.

<a id="policy-invalid"></a>
### `POLICY_INVALID`

**Meaning.** `.gstack/ship-policy.json` has an unknown key, a wrong type or a
value outside its enum. The message names the key. Unknown keys are errors so
a typo never silently means "default".

**Fix.** `gstack-ship-policy validate` lists every problem;
`gstack-ship-policy init --explain` prints each key, its meaning and default.

<a id="policy-containment"></a>
### `POLICY_CONTAINMENT`

**Meaning.** A repo-controlled input escapes its box: an absolute path or a
`..` segment in `stamp_paths`, `release_outputs`, `changelog` or `mirror`; a
glob whose expansion passes 512 regex characters; more than 64 entries in a
list; a `release_tool` over 512 characters or holding a newline. At write time
the same code names a matched file that resolves through a symlink to outside
the repository.

**Fix.** Keep paths repo-relative, globs short and lists small. A mirror may
start with `..` (a sibling checkout) but may not contain an interior `..`.

<a id="policy-exists"></a>
### `POLICY_EXISTS`

**Meaning.** `gstack-ship-policy init` found an existing policy file and wrote
nothing.

**Fix.** Edit the file, or pass `--force` to replace it with the example.

<a id="repo-commands-not-allowed"></a>
### `repo commands not executed (pass --allow-repo-commands) (REPO_COMMANDS_NOT_ALLOWED)`

**Meaning.** The policy declares a command (`release_tool`), and the tool was
run standalone. File presence never authorizes execution: outside `/ship` and
`/land-and-deploy` a repo-declared command runs only with
`--allow-repo-commands`. The commands were listed and nothing was written.

**Fix.** Pass `--allow-repo-commands` when you mean to execute the repo's
code (you already do when you run its tests), or drop the release tool.

<a id="queue-stale"></a>
### `QUEUE_STALE`

**Meaning.** `gstack-restamp` was told the base SHA (`--expect-base`) or the
merge order (`--expect-order`) the allocation assumed, and one of them moved:
the base advanced, a predecessor is not merged, or a successor merged first.
`--expect-order` lists the lane's own PR (`--pr`) first, then the remaining
order; a list that leaves it out reads every entry as an unmerged predecessor,
and the message says so. The JSON result carries `expected`, `actual` and
`recompute`.

**Fix.** Run the printed `recompute` command: it carries the corrected order
(this PR first, merged PRs dropped, an unmerged predecessor kept ahead because
it must merge first) and recomputes the version from the current base; then
merge with the server-side head condition (`MERGE_CONDITION: sha=<head>`). A
predecessor GitHub calls merged that the local base does not carry yet
(`#<pr>=merged-not-in-base`) is kept ahead too, with `fix: git fetch origin
<base>`: fetch, then rerun, so the recompute, pinned to that local base, never
allocates the version the predecessor already took.

<a id="restamp-version-source"></a>
### `RESTAMP_VERSION_SOURCE`

**Meaning.** The configured version source (`VERSION`, `.gstack/version-path`)
is absent, ambiguous or broken at the base revision or on the branch, so there
is no version to bump from.

**Fix.** Create `VERSION` or pin the manifest path in `.gstack/version-path`
on the base branch. gstack never substitutes `0.0.0.0`.

<a id="restamp-merge-conflict"></a>
### `RESTAMP_MERGE_CONFLICT`

**Meaning.** `--after <pr>` builds the merge of the branch and the
predecessor's head in a throwaway worktree, and that merge conflicts. The
branch is untouched.

**Fix.** Merge the predecessor (or the base once it merges) into the branch
under `/ship` Step 3's conflict rules, then run `--after` again.

<a id="restamp-release-tool-failed"></a>
### `RESTAMP_RELEASE_TOOL_FAILED`

**Meaning.** The policy's `release_tool` exited non-zero inside the staging
worktree. The branch was not written; the journal records the stage.

**Fix.** Run the tool by hand in the repo, fix it, then rerun `gstack-restamp`.

<a id="restamp-output-outside-allowed"></a>
### `RESTAMP_OUTPUT_OUTSIDE_ALLOWED`

**Meaning.** The release tool changed a path outside its allowed-output set
(the version files, lockfiles, the CHANGELOG, `stamp_paths` and
`release_outputs`). The restamp refused before writing anything to the branch.

**Fix.** Add the path to `release_outputs` on the base branch when it is a
legitimate generated output, or stop the tool from writing it.

<a id="restamp-conflict"></a>
### `RESTAMP_CONFLICT`

**Meaning.** While applying or rolling back, a file no longer held the bytes
the journal recorded (someone edited it after the stage ran). Overwriting it
would lose that edit, so the restamp stopped.

`cannot fingerprint the working tree (<detail>); nothing written` is the same
code before anything was staged: `gstack-wtree exited <n>: <reason>` carries
the helper's own repair (for example a writable `TMPDIR`), and
`gstack-wtree could not start: ...` is the Windows bash lookup failing (see
[`BASH_UNAVAILABLE`](#bash-unavailable)).

**Fix.** Read `.gstack/tmp/restamp-journal.json`, reconcile the named file by
hand, then rerun `gstack-restamp` (idempotent: a complete stamp is a no-op).

<a id="restamp-predecessor-moved"></a>
### `PREDECESSOR MOVED <old> -> <new> — fix: gstack-restamp --after <pr> again (RESTAMP_PREDECESSOR_MOVED)`

**Meaning.** The gate ran on a synthetic tree built against a predecessor
head that is no longer that PR's head, so the gated tree is not the tree that
will merge. The receipt refuses `gate-reuse: eligible`.

**Fix.** `gstack-restamp --after <pr>` again, gate the new synthetic tree, and
read the receipt again.

<a id="changelog-duplicate-heading"></a>
### `CHANGELOG_DUPLICATE_HEADING`

**Meaning.** Two sections share one version heading, usually a stamp that
re-headed `[Unreleased]` beside an entry that already carried the version.
In `gstack-restamp` only duplicates the PR introduces count: the headings are
compared against the base branch's CHANGELOG as read at `origin/<base>` and at
the commit the branch's own lines are counted from (its fork point, or the
predecessor's head in a gate-ahead stamp); the larger count per heading wins,
so a version the base already heads twice (released history the PR inherited
and must keep) passes as long as the PR adds no further copy of it. When a
reading is unavailable (the PR adds the CHANGELOG itself, or the file moved),
the stage detail and the refusal name it: with no reading left every duplicate
counts, otherwise inherited headings are counted at the readable commit only. Two paths keep the strict rule: the section being re-headed itself
(`[Unreleased]`, or the branch's earlier stamp) may exist only once, and
`gstack-version-bump write --changelog` (the claim-at-open bump) compares the
file with itself.

**Fix.** Merge the duplicate sections the PR introduced into one entry under
the new version. A duplicate that is on the base branch itself is not this
PR's to fix in a restamp; leave it and the stamp proceeds.

<a id="changelog-top-mismatch"></a>
### `CHANGELOG_TOP_MISMATCH`

**Meaning.** After the stamp, the first entry's heading is not the version in
`VERSION`.

**Fix.** `gstack-restamp` moves the PR's section to the top; if a hand edit
undid that, fix the heading or rerun the restamp.

<a id="changelog-section-missing"></a>
### `CHANGELOG_SECTION_MISSING`

**Meaning.** The CHANGELOG has neither an `[Unreleased]` section nor one
headed by the version currently stamped on the branch, so there is nothing to
re-head.

**Fix.** Under stamp-at-merge, write the PR's entry under `## [Unreleased]`;
the restamp turns it into `## [<version>] - <date>`.

<a id="gate-reuse-not-eligible"></a>
### `gate-reuse: not-eligible (<what changed>) — fix: <rerun command> (GATE_REUSE_NOT_ELIGIBLE)`

**Meaning.** Tree identity alone is not gate evidence. The receipt compares
the gated identity (tree modulo stamps, runtime pins, lockfile hash, CI
workflow hashes, gate command hash, executed selection, runner image) with the
current one and names what differs, or the stamp-sensitive gates that must
rerun on the final tree.

**Fix.** Rerun the named lanes with the printed command on the stamped tree,
or pass `--force-gate <reason>` in `/ship` to run the full gate again.

<a id="evidence-identity-unknown"></a>
### `EVIDENCE_IDENTITY_UNKNOWN`

**Meaning.** The bundle (or ledger record) lacks a committed tree id, runtime
versions, lockfile hashes or the command hash, so no reuse decision can rest on
it. Imported assertions without verification count as unknown too.

**Fix.** Rebuild the bundle on the gate machine after the lanes ran on a
committed head: `gstack-evidence bundle --out <file> --label <lane>...`.

<a id="evidence-bundle-invalid"></a>
### `EVIDENCE_BUNDLE_INVALID`

**Meaning.** The bundle is not valid JSON or not `gstack-evidence-bundle` v1.

**Fix.** Rebuild it with `gstack-evidence bundle`; a bundle is never hand-edited.

<a id="preregistration-not-ancestor"></a>
### `PREREGISTRATION_NOT_ANCESTOR`

**Meaning.** A `preregistration_shas` entry in the policy is not an ancestor
of HEAD, so the preregistered eval does not describe this branch.

**Fix.** Merge or rebase so the commit is in the branch history, or remove the
entry on the base branch. `gstack-evidence ancestor <sha>...` prints one line
per entry; the ship receipt records the result.

<a id="history-policy-violation"></a>
### `HISTORY_POLICY_VIOLATION`

**Meaning.** The policy says `history: merge-only` and the plan would squash,
rebase or otherwise rewrite the branch: `gstack-ship-policy check-history
--plan squash|rebase` refuses (exit 3) before anything moves, and without
`--plan` it reports the violation (exit 1) when the pushed branch is no longer
an ancestor of HEAD.

**Fix.** `git merge origin/<base>` and keep every commit; merge the PR with a
merge commit.

<a id="receipt-missing"></a>
### `RECEIPT_MISSING`

**Meaning.** `gstack-ship-receipt read --pr <n>` found no
```` ```gstack-ship-receipt ```` block in the PR body.

**Fix.** `/ship` Step 18 writes it (`gstack-ship-receipt write ... --pr <n>`);
for an older PR, write it once by hand with the same command.

<a id="receipt-invalid"></a>
### `RECEIPT_INVALID`

**Meaning.** The block exists but does not validate against the `ship-receipt`
schema (`gstack-artifact schema ship-receipt`). `gstack-ship-receipt write`
also refuses with this code, and writes nothing, when `--head` is not the
checked-out HEAD: the receipt binds the tree the review read.

**Fix.** Regenerate it with `gstack-ship-receipt write`; never hand-edit the
block. For the `--head` refusal, check out that commit and write there.
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

## Pre-gate: generated-file registry, gstack-pregate, issue links

Both tools read their pin file (`.gstack/generated.json`, `.gstack/pregate.json`)
from `origin/<base>`, never the working tree, and run repo-declared commands only
under `--allow-repo-commands` or inside `/ship`. When the base carries no
`.gstack/pregate.json`, `gstack-pregate run` reads
`<state root>/projects/<slug>/pregate.json` instead (outside the repository; see
docs/pregate.md for the state root and slug).
Details: docs/pregate.md.

<a id="regen-registry-invalid"></a>
### `REGEN_REGISTRY_INVALID`

**Meaning.** `.gstack/generated.json` is not valid JSON, has an unknown key, a
missing `id`/`inputs`/`outputs`, or a duplicate id.

**Fix.** `gstack-regen validate` prints every error with its JSON path; compare
with `gstack-regen init --explain` and fix the file on the base branch.

<a id="regen-containment"></a>
### `REGEN_CONTAINMENT`

**Meaning.** A registry glob escapes the repository (`..`, absolute, more than 64
per list) or a command is not one line under 512 bytes.

**Fix.** Repo-relative globs only; one line per command.

<a id="regen-stale"></a>
### `REGEN_STALE`

**Meaning.** A registered output differs from what its command produces in a
scratch `git worktree` of the current tree: the output is stale or hand-edited.

**Fix.** Run the printed command (`gstack-regen write --only <id>` does it in
place) and commit the outputs. Never hand-merge a generated file: on a conflict
take either side, then regenerate.

<a id="regen-command-failed"></a>
### `REGEN_COMMAND_FAILED`

**Meaning.** A registered command exited non-zero in the scratch worktree.

**Fix.** Run it by hand in the repository and read its output; the scratch
worktree has no `node_modules` of its own, so a command that needs them must
reference the repository's (gstack's entries do through `bun run`).

<a id="regen-deps-missing"></a>
### `REGEN_DEPS_MISSING`

**Meaning.** A registered command exited 0 and its outputs differ from the
committed ones, but `package.json` declares dependencies and the repository has
no `node_modules`, so the scratch worktree ran the generator without them. The
difference may come from the missing dependencies rather than stale files, so
the entry is reported as unverified, not `REGEN_STALE`.

**Fix.** Run the printed install command (`bun install`, or the one matching the
repository's lockfile), then rerun `gstack-regen check` or the pre-gate.

<a id="pregate-config-invalid"></a>
### `PREGATE_CONFIG_INVALID`

**Meaning.** `.gstack/pregate.json` has an unknown key, a wrong type, a glob
that escapes the repository, a runner without `{files}`, or `secrets` in `warn`.
The user-owned `<state root>/projects/<slug>/pregate.json` also refuses when it
sets `sealed` or `price_file` (both are read only from the base branch's copy)
or exists but cannot be read (a dangling symlink on its path counts).

**Fix.** `gstack-pregate validate`. `secrets` and required-lane obligations
cannot be downgraded; every other check id in `warn` is honoured only from the
base branch's copy or the user-owned file. For the user-owned file, edit it
directly at the path the message names. A user file inside the repository, or
reached through a symlink into it, is ignored rather than read (`--explain`
names it). An unknown `sealed` key that a newer gstack defines (such as
`allow_paths` or `case_insensitive`) means this machine's gstack is older than
the policy: upgrade gstack here, and raise `min_gstack_version` in the
repository's `.gstack/ship-policy.json` before landing such a key.

<a id="pregate-secrets"></a>
### `PREGATE_SECRETS`

**Meaning.** `gstack-redact` found a HIGH finding, or a MEDIUM finding in the
`secret` category, in the lines this branch adds.

**Fix.** Rotate the credential, remove it from the added lines (history
included), rerun. Not downgradable. A benign finding (a dummy token, a run id
read as a phone number, a vendor's public key) is named in the policy's
`allowlist` by finding id or non-secret category with a path glob or an
anchored pattern and a reason ([docs/pregate.md](pregate.md#allowlist));
`env.value`, the whole `secret` category and `engine.*` never.

<a id="pregate-strays"></a>
### `PREGATE_STRAYS`

**Meaning.** A file was added at the repository root, in a new top-level
directory, or under a scratch name (`zz-*`, `tmp*`, `scratch*`).

**Fix.** Delete or move it. An intentional root file goes in `strays.allow`.

<a id="pregate-literals"></a>
### `PREGATE_LITERALS`

**Meaning.** A changed exported constant (or a named timeout/retry literal) still
appears with its old value in a test file the branch did not update — nightly-
and Heavy-only files included.

**Fix.** Update every listed `file:line`, or keep the old value.

<a id="pregate-no-lane"></a>
### `PREGATE_NO_LANE`

**Meaning.** A touched source file maps to no test through static imports,
repo-path string literals, the `bin/<name>` → `test/<name>*.test.ts` convention
or a `dependencies` declaration (in a Django project, also the files Django
loads by name: settings strings, `include()`, app migrations, admin, templates
and static files). That is a failure, not a pass. Markdown no
test depends on is a docs/no-tests empty lane and is not this error, whether
or not the name says plan, evidence or redproof. A test that reads one of
those files (a quoted path or a `join()` of path segments) still selects that
test. An unmapped source or code file still fails. A file under a test
directory is not this empty lane. Images, fonts and media, and
allowlisted tool config no test names, are the assets-and-tool-config empty lane,
not this error.
A release manifest the branch only re-stamped is not this error either: when a
touched `*.json`, `*.plist`, `VERSION` or `VERSION.txt` file differs from the
merge base in nothing but its version values, `lanes` waives it as
version-stamp-only and prints `version-stamp-only (no lane needed): <files>`.
The exact per-kind rule (the document's top-level `version` in JSON of the
same shape and text, the two bundle version keys in a plist, one bare version
in a VERSION file) is in [docs/pregate.md](pregate.md#gstack-pregate). A
restamp PR on a base whose policy declares no lane for its manifests (gbrain's
`release:restamp` and its plugin manifests) therefore passes without a
policy change. A manifest whose description, keys, key order, nested
versions, line endings or any non-version byte changed, one under a test,
fixture, golden, `.gstack/` or workflow tree, or one added, deleted, renamed
or re-moded, is still this error; `--explain` prints `not version-stamp-only (<reason>)`
for it.
A test the branch removed is usually not this error either: a deleted or
renamed JS, TS, Python, Dart or bats test that nothing remaining imports prints
`removed (no lane owed): <path> — <why>` instead. It runs the tests of files
that still name it, and a deleted test runs its owning suite or says
`coverage removed: <file> has no remaining test`. These are still this error:
a removed test that remaining code imports or that a file with no test still
names, a deleted or renamed Go or Ruby test, a deleted test whose merge-base
text cannot be read (a symlink, invalid UTF-8, over 1 MiB), any other removed
path (a renamed source file's old name included), and a modified file whose
only test the branch deleted. `--explain` prints the reason as `<path>:
removed, but …` (`<path>: removed test whose merge-base text could not be
read …` for an unreadable deleted test).

**Fix.** Add a test that names the file, or declare its lane (an explicit `[]`
for files with no behaviour) under `dependencies` in `.gstack/pregate.json` (or the user-owned file the message names).
Other non-Markdown documentation goes in `empty_lanes` on the base branch.
Dart files under `integration_test/` or `test_driver/` need a device, so pregate
never runs them: declare `"**/integration_test/**": []` (and
`"**/test_driver/**": []`) under `dependencies` and let CI run them.
With no policy anywhere (no base copy, no user-owned file) an unmapped file is
the warning [`PREGATE_NO_POLICY`](#pregate-no-policy) with a starter policy
printed, not this error; `gstack-pregate init` writes that draft and lists the
files it could not place. `--explain` prints every mapping and why. For a file with no lane it also prints the import
specifiers in test files that resolved to no repo file (for example a
`tsconfig.json` `paths` alias such as `@/lib/x` whose target is missing) and any
`extends` hop that was not followed (only relative `extends`, at most 4 hops). If
a test does cover the file, declare it under `dependencies`; if the resolver
should have found it, report the specifier as a resolver gap.

<a id="pregate-no-lane-own-policy"></a>
**The branch adds the lane itself.** A branch that edits `.gstack/pregate.json`
to give its own new files a lane still gets this error: pregate reads the policy
from `origin/<base>` (or the user-owned file), never from the branch, so a
branch cannot loosen its own gate ([trust boundary](pregate.md#trust-boundary)).
That is intended, and pregate never switches to the branch's copy on its own.
The fix line then opens `this branch edits .gstack/pregate.json, but the policy
comes from origin/<base>@<sha>:.gstack/pregate.json so a branch cannot loosen
its own gate, and a lane it adds counts only once it is on <base>` and names the
two routes:

1. Land the policy change in its own PR first (the reviewed route), then merge
   the base into this branch and rerun.
2. Rerun with `--policy-from head --allow-repo-commands`. The run reads the
   branch's copy and its record says `policy head (unreviewed)`, so a
   reviewer sees that the gate ran under a policy nobody has reviewed yet;
   `gstack-ship-queue` never accepts a head-policy run as a remote mirror.

An allowlist entry the branch adds to its own `pregate.json` is read the same
way: it clears a finding only once it is on the base.

<a id="pregate-lane-failed"></a>
### `PREGATE_LANE_FAILED`

**Meaning.** A local lane the touched files select exited non-zero under
`set -o pipefail`, or reported zero tests (ZERO-RUN).

**Fix.** Read the printed lane log, fix the failure, rerun
`gstack-pregate --stage tests`. A `| tail`-hidden exit is still an exit.

<a id="pregate-incomplete"></a>
### `PREGATE_INCOMPLETE`

**Meaning.** A check timed out, a runner process was killed by a signal (out of
memory, an outside kill) and ended without an exit code, repo commands were not
allowed, no runner is declared or detected, or the working tree changed while
the check ran. Incomplete is never pass and blocks publication. A tool missing from PATH, a
network or quota error before any test ran, or a full disk is
[`PREGATE_ENVIRONMENT`](#pregate-environment) instead, so the machine's failure
reads apart from the diff's.

**Fix.** Pass `--allow-repo-commands`, commit the `pubspec.yaml` of a Dart
package the message says has none (or declare `runner`), raise `--timeout`, or
keep the tree still, then rerun. A runner killed by a signal never passes: read
the lane log, then rerun or split the selection. A tool missing from PATH is
[`PREGATE_ENVIRONMENT`](#pregate-environment), with its own fix.

<a id="pregate-stalled"></a>
### `PREGATE_STALLED`

**Meaning.** A test command the lanes check (or a guard, or the `--remote`
gate) launched wrote nothing to its log for the stall timeout (default 300 s,
`stall_timeout_s` in the base branch's `.gstack/pregate.json` or the user-owned file, or
`--stall-timeout`). pregate killed its process group and names the last test
file started. The check is incomplete, never pass.

**Fix.** Open the printed log, find the hang in the named file (a blocked
child, a server that never exits, a synchronous wait), fix it and rerun
`gstack-pregate --stage tests`. A test that is legitimately quiet for longer
needs a larger `--stall-timeout`; `0` disables the stall kill and leaves only
`--timeout`.

<a id="pregate-receipt-invalid"></a>
### `PREGATE_RECEIPT_INVALID`

**Meaning.** `gstack-pregate clear --remote pregate.json/remote_gate --receipt
<file>` read the remote gate's output and its `PREGATE_REMOTE:` line is missing,
names another tree than the one `pregate.json` tested, reports 0 tests, or
reports failures. The obligation stays uncleared. A run URL alone never clears
this obligation; a `test_backend/<backend>` obligation takes a run URL, recorded
as attested rather than validated.

Another tree is accepted in exactly one case: it differs from `pregate.json`'s
tree only in the repo's stamp rule (`.gstack/ship-policy.json` on the base
branch: `stamp_files`, `stamp_patterns`, the built-in version, manifest,
lockfile and CHANGELOG forms), judged by the tree receipt's own classifier on a
`git diff` of the two trees ([the gate ran ahead of the
stamp](pregate.md#remote-gate-stamp-only)). The refusal line then says `and the
trees differ beyond the stamp rule of <policy>: <path> (<rule>: <why>, line
<n>)`, and the path it names is the one that is not a stamp: a file outside
`stamp_files`, or a stamp file with a hunk that is not the old → new rewrite.
`the gated tree <t> is not an object in this repository` means the gated
commit is not fetched here, so the two trees cannot be compared. Three more
refusals close the substitution without classifying anything: `lists the test
lane as stamp-sensitive (stamp_sensitive_gates: tests)` (the base policy says
the test tier reads the stamps, as gstack's own does, so no run on another tree
covers this one; rerun the gate on the head), `pregate.json was recorded against
origin/<a>, not this repository's base origin/<b>` (rerun `gstack-pregate --base
<b>`, or `git remote set-head origin <a>` when `origin/HEAD` was unset), and
`.gstack/ship-policy.json on origin/<base>@<sha> is invalid` or `could not be
read` (fix the policy on the base, or fetch it).

**Fix.** Run the remote gate on the tree pregate tested and pass its output
file with `--receipt`, or let `gstack-pregate --stage tests --remote --spend-cap
<usd> --allow-repo-commands` run and validate it. For a gate-ahead receipt:
fetch the gated commit (`git fetch origin <sha>`) and clear again, or make the
named path a stamp under the repo's rule; a receipt is never accepted while any
differing path is a change.

<a id="pregate-no-policy"></a>
### `PREGATE_NO_POLICY`

**Meaning.** The repository has no pregate policy yet (no `.gstack/pregate.json`
on the base branch and no user-owned `<state root>/projects/<slug>/pregate.json`)
and a touched file maps to no test lane. Under no policy that is a `warn`, not
`PREGATE_NO_LANE`: the selected tests still ran (a red lane is still `fail`),
and the table printed a starter policy drafted from the repository
(`PREGATE_STARTER:` lines: runner, test directories, CI lanes, the JSON between
`begin` and `end`, a `TODO` per file nothing covers). `run` wrote nothing.
Details: [docs/pregate.md](pregate.md#no-policy).

**Fix.** Review the starter, write it with `gstack-pregate init` (it refuses to
overwrite an existing file without `--force`), edit each `TODO` (a test that
names the file, a `dependencies` entry, or `[]` for a file with no behaviour),
run `gstack-pregate validate`, then commit `.gstack/pregate.json` on the base
branch. From then on an unmapped file is `PREGATE_NO_LANE`.

<a id="pregate-environment"></a>
### `PREGATE_ENVIRONMENT`

**Meaning.** A check could not run its command because of the machine, not the
diff: a runner or guard binary missing from PATH (exit 127, `command not
found`, a tool `not on PATH`), a network error or a quota refusal before any
test was counted, a full disk, an unverified runtime, or gstack's own scanner
not finishing. The check is `incomplete` (never pass) with `cause:
"environment"` and `environment: { kind, evidence, proof }` in `pregate.json`,
and the table prints `environment: <kind> — <evidence>`. A test that failed and
whose log also names a connection error is **not** this code: the runner's own
summary counted a failure, so it is `PREGATE_LANE_FAILED` with `cause:
"diff"`; nor is a runner, guard or gate script whose own binary is present but
exits 127. `proof: "launch"` is certain (the command could not start, its
binary is off PATH, the runtime or a gstack tool refused); `proof: "output"`
means a rule matched the command's text before any test was counted, which the
diff's own output could have written, so the line says `(inferred from output)`
and the fix asks for confirmation elsewhere. Kinds and the rule:
[docs/pregate.md](pregate.md#environment).

**Fix.** Repair what the `environment:` line names on this machine (install the
tool, restore the network or the quota, free the disk, repair the runtime), or
run the lane where it can run: `gstack-pregate --stage tests --remote
--spend-cap <usd> --allow-repo-commands`, or the CI job and `gstack-pregate
clear --remote <workflow.yml/job> --run-url <url>`. A lane that waives the run
cites the kind, the evidence and the proof, never a test name; `verify` prints
`PREGATE_ENVIRONMENT: <n> check(s) blocked by the environment (<kinds>), not by
the diff`, naming any check inferred from output alone, so a coordinator can
tell the two apart and knows which to confirm elsewhere first.

<a id="pregate-stale"></a>
### `PREGATE_STALE`

**Meaning.** `pregate.json` was recorded against a different working-tree
fingerprint than the one being published (the final stamp, a regen, any edit),
or the user-owned policy it ran under was edited or deleted (or one appeared,
or a symlink on its path started pointing nowhere, after a run under the
defaults).

**Fix.** Rerun `gstack-pregate` after the final generation and stamp; Step 18
refuses to write the ship receipt otherwise.

<a id="pregate-remote-uncleared"></a>
### `PREGATE_REMOTE_UNCLEARED`

**Meaning.** A `requires-remote` obligation (a platform lane this machine cannot
run, named by `workflow.yml/job`, or the small-machine `pregate.json/remote_gate`
tier) has no receipt; or a `remote_gate` receipt accepted from a stamp-only
predecessor tree records `accepted_for` as a tree other than `pregate.json`'s,
or a `gated_tree` other than its receipt string's `tree=` (the file was edited
after `clear`), so it clears nothing here.

**Fix.** Dispatch that job, then
`gstack-pregate clear --remote <workflow.yml/job> --run-url <url>` (or
`--bundle-lane <label>` from an evidence bundle). For `pregate.json/remote_gate`,
`clear --remote pregate.json/remote_gate --receipt <gate output>`: the gate's
own run on this tree, or a run on a predecessor tree that differs only by the
repo's stamp rule ([gate ahead of the stamp](pregate.md#remote-gate-stamp-only));
`verify` then prints the accepted substitution on its ok line. The ship receipt
carries each obligation with its receipt.

<a id="issue-unreadable"></a>
### `ISSUE_UNREADABLE`

**Meaning.** An issue named by a `Fixes #N`/`Closes #N` trailer or `--issue N`
could not be read through `gstack-issue-guard`.

**Fix.** Check `gh auth status` and the number. Until it reads, the link is
rendered as `Refs #N`, never `Fixes`.

<a id="issue-lookup-failed"></a>
### `ISSUE_LOOKUP_FAILED`

**Meaning.** `gstack-issue-links` could not resolve the repository, list the open
PRs that close an issue this PR fixes, search the flake issues naming a
`--ci-run` id, or tell this PR's author: `gh` runs as an app (`…[bot]`) and
neither the HEAD commit (unpushed, or not linked to a GitHub user) nor a
user-owned repository names one, so the owner's own open PRs stay in the
`Related:` lines. The closure and reference lines are still printed; `--json`
lists each failure under `unavailable`.

**Fix.** Check `gh auth status`, pass `--repo <owner/repo>` when the remote
is not a GitHub repository and `--author <login>` when `gh` runs as an app,
then rerun. If it still fails, say in the handoff
which lookup is missing; never present the body as complete.

<a id="issue-links-missing"></a>
### `ISSUE_LINKS_MISSING`

**Meaning.** `gstack-ship-receipt write --issues @issues.json --body <file>`
found that the body lacks a `Fixes`, `Refs`, `Flake:`, `Related:`,
`Supersedes` or `Contributed by` line the issues object records, so the PR
body and its receipt would disagree. Nothing was written.

**Fix.** Paste every line `gstack-issue-links` printed under `## Issues` in the
body (or rerun `gstack-issue-links --out` if the issue set changed), then rerun
the receipt write.

## Eval plans, lane ownership, evidence verification, the owner brief

Codes printed by `bin/gstack-eval-plan`, `bin/gstack-lane-check`,
`gstack-evidence verify`, `bin/gstack-owner-brief`, `bin/gstack-contributor-mode`
and `bin/gstack-banned-terms` (plan E1–E3). Each ends an error line in
parentheses; grep the code.

<a id="prereg-incomplete"></a>
### `PREREG_INCOMPLETE`

**Meaning.** `gstack-eval-plan prereg --check <file>` found a required
preregistration section missing or empty: `## Bars`, `## Arms`, `## Decoys`,
`## Stop rules` or `## Held-out exposure` (every held-out set the plan
touches, its prior exposure and the reservation on it).

**Fix.** Fill the named sections before any priced call. A plan that cannot
name its stop rule or its held-out exposure is not preregistered; the pilot
refuses to start without a passing check.

<a id="eval-price-missing"></a>
### `EVAL_PRICE_MISSING`

**Meaning.** An arm's model has no row in `lib/pricing.ts`, so the admission
estimate would be `$0`, which the ledger would admit without limit.

**Fix.** Add the row from the provider's pricing page (USD per million tokens
with `as_of`), or drop the arm. The table prices standard text tokens only;
see the excluded billing categories in `lib/pricing.ts`.

<a id="eval-dry-run-failed"></a>
### `EVAL_DRY_RUN_FAILED`

**Meaning.** The `$0` stub-model dry run over the real input file found a
problem the priced run would have paid for: a row without the fields the
prompt needs, an output budget too small for a reasoning model, or no retry
prompt text.

**Fix.** Repair the named rows or flags (`--output-budget`, `--retry-prompt`)
and rerun `gstack-eval-plan dry-run`. The checklist it prints is the record
the pilot requires.

<a id="eval-arms-unresolved"></a>
### `EVAL_ARMS_UNRESOLVED`

**Meaning.** `gstack-models resolve --role eval-arms` produced no arm and the
repo policy document fallback (`--policy-doc`, default the first of
`docs/model-policy.md`, `MODEL_POLICY.md`, `docs/MODELS.md`) named no priced
model.

**Fix.** Pass `--arms <model,model>`, point `--policy-doc` at the document
that lists the project's allowed models, or fix the model policy config.

<a id="eval-budget-exhausted"></a>
### `EVAL_BUDGET_EXHAUSTED`

**Meaning.** The ledger refused the next reservation: spent + reserved +
unknown charges + the estimate exceeds the cap (`SPEND_CAP_EXCEEDED`
underneath). The run stops with status `budget_exhausted`; nothing is retried.

**Fix.** Read the spend table (`gstack-eval-plan pilot report`), settle or
release the open attempts, then raise `--cap` on purpose or stop.

<a id="lane-conflict"></a>
### `LANE_CONFLICT`

**Meaning.** `gstack-lane-check` found a planned file that an in-flight
branch or pull request already changes; the line names the PR number, the
branch and the hunk count.

**Fix.** Give the file one owner: wait for that PR to merge, stack this lane
on its branch, or drop the file from the plan. Two lanes editing one file is
the merge-conflict incident the check exists to prevent.

<a id="lane-ref-unavailable"></a>
### `LANE_REF_UNAVAILABLE`

**Meaning.** A `--branch` or `--pr` could not be resolved: the ref is not
fetched, or `gh` is missing or not logged in.

**Fix.** `git fetch origin <branch>`, or `gh auth status`. An unresolved lane
is reported as such and never counted as clear.

<a id="evidence-unverified"></a>
### `EVIDENCE_UNVERIFIED`

**Meaning.** `gstack-evidence verify <bundle>` could not verify a lane claim
on this machine: the committed tree differs from the bundle's, the recorded
log is absent or its hash differs, or the probe was not rerun.

**Fix.** Check out the bundle's commit and run `--rerun` to execute the lane
command here, or treat the claim as an imported assertion that never counts
toward gate reuse.

<a id="banned-term-found"></a>
### `BANNED_TERM_FOUND`

**Meaning.** The diff adds a term listed in `.gstack/banned-terms.json`
outside that term's `allowed_paths`. The finding names the term, the file and
line, and the allowed locations.

**Fix.** Remove the term from the added line or move the text to an allowed
path. `/review` and `/document-release` run this check on every diff.

<a id="banned-terms-invalid"></a>
### `BANNED_TERMS_INVALID`

**Meaning.** `.gstack/banned-terms.json` is not valid: `terms` must be a
non-empty list of strings, and each `allowed_paths` entry must be a plain
repo-relative glob (no `..`, no absolute path, no symlink escape).

**Fix.** `gstack-banned-terms init` writes a commented example with every key
at its default; `gstack-banned-terms validate` checks the file.

<a id="contributor-source-unavailable"></a>
### `CONTRIBUTOR_SOURCE_UNAVAILABLE`

**Meaning.** `gstack-contributor-mode detect` found no `maintainers` list in
`.gstack/ship-policy.json` and could not ask the collaborators API (`gh`
missing, not logged in, or no PR author resolvable), so the mode is off and
`source=off` is recorded.

**Fix.** Add `maintainers` to the ship policy (the explicit list always wins),
run `gh auth login`, or pass `--contributor` to force the mode for this review.

<a id="brief-input-missing"></a>
### `BRIEF_INPUT_MISSING`

**Meaning.** `gstack-owner-brief render --out <dir>` needs `gate.json`,
`decisions.jsonl` and `findings.jsonl` in the run directory; one is missing.

**Fix.** Reach the gate first (`gstack-autoplan next --out <dir>` until
`gate_pending`); the brief renders what the gate wrote.

<a id="draft-direction-unresolved"></a>
### `DRAFT_DIRECTION_UNRESOLVED`

**Meaning.** The phase-close rewrite found a `draft direction stands until the
owner decides` line whose decision id is still pending, so it was left as is.

**Fix.** Answer the gate for that id, then rerun `gstack-owner-brief close`;
only decided lines are rewritten, each to its chosen option and the date.

<a id="setup-crlf-repair"></a>
### `warning: left <n> locally edited file(s) with CRLF line endings that gstack pins to LF`

**Meaning.** Git for Windows checks out with `core.autocrlf=true`, so gstack's
nested shell scripts (skill `bin/` helpers, the Claude hook shims,
`lib/cso/images/*`, `scripts/app/*`) were written with CRLF until
`.gitattributes` pinned them to LF (#3110). Git Bash runs them anyway, but a
Linux bash reading the same checkout (a synced tree, WSL, a bind mount) fails
with `set: pipefail: invalid option name`, and a hook that fails that way
blocks the tool call it guards. Pulling the new rule does not fix existing
copies, because git never rewrites a file whose content did not change. Setup
finds those files with one `git ls-files --eol` pass and checks them out again
as LF. It leaves a file you edited locally alone and names it in this warning.
The same section covers `skipped the CRLF repair` (another setup held the
install registry lock) and `the CRLF repair could not rewrite every file`.

**Fix.** For edited files, stash and restore them; git writes them back with LF
and keeps your edits:

```bash
cd ~/.claude/skills/gstack && git stash && git stash pop
```

If the repair was skipped, re-run `./setup` once the other setup finishes. If
it failed, `git checkout -- . && ./setup` in the checkout discards local edits
and rewrites every file. Use your install directory if it is not
`~/.claude/skills/gstack` (`./setup --status` prints it). Expected result: the
next `./setup` prints no CRLF warning.

## Field wave lane CD: pregate guards, regate, sealed output

<a id="pregate-guard-failed"></a>
### `PREGATE_GUARD_FAILED`

**Meaning.** A guard (a repo command such as a serial-test manifest check or a
CLI golden test) from the base branch's `.gstack/pregate.json`, or from the
user-owned file when the base carries none, matched a
file the branch touched and exited non-zero. Guards cover what the import graph
cannot see: manifests, subprocess goldens, registries. They cannot be
downgraded to warn. A guard that could not start, or whose own binary is off
PATH (exit 127), is the machine's: `PREGATE_ENVIRONMENT` (`incomplete`), not
this code; a guard whose binary is present but whose script exits 127 is this
code.

**Fix.** Read the guard's lines in the table (exit code, output tail, log path)
and do what its `fix` line says, commit, then rerun
`gstack-pregate run --allow-repo-commands`. A lane reports done only after this
passes and carries the `PREGATE:` line in its handoff.

<a id="migration-collision"></a>
### `MIGRATION_COLLISION`

**Meaning.** `gstack-pregate regate` read `migrations` (`dir`, `id`) from the
base branch's `.gstack/ship-policy.json` and found a migration number this
branch adds that the base branch already has, or that another open PR adds
under a different file name. Both PRs would pass their own gates and the
second merge would break the schema order. When the open-PR lookup cannot
finish (`gh` missing or failing, 1000 open PRs, a PR whose file list GitHub
truncates and cannot be fetched in full) the line says
`MIGRATION_COLLISION: unknown (...)` and `REGATE: not-needed` is withheld.

**Fix.** Take the next free migration number when this PR is next to merge,
rename the file and its id, commit, then rerun
`gstack-pregate regate --against <gated-head> --bundle <file>`. The renamed
migration is a code change, so the gate reruns.

<a id="sealed-output-refused"></a>
### `SEALED_OUTPUT_REFUSED`

**Meaning.** The repo declares a `sealed` policy in `.gstack/pregate.json`
(base branch ∪ the pushed commit) and a commit this push publishes adds a
sealed path or transcript (binary, empty and later-deleted files included), or
adds a line with a sealed-answer marker, a seed or a local home path, and the
destination is public or its visibility is unknown (a new or unreadable
repository counts as public). An unreadable or malformed sealed policy refuses
too. The managed pre-push hook and `gstack-pregate sealed` print one line per
finding: rule, `file[:line]`, commit. They never print the matched text.

**Fix.** Remove the output from every published commit before the branch
reaches the public repository (a later commit that deletes it still publishes
it). A publishable file kept next to sealed data (a `MANIFEST.json` of hashes
and counts) can be exempted from the path rules with a `sealed.allow_paths`
glob in the base branch's `.gstack/pregate.json`; the text rules still read it
([docs/pregate.md#sealed](pregate.md#sealed)). A reviewed false positive gets
one line in the base branch's
`.gstack/sealed-allow.tsv`: `rule<TAB>path<TAB>sha<TAB>reason`, where `sha` is
the full commit sha (a shortened one is ignored and named on stderr). A private
destination sets `"visibility": "private"` under `sealed` in the base branch's
`.gstack/pregate.json`. Capy's pull-request tool may not run local hooks, so
run `gstack-pregate sealed` yourself before any push or PR creation.

<a id="eval-gate-unpriced"></a>
### `EVAL_GATE_UNPRICED`

**Meaning.** `gstack-eval-plan price-gate` found no call-plan file for the paid
gate: no `--plan-file`, no `price_file` in the base branch's
`.gstack/pregate.json`, or the file has no `GSTACK_EVAL_CALLS` lines. (A
declared `price_file` missing from HEAD is `EVAL_PLAN_STALE`, not this.) A gate whose cost is unknown cannot
be approved as priced.

**Fix.** The consuming repo commits a call-plan file in the format of
[docs/eval-calls.md](eval-calls.md) and names it in `price_file`. Only when the
owner accepts an unpriced gate, rerun with `--allow-unpriced "<reason>"`: it
exits 0, prints `GATE_UNPRICED_OVERRIDE: <reason> (owner-authorized override;
not authorization to spend)` and records the reason in the receipt.

<a id="eval-gate-over-cap"></a>
### `EVAL_GATE_OVER_CAP`

**Meaning.** The gate's priced total is above `--cap-usd`, or one call's
reservation (its share of the input plus `max_out_tokens`) is above `--cap-usd`,
or above `--smoke-cap-usd` for a `scope=smoke` row. A provider refuses a
reservation the cap cannot hold, so the run would fail after spending.

**Fix.** Cut questions, arms or `max_out_tokens` in the call plan and
regenerate it, or raise the cap deliberately with the owner. Never split calls
to slip under it.

<a id="eval-plan-stale"></a>
### `EVAL_PLAN_STALE`

**Meaning.** The call-plan file prices something other than what is being
approved: its `GSTACK_EVAL_GATE` command is not the exact `--gate` string, its
`GSTACK_EVAL_HEAD` is behind HEAD with files other than the plan file changed
since, an input's sha256 at HEAD differs from its `GSTACK_EVAL_INPUT` line, or
the base policy's `price_file` is not in the HEAD commit. `--allow-unpriced`
does not override it.

**Fix.** Regenerate the plan file at HEAD for the exact gate command (the
repo's own producer), commit it, and rerun `gstack-eval-plan price-gate`.

<a id="plan-sections-invalid"></a>
### `PLAN_SECTIONS_INVALID`

**Meaning.** `gstack-autoplan next` reviews only the plan's `## Implementation
plan` section and keeps the `## Review record` private, so the plan needs
exactly one non-empty Implementation plan section followed by one Review record
section, both outside code fences. A plan with neither heading is wrapped
automatically; one heading alone, duplicate or reversed headings, or an empty
section is refused before anything is written. The error names the problem.

**Fix.** Add the missing heading, or rerun the first `next` with `--scaffold`:
it writes `<out>/plan-source.md` with the missing heading added, reviews that
copy and prints `SCAFFOLDED:`. Your plan file is never edited. Duplicate,
reversed or empty sections are ambiguous and must be fixed by hand.

<a id="plan-amend-pending"></a>
### `PLAN_AMEND_PENDING`

**Meaning.** The owner accepted at least one plan change at the gate (each was
printed as an `APPLY:` line), and the run's plan has not absorbed it, so a rerun
would review the old plan. `next` refuses until every accepted change is
incorporated or withdrawn; `export` refuses a `complete` run with one pending.

**Fix.** Edit the plan, then `gstack-autoplan revise --out <dir> --plan <file>
--incorporates <decision id,...>`. `revise` binds each named id to the old and
new Implementation-plan hashes and refuses when the Implementation plan did
not change; an id you do not name stays pending. A packaging or ordering change
(its `APPLY:` line ends `no plan edit needed: revise --settle <id>`) is
discharged with `gstack-autoplan revise --out <dir> --settle <id>` and reopens
nothing. To drop an accepted change
instead, `gstack-autoplan revise --out <dir> --withdraw <decision id>` records
the withdrawal in the journal.

<a id="amendment-unknown"></a>
### `AMENDMENT_UNKNOWN`

**Meaning.** `gstack-autoplan revise --incorporates` or `--withdraw` named a
decision id that is not a pending amendment: the owner never accepted it as a
plan change at the gate (for example a gate answered before gstack recorded
amendments), or it was already incorporated or withdrawn. Nothing was changed.

**Fix.** Name only the ids the refusal lists after `pending:`. With none
pending, revise without `--incorporates`:
`gstack-autoplan revise --out <dir> --plan <file>`.

<a id="amendment-not-settleable"></a>
### `AMENDMENT_NOT_SETTLEABLE`

**Meaning.** `gstack-autoplan revise --settle <id>` discharges an accepted change
without a plan edit, which is honest only for a packaging or ordering change
(the gate item's `changes` is `packaging` or `ordering`) on the plan the run
already reviews: the plan the owner accepted it on, or one a later `revise`
recorded. The named change alters scope, cost or direction, names no `changes`
value, the plan file has edits no `revise` has recorded, or `--settle` came with
a `--plan` that changes the Implementation plan while incorporating nothing.
Nothing was changed.

**Fix.** Edit the plan, then
`gstack-autoplan revise --out <dir> --plan <file> --incorporates <decision id>`,
adding `--settle <id>` to settle packaging or ordering changes in the same call
(or settle them after the revise). The `APPLY:` line for each change says which
path it takes, and `NEXT:` lists the settle step first.

<a id="gate-rec-stale"></a>
### `GATE_REC_STALE`

**Meaning.** `gstack-autoplan recommend` changed a recommendation after the gate
was rendered, so a `rec` (or `all`) reply the owner gave to the earlier render
would take recommendations they never saw. Every render prints
`rec_hash=<h>`; once `recommend` has run, a `rec` answer must name the hash of
the render the owner answered. The same refusal meets a `rec`/`all` reply to a
gate written before `rec` existed (a `gate.json` with no `rec_rev`, from
1.91.101.0 or earlier): that render told the owner `all` leaves items
recommended `b` pending, and `all` now takes them.

**Fix.** Render again (`gstack-gate render <dir>/gate.json --all`), relay it,
and answer with `--rec-hash <h>` from that render. Explicit `<id><option>`
tokens are never refused.

<a id="checkpoint-invalid"></a>
### `CHECKPOINT_INVALID`

**Meaning.** `gstack-autoplan resume --out <dir> --from <checkpoint>` found no
generation it can restore: a `checkpoint.json` is unreadable or not a
schema_version 1 checkpoint, a listed file is missing, is not a regular file,
escapes the generation (an `..` path or a symlinked directory), or does not
match its recorded sha256; or the staged run does not pass
`gstack-artifact validate`. `--from` naming a run's collection restores the
newest generation that verifies, skipping corrupt newer ones; a root holding
several runs must name one. Nothing was written to `--out`.

**Fix.** `gstack-autoplan checkpoints --from <dir>` lists every generation
with `hash=ok` or `hash=bad (<reason>)`; restore an intact one by passing its
directory. With `GSTACK_AUTOPLAN_CHECKPOINT_DIR` set, every command that
leaves the run at rest publishes a new generation and keeps the previous one.

<a id="checkpoint-overlap"></a>
### `CHECKPOINT_OVERLAP`

**Meaning.** The checkpoint directory for this run and the run directory (or,
on restore, the checkpoint and `--out` or its staging directory) are the same
directory or one contains the other, after resolving symlinks. Copying one
into the other would replace or delete the live run, so nothing was touched.
A checkpoint refusal after a committed command prints `CHECKPOINT: failed …`
on stderr and leaves that command's exit code alone.

**Fix.** Point `GSTACK_AUTOPLAN_CHECKPOINT_DIR` (or `--from` / `--out`) at a
directory outside the run, for example the private project-user Drive folder.

<a id="checkpoint-target-exists"></a>
### `CHECKPOINT_TARGET_EXISTS`

**Meaning.** `resume --from` restores only into a missing or empty `--out`
directory, and this one already holds files.

**Fix.** Pass a new `--out` directory, or run `gstack-autoplan resume --out
<dir>` without `--from` to resume the run already there.

<a id="owner-reply-required"></a>
### `OWNER_REPLY_REQUIRED`

**Meaning.** An agent answered the gate (`--by agent:<id>`) without recording
what the owner actually said. Nothing was applied.

**Fix.** Pass the owner's words verbatim: `--owner-reply "<text>"`,
`--owner-reply -` to read them from stdin, or `--owner-reply-file <path>`. They
are stored on every decision row; when they parse under the gate grammar they
must resolve to the same choices as `--reply`.

<a id="gate-owner-reply-mismatch"></a>
### `GATE_OWNER_REPLY_MISMATCH`

**Meaning.** The owner's verbatim reply is itself a gate reply (for example
`rec`), and it resolves to different choices than the tokens the agent relayed.
Nothing was applied.

**Fix.** Relay what the owner chose; passing their reply as `--reply` is always
consistent. When the owner's words and your tokens disagree, ask the owner.

<a id="gstack-version-changed"></a>
### `GSTACK_VERSION_CHANGED`

**Meaning.** `run.json.gstack_version` names a different gstack than the one
running. For an older run (or one written before the field existed) this is a
notice: the command journals `gstack_version_changed`, runs the forward
migrations (for example rewriting decision ids minted before 1.91.95) and
continues. For a run written by a newer gstack the command refuses, because an
older runner cannot know the newer state.

**Fix.** Nothing for the notice. For the refusal, upgrade gstack
(`bin/gstack-upgrade`) on this machine and rerun the command.

<a id="artifact-gate-unsettled"></a>
### `ARTIFACT_GATE_UNSETTLED`

**Meaning.** `gstack-artifact validate` found a run whose status is `complete`
while an approval item of its last gate revision is still pending, or an
accepted plan change (`run.json.amendments`) is still pending. The runner never
writes that state; it comes from a hand edit or an older runner.

**Fix.** Answer the gate with `gstack-autoplan answer` until no approval is
pending, and `revise --incorporates` or `--withdraw` each pending amendment.

<a id="ios-launch-env-invalid"></a>
### `ios-qa launch: GSTACK_IOS_LAUNCH_ENV ... so the app was not launched (<detail>); fix: ... (IOS_LAUNCH_ENV_INVALID)`

**Meaning.** `gstack-ios-qa-daemon` forwards `GSTACK_IOS_LAUNCH_ENV` to
`xcrun devicectl device process launch --environment-variables` whenever it
launches the app under test. The value must be a JSON object whose keys are
environment variable names and whose values are strings, and it may not set a
`GSTACK_` variable (that namespace belongs to the debug bridge). Anything else
(invalid JSON, an array, a number value, a `GSTACK_` key) refuses the launch,
because launching without the variables an env-gated debug bridge needs would
look like a working app with no bridge. The detail names the key and its type,
never a value. Added in the release after v1.91.101.0.

**Fix.** In the shell that starts the daemon (macOS Terminal or Claude Code on
the Mac with the device):

```bash
export GSTACK_IOS_LAUNCH_ENV='{"DEBUG_BRIDGE":"1"}'
```

or `unset GSTACK_IOS_LAUNCH_ENV`, then restart `gstack-ios-qa-daemon`.

<a id="outside-voice-unavailable"></a>
### `Outside voice unavailable: <cause>. Fix: <fix>. Continuing to ... (OUTSIDE_VOICE_UNAVAILABLE)`

**Meaning.** `/plan-ceo-review`, `/plan-eng-review` or `/plan-devex-review` ran
without a second opinion. The outside provider (Codex, or Claude Code under the
Codex host) did not run or failed, and the native fallback could not supply a
bounded review either. That fallback dispatches the built-in Plan subagent in
the background next to a five-minute background timer, and stops whichever is
still running when the other ends. The cause names which part was missing:
`Plan agent type not offered`, `TaskStop not offered`, `background tasks
unavailable`, `no complete report within five minutes`, or a failed status.
The review-log row carries the same cause as `unavailable_reason`. Claude Code
2.1.277 removed the TaskOutput tool the fallback used before, so on older
gstack every native fallback on current Claude Code ended here.

**What is kept.** The native plan review itself is complete. The row is
recorded with `status: unavailable`, never as a clean review; a late or partial
reviewer result is not counted.

**Fix.** Repair the provider the line names: install it, or run `codex login`
(in your terminal or Git Bash). For the native fallback, run Claude Code 2.1.277
or later with background tasks enabled (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`
unset, not in bare mode). Then re-run the review.

**Expected result.** An `OUTSIDE VOICE (...)` report, or `CODEX SAYS (plan
review — outside voice)` when the provider runs.

<a id="artifact-machine-path"></a>
### `ARTIFACT_MACHINE_PATH`

**Meaning.** A public copy of an autoplan run still contains a path the run
recorded on this machine: its run directory, the home directory, the plan's
directory, the checkpoint directory or the worktree root. `gstack-artifact
validate --public <dir> --private <run>/run.json` reports each hit with
file:line; `gstack-autoplan export --public` runs that check on a staging copy
and writes nothing when it fails.

**Fix.** Export with `gstack-autoplan export --out <run> --public <dir>`, which
rewrites recorded roots to repo-relative paths or `<local notes (not
committed)>`. Export never rewrites inline code or fenced blocks in plan.md, so
a hit there needs a plan edit: change the path, `revise`, and export again.
Generic home-directory paths that are not recorded roots are WARN lines, not
errors.

<a id="artifact-public-target-exists"></a>
### `ARTIFACT_PUBLIC_TARGET_EXISTS`

**Meaning.** `gstack-autoplan export --public <dir>` found files in `<dir>`
that are not an earlier public copy of the same run, and refused to overwrite
them.

**Fix.** Pass an empty or new directory, or the directory that already holds
this run's public copy (it is replaced as a whole).

<a id="prereg-diagnostic-untested"></a>
### `PREREG_DIAGNOSTIC_UNTESTED`

**Meaning.** `gstack-eval-plan prereg --check <file> --allow-repo-commands` ran
the preregistration's declared summarizer (`## Diagnostics`: `summarizer:`,
`fixture:` and one `| diagnostic | expected |` row each) on its synthetic
fixture. Its result did not match the preregistered definitions: a count
differed (`mismatch`), a declared diagnostic was absent (`missing`), it
reported one nobody preregistered (`undeclared`), or the summarizer failed,
timed out, or did not end its stdout with one JSON object of counts. Each
`PREREG_DIAGNOSTIC:` line names one diagnostic. This is the gbrain-evals #162
(D7) shape, where two diagnostic counts needed a post-paid amendment.

**Fix.** Fix the summarizer, or correct the definition (the expected count or
the fixture), until every line says `ok`. Then commit the freeze. The
`PREREG_DIAGNOSTICS:` line's `sha256` binds the fixture you tested. Without
`--allow-repo-commands`, the command lists the summarizer
(`PREREG_COMMAND:`) and exits 3 (`REPO_COMMANDS_NOT_ALLOWED`), because the
summarizer is a repository command.

<a id="eval-models-invalid"></a>
### `EVAL_MODELS_INVALID`

**Meaning.** `.gstack/eval-models.json` could not be read or failed
validation. Causes include JSON errors, `schema_version` other than 1, a
missing or empty `allow`, an unknown key or scope, a glob in `families`, an id
in two families, or a family that lists gstack's current catalog model after an
older id. It also fires when `origin/<base>` cannot be resolved while a
working-tree copy exists. While the rules are invalid, no arm passes.

**Fix.** Correct the file as the line says (`docs/eval-models.md`) in a
reviewed PR, or fetch the base branch. To test an unmerged edit, use
`--models-from head`.

<a id="eval-model-denied"></a>
### `EVAL_MODEL_DENIED`

**Meaning.** An arm's model matched `deny` or its scope's `deny`, matched no
`allow` entry (unknown ids fail closed), or matched no entry of its scope's
`allow` list. The `EVAL_MODEL:` line names the rule.

**Fix.** Pick a model the rules allow for that scope. For a smoke run, pass
`--scope smoke` (`price-gate` uses each call row's scope). To change the rule,
edit `.gstack/eval-models.json` in a reviewed PR.

<a id="eval-model-old-generation"></a>
### `EVAL_MODEL_OLD_GENERATION`

**Meaning.** The rules declare `families` (newest first), and an arm uses an id
that is not the first one in its family.

**Fix.** Use the family's newest id, which the `EVAL_MODEL:` line names. If the
order is wrong, fix `families` in a reviewed PR.

<a id="eval-model-generation-unresolved"></a>
### `EVAL_MODEL_GENERATION_UNRESOLVED`

**Meaning.** The rules declare `families`, so every arm must be its family's
newest generation. This arm's model is in no family, so its generation cannot be
checked, and the arm fails instead of passing unchecked.

**Fix.** Add the model to its family (newest first) in
`.gstack/eval-models.json` in a reviewed PR, or use a model a family lists.

<a id="wtree-unavailable"></a>
### `gstack-pregate: cannot fingerprint the working tree: bin/gstack-wtree could not start (on Windows, no Git Bash was found) or it ran and failed (<detail>); fix: <fix> (WTREE_UNAVAILABLE)`

**Meaning.** `gstack-pregate` fingerprints the working tree with
`bin/gstack-wtree` before any check runs, and refuses (exit 3) when it cannot.
There are two causes, and the line says which:

- **It could not start.** On Windows no Git Bash was found to run the script.
  The detail lists every candidate tried with the reason it was rejected
  (`GSTACK_GIT_BASH (unset): not set; git --exec-path …; install path …;
  PATH bash: …`), in the order [`BASH_UNAVAILABLE`](#bash-unavailable)
  describes. On macOS or Linux it means `bin/gstack-wtree` is missing.
- **It ran and failed.** The detail is the script's own message, and the fix
  is the repair it printed, for example `set TMPDIR to a writable directory`.

Before this, both cases were reported as `policy source unavailable:
origin/<base> is not a resolvable commit` with `git fetch` as the fix, which
changed nothing.

**Fix.** Run the fix the line prints. For the Windows case, point gstack at
Git Bash's `bash.exe`, then rerun `gstack-pregate`:

- Git Bash (this shell only): `export GSTACK_GIT_BASH='C:/Program Files/Git/bin/bash.exe'`
- Windows PowerShell 5.1 or PowerShell 7 (this shell only):
  `$env:GSTACK_GIT_BASH = 'C:\Program Files\Git\bin\bash.exe'`

To set it for good (Claude Code reads it on its next start), follow the
recipes under [`BASH_UNAVAILABLE`](#bash-unavailable), or install Git for
Windows (`winget install --id Git.Git -e` in PowerShell).

**With `--json`.** Every refusal before a check runs (this one, an
unavailable base, an invalid pin file) is one JSON object on stdout,
`{"ok":false,"status":"refused","code":"WTREE_UNAVAILABLE","detail":"…","fix":"…","docs":"…#wtree-unavailable"}`,
with exit 3. A run's object carries the same `ok` and `status`
(`complete` or `incomplete`), so `status` tells a refusal from a run. The
`GSTACK_RESULT:` line goes to stderr under `--json`.

<a id="claude-md-skill-list"></a>
### `warn CLAUDE.md the gstack section in <file> lists <n> skills; Claude Code lists installed skills itself, and a pasted list goes stale with each release`

**Meaning.** `gstack-doctor` found a gstack section in `~/.claude/CLAUDE.md`
or in this project's `CLAUDE.md` that enumerates skills: an `Available
skills:` line, or eight or more `/skill` names. Older install prompts asked
for that list (#3169). Claude Code already lists every installed skill with
its description, and a pasted list goes stale with each release, so the agent
can take a partial list as the complete set.

**Fix.** Replace the section with the short block the doctor prints (no skill
list; keep any other gstack rules you wrote yourself):

```
## gstack
Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.
```

**Expected result.** The next `gstack-doctor` run shows
`ok CLAUDE.md no gstack section lists skills (...)`.
<a id="policy-gstack-too-old"></a>
### `POLICY_GSTACK_TOO_OLD`

**Meaning.** `.gstack/ship-policy.json` on the base branch sets
`min_gstack_version` above the gstack reading it. The policy uses keys this
gstack would read differently or not at all, so every ship-policy reader
(`gstack-restamp`, `gstack-tree-receipt`, `gstack-ship-queue`,
`gstack-ship-policy`) refuses it instead of guessing. A gstack older than
`min_gstack_version` itself sees that key as unknown and fails with
`POLICY_INVALID`, which names the key.

**Fix.** Upgrade gstack to the version the message names
(`bin/gstack-upgrade`, or rerun the session install), then rerun. A crew lead
raising `min_gstack_version` raises the crew's install floor at the same
time; `gstack-ship-policy validate` prints `MIN_READER:` for exactly that.

<a id="queue-not-ready"></a>
### `QUEUE_NOT_READY`

**Meaning.** `gstack-ship-queue ready` will not print a READY block the
coordinator could misread: the working tree has uncommitted tracked changes,
HEAD is not the PR's pushed head (read through `gh pr view`), CI at that
exact head is not green (failed, pending or unreadable), or the pregate result
is missing, failed or recorded on another tree (`PREGATE_STALE`). Under
`--dispatch-ci` it is also a dispatched workflow run that concluded red (a red
run clears no pregate lane) or a `gh workflow run` that failed. `train land`
uses it while a slot cannot merge yet: checks on the stamp commit are not
green, a name in `changelog_fragments.required_checks` is missing or not green
there, the PR's base is no longer the train's base, the stamp push failed while
the branch still read the pin, `gh pr merge` refused, or the merge is not yet
visible on main.

**Fix.** Commit and push, wait for CI on that head, rerun
`gstack-pregate run --allow-repo-commands` when the tree changed, then rerun
`gstack-ship-queue ready --pr <n>`. The block it prints before refusing shows
which line is not yet true. For `train land`, do what `NEXT:` says, then rerun
the same `train land` command; it adopts its own journaled stamp commit.

<a id="queue-proof-missing"></a>
### `QUEUE_PROOF_MISSING`

**Meaning.** A queue step lacks an input it needs to prove its claim, or an
input does not match: the gated head is not a commit here, HEAD differs from
the gated head beyond stamps (the gate never covered this tree), an earlier
stamp with other inputs is unfinished, the stamp journal's head moved, or a
gate-ahead merge could not be recomputed with `git merge-tree`. The train
commands use it too: `train forget` on a record that does not exist or on a
train still building, running or merging, `train watch` on an unknown record,
`verify --pr <n> --screen` on a run with no verdict to read (an INCOMPLETE or
unreadable run), `verify --pr <n> --train <nonce>` when main's tree mismatches
and whether a slot merged on GitHub cannot be read (so whether the queue must
freeze is unknown; it never answers "nothing merged" from an unreadable
state), `train land` when the base or the train branch cannot be fetched or
the record's T0 and S_1..S_k are not the gated head's first-parent chain
(each S_i's second parent slot i's pin), `train land` when main's tree is the
slot's S_i but GitHub does not report the PR as MERGED (a record whose slot
numbers or merged entries disagree with GitHub),
and `ready --screen` when the
scratch merge branch cannot be pushed. Nothing was written unless the `QUEUE_STAMP_REFUSED:` line says
`committed=yes`.

**Fix.** Supply the named input (fetch the gated head, pass the current base
sha), or regate the tree you mean to stamp. For an unfinished stamp, rerun the
identical command to resume, or revert its files and delete
`.gstack/tmp/ship-queue/stamp-<pr>.json`.

<a id="queue-stamp-not-stamp-only"></a>
### `QUEUE_STAMP_NOT_STAMP_ONLY`

**Meaning.** `gstack-ship-queue stamp` committed the stamp, and the tree
receipt between the gated head and the stamped head found a difference
outside the stamp rules (the residual paths are printed). The gate's result
does not cover that head. The refusal line says `committed=yes <sha>`.

**Fix.** Inspect the residual paths: drop the stray edit and stamp again, or
run the gate on the stamped head.

<a id="queue-verify-mismatch"></a>
### `QUEUE_VERIFY_MISMATCH`

**Meaning.** The coordinator's `gstack-ship-queue verify` could not
reproduce the lane's claim from the PR's pushed commits: the head moved, the
head differs from the gated tree beyond stamps, the receipt digest differs
from the one in `QUEUE_STAMP`, or, for a gate-ahead record, `git merge-tree
--write-tree` gives another merge tree, the recorded stamp patch does not
rebuild the recorded gated tree or changes more than stamps, or the
predecessor PR moved after the gate.

**Fix.** Do not merge. Ask the lane to rerun `gstack-ship-queue stamp` (or
`gate-ahead`) on the current queue and report again.

<a id="queue-gate-missing"></a>
### `QUEUE_GATE_MISSING`

**Meaning.** The ship policy sets `full_e2e: true`, and no passing full-gate
result is bound to the tree being stamped or verified: no recorded gate-ahead
attempt for that gated head, no `--gate-exit 0 --gate-log <file>` from a run
on it, or the recorded run exited non-zero. The train commands use it too: a
PR that is not in the train, a train without a green gate, `verify --train` on
a stamped train and `train land` on a plain one (each names the other).

**Fix.** Run the gate the policy's `gate_command` names in the gate-ahead
worktree and bind it with `gstack-ship-queue gate-ahead --record`, or pass the
exit code and log of a passing run on the gated head to `stamp`.

<a id="gate-ahead-attempt-invalid"></a>
### `GATE_AHEAD_ATTEMPT_INVALID`

**Meaning.** `gstack-ship-queue gate-ahead --record` could not bind the gate
result: the attempt id is unknown for that PR, the attempt already holds a
different result, the log file is missing, or the attempt's worktree no longer
holds the gated commit (its HEAD moved or a tracked file changed), so the
result would not describe the gated tree.

**Fix.** `gstack-ship-queue gate-ahead --list --pr <n>` shows every attempt
and the current one. Record the live attempt, or prepare a new one with
`gate-ahead --after <pr>` and run the gate there without editing tracked
files.

<a id="queue-train-off"></a>
### `QUEUE_TRAIN_OFF`

**Meaning.** A merge-train command (`train …` or `verify --train`) ran
against a base revision whose `.gstack/ship-policy.json` declares no `train`
block, so the train surface is off and the per-PR queue applies. Nothing was
written.

**Fix.** Use the per-PR queue (`ready --pr <n>`, `stamp`, `verify`), or land
a `train` block with `min_gstack_version` on the base branch first
([Run a merge train](ship-policy.md#run-a-merge-train)).

<a id="queue-train-untrusted"></a>
### `QUEUE_TRAIN_UNTRUSTED`

**Meaning.** A pinned PR's head repository is not the base repository. The
train branch and its dispatches run with repository secrets, so fork work
never rides a train. `ready --dispatch-ci` refuses a fork head for the same
reason and dispatches nothing, and `train land` refuses one and pushes nothing.

**Fix.** Run the printed `train build --prs <list without it>`; the fork PR
stays on the trusted-branch path.

<a id="changelog-fragment-invalid"></a>
### `CHANGELOG_FRAGMENT_INVALID`

**Meaning.** A CHANGELOG fragment under the policy's `changelog_fragments`
directory is not one regular `.md` file directly in that directory with entry
text, optional `bump:` front matter and no release heading, or it is over
64 KiB, or a fragment of that name already landed with other text. Nothing was
allocated or written. See [changelog fragments](ship-policy.md#changelog-fragments).

**Fix.** Rewrite the named fragment as a flat `<dir>/<slug>.md` holding only
the entry text (and optional `bump: minor|major` front matter); rename it if
the name already landed. Then rerun.

<a id="queue-land-locked"></a>
### `QUEUE_LAND_LOCKED`

**Meaning.** Another `gstack-ship-queue land` holds the repository land lock
(`refs/notes/gstack-land`), or took it from under this run, so this one would
race it for the next version. The line names the holder, its PR and phase.

**Fix.** Wait for the holder to finish. If it crashed, rerun with
`--break-lock`; that is refused while the holder entered a push or a merge
less than 10 minutes ago. A lock in phase `drift` is released by landing its
repair PR ([QUEUE_LAND_DRIFT](#queue-land-drift)).

<a id="queue-land-conflict"></a>
### `QUEUE_LAND_CONFLICT`

**Meaning.** The PR conflicts with the base branch in a product file (or a
release field that cannot be resolved alone, such as a real dependency
conflict in a manifest), so the merge step cannot stamp it. Nothing was
pushed.

**Fix.** The lane merges the base into the PR, resolves the named files, runs
/ship and reports READY again.

<a id="queue-land-drift"></a>
### `QUEUE_LAND_DRIFT`

**Meaning.** After the squash merge, the base branch's tree is not the
stamped tree on the base `land` stamped: a merge made outside `land` slipped
in between the last check and the merge. The lock stays held, in phase
`drift`, so no other land allocates on a release record that is now wrong.

**Fix.** Run `gstack-ship-queue land --pr <n> --repair`. It opens a PR whose
only change is a fragment for what the outside merge brought. Run /ship on it
and land it; that land takes over the lock and releases it. Then find what
merged outside `land`.

<a id="queue-land-base-busy"></a>
### `QUEUE_LAND_BASE_BUSY`

**Meaning.** The base branch moved during the stamp commit's CI on each of
the two allowed restamps, so `land` stopped instead of restamping again.

**Fix.** Find what is merging outside `land` (every merge should go through
it), then rerun `gstack-ship-queue land --pr <n>`; the lock was released and
the rerun restamps from the pin.

<a id="queue-train-stamp-mismatch"></a>
### `QUEUE_TRAIN_STAMP_MISMATCH`

**Meaning.** While building a stamped train (`changelog_fragments`), a prefix
S_i could not be stamped, or it is not the merge of S_(i-1) and its pin
modulo stamps, or it rewrote an earlier release entry, or it differs from the
plain prefix T_i outside release paths. Nothing was pushed or dispatched. See
[stamped trains](ship-policy.md#train-land).

**Fix.** Read the named slot and files. A stamp hook (`restamp_command`,
`release_tool`) that writes product files is fixed in the hook; an invalid
fragment goes back to its lane. Otherwise rebuild the train without that slot
and report it.

<a id="queue-train-moved"></a>
### `QUEUE_TRAIN_MOVED`

**Meaning.** A PR's head is no longer the SHA the train pinned (at build, or
past its pin beyond stamps at verify), so the train would not test what
merges. At verify after earlier slots merged, the queue also freezes
(`QUEUE_TRAIN_FROZEN`). At `train land` it is a PR head or branch that moved
off the pin (or off land's own stamp commit); land never overwrites it.

**Fix.** Ask the lane for a fresh READY on the new head, then build the train
with the new pin (`train build --prs <n>@<new sha>,…`).

<a id="queue-train-conflict"></a>
### `QUEUE_TRAIN_CONFLICT`

**Meaning.** Merging a PR onto the prefix before it conflicts outside the
version files and the CHANGELOG. From `train build`, the
`QUEUE_TRAIN_CONFLICT:` line names the PR, the conflicting files and the PRs
merged before it, and the check runs before the fill rule, so a filling train
finds it too. From `ready --no-screen`, the prefix is the base itself: the
`BASE_OVERLAP:` line names the files the base moved onto since the head
forked, and the train would stop at this PR (under `--screen` the same
conflict is `QUEUE_SCREEN_STALE_REF`). Nothing was dispatched and no branch
was pushed.

**Fix.** From `train build`, run the printed `train build --prs <list without
that PR>`. The PR's lane reports the conflict to the controller and, on its
word (crew template rule 14), merges main into the pin (with the earlier PRs
once they land), resolves, pushes, runs /ship and reports READY again.

<a id="queue-train-free-red"></a>
### `QUEUE_TRAIN_FREE_RED`

**Meaning.** The free tests dispatched on `train/<nonce>` are red, cancelled,
missing (no `workflow_dispatch` run appeared before `--free-timeout`) or ran
on another SHA, so the paid gate was not dispatched.

**Fix.** Read the free-tests run. A PR-caused red drops that PR (`train build
--prs <list without it>`); a flaky test goes to its owner before the next
build.

<a id="queue-train-dispatch-unknown"></a>
### `QUEUE_TRAIN_DISPATCH_UNKNOWN`

**Meaning.** A train dispatch was attempted, but no run carrying its nonce
appeared, so whether it started is unknown (`gh workflow run` can fail after
GitHub accepted the dispatch). It is never dispatched again blindly.

**Fix.** Run `gstack-ship-queue train status --train <nonce>`. It adopts the
run carrying the nonce, or marks the dispatch absent; only then does
`train build --train <nonce>` dispatch it again, under the same nonce.

<a id="queue-train-waiting"></a>
### `QUEUE_TRAIN_WAITING`

**Meaning.** The train has fewer PRs than `train.max_size` and its oldest
READY PR has waited less than `train.fill_hours`, so it does not dispatch
yet. The message prints when it will. The scratch merges already ran: the
`MERGE_CHECK: T1..T<k> merge clean onto <base>@<sha>` line above it says every
seated pin merges in slot order (a pin that does not is `QUEUE_TRAIN_CONFLICT`
instead), and a `#<pr> BASE_OVERLAP:` line names a pin whose files the base
moved onto since it forked.

**Fix.** Add READY PRs, rerun after the printed time, or pass `--urgent` for a
one-PR train.

<a id="queue-train-pending"></a>
### `QUEUE_TRAIN_PENDING`

**Meaning.** The train's run (free tests, the full gate or the bisect) has
not finished, so there is no verdict yet. The same code covers a `train watch`
that reached its timeout, `verify --pr <n> --screen` on a screen run still
going, `verify --post-merge` on checks that have not settled, and a
`ready --dispatch-ci` workflow run still going at its `--timeout`; each prints
the command to rerun as `NEXT:`.

**Fix.** Rerun the printed `NEXT:` command later. Nothing is dispatched again
while a run is pending.

<a id="queue-train-incomplete"></a>
### `QUEUE_TRAIN_INCOMPLETE`

**Meaning.** The train gate did not complete its census: INFRA or INCOMPLETE
panels, an unbound, partial or cancelled shard, a slice killed before its
upload, a record bound to another nonce, head or tree, or no published
record. An incomplete gate is never green.

**Fix.** When every gap is machine-classified INFRA or INCOMPLETE, take the
one re-dispatch EVAL_POLICY.infraRedispatch allows (`train rebuild --train
<nonce> --infra`) and report both runs. Otherwise diagnose the run.

<a id="queue-train-red"></a>
### `QUEUE_TRAIN_RED`

**Meaning.** The train's full gate is red on the train tree; the message names
the red cases. Its PRs do not merge, and nothing is retried to change the
verdict.

**Fix.** Bisect the red cases (`train bisect --train <nonce> --spend-cap
<usd>`). After a rebuild's second red, route the cases to a repair lane.

<a id="queue-train-red-on-main"></a>
### `QUEUE_TRAIN_RED_ON_MAIN`

**Meaning.** The bisect found the red cases red on every prefix, main (T0)
included: main is broken, not the train's PRs.

**Fix.** Fix forward on main first (a one-PR train), then rebuild this train
unchanged.

<a id="queue-train-unattributed"></a>
### `QUEUE_TRAIN_UNATTRIBUTED`

**Meaning.** The bisect pattern blames no PR and not main: all green, or not
monotone. One trial per prefix cannot tell a flake from a break.

**Fix.** All green: the one preregistered rebuild (`train rebuild --train
<nonce>`), reporting both runs. Any other pattern: a repair lane, then a
changed train once the repair merges.

<a id="queue-train-bisect-capped"></a>
### `QUEUE_TRAIN_BISECT_CAPPED`

**Meaning.** The bisect's reserved price (every case×prefix trial, trials
without cost data at `train.trial_reservation_usd`) passes `--spend-cap`.
Prefixes that fit were launched, completed prefixes are kept, and the
outcome stays unattributed; it is never green.

**Fix.** Resume with a higher cap (`train bisect --train <nonce> --spend-cap
<usd>`). Only prefixes without a result run.

<a id="queue-train-prefix-invalid"></a>
### `QUEUE_TRAIN_PREFIX_INVALID`

**Meaning.** A bisect prefix is not an ancestor of the train head on
`train/<nonce>` (the branch moved), or a red case is not in the gate's plan,
so the bisect inputs are refused before any dispatch.

**Fix.** Check that `train/<nonce>` still points at the recorded head
(`train status`). A moved branch needs a new train.

<a id="queue-train-rebuild-refused"></a>
### `QUEUE_TRAIN_REBUILD_REFUSED`

**Meaning.** `train rebuild` is not allowed: there is no bisect record (or,
with `--infra`, no INFRA/INCOMPLETE-only census), the bisect was not all
green, or the train was already rebuilt or re-dispatched once.

**Fix.** Route the red cases to a repair lane; the train is rebuilt only once
the repair merges (a changed train).

<a id="queue-train-tree-mismatch"></a>
### `QUEUE_TRAIN_TREE_MISMATCH`

**Meaning.** Main's tree is neither the train's prefix before this PR nor the
one after it, modulo stamps, so the merge would not publish what the gate
tested. After a merge, a main that differs from the prefix after the PR in
the CHANGELOG alone, while being its own first parent's CHANGELOG plus the
PR's own entry (the rule the pre-merge verify applied to the head), is not a
mismatch ([one CHANGELOG rule, before and after](ship-policy.md#run-a-merge-train)).
For a stamped train, `train land` compares exact trees: main must be S_(i-1)
before the merge, must not move during the slot's checks, and must be S_i
after it ([stamped trains](ship-policy.md#train-land)); main equal to an
earlier prefix refuses without freezing and names the slot to land first.

**Fix.** Stop merging. If a PR of the train merged (verified, or reported
MERGED by GitHub without a verified tree, slot 1's own squash included), the
queue is now frozen (`QUEUE_TRAIN_FROZEN`); otherwise build a new train on
current main. When whether a slot merged on GitHub cannot be read, verify
refuses with `QUEUE_PROOF_MISSING` instead of either answer; rerun it once
`gh pr view` answers.

<a id="queue-train-stale"></a>
### `QUEUE_TRAIN_STALE`

**Meaning.** Verify found main's tree outside this train's prefixes, but every
slot of the train already merged on GitHub and main's SHA is a prefix another
train's verify confirmed, so the record is stale: its PRs landed and later
trains moved main on. Comparing today's main with its prefixes proves nothing,
so the queue is not frozen and no backstop is dispatched (train 24's record
did both on a main train 28 had verified, #3519). Other trains are read after
the notes ref, so a machine that never ran the later train still sees it.

**Fix.** `gstack-ship-queue train prune --stale --train <nonce>` settles the
record. When some slot is not merged, no train verified main's SHA, or verify
ran with `--no-fetch`, verify freezes as before (`QUEUE_TRAIN_FROZEN`). A queue
another machine already froze stays frozen; the refusal prints its freeze
lines.

<a id="queue-train-frozen"></a>
### `QUEUE_TRAIN_FROZEN`

**Meaning.** A train stopped partway through publication, so main holds a
prefix no gate covered on its own. The `QUEUE_TRAIN_FROZEN:` line lists the
merged PRs (a slot GitHub reports MERGED counts as merged, verified tree or
not, and the reason then says `merged on GitHub without a verified tree`, so
the repair's rebuild never seats it again), main's tree and the backstop run
dispatched on main's SHA. The record is built from the one GitHub read that
decided to freeze: a slot that read MERGED stays merged even when `gh pr view`
stops answering a moment later, and a slot whose state could not be read when
another slot had merged is left out of `unmerged` and named in the reason
(`#<n> unreadable on GitHub, left out of unmerged; seat it in a train by hand
once gh pr view answers`), so the rebuild after the repair never seats a PR
that may already be in; the record keeps it under `unreadable`, an
`unreadable:` line prints it, and the `NEXT:` after the repair names it for a
`gh pr view` check. The
freeze lives in local state and on `refs/notes/gstack-trains`. Ordinary
trains and other trains' merges are refused until a repair lands.

**Fix.** Admit one repair PR at its exact head (`train build --repair --prs
<n>@<sha>`). The freeze clears when verify finds main's tree after that merge
in a green record; `NEXT:` then builds a train of the PRs still unmerged.

<a id="queue-receipt-missing"></a>
### `QUEUE_RECEIPT_MISSING`

**Meaning.** The PR body carries no valid ```gstack-ship-receipt``` block, so
/ship never ran on this branch (or its receipt was lost when the body was
rewritten). `gstack-ship-queue ready` refuses to READY it, `train build`
refuses the pin by PR number before any write, push or dispatch (dry run
included), and `verify --train` refuses the slot. The block still prints the
informational `SHIP_RECEIPT: none in the PR body` (or `invalid`) line. There
is no flag that skips this check (Garry, 2026-10-25: use the gstack ship skill
before merging PRs; [ship-policy.md](ship-policy.md#ship-before-ready)).

**Fix.** Run /ship on the branch. Unattended, it ends by writing the receipt
into the PR body (`gstack-ship-receipt write --pr <n> … --body <file>`, then
`gstack-post pr-body`) when an open PR exists for the branch at HEAD;
otherwise it leaves the receipt in `.gstack/tmp/ship-receipt.md` and the
parent posts it ([unattended.md](unattended.md)). Then rerun
`gstack-ship-queue ready --pr <n> --screen|--no-screen` and send the new READY
block.

<a id="queue-receipt-stale"></a>
### `QUEUE_RECEIPT_STALE`

**Meaning.** The PR body's ship receipt is valid but names another head than
the one being READY'd or merged (a push after /ship, a receipt copied from
another PR, or a `pr` field for another PR), so the receipt does not cover
what would merge. The one accepted difference is a train slot's stamp: when
the current head is the pinned head's stamp commit (same tree modulo stamp
files, or the pin with main merged in at slot 2 and later), the receipt
written for the pinned head is the binding one and `verify --train` accepts it.

**Fix.** Rerun /ship on the current head so the receipt names it, then rerun
`gstack-ship-queue ready --pr <n> --screen|--no-screen`. A lane never stamps
to fix this: the stamp comes only when the slot is called.

<a id="queue-receipt-depth-raised"></a>
### `QUEUE_RECEIPT_DEPTH_RAISED`

**Meaning.** `ready` or `train build` recomputed the review depth the head
needs from git (the range against the base ref, `origin/<base>` in `ready`
and `<remote>/<base>` in `train build`, the base commit's
generated-output registry, and the receipt's gate scan when it names this
head) and the receipt's `review_depth.depth` is below it, or the receipt comes
from a gstack that records `gstack_version` but carries no `review_depth`. The
`REVIEW_DEPTH:` line prints the receipt's depth, the required depth, runtime
lines, the class, the reasons and the inputs (`base@`, `registry@`,
`gate_scan@` or `missing`). A gate scan recorded for another head counts as
missing, which makes the head need `full`. The receipt is unchanged.

**Fix.** Run /ship on the head the READY names; it reviews at the depth
`gstack-review-plan` plans for that head and writes a receipt that records it.
Never edit `review_depth` by hand ([review-policy.md](review-policy.md#review-depth)).

<a id="queue-receipt-exception-invalid"></a>
### `QUEUE_RECEIPT_EXCEPTION_INVALID`

**Meaning.** The receipt records an owner exception (`docs.exception` or
`review_loop_exception`) that the queue cannot accept: the record does not
parse, a review-loop exception names no fix-check (`review_loop.fix_checks`
is 0 or missing), its `fix_check.head` is neither the bound head nor an
ancestor of it (not checked after a carry across rewritten history), or the PR
body no longer carries the exception's line word for word
(`Documentation exception: …` or `Review-loop exception: …`).

**Fix.** Restore the line in the PR body exactly as `write` printed it, or run
/ship again and record the owner's acceptance with `--docs` or
`--review-loop-exception` ([ship-policy.md](ship-policy.md#ship-receipt)).

<a id="queue-screen-stale-ref"></a>
### `QUEUE_SCREEN_STALE_REF`

**Meaning.** `ready --screen` refuses with this code when the PR conflicts with
the base beyond the CHANGELOG and the stamp files (the message lists the
conflicting paths) or when it cannot list the remote's refs. A missing or
lagging merge ref alone no longer refuses (see Fix). The rest of this
paragraph is why such a ref cannot be screened directly: `ready --screen`
dispatches the screen against GitHub's `refs/pull/<n>/merge`, and that ref can
be missing or still merge an older head than the PR's pushed head. GitHub
stops recomputing the merge ref while the PR conflicts with the base (a CHANGELOG-only conflict after a stamp
counts), so a screen dispatched there checks out the old merge, sees itself
superseded, plans 0 cases and reports success. GSTA-95 hit this on #3431:
`ready` printed `SCREEN_DISPATCH:` as if a screen ran. `ready` now compares
the merge ref's second parent with the PR head before dispatching, and a
finished screen that planned no cases is never adopted as a screen. A screen
run uploads no train record, so the evidence is its plan: a superseded run
skips `plan-slices` and uploads no `paid-plan` artifact, and a manifest with
nothing planned counts the same. `ready --screen` dispatches a fresh one and
`train build` prints `SCREEN: #<n> run <id> planned no cases (no paid-plan
artifact; …)` or `… planned no cases (an empty plan manifest; …)`, each
ending `; counted as not-run, the slot rides unscreened`. A plan it cannot
read (`… paid-plan artifact has expired`, `… manifest.json is unreadable`, an
unreadable run or artifact list, an unreadable repository slug, or a READY
whose run id is not a number) keeps the slot screened and prints
`SCREEN: #<n> <reason>; counted as screened, unverified`; `ready --screen`
follows such a run. When `ready` cannot list the remote's refs, it refuses with
the same code and a `could not list …` message whose NEXT line says to check
the remote, not to resolve a conflict; a merge ref that lists but cannot be
fetched is replaced by the scratch merge described under Fix.

**Fix.** Since the scratch-merge screen landed, a lagging merge ref is no
longer a refusal: `ready --screen` builds the merge of the PR head onto
`origin/<base>` itself with the train's merge rules (version files take the
base's side, the CHANGELOG merges by section), pushes it as
`screen/<pr>-<head12>` and dispatches the screen on that commit, printing
`SCREEN_MERGE: scratch merge …`. The code now means a real conflict: the
message lists the conflicting paths. Resolve those with the base branch,
push, and run `gstack-ship-queue ready --pr <n> --screen` again. A
CHANGELOG-only or stamp-file-only conflict does not refuse, unless the PR's
CHANGELOG drops or renames a released heading (the message then names the
CHANGELOG). `train prune --stale` deletes the scratch branches of merged or
closed PRs.

<a id="queue-screen-red"></a>
### `QUEUE_SCREEN_RED`

**Meaning.** The screen run dispatched for this PR head finished RED. The
verdict is read from the run itself, never from a lane's report: the
`gate-binding-a<attempt>` artifact evals.yml's report job uploads (verdict,
reconcile exit, flaky cases) and the `report-verdict-a<attempt>` artifact's
`collector-outcomes.json` (the panels that failed the lane and the rule-16
flaky lines). A case the binding calls red already failed twice inside the
run (rule 16 reruns a first failure once), so the red is real. `ready`
refuses with this code when the head's recorded screen run is red, whichever
of `--screen` or `--no-screen` it is given, and never dispatches another
screen at the same merge SHA; `train build` refuses to seat the pin and its
`NEXT:` names the build without it; `verify --pr <n> --screen` prints
`SCREEN_VERDICT: #<n> run <id> RED red=<cases> flaky=<cases>` and one
`FLAKY:` line per flaky case. The verdict is recorded in the READY receipt
(`screen.verdict`), locally and in `refs/notes/gstack-trains`.

**Fix.** Read the red cases from the `SCREEN_VERDICT:` line, repair, push a
new head, run /ship and `gstack-ship-queue ready --pr <n> --screen` again
(the new head gets its own screen). A GREEN screen with flaky cases is green:
the flaky cases are listed for the ledger and need no rerun.

<a id="queue-train-stack-red"></a>
### `QUEUE_TRAIN_STACK_RED`

**Meaning.** `gstack-ship-queue train build --dry-run --stack-tests` ran a PR's
new test files (files the PR adds relative to the base whose name ends in
`.test`, `_test`, `.spec` or `_spec` plus a JS or TS extension, bun's own
rule; a helper or fixture under `test/` is not one) on the integrated prefix that includes it,
T<k> (the base plus every slot up to and including that PR), in a scratch
worktree, and they failed. The `STACK_TESTS: #<pr> T<k> <n> new test file(s)
FAIL (<files>): <failing assertion>` line names the files and the runner's
failing lines. Those tests pass on the PR head alone only because nothing
before it in the train had changed what they read (a PR stacked on another
PR's test files or fixtures hit this on 2026-10-26). Nothing was written,
pushed or dispatched; the ordinary dry run (without `--stack-tests`) does not
run them.

**Fix.** Fix the PR's tests against that prefix, or reorder the train with
`--order` so the PR they depend on comes first, then rerun the dry run. Pass
`--stack-tests-command "<cmd>"` when the repo's tests run under something
other than `bun test`; the files are appended to the command.

<a id="queue-post-merge-red"></a>
### `QUEUE_POST_MERGE_RED`

**Meaning.** `gstack-ship-queue verify --post-merge <sha>` (the full 40-character
SHA) watched the check runs attached to a commit the train merged onto the
base branch (the push workflows: free tests, the Windows subset, the main
backstop) and its commit statuses until none was still running, and at least
one check concluded `failure`, `timed_out`, `cancelled` or another non-success,
or a commit status failed (the message then says a commit status, not a check
run). A `neutral` or `skipped` check (the
backstop superseding itself when main moved on) is counted as skipped, never
red. The command keeps no process state: it polls gh until the checks settle
or `--timeout` (default 2700 s) passes, prints `POST_MERGE: <sha12>
green|red|pending|none (passed= failed= pending= skipped=)` and one
`CHECK: <name> <conclusion|status>` line per check, and a timeout is
`QUEUE_TRAIN_PENDING` with the same command as `NEXT:`, so rerunning it after
an interruption continues the watch.

**Fix.** Read the red run named on its `CHECK:` line. Repair on a new PR or
roll back the merge; `gstack-ship-queue train status` names the freeze if the
backstop filed one.

<a id="queue-screen-not-run"></a>
### `QUEUE_SCREEN_NOT_RUN`

**Meaning.** The screen run dispatched for this PR concluded `success` but
ran no slice. evals.yml's `route` job plans nothing when
`scripts/eval-readiness.ts wait` finds the PR head superseded (a push landed
between `ready --screen` and the plan) or when the plan selects no case; the
run then uploads no `paid-plan` artifact (or an empty manifest), every slice
job is skipped and GitHub shows a green check. On 2026-10-26, 18 of 41 PR
screens ended this way. The verdict is read from the run (`lib/ship-queue-screen.ts`),
so such a run is `NOT-RUN`: `verify --pr <n> --screen` prints
`SCREEN_VERDICT: #<n> run <id> NOT-RUN (<why>)` and refuses with this code, the
READY receipt records `screen.verdict.outcome: NOT_RUN`, `ready --screen` never
follows the run (its `SCREEN_DISPATCH:` line says `not following … a screen
that planned nothing is not a screen`) and `train build` seats the pin unscreened
with `SCREEN: #<n> run <id> planned no cases …; counted as not-run, the slot
rides unscreened`.

**Fix.** `gstack-ship-queue ready --pr <n> --screen` at the current head
dispatches a fresh screen. A head that moved since the dispatch needs a fresh
READY anyway (`QUEUE_TRAIN_MOVED`); a head that did not move and still plans
nothing has nothing diff-relevant to screen, and `--no-screen` with the
focused cases named in the READY block is the honest choice.

<a id="ready-screen-choice-required"></a>
### `READY_SCREEN_CHOICE_REQUIRED`

**Meaning.** The base policy turns trains on, so READY needs an explicit
screen choice: `--screen` (pay for a screen on the PR's merge SHA now) or
`--no-screen`. The `SCREEN:` lines show the selection and the recommendation.

**Fix.** Rerun `gstack-ship-queue ready` with the printed recommendation. A
lane that already ran focused local cases says so in the READY block and may
pass `--no-screen`.

<a id="pregate-timing-assertion"></a>
### `PREGATE_TIMING_ASSERTION`

**Meaning.** A test line the branch added or changed compares an elapsed
wall-clock or CPU time against a bound, or sleeps for a fixed time and then
asserts. Under machine load such a test fails without a code change. The
`timing` check warns; it does not block (the measurement is in
[docs/pregate.md#timing](pregate.md#timing)).

**Fix.** Assert on the outcome instead: an injected clock, a forced deadline,
an event or a poll with a deadline. When the bound is the contract, add
`gstack-timing-ok: <reason>` in a comment on the line or the line above. Never
raise a bound to make a flake pass; /investigate's flake playbook covers the
diagnosis.

<a id="approval-classes-invalid"></a>
### `APPROVAL_CLASSES_INVALID`

**Meaning.** The `.gstack/approval-classes.json` committed on the base branch
(or, for `gstack-approval-classes validate`, the working-tree copy) is not
valid JSON, has an unknown key, a class without a name or anything to match,
or a glob that escapes the repository. `gstack-ship-receipt write` refuses
rather than ship with the classes unchecked.

**Fix.** Run `gstack-approval-classes validate`, correct the file, and merge
it. See [Approval classes](ship-policy.md#approval-classes).

<a id="approval-class-found"></a>
### `APPROVAL_CLASS_FOUND`

**Meaning.** `gstack-approval-classes check` found changes a declared class
covers. Each `APPROVAL_CLASS:` line names the class and file:line, and each
`APPROVAL_SCOPE: <class>@<digest12>` line is the token an approval binds to.
Report-only lines from built-in detectors do not set this code.

**Fix.** Ask the owner, then add
`Approved by <owner> <YYYY-MM-DD> via <ref> for <class>@<digest12>` to the PR
body. The token changes whenever an effect is added, removed or edited, so a
later change needs a new approval.

<a id="approval-citation-missing"></a>
### `APPROVAL_CITATION_MISSING`

**Meaning.** `gstack-ship-receipt write` found a declared approval class with
no citation that both resolves and binds to the current effects, and wrote no
receipt. The line lists every candidate citation and why it did not count:
the plan's autoplan gate is not APPROVED, the comment is not by a ship-policy
maintainer or not by the cited owner, the evidence names neither the scope
token nor the class with every effect path (an approval of other work, or one
given before an effect was added), or an unresolvable reference lacks a
matching `for <class>@<digest12>` attestation.

**Fix.** Cite the approval: a plan sha with `--approval-run <run dir>`, or the
URL of a maintainer's comment or review that names the token. For evidence
gstack cannot read (a thread code, a chat message), attest which scope it
covers with `for <class>@<digest12>`; the receipt records it as
`citation: unverified` for the coordinator.

<a id="approval-source-unavailable"></a>
### `APPROVAL_SOURCE_UNAVAILABLE`

**Meaning.** `origin/<base>` does not resolve, so the committed approval
classes cannot be read. `check` exits 3; `gstack-ship-receipt write`
records `approval.status: unavailable` and prints `approval=unchecked`.

**Fix.** `git fetch origin <base>` and rerun. The working-tree copy is never
used.

<a id="state-matrix-incomplete"></a>
### `STATE_MATRIX_INCOMPLETE`

**Meaning.** `gstack-state-matrix check` read the state-machines specialist's
output and found a gap: a kind × owner action pair with no row, a row with no
resulting row, a test reference that does not exist in the checkout, or an
untested cell without a CRITICAL finding. A review whose matrix is incomplete
has incomplete coverage, never a clean result.

**Fix.** Rerun the state-machines specialist on the same diff and check its
output again.

<a id="review-scope-input"></a>
### `REVIEW_SCOPE_INPUT`

**Meaning.** `gstack-review-scope` (the finding scope of /ship's review loop,
[ship-policy.md#review-scope](ship-policy.md#review-scope)) was given input it
cannot classify: the findings were not a JSON array of objects, `--pass` or
`--policy` was outside its values, a pass 2+ call came without
`--range-base`, `--range-base` was not a commit id (7 to 64 hex digits), or
`summary --since` matched no review-log row of this branch written via /ship
(so no `REVIEW_LOOP:` line could be derived, and the ship receipt's
`--review-loop` input was not written). Nothing was classified, deferred or
summarized.

**Fix.** Pass the Step 9.3 findings as a JSON array (`--findings <file>` or
stdin), `--pass <n>` from the invocation record, and from pass 2 on
`--range-base <sha>`, the HEAD the previous pass saved when it started, as a
hex commit id. For `summary`, check `REVIEW_SINCE` against the invocation
record's start time and that each pass was finished with `via:"ship"`.

<a id="review-scope-range"></a>
### `REVIEW_SCOPE_RANGE`

**Meaning.** `gstack-review-scope classify` could not read the diff it scopes
findings against: `origin/<base>` or `--range-base` does not resolve, or the
range base is not an ancestor of HEAD (history was rewritten since the previous
pass).

**Fix.** Fetch `origin/<base>`, check `--range-base` against the pass heads in
the invocation record, and start a full pass (`--pass 1`) when the branch was
rebased; /ship's own rule is to merge the base in, never rebase a reviewed head.

<a id="receipt-carry-refused"></a>
### `RECEIPT_CARRY_REFUSED`

**Meaning.** `gstack-ship-receipt carry` could not carry the PR's /ship receipt
to HEAD: the PR body has no valid receipt, the working tree has uncommitted or
untracked changes (a carry certifies a commit, never a tree that differs from
it), the receipt's head left HEAD's history and the receipt records no tree to
compare (a receipt written before `head_tree`, whose head is not in this
clone), the PR was retargeted to the base after its stack parent landed but
the receipt records no `product_patch_id` and `origin/<parent>` no longer
resolves, so the reviewed range cannot be recomputed, or git could not
compare the two product diffs or read the working tree's status. It also refuses when an owner exception the receipt records
no longer stands, and, for a receipt from a gstack that records review
depth, when HEAD needs a deeper review than the receipt records, `--head` is
not the checked-out HEAD, or the receipt records `gstack_version` without
`review_depth` ([ship-policy.md](ship-policy.md#ship-receipt)). The receipt in
the body is unchanged and still names the old head, so `gstack-ship-queue
ready` refuses `QUEUE_RECEIPT_STALE`.

**Fix.** Commit or stash every working-tree change, then rerun
`gstack-ship-receipt carry --pr <n>` at the new head. When the history is
already rewritten and the receipt predates `head_tree`, run /ship on the new
head; next time merge the base in instead of rebasing. For a retargeted stacked
PR whose older receipt lost its parent branch, or a depth or exception
refusal, run /ship on the new head. When `--head` is not the checked-out HEAD,
check it out and carry there.

<a id="review-loop-exception-invalid"></a>
### `REVIEW_LOOP_EXCEPTION_INVALID`

**Meaning.** `gstack-ship-receipt write --review-loop-exception` refused the
record and wrote nothing: it is not `{ accepted_by, date, via, reason,
fix_check: { head, findings[, files] } }`, `--review-loop` is missing or counts
no fix-check, `fix_check.head` is neither the receipt head nor its ancestor,
or the `--body` file lacks the `Review-loop exception: …` line.

**Fix.** Record the owner's exact words and the fix-check the stop followed,
pass the `gstack-review-scope summary` file as `--review-loop`, put the printed
line in the PR body, and write again
([ship-policy.md](ship-policy.md#ship-receipt)).

<a id="receipt-carry-tree-mismatch"></a>
### `RECEIPT_CARRY_TREE_MISMATCH`

**Meaning.** The branch was rebased or force-pushed after /ship, so the
receipt's head is no longer in HEAD's history, and HEAD's tree is not a tree
the receipt covers (its `head_tree` or a tree in `carry.trees`). No review saw
this code. The refusal names HEAD's tree and the covered trees; the body is
unchanged.

**Fix.** Run /ship on the new head. A rebase carries only onto a reviewed tree
whose product diff against the new base is unchanged; merging the base in
instead keeps every later carry available
([ship-policy.md](ship-policy.md#receipt-carry)).

<a id="receipt-carry-product-changed"></a>
### `RECEIPT_CARRY_PRODUCT_CHANGED`

**Meaning.** Between the receipt's head and HEAD the product diff against the
base changed: at least one path that is neither a test, release metadata, a
registered output the pregate's regen check proved (listed under `proven`,
checked against the same base registry), nor part of the base merge has
a different patch than the reviewed head had. After a rebase it means HEAD has
the reviewed tree but the base moved under it, so the diff a reviewer would see
is not the reviewed one. For a stacked PR retargeted to the base after its
parent landed, it means HEAD's product diff against the base is not the range
reviewed against the parent branch: the parent has not fully landed, or the
branch changed since. The reviewed verdict does not cover HEAD, so the
receipt is not carried. The refusal names the changed product paths, or for a
retargeted stacked PR the parent branch and the base.

**Fix.** Run /ship on the new head. The receipt carries only across a
conflict-only base merge, a test-only change, release metadata, a registered
output the pregate's regen check proved, a rebase onto a covered tree with
the recorded product diff, or a stacked PR's retarget once its parent fully
landed on the base, which the
`carry` object in the carried receipt records with the product patch-id and
the range-diff evidence ([unattended.md](unattended.md#the-terminal-line)).

<a id="receipt-prose-mismatch"></a>
### `RECEIPT_PROSE_MISMATCH`

**Meaning.** `gstack-ship-receipt read --check-prose` found a number in the PR
body that names a counter the receipt records (`passes=3` against
`review_loop.passes: 2`, `1 deferred` against `deferred: 2`, `passed: 40`
against `gate.passed: 41`) with a different value. The receipt is written from
the run; the prose was typed, so a reader of the body would learn a number the
run did not produce. The `PROSE:` line names each field with both values.

**Fix.** Correct the body to the receipt's number. When the receipt is the
stale one (the run was repeated), rerun `/ship` so the receipt is rewritten
([ship-policy.md](ship-policy.md#ship-receipt)).

<a id="receipt-carry-pregate-stale"></a>
### `RECEIPT_CARRY_PREGATE_STALE`

**Meaning.** The receipt in the body records a pregate result for its old head,
and `gstack-ship-receipt carry` was asked to rebind it to HEAD without a pregate
result current for HEAD (or the one passed with `--pregate` is not current). A
carry certifies the new head, so it never keeps the old tree's checks. Nothing
was rewritten.

**Fix.** Run `gstack-pregate` at HEAD (the remote tests stage when the policy
requires it), then rerun `carry --pregate <pregate.json>`. `--dry-run` still
reports eligibility without one ([ship-policy.md](ship-policy.md#receipt-carry)).

<a id="receipt-git-too-old"></a>
### `RECEIPT_GIT_TOO_OLD`

**Meaning.** `gstack-ship-receipt carry` compares the product diff at the two
heads with `git patch-id --verbatim`, which git added in 2.39. The installed git
is older (the refusal names its version), so the comparison could not run and
nothing was rewritten.

**Fix.** Upgrade git to 2.39 or later and rerun `carry`; without an upgrade, run
`/ship` on the new head ([ship-policy.md](ship-policy.md#receipt-carry)).

<a id="docs-audit-blocked"></a>
### `DOCS_AUDIT_BLOCKED`

**Meaning.** `gstack-ship-receipt write --docs` was given a documentation audit
whose `status` is `blocked` with no `exception`, or `--body` lacks the exception
line the record implies, or `gstack-ship-receipt docs-caps` found a declared
documentation file over its `docs.caps` byte cap (or absent). /ship Step 14.5
ends blocked only when nobody has accepted the named risk, so a receipt written
then would publish an unaudited release as audited; nothing was written.

**Fix.** Repair the audit and rerun Step 14.5, or trim the file the `DOCS_CAP: …
over` line names (or raise its cap on the base branch). When the owner accepts
the named risk instead, record it as `docs.exception: { accepted_by, date, via,
reason }` and carry the `Documentation exception: accepted by <owner> <date> via
<ref>: <reason>` line in the PR body's `## Documentation` section, word for word
([ship-policy.md](ship-policy.md#ship-receipt)).
<a id="gstack-pr-wait"></a>
## gstack-pr-wait

`gstack-pr-wait <pr> [--repo owner/name] [--until green|ready|any-change]
[--interval SECONDS] [--timeout MINUTES] [--exclude CHECK,...]` watches one pull request and prints
one stdout line per real event, prefixed `#<pr>`; progress and recoverable
errors go to stderr. `/land-and-deploy` Step 3 runs it with `--until green`.
Exit 0 means the `--until` condition is met or the PR merged; exit 1 and 2
end with one of the two codes below. `green` gates on every check on the
head, as `gstack-ci-gate` does, so the two never disagree; a check the base
branch requires (rulesets and classic branch protection) counts as pending
until it appears. `--exclude <check,...>` leaves a named non-required check
out of the verdict, as `gstack-ci-gate --exclude` does: it neither holds
`green` while pending nor blocks when it fails, and the first poll logs
`excluded from the verdict: <names>`; a required check cannot be excluded
(`exclude refused for required check <name>`) and gates, and while a
required-check source cannot be read nothing is excluded (`exclude refused for
<names>: the required checks could not be read`), as `gstack-ci-gate` refuses
its overrides. A 403 on the classic
protection read (a token without admin scope) is logged and skipped, and the
rulesets read still names the required checks. The review-bot lists are
configuration: `gstack-config set pr_wait_gating_bots greptile,macroscope`
and `pr_wait_advisory_bots coderabbit` (`none` empties a list); a bot owns
the logins that start with its name and the checks that mention it, and an
advisory bot's review is never waited for while its checks gate like any
other. The loop
is synchronous, so Ctrl-C and `kill` stop it at once; the lock it leaves is
taken over by the next watcher for that PR once the pid is gone.

<a id="pr-wait-blocked"></a>
### `#<pr> stopped: action needed (PR_WAIT_BLOCKED)`

**Meaning.** Exit 1. The condition cannot be met without a change to the PR:
the lines above it say which. A check failed (name and link; `required check
failed` when the base branch requires it); the merge state is DIRTY (the branch
conflicts with its base); the PR was closed without merging; `--until ready` is
blocked by unresolved review threads or a BEHIND branch; GitHub stayed
unreachable for ten polls, or answered with a non-transient error
(`gstack-pr-wait stopped: <gh message>`); or `--timeout` passed (default 60
minutes) with the condition unmet (`gstack-pr-wait stopped: no green after 60
minutes; still pending: <checks>`).

**Fix.** Act on the named line: fix the failing check and push, rebase or
update the branch, resolve the threads, or read the gh message. After a
timeout, decide whether the pending checks are worth waiting for and start
again, with `--timeout 0` to wait without limit. Then start `gstack-pr-wait`
again; its state file remembers what it already reported, so only new events
print. A watcher that stopped on a gh error restarts cleanly once `gh auth
status` passes.

<a id="pr-wait-refused"></a>
### `gstack-pr-wait: the watcher did not start, or a local error stopped it before a verdict — ... (PR_WAIT_REFUSED)`

**Meaning.** Exit 2, never a verdict on the PR. The target is not a PR number
or URL, `--repo` is not `owner/name`, no repository could be read from the
checkout, the PR cannot be read with the current `gh` login, an option is
unknown, another `gstack-pr-wait` process (the line names its pid) already
watches this PR from the same state root, so a second one would print
duplicate events, or a local error (`a local error stopped the watch before a
verdict: <message>`, an unwritable state root for example) ended the process.
Exit 1 is reserved for `PR_WAIT_BLOCKED`, so a local fault never reads as a
PR that needs action.

**Fix.** Pass the number or URL and `--repo owner/name`, check `gh auth
status`, fix the named local error, or let the running watcher finish. If no
events reach you from the named pid, `kill <pid>` and start again; a lock
whose pid is no longer alive is taken over without that step.

## gstack-error-capture

`gstack-error-capture` runs one target CLI for `/devex-review` Step 3 with no
terminal, a scrubbed environment and a private temporary HOME, and prints one
redacted JSON record. Its own failures print one stderr line,
`gstack-error-capture: <what>; fix: <fix> (<CODE>)`, and no record. Exit 2 is a
usage error, 3 a refusal, 1 a helper failure. `gstack-error-capture --help` lists
every flag and code.

<a id="dx-capture-usage"></a>
### `gstack-error-capture: ... (DX_CAPTURE_USAGE)`

**Meaning.** Gstack-error-capture arguments are malformed: an unknown flag, a flag missing its value, no `--`, or no command after it. Exit 2.

**Fix.** Rerun as `gstack-error-capture [--deadline <s>] [--max-bytes <n>] [--pass-env NAME,...] [--copy-config <path>] [--cwd <dir>] [--approved] [--launch-check] -- <cmd> [args]`: flags before `--`, the command and its arguments after it.

<a id="dx-capture-bad-deadline"></a>
### `gstack-error-capture: ... (DX_CAPTURE_BAD_DEADLINE)`

**Meaning.** --deadline is not a positive number of seconds (at most 3600, up to 3 decimals). Exit 2.

**Fix.** Rerun with `--deadline 20`.

<a id="dx-capture-bad-max-bytes"></a>
### `gstack-error-capture: ... (DX_CAPTURE_BAD_MAX_BYTES)`

**Meaning.** --max-bytes is not an integer from 1 to 1048576. Exit 2.

**Fix.** Rerun with `--max-bytes 65536`.

<a id="dx-capture-bad-pass-env"></a>
### `gstack-error-capture: ... (DX_CAPTURE_BAD_PASS_ENV)`

**Meaning.** --pass-env names an invalid or unset variable, or one the containment owns (PATH, HOME, XDG_CONFIG_HOME, TERM, USERPROFILE). Exit 2.

**Fix.** Rerun with `--pass-env NAME with NAME set in the calling environment`.

<a id="dx-capture-bad-cwd"></a>
### `gstack-error-capture: ... (DX_CAPTURE_BAD_CWD)`

**Meaning.** --cwd is not an existing directory. Exit 2.

**Fix.** Rerun with `--cwd <existing directory> --approved`.

<a id="dx-capture-approval-required"></a>
### `gstack-error-capture: ... (DX_CAPTURE_APPROVAL_REQUIRED)`

**Meaning.** --pass-env, --copy-config or --cwd was given without --approved; they hand the target credentials or real files. Exit 3.

**Fix.** Ask the user to approve the named variables, files or directory, then add --approved.

<a id="dx-capture-config-refused"></a>
### `gstack-error-capture: ... (DX_CAPTURE_CONFIG_REFUSED)`

**Meaning.** --copy-config names a missing file, a symlink, a non-regular file, a path outside HOME, a duplicate, or a file over 1 MiB. Exit 3.

**Fix.** Rerun with `--copy-config <regular file under $HOME, no symlinks>`.

<a id="dx-capture-not-found"></a>
### `gstack-error-capture: ... (DX_CAPTURE_NOT_FOUND)`

**Meaning.** The command does not resolve to an executable file; the record carries launch "not_found" and nothing ran. Exit 1.

**Fix.** Install the command or pass its absolute path after --.

<a id="dx-capture-temp-dir"></a>
### `gstack-error-capture: ... (DX_CAPTURE_TEMP_DIR)`

**Meaning.** The private 0700 containment directory under the gstack state root could not be created. Exit 1.

**Fix.** Make $GSTACK_STATE_ROOT/error-capture a writable directory you own (not a symlink), then rerun.

<a id="dx-capture-containment-unavailable"></a>
### `gstack-error-capture: ... (DX_CAPTURE_CONTAINMENT_UNAVAILABLE)`

**Meaning.** Process-group or Windows job containment is unavailable on this platform; nothing ran. Exit 1.

**Fix.** Run the capture on Linux, macOS or Windows with job objects available.

<a id="dx-capture-supervisor-failed"></a>
### `gstack-error-capture: ... (DX_CAPTURE_SUPERVISOR_FAILED)`

**Meaning.** The deadline supervisor failed before reporting a result. Exit 1.

**Fix.** Rerun the same command once; if it repeats, run bin/gstack-qa-deadline --help to check the supervisor.

<a id="dx-capture-interrupted"></a>
### `gstack-error-capture: ... (DX_CAPTURE_INTERRUPTED)`

**Meaning.** The helper received SIGINT, SIGTERM or SIGHUP; the target group was killed and no record was printed. Exit 1.

**Fix.** Rerun the same command without interrupting it.

<a id="dx-capture-redaction-failed"></a>
### `gstack-error-capture: ... (DX_CAPTURE_REDACTION_FAILED)`

**Meaning.** The finished record still matched a secret check, so nothing was printed. Exit 1.

**Fix.** Do not rerun with more --pass-env; report the command name to the gstack maintainers.

<a id="dx-capture-internal"></a>
### `gstack-error-capture: ... (DX_CAPTURE_INTERNAL)`

**Meaning.** Unexpected helper failure; the line names the error class and its first stack frame. Exit 1.

**Fix.** Rerun once; if it repeats, report the printed frame to the gstack maintainers.

## Prose lint (gstack-prose-lint)

`bin/gstack-prose-lint` reads the prose /ship is about to publish, a CHANGELOG
entry (Step 13) and the sections the author writes in the PR body (Step 19:
`## Why`, `## Summary` and `## Blast radius`, through `--sections`; the
`## What changed` captions and image text stay a report), and the quality-gate
workflow runs it over `CHANGELOG.md`'s `[Unreleased]` block. It decides only
what a regular expression can: autopilot vocabulary, "not just X, but Y",
metaphor nouns, a colon used as a conjunction, a bold label that restates its
line, an arrow or a dropped article standing in for a sentence, and a fence or
HTML comment left open (`unclosed-block`), because nothing after it was read.
Fenced code, inline code, URLs, HTML comments and quoted words are never read,
so the problem quoted in `## Why` is the person's to phrase. Everywhere else (a
template, a doc, this file) it is a report: run it, read it, keep your em dashes.

<a id="prose-lint-found"></a>
### `PROSE_LINT_FOUND`

**Meaning.** A gated run (`--gate`) found at least one tell in the text it was
given. Each `PROSE: <file>:<line> <rule> "<match>" (<hint>)` line above the
trailer names the rule and what to write instead; `PROSE_LINT: found=<n>` counts
them. With `--unreleased` only the `## [Unreleased]` block was read; with
`--base <ref>` only the lines the working tree added since the merge base; with
`--sections <a,b>` only the text under those `## ` headings (under `--gate`, a
file with none of them is exit 2, not a pass: the draft lost a heading).

**Fix.** Rewrite each named line in the draft the way its hint says (a measurement
such as `1.6740 → 1.7010` and the `before → after` heading are not findings), then
rerun the same command. The PR body's verbatim tool sections (the approvals
table, issue links, review findings, the coverage diagram) are outside
`--sections` and are never read, so a finding there means the compose block was
edited: restore its `--sections` list. A rule that keeps flagging correct prose
is a bug in `lib/prose-lint.ts`: file it with the sentence.

## Quick answers

The short troubleshooting entries that used to live in the README. Each names the symptom and the fix; the sections above cover every gate message in depth.

**Skill not showing up?** Run `./setup --status` from your gstack checkout. It
prints every install (host, scope, version, skills directory, source checkout)
and, for a `stale`, `missing` or `unregistered` row, the exact command that fixes
it. The usual fix is to re-run setup from that row's source for that host, e.g.
`cd ~/.claude/skills/gstack && ./setup` (Claude) or `cd ~/gstack && ./setup --host codex`.
A project install lives in the project's `.claude/skills/gstack` or
`.agents/skills/gstack`; run its `setup` from inside the project.

**Cursor freezes on load, or an agent's gstack skills went missing after an upgrade?** Each checkout now renders skills only for the agents installed from it (#1694). `./setup --status` lists them; `./setup --host <name>` adds one back. Pruned copies are in `~/.gstack/backups/host-renders/<time>-<id>/`, with every path in its `prune.log` ([host renders pruned](#host-renders-pruned)).

**`/browse` (or `/qa`, `/design-review`) says `NEEDS_ASIDE` or `ASIDE_NOT_RUNNING`?** That's the probe telling you it's about to use the fallback browser. Want Aside? Open the app and sign in — `aside --version` should print a version and `aside repl 'console.log("ok")'` should print `ok` — then re-run. gstack never installs it for you. Want the fallback on purpose while Aside is open? `GSTACK_SKIP_ASIDE=1` makes every skill, the renderer, and `./setup` treat Aside as absent. When Aside is absent the probe prints `NEEDS_ASIDE: <OS>` and skills trust that line for the macOS-only download pitch; `GSTACK_PLATFORM` overrides the OS it names, for tests and unusual hosts (set it in your shell — gstack never reads it from a project `.env`).

**`/browse` fails on the fallback browser?** `cd ~/.claude/skills/gstack && bun install --production --frozen-lockfile && bun run build`

**`/make-pdf` or `/diagram` can't render?** Same two paths: with Aside open they print through Aside (`bun run ~/.claude/skills/gstack/bin/gstack-render.ts some.html --screenshot /tmp/out.png` tests it directly, and its first line, `ENGINE=aside` or `ENGINE=browse`, names the browser that actually rendered); without it they use the bundled browser, so `bun run build` is the fix.

**Stale install?** Run `/gstack-upgrade` — or set `auto_upgrade: true` in `~/.gstack/config.yaml`.
On Codex and the other non-Claude hosts, upgrade from a terminal: find the
checkout in the `source` column of `./setup --status`, then
`cd <source> && git pull && ./setup --host <host>`, and start a new session.

**Typing into a specific field with the fallback browser?** `browse type --selector '<css>' <text>`
types into that element; bare `browse type <text>` types into whatever has focus.

**State in the wrong place, or a setting that won't stick?** `~/.claude/skills/gstack/bin/gstack-paths --explain` shows which directory gstack uses for its state and why. See [docs/state-root.md](state-root.md).

**Want shorter commands?** `cd ~/.claude/skills/gstack && ./setup --no-prefix` — switches from `/gstack-qa` to `/qa`. Your choice is remembered for future upgrades.

**Don't use some skills?** `gstack-config set disabled_skills make-pdf,pair-agent` stops registering them on every host, so their descriptions stop loading into each session. Claude Code updates right away; other hosts on their next `./setup --host <name>` or `/gstack-upgrade`. Their files stay installed, so a skill that calls a disabled one still works (you get a warning). Typos are rejected with the closest skill name, `gstack-upgrade` can't be disabled, and `gstack-config set disabled_skills ""` re-enables everything.

**Never use plan mode?** `gstack-config set plan_mode_preamble off` leaves the "Plan Mode Safe Operations" and "Skill Invocation During Plan Mode" sections (about 1.6 KB per skill) out of every installed skill on the next `./setup` run; the command prints the exact `./setup --refresh-registered` line that applies it. Claude Code then serves a render under `~/.gstack/render/claude` instead of the committed files. Commands marked "PLAN MODE EXCEPTION — ALWAYS RUN" keep their marker. `gstack-config set plan_mode_preamble on` (the default) and another `./setup` bring the sections back. It matters for Claude Code, Copilot and OpenCode: hosts without plan mode (Codex and others) never carry these sections.

**Want namespaced commands?** `cd ~/.claude/skills/gstack && ./setup --prefix` — switches from `/qa` to `/gstack-qa`. Useful if you run other skill packs alongside gstack.

**Codex says "Skipped loading skill(s) due to invalid SKILL.md"?** Your Codex skill descriptions are stale. `${CODEX_HOME:-~/.codex}/skills/gstack` is a runtime directory, not the checkout: `./setup --status` shows the Codex row's source checkout. Fix: `cd <that source> && git pull && ./setup --host codex` — for a repo-local install, run it from inside the project.

**Chromium install failed or hung during `./setup`?** The bundled browser is
best-effort: setup records the reason, finishes registering every skill, and
prints which skills are affected (`/qa`, `/qa-only`, `/design-review`,
`/browse`, make-pdf, `/diagram`, `/pair-agent`). With Aside open, the browser
skills keep running in Aside and only the fallback engine is missing;
`/pair-agent` always needs the bundled browser. Fix the cause and re-run
`./setup`. Knobs:
`GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=<seconds>` raises the download bound
(default 600) on slow links; `GSTACK_SKIP_PLAYWRIGHT=1` skips the Chromium
install entirely (CI, no-browser boxes); `GSTACK_CHROMIUM_NO_SANDBOX=1` is the
fix when Chromium installs but cannot launch because the host blocks
unprivileged user namespaces (Ubuntu 24.04+ AppArmor default, #2157).

**Setup ended with "Not registered (a skill you own already uses the name; left untouched)"?**
gstack only deletes or links over a skill entry it can prove it created: a
symlink into gstack, a directory carrying the `.gstack-owned` marker `./setup`
writes into every directory it creates, or a SKILL.md that is byte-identical to
gstack's or carries the generated `<!-- AUTO-GENERATED from ... -->` banner. A
`qa/` or `ship/` you wrote yourself is left untouched by `./setup`,
`gstack-relink`, and both prefix-mode flips, and the linker names it in the
final summary. Rename or move yours, or switch modes (`./setup --prefix` /
`--no-prefix`) so the names stop colliding. If you started your own skill from
a generated gstack SKILL.md and then edited it, that file is moved to
`~/.gstack/backups/skills/<timestamp>/<skill>/SKILL.md` before gstack's is
linked in, never deleted.

## gstack-decision-trail and gstack-worktree-audit

<a id="decision-trail-start-required"></a>
### `gstack-decision-trail: DECISION_TRAIL_START_REQUIRED: <file> has <n> rows and run <id> has no start row after the newest one`

You appended with `--run <id>` to a trail that other runs already wrote, and
the newest `start` row in it is not this run's. A run (one agent
conversation, with its later turns) that joins a trail opens with its own
`start` row so a reviewer can tell whose rows are whose. Run
`gstack-decision-trail start <file> <id>` once and append again; the start
command is a no-op while this run's start row is still the newest, so a rerun
of the same script is safe. Nothing was written. See
[docs/unattended.md](unattended.md#the-decision-trail).

### `gstack-worktree-audit` prints `warn: no -b given; MERGED checks against origin/HEAD` or every row says `MERGED no`

Without `-b` the audit compares each worktree's head against the remote's
default branch (then `origin/main`, then `origin/master`), which is not
always the branch PRs merge into; pass `-b origin/<branch>`. A squash-merged
branch is never an ancestor of the base, so `MERGED no` beside `PR #n/merged`
is normal and the bucket is still `safe` while the tree is clean and every
commit is pushed; an unpushed commit or an untracked file on that branch makes
it `review`, because deleting the worktree would lose it. The audit only reads
(its one write is the base fetch, which `--no-fetch` skips);
a worktree it calls `safe` is still yours to remove, and a `prunable` row names
a registered, unlocked worktree whose directory is already gone (`git worktree
prune`); a locked one, or a `broken` row whose `.git` link is missing, reads
`review` instead. `clean,ignored:<n>` means the tree is clean but holds
gitignored entries (`.env`, build output) that go with the worktree.


## Agent harnesses (gstack-harness)

`bin/gstack-harness` registers gstack's skills with the agent harness gstack is installed into (OpenClaw, Hermes, a Dot, any other; QM is not available yet) and records every file it writes in `$GSTACK_STATE_ROOT/harness/<id>.ledger`. Each error line ends with its code and a link here. Per-harness install, verify and uninstall steps: [docs/hosts.md](hosts.md#agent-harnesses).

<a id="harness-unknown-target"></a>
### `gstack-harness: unknown harness "<name>"` (HARNESS_UNKNOWN_TARGET)

The name is not one of openclaw, hermes, dots, generic, qm, muse or grok. For a harness gstack does not know, use `generic` with `--skills-dir` or `--context`, or `--print` to get the router and block to paste in.

<a id="harness-no-destination"></a>
### `gstack-harness: <harness> has no default skills folder` (HARNESS_NO_DESTINATION)

`generic` has no default location, and gstack never guesses at your context files. Pass `--skills-dir <dir>` (an Agent Skills folder the harness reads) or `--context <file>` (a file it loads every session), or `--print` to write nothing.

<a id="harness-mode-unsupported"></a>
### `gstack-harness: Hermes does not support --skills router` (HARNESS_MODE_UNSUPPORTED)

Hermes lists in its skills index only the skills registered as folders in its skills tree, so a router would leave every other gstack skill out of the listing the model chooses from (Hermes's `skill_view` can still load an unlisted skill by name, but nothing tells the model it exists). Drop `--skills` to take the harness's default (Hermes: all; OpenClaw: hybrid; dots and generic: router). OpenClaw takes router, hybrid or all.

<a id="harness-unsafe-destination"></a>
### `gstack-harness: refusing to write into <dir>: <why>` (HARNESS_UNSAFE_DESTINATION)

The destination is your home folder, the filesystem root, inside the gstack checkout, a symlink (or holds one where gstack's own folders were), or a path with a tab or newline. Nothing was written. Pick the harness's own skills folder, for example `--skills-dir ~/.openclaw/skills`.

<a id="harness-unowned-entry"></a>
### `gstack-harness: <path> already exists and gstack did not write it` / `a skill named <name> already exists at <path>` (HARNESS_UNOWNED_ENTRY)

gstack only replaces files its ledger says it wrote. A folder or a skill with the same name is yours (or another tool's), and harnesses resolve skills by name, so gstack stops instead of shadowing it. Rename or move that entry, then register again.

The same code stops `register <harness> --context <file>` when the file holds a `<!-- gstack:begin harness-routing -->` or `<!-- gstack:end harness-routing -->` line without exactly one partner, or a gstack block someone edited. Delete those marker lines (and the lines between them, once you have kept what you want), then register again.

<a id="harness-context-refused"></a>
### `gstack-harness: refusing to write the gstack block into <file>: <why>` (HARNESS_CONTEXT_REFUSED)

`--context` writes the routing block only into a file you name, and two kinds of file are refused before anything is written. `SOUL.md` (in any letter case) is the harness's identity file (Hermes and OpenClaw both load it every session), and gstack never edits it. For Hermes, a new `.hermes.md`, `HERMES.md`, `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md` that would outrank a rules file Hermes loads now is refused too: Hermes loads one project context type, first match wins (`.hermes.md`/`HERMES.md`, then the `AGENTS.md` chain, then `CLAUDE.md`, then `.cursorrules`), takes the first name it finds in a folder (`.hermes.md` before `HERMES.md`, `AGENTS.override.md` before `AGENTS.md`), and takes the nearest `.hermes.md`/`HERMES.md` walking up to the git root, so creating it would hide those rules. Name the file Hermes already loads instead (the error names it), or a file in `$HERMES_HOME` for every session.

<a id="harness-render-failed"></a>
### `gstack-harness: could not render <harness> skills: ...` (HARNESS_RENDER_FAILED)

The harness's skills are rendered from this checkout with `scripts/gen-skill-docs.ts`. Run `bun install` in the checkout and register again; the last lines of the generator's output are in the message.

<a id="harness-budget-exceeded"></a>
### `gstack-harness: router description is <n> bytes` / `context block is <n> bytes` (HARNESS_BUDGET_EXCEEDED)

The router's description (at most 300 bytes) and the context block (at most 600 bytes) go into every session, so gstack refuses to grow them. This is a gstack bug: report it with the byte count.

<a id="harness-not-registered"></a>
### `gstack-harness: no registration named "<name>"` (HARNESS_NOT_REGISTERED)

There is no ledger for that harness or id under `$GSTACK_STATE_ROOT/harness`. `gstack-harness status` lists every registration on this machine with its id.

<a id="harness-qm-credentials"></a>
### `gstack-harness: no QM admin credential in the environment` / `... needs --yes` (HARNESS_QM_CREDENTIALS)

Registering gstack in QM publishes an org skill pack, so it needs an org admin's credential and an explicit `--yes`. Set `GSTACK_QM_URL` and `GSTACK_QM_ADMIN_TOKEN` (or `GSTACK_QM_SIGNING_SECRET` with `GSTACK_QM_ADMIN_ACTOR`) in the environment and run `gstack-harness register qm --yes`. gstack never prompts for, prints or stores the credential; the message shows the exact request instead. With the credential set, registration still stops at the next check: QM cannot import gstack yet ([HARNESS_QM_PACK_TOO_LARGE](#harness-qm-pack-too-large)).

<a id="harness-qm-api"></a>
### `gstack-harness: <METHOD> /v1/admin/skill-packs... returned HTTP <code>` / `... failed: timed out after 60 s` (HARNESS_QM_API)

QM's admin API refused or did not answer. gstack lists packs before it creates one and retries once, so rerunning never makes a second pack. Check the URL is QM core and the credential is an org admin; `gstack-harness status` shows whether a pack id was recorded.

<a id="harness-qm-pack-too-large"></a>
### `gstack-harness: gstack at <sha> is <n> MiB in <n> files; nothing was sent to QM` / `QM refused the pack: pack exceeds max bytes (33554432)` (HARNESS_QM_PACK_TOO_LARGE)

QM registration does not work yet. QM's skill-pack import clones the whole repository and reads every file before it picks the skills, and by default it refuses a pack over 32 MiB or 5,000 files. The gstack repository is larger (about 73 MiB in 4,300 files), so gstack checks the size first and sends nothing. When QM itself refuses (a QM with other limits), the pack it created stays in the org without skills: `gstack-harness unregister qm --remote` archives it. Meanwhile, give a QM agent gstack by pasting the output of `gstack-harness register generic --print` into its instructions.


## Module loadouts (gstack-modules)

These codes come from `bin/gstack-modules` and `gen-skill-docs --loadout/--modules` (guide: [loadouts.md](loadouts.md)). Each one exits 2 before anything is written, and none falls back to the `full` loadout: an eval arm that silently rendered `full` would measure the control.

<a id="loadouts-invalid"></a>
### `LOADOUTS_INVALID: modules/loadouts.json …`

**Meaning.** `modules/loadouts.json` is unreadable, or names a module, base loadout, rung or default that does not exist, excludes a pinned module, or maps one model id to two rungs. **Fix.** Correct the named entries, then run `bin/gstack-modules validate` until it prints `LOADOUTS: ok`; `git checkout -- modules/loadouts.json` restores the committed file.

<a id="loadout-unknown"></a>
### `LOADOUT_UNKNOWN: "<name>" is not a loadout (valid: …)`

**Meaning.** `--loadout` or the first token of `--modules` names no loadout in `modules/loadouts.json`. **Fix.** Use a name from the `valid:` list (`bin/gstack-modules list` prints them); `full` is always present.

<a id="module-spec-invalid"></a>
### `MODULE_SPEC_INVALID: …`

**Meaning.** A `--modules` token is not `-<module id>` or `+<module id>`, both `--loadout` and `--modules` were given, `gen:skill-docs` got a selection with exclusions but no `--out-dir`, or a render flag is missing or malformed. **Fix.** Write the spec as `<loadout>,-<id>,+<id>` (for example `full,-section:office-hours/second-opinion`) and pass the flags `bin/gstack-modules --help` lists.

<a id="module-unknown"></a>
### `MODULE_UNKNOWN: "<id>" is not a module`

**Meaning.** The id names no skill, section, overlay or preamble piece. **Fix.** Copy the id from `bin/gstack-modules list`.

<a id="module-pinned"></a>
### `MODULE_PINNED: <id> is pinned and can never be excluded`

**Meaning.** The spec removes a module the safety contract needs: the start command (`preamble:bash`), plan-mode rules, the question format, completion status, the unattended profile, /ship's review gates, the router or `/gstack-upgrade`. **Fix.** Drop `-<id>` from the spec; `bin/gstack-modules list --pinned` prints every pinned id.

<a id="module-exclusion-unsafe"></a>
### `MODULE_EXCLUSION_UNSAFE: <id>: referenced by <file>:<line>`

**Meaning.** The rendered tree still points at a module the loadout left out, so an agent following it would read a file that is not there. **Fix.** Exclude the referencing module as well, or wrap the referencing skeleton text in `{{IF_SECTION:<id>}}…{{/IF_SECTION}}` in its template (the text renders unchanged when the section loads). Nothing was published; rerun after the change.

<a id="render-failed"></a>
### `RENDER_FAILED: gen-skill-docs failed: …`

**Meaning.** Generation itself failed for this loadout (an unresolved placeholder, an oversized skill, a missing section). **Fix.** Fix the named template or module and rerun. The staging directory was removed and `--out-dir` is unchanged.

<a id="render-dest-not-owned"></a>
### `RENDER_DEST_NOT_OWNED: <dir> exists and holds no loadout.lock.json`

**Meaning.** `--out-dir` is a non-empty directory that an earlier `gstack-modules render` did not write, so replacing it could delete someone's files. **Fix.** Pass a new or empty directory, or the directory of an earlier render.
