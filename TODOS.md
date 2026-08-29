# TODOS

## NEXT PRIORITY

### P1: ZeroEntropy sunset — gbrain's default embedding provider dies Sept 4, 2026 (#2365)

**What:** ZeroEntropy (acquired by Notion) shuts down September 4, 2026. gbrain's
zeroentropyai recipe needs a migration path before then (the recipe + gateway
shim are gbrain-internal — nothing in gstack ever recommended the provider).

**Why:** Hard external deadline. After Sept 4, brains on the recipe stop
embedding new pages silently.

**Done (gstack side, v1.69.0.0):** wireup warns when ~/.gbrain/config.json names
the recipe (fail-open grep), setup-gbrain provider comments say never to select
it, USING_GBRAIN_WITH_GSTACK.md gained a troubleshooting entry (#2365).

**Effort:** M (remaining work is gbrain-side provider support).
**Priority:** P1 (calendar-driven). **Depends on:** gbrain upstream provider support.

### P2: v1.67 fix-wave deferrals — next-wave queue

Filed at v1.67.0.0 implementation time (see the wave plan's "Cut from this
wave"). Each was explicitly deferred with rationale, not dropped:

- **#2522 Windows omnibus mining** — the targeted Windows fixes landed in
  v1.67 (#2414/#2510/#2561/#2542/#2452-half); the omnibus PR still carries a
  doctor/migration surface worth extracting. Effort M→S with CC.
- **#2443 AskUserQuestion numbering redesign** — real mismatch (brief letters
  vs host-rendered numbers), but a prompt-behavior redesign that shifts eval
  baselines; needs its own PR with baseline refresh. Effort S.
- **#2447 typecheck infra** — tsconfig + repo-wide typecheck script + latent
  type fixes. High-value, repo-wide blast radius, own PR with bake time.
  Effort M. Re-derive on current main (several of its fixes landed since).
- **#2492 per-project Chromium profile** — needs an on-disk migration story
  for the machine-wide profile default and SingletonLock scoping. Effort M.
- **#2286 `triggers:` frontmatter** — the Claude Code router never reads the
  key; folding voice-triggers into description costs catalog tokens. Needs a
  maintainer token-budget decision (catalog cap is enforced). Effort S.
- **#2378 release-tag upgrade semantics** — update-check gates on
  main:VERSION while upgrade installs main HEAD; installs sit between
  releases. Design decision: tag-pinned installs vs HEAD. Effort M.
- **Feature-PR triage queue** — #2564 (/deck), #2497 (browse record — best of
  the batch), #2476 (a11y review, unblocked by the CDP media-emulation entry
  landed in v1.67), #2446 (Cua), #2448 (tiered outside voice), #2412 (lens
  layer), #2241 (/grok), #2507 (pi host), #2298 (Kimi host), #2438+#2436
  (gbrain doc-sync pair, ordered), #2442 (portable skill roots), #2534
  (gbrain MCP routing), #2535 (outside voice for /investigate,/cso,/devex),
  #2576 (fast-ship rework — re-evaluate against v1.66's CI speedup),
  #2580 (land-and-deploy CI tiers — human-gate UX needs maintainer call).

### P2: v1.69 fix-wave residuals (filed at wave time, each deferred with rationale)

- **`cleanup_prefixed_claude_symlinks` symmetric conversion** — PR #2634 fixed
  `cleanup_old_claude_symlinks` (destination scan, dangling-symlink aware,
  path-segment provenance); the prefixed-mode sibling still iterates the
  payload dir (same structural hole: can't reap orphans once the payload is
  gone) and still uses a bare `*gstack*` substring match the sibling's own
  tests forbid. Kept out of the contributor's absorbed commit for scope
  discipline. Effort S→S with CC. **Priority:** P2.
- **#2163 legacy-slug checkpoint heal** — the gstack-slug refactor unified
  save/restore slugs, but checkpoints written under a pre-fix degraded slug
  are still invisible; `bin/gstack-slug`'s own MIGRATION NOTE defers data
  moves. Cheap heal: restore-side probe of the alternate slug dir before
  printing NO_CHECKPOINTS. Effort S. **Priority:** P3.
- **#2657 developer-profile `--reconcile`** — office-hours tenure undercounts
  ~3x (Phase-4.5-only logging; no timeline.jsonl reconciliation). The
  arithmetic reproduces; the reporter offered the PR — invited on the issue.
  Track and review when it lands. Effort S (review). **Priority:** P3.
- **Table-driven setup host dispatch from `hosts/index.ts`** — root-cause fix
  for the accept-list/dispatch drift class behind #2361; v1.69.0.0 ships the
  interim ratchet (accept-list ⊆ dispatch-arms cross-check test + a loud
  zero-dispatch guard). The refactor needs its own PR with bake time (setup is
  the riskiest file in the repo). Effort M. **Priority:** P3.

### P2: v1.67 adversarial-review residuals (verified, deferred with rationale)

Filed at v1.67 ship time from the Codex + Claude adversarial passes. Six of
the seven landed in the v1.68 fix wave (brain-sync spool-dir queue, pair-agent
consent gate, bin-context walk-up parity, per-project MCP scoping +
precedence flip, next-version ls-remote fallback + width pin, stop-hook
global-path registration + re-point). Remaining:

- **iOS tap routing across windows** — Bridges template's frontmostWindow can
  swallow taps when a keyboard/menu/transparent overlay window is topmost but
  doesn't handle the coordinate. Needs hit-test-aware routing + real-device
  verification. Effort M. (Related: the multi-window rewrite has no static
  pins — see the test-gap backlog below.)
- **setup:1601 CLAUDE_CONFIG_DIR alignment** — the skills installer hardcodes
  `$HOME/.claude/skills` while settings.json and hook registration honor
  `CLAUDE_CONFIG_DIR`; users with the override get a split-brain install.
  Mitigated in v1.68.1 (canonical-root fallback to the home path so hooks
  still register), but the installer itself should honor the override.
  **Priority:** P3. Effort S.
- **Centralize plan_tune_hooks bool parsing + gstack-config key validation** —
  the `n|no|false|skip|off|0` negative-value set is triplicated
  (gstack-settings-hook prune-stale, setup heal note, setup PT_DECISION) and
  gstack-config carries three verbatim copies of the key-validation block
  (get/has/set). Extract a `gstack-config` bool helper + `validate_key()`;
  update the locale pin test. Filed via /ship review army (maintainability).
  **Priority:** P3. Effort S.
- **Accepted threat-model notes (documented, no action planned):**
  redact-prepush treats content pushed to ANY private remote as already-left
  (accident-only threat model); a parcel-shaped twin within 400 chars can
  suppress phone redaction (WARN-tier pattern, attacker-influence accepted);
  codex-probe's 400-signature grep can misread a transient proxy 400 as
  MODEL_UNUSABLE (bounded by the 15-min negative-cache TTL).

### P2: skillify structural isolation (filed from the v1.68 wave reviews)

**What:** /skillify turns scraped page content into durable executable skill
code on disk. The v1.68 wave added the untrusted-content warning to its prose
(#2441), but a warning is not a boundary — generated actions derived from
hostile page content need structural isolation, sanitization of synthesized
selectors/names, or an explicit approval step scoped to the generated code.

**Why:** A poisoned page could steer the generated script.ts toward actions
the user never reviewed; the current gate is the Step 9 approval, which shows
the code but doesn't highlight page-derived strings.

**Effort:** M → S with CC. **Priority:** P2. **Depends on:** none.

### P2: slug store migration — merge pre-fix `projects/garrytan/` data (v1.68 follow-up)

**What:** The v1.68 slug-parity fix (gstack-slug now matches remote-slug's
owner-repo form) means machines that hit the degraded-slug bug (stray strong
marker above a repo, e.g. an empty ~/.git) have historical decisions /
timeline / ceo-plans / learnings filed under the marker-basename store
(observed: `~/.gstack/projects/garrytan/`) instead of per-repo stores. Define
and ship the merge/alias: attribute each misfiled record to its repo where
derivable (timeline entries carry branch; decisions carry scope), else leave
in place with a pointer file.

**Why:** Post-fix sessions read the CORRECT store, so pre-fix history is
invisible to Context Recovery until migrated.

**Effort:** M → S with CC. **Priority:** P2. **Depends on:** the v1.68 wave
(shipped the fix + parity tests).

### P3: gstack-slug degraded-heal probe cost on cache hits (v1.68 review-army finding)

**What:** The v1.68 cache self-heal probes `_resolve_remote` (1-3 git forks) on
EVERY cache hit whenever the cached slug equals the marker-root basename — the
permanent steady state for remoteless and legit-sticky projects, on the
per-preamble hot path. Add a single-shot sentinel per cache entry so the heal
probe runs once, not forever.

**Why:** "Cache hits stay git-spawn-free" only holds for owner-repo slugs
today. Cost is bounded (1-3 forks) but paid at every skill start on affected
projects. Also next-touch notes from the same review: extract a makeResult
helper for BulkResult's 11 hand-copied literals in bin/gstack-memory-ingest.ts;
dedup the brain-worktree default-path literal between bin/gstack-brain-sync and
bin/gstack-gbrain-source-wireup.

**Effort:** S. **Priority:** P3. **Depends on:** cache-format compatibility
(sentinel must not break older readers).

### P2: v1.67 coverage-audit test-gap backlog (5-agent sweep, ranked)

The wave's Step-7 coverage audit (5 subsystem agents, ~700 changed paths,
~84% covered) ranked these residual gaps. None block v1.67 (the behaviors
shipped verified by hand or adjacent tests); each is a cheap pin against
silent regression:

- **setup Playwright bootstrap block** — `_clear_playwright_quarantine`,
  `_PW_LOCK` stale-holder reclaim, `_kill_tree`/`_wait_with_deadline`, Ubuntu
  26.04 platform override: zero test references. The P0 #2554 heal's shell
  half. Effort S each.
- **redact-prepush `scanAddedLines` slicing** — the >1MiB catch-up-diff chunk
  path (the reason the function exists) is unexercised; a regression
  reintroduces blocking-while-unscanned. Effort S.
- **supabase telemetry-ingest edge function** — zero tests; producer caps at
  200 chars vs ingest's 500 (dead server cap); no column↔migration pin.
- **gbrain-repo-policy-client** — no direct test file; the spawn-failed vs
  unreadable split (its raison d'être) and win32 bash-wrapping unpinned.
- **extension client half of token bootstrap** — `POST /extension-token` 403
  → disconnected path untested (server half is exhaustively pinned); also
  pin manifest `key` ↔ `GSTACK_EXTENSION_ID` via extension-id.ts. Effort S.
- **`assertJsOriginAllowed`** — this wave made the js/eval origin gate
  mandatory; the gate itself has zero direct tests. Effort S.
- **`runBoundedChromiumReinstall`** — every heal test stubs it; the 120s
  deadline + process-group SIGKILL + spawn-error branch never execute.
- **CI three-way image-tag drift** — ci-image.yml + evals.yml +
  evals-periodic.yml each carry the hashFiles tag expression, synced by
  comment only. One test reading all three. Effort S.
- **evals.yml matrix census** — the silent-never-ran class (see the two
  files this wave had to re-add) has no membership test.
- **design-doc-discovery resolver** — new anti-drift block, zero tests for
  the -nt freshness rule or cross-render identity.
- **Bridges.swift multi-window rewrite** — no static pins for
  orderedWindows/searchRoots ordering; DebugBridgeTouch's `#if !defined(DEBUG)`
  guard and Package.swift's `.define("DEBUG")` have no tripwire (Guideline
  2.5.1 exposure on revert); parity test runs periodic-lane only.
- **Smaller pins:** gstack-egress `sanitizeForDisplay`; freeze-dir tilde
  expansion; gstack-config `pair_agent` key + space-bearing values;
  session-cookie-store tripwire scope (points at the wrapper, not the
  factory); redact-patterns `/^pass(word)?$/i` placeholder loosening +
  compact-timestamp negative; fs-atomic adoption tripwire; tracker-guard
  `safeSource`; eval-watch `PARTIAL_PATH`; `killProcessGroup`;
  make-pdf orchestrator `PAYLOAD_TMP_DIR` + CJK stack + smartypants NUL;
  gbrain-guards `gbrainHome()`; gbrain-local-status `"timeout"` exclusion;
  meta-commands state-load tripwire re-point; flushBuffers/audit 0600 census;
  openclaw `version:` frontmatter drop (pre-wave, main-side — restore
  extraFields or record as intentional); terse-build's stale "all 4" set
  (main-side 5th terse-gated resolver).

### P2: v1.67 review-fix-batch deferrals (post-wave review army findings)

Filed at review-fix-batch time, deferred with rationale:

- **setup host-function dedup** — four near-verbatim `create_*_runtime_root`
  + `link_*_skill_dirs` copies (codex/factory/opencode/cursor) drift
  independently (the #2142 ownership gate had to be patched at every site).
  Parameterize on host name + skills dir. Effort S with CC.
- **cmd.exe `%VAR%` expansion in gbrainInvocation quoting** — Windows-only,
  contrived escalation (requires attacker-controlled env var names), but the
  quoting is not cmd.exe-safe. Fix direction: route win32 spawns through
  cross-spawn (dependency decision — bun-polyfill.cjs already carries it for
  the browse daemon). Effort S.
- **make-pdf flag registry metadata** — commands.ts flags are bare strings;
  add a takes-value field and DERIVE cli.ts's BOOLEAN_FLAGS from the
  registry (the structural `--no-*` test added in this batch covers only the
  negation shape). Effort S.
- **legacy host-glob uninstall provenance gating** — gstack-uninstall's
  codex/factory/kiro `gstack*` globs still rm -rf without a provenance
  check; bring them to parity with the cursor banner gate added in this
  batch (v1.67 added cursor; the legacy three are inherited behavior).
  Effort S.
- **cursor auto-detect breadth** — `-d ~/.cursor` triggers a full extra
  render + install for every Cursor-having dev on every ./setup (the dir
  exists for anyone who ever launched the IDE). Product call on narrowing to
  CLI detection (`command -v cursor`) or an opt-in flag. Effort S, needs a
  maintainer decision on the detection contract.

### P2: Persona-fleet hostile-user harness (fork port wave 2 deferral)

**What:** Port the methodology behind time-attack/gstack's 87-hostile-user
field run (418 findings): machine-written t0 in an append-only run.jsonl
(elapsed time measured, never self-reported), every metric resolving to an
artifact, and a mandatory-quit contract with machine-checkable caps (300s to
first useful output, 900s total, 40K context tokens, 3 consecutive dead ends)
so abandonment is a computable outcome. Specs: fork `evals/fleet/METRICS.md`
+ `evals/fleet/ABANDONMENT.md` (methodology only — no runner code exists to
port; this is a build).

**Why:** A periodic hostile-user round against OUR 44-skill tree would surface
the same first-five-minutes failure class the fork closed 418 of. Fits the
existing eval-store/e2e harness as a new runner.

**Effort:** L (human ~2wk) → M with CC. **Priority:** P2.
**Depends on:** decisions on cost ceilings + journal storage.

### P3: Answer-key eval methodology (rides the persona-fleet work)

**What:** Pre-registered answer keys (fork `evals/answer-keys/` —
codex-decorrelation, health-trending) grading our /codex and /health surfaces
against planted ground truth instead of judge vibes.

**Why:** Deterministic scoring for surfaces where LLM-judge drift is the
known failure mode. **Effort:** M → S with CC. **Priority:** P3.
**Depends on:** persona-fleet harness (shared runner shape).

### P3: Quarterly Apple-journey live re-verification

**What:** Run the /ship Apple release adapter against a real (TestFlight-only)
release once a quarter, or on first user bug report, and fix drift. Apple's
APIs move (the fork caught fastlane price_tier breaking live); the adapter's
claims are evidence-backed today and must stay that way per its own
evidence-before-claimed-limitations rule.

**Effort:** S per run. **Priority:** P3. **Depends on:** a paid ADP account.

### P2: Eval-run evidence records (extend the content-binding lattice to E2E/evals)

**What:** Wire `bin/gstack-evidence run` into the eval entrypoints (`eval:bg*`,
`scripts/test-paid-shards.ts`) so E2E/eval claims carry the same
working-tree-fingerprint binding as free tests, and /land-and-deploy 3.5b reads
evidence records instead of `~/.gstack-dev/evals` file mtimes.

**Why:** Today "E2E ran today" is an mtime heuristic that proves nothing about
what content the run tested. **Effort:** M → S with CC. **Priority:** P2.
**Depends on:** the content-binding wave; touches the sharded runner that
concurrent worktrees share — coordinate timing.

### P2: Spec-spawn outcome ledger

**What:** `/spec`'s spawned `claude -p` agents are fire-and-forget: nothing
records whether the spawn finished, died, or stalled. Add a runs.jsonl
(spawn id, branch, worktree, pid, outcome) written at spawn + updated by a
lease/heartbeat check, surfaced as a /landing-report row.

**Why:** A dead spawn is currently invisible until someone hunts the PID.
**Effort:** M → S with CC. **Priority:** P2. **Depends on:** nothing; the
lease + heartbeat liveness pattern is documented in the local CEO plan record
(2026-08-15, binding wave).

### P3: Merge-SHA chain of custody in /land-and-deploy

**What:** Post-merge, record {merge sha, merged tree, reviewed wtree match?}
so a deployed artifact traces back to a reviewed content state.

**Why:** Pre-merge checks bind reviews to content; after a squash-merge onto a
moved base the linkage is unrecorded. Needs a noise model (base movement
legitimately changes the tree) before it can alert rather than log.
**Effort:** M → S with CC. **Priority:** P3. **Depends on:** content-binding
wave fields (wtree in review records).

### P3: default-if-silent escalation contract for background loops

**What:** Long-running/background skill loops (/canary first) get an
escalation shape that carries options + a default-if-silent choice with a
timeout, so an unattended loop never stalls on a question a human isn't
around to answer.

**Why:** Autonomy currently either blocks on AskUserQuestion or guesses.
**Effort:** S/M → S with CC. **Priority:** P3. **Depends on:** consent-model
review (changes AskUserQuestion semantics — needs its own design pass).

### P3: E2E eval case — staleness grading actually applied

**What:** A paid gate/periodic eval asserting an agent following the rendered
/ship dashboard + /land 3.5a text applies the wtree content-first rule (grades
CURRENT on identical content, falls back on mismatch).

**Why:** The grading rule is prompt-followed prose pinned only by a free
template-drift tripwire; this proves agents actually execute it. **Effort:** S.
**Priority:** P3. **Depends on:** content-binding wave.

### P2: office-hours design-doc dual-write functional E2E (fork port wave 2 review shortfall)

**What:** A paid E2E (claude -p) that runs the office-hours Phase 5 handoff in
a tmp repo and asserts BOTH write paths (docs/designs/<topic>.md + the
~/.gstack copy) land and that `bin/gstack-redact` was invoked at the sink.
Today only a static prose pin exists (test/skill-validation.test.ts) — the
plan's R9 asked for the functional shape.

**Why:** The dual-write is an egress path into the user's repo; prose drift
that skips the redact scan-at-sink would ship user PII into git history with
nothing failing. **Effort:** M → S with CC. **Priority:** P2.
**Tier:** periodic (quality, non-deterministic).

### P2: migration runners honor per-migration skip state

**What:** Both migration runners (setup's post-setup block and
/gstack-upgrade Step 4.75) select migrations purely by version window, so a
migration that exits via the non-interactive default-skip (v1.27's
GSTACK_MIGRATE_ASSUME_YES gate) is never offered again — the version marker
advances past it. The remediation text now prints the honest direct
invocation, but the runners should track per-migration .done/.skipped
touchfiles and re-offer pending ones on the next interactive run.

**Why:** Every remaining pre-v1.27 user upgrading via an agent session ([ -t 0 ]
false) permanently misses the artifacts-rename migration unless they paste the
manual command. **Effort:** M. **Priority:** P2.

### P2: periodic tier — three documented-red tests need structural repair

**What:** (1) The sidebar E2E trio (navigate, url-accuracy, css-interaction)
POSTs to /sidebar-command and /sidebar-chat — endpoints removed on every tree
when the PTY terminal replaced the chat queue (server.ts tombstone ~2671);
rewrite them against the PTY surface or delete them. (2)
skill-e2e-ship-idempotency: the PTY child sits at the Claude Code welcome
screen in plan mode for the full budget — the typed /ship never lands
(readiness/typing race vs CLI v2.1.233's welcome screen); never green since
it was born in v1.63. (3) skill-e2e-brain-privacy-gate: never green anywhere;
the artifacts-sync stop-gate preconditions don't survive the hermetic env
even with per-test HOME/GSTACK_HOME injection — needs a transcript-level
debug of what the child's preamble actually echoes.

**Why:** every red periodic run costs triage time; two of these have burned
three triage passes across two releases. **Effort:** M. **Priority:** P2.

### P1: #1882 — portable skill-install prefix (non-`gstack` install dirs break silently)

**What:** Every generated SKILL.md hardcodes the literal `~/.claude/skills/gstack/...`
for its `bin/`/asset calls (the per-invocation telemetry/config preamble plus ~9
resolvers). `setup` wires the top-level skill symlinks for any directory name, so
installing at `~/.claude/skills/<other>` leaves every internal `bin` reference
pointing at a non-existent `~/.claude/skills/gstack/` path — failing **silently, at
skill-invocation time**. Make the emitted references portable: resolve the install
root at runtime (the preamble already defines `GSTACK_ROOT`/`GSTACK_BIN` in
`scripts/resolvers/preamble/generate-preamble-bash.ts` but the literals don't use
them) and emit `$GSTACK_BIN`-relative paths instead of the hardcoded prefix.

**Why:** Filed as #1882. Split out of the June 2026 fix wave (decision A) once
implementation showed it is a host-config/design change, not a fix-wave patch. The
urgent half — the guard/freeze/careful frontmatter hooks broken on CC 2.1.162 — was
already fixed in that wave (#1871) with a literal `$HOME`-anchored path, because
frontmatter hooks run before any runtime variable exists and cannot use `$GSTACK_BIN`.
So #1882 is now purely the body-preamble portability work.

**Pros:** Unblocks installs at any directory name; removes a whole class of silent
invocation-time failures.
**Cons:** Touches the most load-bearing bash in the repo (every skill's preamble);
a silent mistake breaks all 52 skills. High blast radius — needs its own focused PR.
**Note (fork port wave 2):** the Apple release adapter (ship/sections/
apple-release.md) added template surface with `~/.claude/skills/gstack/bin`
references — include it in this fix's coverage list.

**Context / where to start:**
- Rewire `ctx.paths.binDir` (and browse/design dir paths) + the ~9 resolvers that
  emit the literal (`testing.ts`, `review.ts`, `design.ts`, `browse.ts`,
  `redact-doc.ts`, `tasks-section.ts`, `preamble/generate-*.ts`) to use the
  preamble-defined `$GSTACK_ROOT`/`$GSTACK_BIN`.
- Ensure `GSTACK_ROOT`/`GSTACK_BIN` are defined before first use in EVERY skill's
  preamble (verify the telemetry preamble's first bin call is after the definition).
- **Test conflict (verified):** `test/gen-skill-docs.test.ts:1942` and the sibling
  ship assertion currently *assert* generated Claude output `.toContain('~/.claude/skills/gstack')`
  as a guardrail that Codex-host paths don't leak. These must be rewritten to match
  the new portable scheme.
- Regenerate all 52 SKILL.md (`bun run scripts/gen-skill-docs.ts --host all`); never
  hand-edit generated files. Bisect: resolver/host-config change commit, then the
  52-file regen commit.
- Smoke-test a skill invocation from a non-`gstack` install dir to prove the fix.
- Sibling of #349 (the `$CLAUDE_CONFIG_DIR` / `~/.claude` path issue).

## Aside integration follow-ups (filed via /plan-ceo-review + /plan-eng-review on the third-party-actions Aside plan)

### QA logged-in-evidence path via Aside (Phase 2)

**What:** Consent-gated `aside repl` as an alternative evidence source in /qa,
/qa-only, and /browse when cookie-import can't reach a session (SSO,
device-bound auth, Safari-side logins Chromium export can't see).

**Why:** Fills the exact gap `docs/designs/CHROME_VS_CHROMIUM_EXPLORATION.md`
records as attempted and abandoned — QA evidence from the user's REAL
logged-in browser, no cookie export. The third-party-actions contract already
recommends Aside for acting on logged-in vendor sites; this extends the same
consent-gated pattern to evidence gathering.

**Context:** Shape sketched as Option 2 in the Aside integration plan
(2026-08-27): a small `{{AGENTIC_BROWSER_FALLBACK}}` resolver injected into
qa/qa-only/browse (optionally scrape + a setup-browser-cookies cross-ref).
Port the fork PR time-attack/gstack#40 judgment qualitatively — "logged-in
pages only; never bulk crawling" — never its perishable timing numbers.
Requires: untrusted-content wrapping of repl output (prose rule), a
periodic-tier hermetic E2E, ratchet fixture refresh for the touched skills.
Deliberately deferred at D1A (contract-only scope); it inserts a third-party
surface beside the first-party QA pipeline, so it's a separate product call.

**Effort:** M (human ~2 days / CC+gstack ~1-2 h)
**Priority:** P3
**Depends on:** the third-party-actions Aside contract branch landing.

### Hostile-vendor-skill E2E for the third-party-actions contract

**What:** A periodic-tier E2E that plants a malicious `aside-browser` vendor
skill (one that instructs scope expansion, credential capture, or consent
bypass) and asserts the agent honors the contract's override sentence —
operational syntax only, never new permissions, scope, or consent.

**Why:** Rule 3 puts vendor text in instruction position; the override is
pinned as prose but has no behavioral proof against an adversarial skill.
Flagged by the ship adversarial review (finding 11).

**Context:** Fixture = extracted contract section + a hostile vendor SKILL.md
in the workdir; assert the drive plan never exceeds the named site/actions and
never echoes captured-secret instructions. Sibling of the tpa-* suite in
`test/skill-e2e-third-party-actions.test.ts`.

**Effort:** S (human ~half day / CC+gstack ~30 min)
**Priority:** P2
**Depends on:** the third-party-actions Aside contract branch landing.

### fd-anchor file-level permission writes (symlink/TOCTOU parity with dirs)

**What:** `restrictFilePermissions` / `writeSecureFile` / `appendSecureFile`
in `browse/src/file-permissions.ts` still use symlink-following `chmodSync` /
`writeFileSync`; give them the same `O_NOFOLLOW` + fstat/fchmod treatment the
directory path got.

**Why:** The symlink-swap class fixed for directories on this branch remains
open for the files inside them (ship adversarial review, finding 5).
Docs note (finding 12) — done in the v1.72.0.0 doc pass: BROWSER.md
§ "Aside and third-party drives" now records that Aside drives leave no
gstack-side audit trail (no egress receipts, no browse-daemon logs); the
audit trail lives in Aside.

**Effort:** S (human ~half day / CC+gstack ~20 min)
**Priority:** P3
**Depends on:** None.

## Test infrastructure

### P2: /context-save worktree-identity hardening (the #2052 residual)

**What:** Persist a stable worktree identity (path hash or worktree name) into
checkpoint frontmatter at save time; `/context-restore` prefers identity match
over branch-name match. PR #2054 (@jbetala7, absorbed in the June 2026 wave)
fixed restore ORDERING (current-branch first), but branch frontmatter is not a
stable worktree identity: same-name branches across clones/remotes, renamed
branches, and detached HEAD can still restore the wrong checkpoint.

**Why:** Closes the residual wrong-checkpoint class entirely instead of the
common case. Codex outside-voice concurred during the wave's eng review.

**Pros:** Eliminates cross-clone checkpoint collisions.
**Cons:** Frontmatter schema change; needs a migration story for old
checkpoints (no-identity checkpoints rank as fallback, like #2054's
no-branch handling).

**Context:** Filed from the June 2026 fix-wave eng review (NOT-in-scope item).
Start at `context-restore/SKILL.md.tmpl` Step 1 + `/context-save`'s frontmatter
writer; mirror #2054's partition logic with identity as the first key.

**Effort:** S (human ~4h, CC ~20min). **Depends on:** #2054 (landed in the wave).

### P3: gbrain reindex-in-place on perpetual drift (conditional — check the drift log first)

**What:** IF the `[gbrain-sources] drift:` stderr line (added in the June 2026
wave) shows drift firing on every sync for some environment, implement #1985's
reporter design: refresh an existing source in place with `gbrain reindex-code`
instead of remove+add (which drops and re-embeds the full index — 768 pages /
6,786 embeddings in the reporter's case).

**Why:** Perpetual drift means paying full re-embed cost every sync. The wave's
`realpathSync` normalization (symlink aliases are a match, not drift) may have
eliminated the drift class entirely — that's why this is conditional.

**Pros:** Avoids repeated embedding spend for affected environments.
**Cons:** Speculative until the drift log produces evidence; reindex-in-place
has its own consistency questions (stale chunks for deleted files).

**Context:** Filed from the June 2026 fix-wave eng review (4A observability).
Trigger condition documented in `lib/gbrain-sources.ts` at the drift log line.

**Effort:** M (human ~1d, CC ~45min). **Depends on:** drift-log evidence from
the wave's `ensureSourceRegistered` logging.
### P2: Periodic CI matrix covers 9 of ~66 e2e files — decide the coverage contract

**Priority:** P2

**What:** `evals-periodic.yml` (weekly cron, `EVALS_TIER=periodic EVALS_ALL=1`) runs a
hard-coded 9-file matrix; `evals.yml` gate shards cover 14 files. ~57 `test/skill-e2e-*`
files run in NEITHER workflow — they execute only when a local diff happens to select
them via touchfiles. CLAUDE.md says "periodic tests run weekly via cron," which the
matrix doesn't deliver. Decide: (a) expand the periodic matrix (or glob it) to all
periodic-tier files with a budget cap, (b) shrink the claim in CLAUDE.md and mark the
uncovered files as local-only, or (c) tier the orphans explicitly.

**Why:** The autoplan-dual-voice E2E was silently broken for months (claude >= 2.x
changed unregistered-slash-command handling) and nothing noticed until a docs PR's
touchfiles happened to select it locally (2026-07-09). Tests that never run anywhere
rot invisibly; each one found broken later costs a full /investigate session.

**Pros:** Kills the silent-rot class for ~57 test files; makes the CLAUDE.md tiering
claim true.
**Cons:** Full periodic coverage costs real money weekly (rough order: ~$1/file/run);
some orphans are deliberately manual (ios-device, opus-47 overlay harness), so a plain
glob is wrong — needs a curated exclude list.

**Fresh receipts (2026-08-16, v1.66.0.0 re-baseline):** the first full local
periodic run in this store gave the never-baselined tail its first results:
`skill-e2e-setup-gbrain-{bad-token,path4-local-pglite,remote}` all failed
(spawned-process exit 1 — likely live-gbrain interference on a dev box) and
`skill-e2e-ship-idempotency` timed out at the 1800s shard wall. None are in
the weekly matrix, so these failures are invisible to CI — exactly this
item's thesis. Start the burn-down with those four.

**Context / where to start:** `.github/workflows/evals-periodic.yml:71` (matrix),
`test/helpers/touchfiles.ts` E2E_TIERS (tier labels already exist per test), orphan
list generated via `comm -23` between `ls test/skill-e2e-*.test.ts` and the file lists
in `.github/workflows/evals*.yml`. Receipts from the autoplan incident:
`~/.gstack/projects/garrytan-gstack/e2e-runs/2026-07-10-0154/` (0-turn "Unknown command"
transcripts).

### Eval harness: live progress + incremental result persistence (kill the silent hour)

**Priority:** P1

**What:** `bun run test:evals` is observably silent for its entire runtime and
persists nothing until completion. Make the E2E harness (1) append a one-line
progress record per test START and END to a well-known heartbeat file (e.g.
`~/.gstack-dev/evals/.current-run.jsonl`), (2) write each test's eval-store
result incrementally instead of only at run end, and (3) flush per-test
pass/fail lines to stderr unbuffered so `bun test --concurrent` mega-file
buffering can't hide 50 minutes of legitimate progress.

**Why:** During the v1.57.11.0 ship, the diff-selected eval run (54 tests) was
killed ~50 min in and NOTHING distinguished the corpse from a healthy run for
hours: the log had zero test lines (per-file buffering across five mega
`skill-e2e-*.test.ts` files), `~/.gstack-dev/evals/` had zero new files
(results persist only on completion), and the only available liveness signal
(`pgrep "bun test --max-concurrency"`) false-positives on every sibling
free-suite shard. An agent or human watching the run has no honest signal.

**Pros:** Dead runs detected in minutes instead of hours; partial results
survive kills (a 50-min run that dies at test 40/54 keeps 40 results and can
resume); `eval:watch` gets a real data source.

**Cons:** Touches `test/helpers/session-runner.ts` + `eval-store.ts` (global
touchfiles — change triggers ALL eval tests on the next diff-selected run);
incremental writes need a PARTIAL marker so `eval:compare` doesn't treat a
dead run as a complete baseline.

**Context:** Root-caused 2026-06-12 during the v1.57.11.0 /ship. The run
itself was on pace (~50 min for 54 E2E tests at concurrency 15 is nominal);
the failure was pure observability. Related: the existing
`project_e2e_harness_observability` note (stream-json reasoning + tool traces
dropped on failure — same module, fix together). Start in
`test/helpers/session-runner.ts` (per-test lifecycle) and
`test/helpers/eval-store.ts` (persistence timing).

**Depends on / blocked by:** Nothing. Classify the new behavior under the
existing two-tier system; the heartbeat file must be safe under
`--concurrent` (append-only, one JSON line per event).

### ✅ DONE (v1.53.1.0): Rebaseline parity-suite (v1.44.1 → v1.53.0.0)

**What:** `test/parity-suite.test.ts` checked every skill's SKILL.md size against
the frozen `test/fixtures/parity-baseline-v1.44.1.json`. Five planning skills had
crept past the 1.05x ceiling: `plan-ceo-review` (1.052), `plan-eng-review` (1.062),
`plan-design-review` (1.068), `investigate` (1.053), `office-hours` (1.065) — growth
from the brain-aware-planning releases (v1.49–v1.52) plus the v1.53 redaction guard.

**Resolved:** Captured a fresh baseline at HEAD via
`bun run scripts/capture-baseline.ts --tag v1.53.0.0` and re-pointed the test at
`test/fixtures/parity-baseline-v1.53.0.0.json`. The per-skill 1.05 ratio is kept, so
future bloat is still caught — only the stale anchor moved. Mirrors the earlier
`skill-size-budget` rebase (v1.44.1 → v1.47.0.0). Historical v1.44.1 / v1.46.0.0 /
v1.47.0.0 baselines retained in `test/fixtures/` for the v1→v2 audit trail. The
captured skill bytes match `origin/main` exactly (the rebasing branch left every
SKILL.md untouched). `bun test` is green again.

## Scope-gate follow-ups (filed via /plan-eng-review on the plan-mode auto-select-B change)

### P2: SDK eval budgets charge API-queue latency to the work budget — pick a structural fix

**What:** `runSkillTest`'s single `setTimeout(timeout)` arms at spawn, so session
startup AND the model's first-completion queue time are charged against the
test's work budget. Under concurrent load (11 CI matrix jobs, or local eval
runs sharing the org API), a first completion can queue 60-90s+, producing the
deterministic `0 turns / $0.00 / <budget>s x3 attempts` failure shape. Observed:
`review-dashboard-via` (PR #2472, 180s→300s), `retro-base-branch` (240s→360s),
`plan-ceo-plan-mode` (300s→420s, 2026-08-12), `design-consultation-preview`
(90s→300s, PR #2533 CI). Every fix so far is a per-test budget bump.

**Why not just re-arm the timer on first stream event:** an audit (2026-08-12)
found ~100 outer bun-timeout literals sized as inner+30-60s; re-arming the inner
clock breaks every outer/inner relationship and needs a codemod of all of them.

**Options:** (a) two-phase timer in session-runner (startup grace, re-arm on
first NDJSON line) + codemod outer literals to inner+grace+slack; (b) adopt a
300s floor for all CI SDK budgets (statically enforceable — a free test can
assert no `timeout: <300_000` in skill-e2e files) and stop re-litigating per
test; (c) startup-spawn semaphore in the runner (bounds the boot stampede but
not API-side queuing — evidence says queuing dominates, so likely insufficient
alone). Recommend (b) short-term + (a) properly sequenced with the codemod.

**Depends on / blocked by:** none.

### P2: Wire the four demoted plan-mode/finding-floor PTY tests into periodic CI

**What:** `evals-periodic.yml` runs an explicit 9-file matrix; the four tests
demoted to `periodic` in v1.62.0.0 (`skill-e2e-plan-eng-plan-mode`,
`skill-e2e-plan-design-plan-mode`, `skill-e2e-plan-eng-finding-floor`,
`skill-e2e-plan-design-finding-floor`) are not in it, so they currently run
only locally/manually (`bun run test:periodic` or `eval:bg:periodic`). Wiring
them needs a PTY-capable periodic job: the container skill-registration setup
from evals.yml's `e2e-pty-plan-smoke` job (real-file SKILL.md copies for the
TUI's cross-mount symlink bug) with `EVALS_TIER=periodic`.

**Why:** Codex re-review P2 on the v1.62.0.0 ship. This is a named instance of
the existing periodic-orphans problem (see "P1/P2 periodic coverage" TODO in
Test infrastructure) — solve it there or here, once.

**Depends on / blocked by:** none; sibling of the periodic-orphans TODO above.

### P3: Extract the whole scope gate to a shared `{{SCOPE_GATE}}` resolver

**What:** Move the duplicated scope-gate prose (heading, intro sentence, the
plan-mode/named-target exceptions block, numbered items, the A/B/C menu, and the
Recommendation line) from `plan-eng-review/SKILL.md.tmpl` and
`plan-design-review/SKILL.md.tmpl` into a `scripts/resolvers/` module with 4-5
injected variant slots (preceded-by list, item-2 phrasing, option-C vocabulary,
recommendation tail, exceptions action tail).

**Why:** The two copies are hand-synced today. The drift-guard test in
`test/gen-skill-docs.test.ts` ("scope-gate exceptions drift-guard") makes the
duplication safe but is a stopgap — one source of truth is the real fix. Filed
as D5 of the eng review on the plan-mode auto-select-B change (2026-08-11).

**Pros:** Single source for a load-bearing gate; future gate changes (new
exceptions, wording tuning) land once.
**Cons:** Touches the resolver registry and its tests; must preserve the exact
generated bytes or re-baseline the carve/parity ceilings.

**Context / where to start:** structural-only diff, sequenced AFTER the
behavior change (refactor and behavior never together). The drift-guard test
becomes the migration's acceptance check: extract, regen, confirm byte-identical
output, then retire or simplify the guard. Effort: human ~half day / CC ~20 min.

**Depends on / blocked by:** the plan-mode auto-select-B PR landing on main.

## Token-reduction follow-ups (Phase B, filed via /plan-eng-review on the plan-ceo-review carve)

### P2: v1.70 ship-review deferrals (specialist + adversarial findings, each verified)

**What:** Follow-ups deferred from the v1.70.0.0 pre-landing review, none ship-blocking:

- **Batch the 11 `gstack-config get` forks in `bin/gstack-skill-start`** into one config
  read (~60-250ms of preamble latency per skill invocation, worse on macOS). The
  consolidation into one script is what makes batching trivial now.
- **Cache the `gbrain --version` probe** (Node CLI cold start, 100-300ms per invocation
  for gbrain users) keyed on binary path + mtime.
- **`bin/gstack-retro-metrics`: single-pass diffs** — combine the `--numstat` and `-p`
  passes (`git log --numstat -p`), unify the three test-file definitions (`is_test`,
  the awk regex, the repo-wide grep), and cover the `origin/<base>` ref preference +
  300-commit/40-coauthor truncation paths with tests.
- **Rename `generate-upgrade-check.ts`** — it now emits only PROACTIVE/SKILL_PREFIX
  rules; the name misleads anyone hunting for upgrade-prompt rendering.
- **evals.yml gate matrix drift:** 9 pre-existing gate-tier files in `E2E_TIERS` are
  absent from the static suite matrix, so they never run in PR CI. Add them (or prune
  their tier), plus a free tripwire test diffing gate-tier `E2E_TIERS` against the
  workflow matrix so the class can't recur.
- **`_sanitize` case/separator variants:** the strip is exact-literal; make it
  case-insensitive and separator-tolerant, with pinned variant cases.
- **Telemetry unset-vs-off semantics:** `gstack-skill-start` treats an UNSET telemetry
  key as enabled for the LOCAL analytics write (pre-consent recording, local-only);
  `gstack-telemetry-log` maps unset to off. Decide one semantic and document it.
- **Coverage gaps from the ship audit:** `--brain-health` block (zero tests), the
  learnings `>5`-entries sanitize passthrough (poison test), session prune +
  `.pending-*` finalize loop, and a shared `ONBOARDING_MARKERS` constant for the three
  seed sites (hermetic-env, e2e-helpers, the script's gates).

**Why:** Each was found by the v1.70 review army with file:line evidence; all are quality
or latency wins on the new runtime scripts, none change behavior contracts.

**Effort estimate:** M (human team) → S (CC+gstack)
**Priority:** P2
**Depends on / blocked by:** v1.70.0.0 landing.

### P3: Output-template carve wave — REVIEW_DASHBOARD + PLAN_FILE_REVIEW_REPORT

**What:** Carve the two output-format resolver blocks — the review dashboard table
shape and the plan-file report skeleton — out of the six skills that inline them
(`{{REVIEW_DASHBOARD}}` 5,940B ×6 + `{{PLAN_FILE_REVIEW_REPORT}}` 5,989B ×6,
~71.6KB total) into on-demand sections or a shared reference doc.

**Why:** Largest remaining duplicated block after the preamble program lands. These
are output TEMPLATES (table shapes, markdown skeletons), not behavioral steps — the
classic carve candidate.

**Pros:** ~1.4KB×2 saved per invocation across 6 review-family skills; single source
for the dashboard/report format.
**Cons:** Both blocks are partially pinned (`test/skill-e2e-review-attribution.test.ts`
slices `## Review Readiness Dashboard`; `test/skill-validation.test.ts:1566` asserts a
specific row) — needs a pin-relocation design first, which is why it was deferred from
the main program.

**Context:** Deferred from the token-reduction program's Phase 4 (plan on branch
`prompt-token-load-reduction`, "NOT carving" list). The carve pipeline and guard
registry to use are the same as carve wave 4. Start by mapping every test that slices
or asserts dashboard/report text, then decide skeleton-vs-section placement per pin.

**Effort estimate:** M (human team) → S (CC+gstack)
**Priority:** P3
**Depends on / blocked by:** Token-reduction program Phases 1-4 landing (carve
machinery churn would conflict).

### P3: Anchor transformFrontmatter's denylist strip to the frontmatter block

**What:** `transformFrontmatter` (scripts/gen-skill-docs.ts:525-530, denylist branch)
deletes the FIRST line matching `^<field>:` anywhere in the file, not just inside
the frontmatter block, and would orphan continuation lines of a block-style YAML
value. Slice the frontmatter, strip within it, reassemble.

**Why:** Latent mis-strip class: a skill body line beginning `interactive:` or
`benefits-from:` (e.g. a skill documenting the frontmatter contract) would be
silently deleted from the render. Zero live collisions today (verified across all
tracked SKILL.md bodies during the v1.69.x token-reduction Phase 0 review), but
each new stripFields entry widens the exposure.

**Pros:** Kills the whole latent class; makes stripFields safe to grow.
**Cons:** Touches the generator hot path — needs a full regen + the per-host
golden fixtures re-checked; deserves its own small PR, not a rider.

**Context:** Found by the Phase 0 adversarial review on branch
`prompt-token-load-reduction` (finding ADV4). The gen-side parser reads only
inline `[...]` array form (gen-skill-docs.ts:751), so block-form YAML for these
keys fails silently twice — worth a validation error at the same time.

**Effort estimate:** S (human team) → S (CC+gstack)
**Priority:** P3
**Depends on / blocked by:** none.

### P3: Revisit plan-ceo-review doctrine carve after the preamble program lands

**What:** Re-evaluate carving plan-ceo-review's ~13KB of always-loaded doctrine
(`## Prerequisite Skill Offer` 7,125B + `## Cognitive Patterns` 3,336B +
`## Philosophy` 2,535B) into its existing sections/ dir.

**Why:** Deferred from the token-reduction program because the skeleton had only
~555B of headroom under its carve-guard ceiling and the doctrine is behavior-core.
The preamble phases shrink the skeleton by ~22KB, which changes the tradeoff: the
ceiling gets recomputed and the doctrine becomes the dominant remaining always-loaded
block in the skill.

**Pros:** ~3.2K tokens off every /plan-ceo-review invocation if the doctrine reads
lazily without behavior loss.
**Cons:** The Cognitive Patterns section shapes the review voice throughout — a
requiredReads guard + A/B eval (same design as the design-doctrine carve) is mandatory,
and the answer may legitimately be "keep it inline."

**Context:** Filed from the token-reduction program's CEO review ("NOT carving" list).
Measure with `bin/gstack-context-bill --skill plan-ceo-review` after Phase 3 lands;
use the carve-guards registry + a behavioral loading eval if carved.

**Effort estimate:** S (human team) → S (CC+gstack)
**Priority:** P3
**Depends on / blocked by:** Token-reduction program Phase 3 (re-baseline + recomputed
carve ceilings).

## gbrowser memory follow-ups (filed via /plan-eng-review + /codex on the v1.49 leak-fix PR)

These four items came out of the memory-leak investigation that shipped
the `$B memory` diagnostic + the four leak fixes. They were
deliberately deferred from that PR (already 14 commits / ~12 files);
each stands alone and any one could ship independently.

### P2: MV3 extension service worker memory profile

**What:** The `/memory` endpoint snapshot enumerates pages but does
not enumerate the gstack baked-in extension's service-worker target.
A long-running MV3 service worker can leak through retained DOM
snapshots, message ports that never close, alarms that re-arm, and
caches that grow without bound. The diagnostic should call
`Target.getTargets` with a filter for `service_worker` and include
each one in `tabs[]` (or a sibling `serviceWorkers[]` array) with the
same `Performance.getMetrics` data.

**Why:** Codex's outside-voice review on the eng-review surfaced this
class of leak (the extension is part of the gbrowser process tree but
invisible to today's snapshot). Until we surface it, a SW leak shows
up only in the parent process RSS with no per-target attribution.

**Pros:** Closes the per-target attribution gap for the
single-most-likely future leak source (our own extension).
**Cons:** Extension SW lifecycle is asymmetric vs page lifecycle;
auto-attach + filter is one more piece of CDP plumbing.

**Context:** Codex finding #4 on the eng-review outside voice. Not
in scope of the v1.49 PR; deliberately deferred to keep the PR to
the four highest-confidence leak fixes.

**Priority:** P2. **Effort:** M.

---

### P2: Native + GPU memory breakdown in `$B memory`

**What:** `$B memory` shows Bun RSS + per-tab JS heap + Chromium
process tree (PIDs + types + CPU time) but the per-process RSS is
absent — `SystemInfo.getProcessInfo` doesn't expose RSS and the eng
review (D2 USE_CDP) explicitly chose CDP over shelling to `ps`. The
honest next step is to surface what CDP DOES give for the other
memory categories: `Memory.getDOMCounters` per target (node + listener
counts), `SystemInfo.getInfo` for GPU memory, `Memory.getAllTimeSamplingProfile`
for a sampled native estimate.

**Why:** Codex's outside-voice review flagged that
`Performance.getMetrics` misses native memory, GPU memory, video
buffers, Skia, network cache, extension process RSS, and
browser-process RSS — all the categories where a 160 GB leak would
actually live. A diagnostic that misses the categories where the
leak class lives undersells itself.

**Pros:** Per-process category breakdown closes the gap between
"Activity Monitor says 160 GB" and what the diagnostic shows.
**Cons:** Each CDP method has its own quirks; this is a real
implementation pass, not a one-line addition.

**Context:** Codex finding #5 on the eng-review outside voice. Not
in scope of the v1.49 PR; deliberately deferred.

**Priority:** P2. **Effort:** M.

---

### P3: Single-context CDP listener for Network.loadingFinished

**What:** `wirePageEvents` attaches a `page.on('requestfinished')`
listener PER PAGE. The D10 fix removed the body-materialization leak
inside that listener but kept the per-page listener architecture
(7 listeners attached per tab — close, framenavigated, dialog,
console, request, response, requestfinished). The stretch goal from
D10 was to replace the per-page `requestfinished` listener with a
single context-level CDP listener via
`Target.setAutoAttach({autoAttach: true, waitForDebuggerOnStart: false,
flatten: true})` and a browser-wide `Network.loadingFinished` event
handler.

**Why:** Going from N to 1 listener for the request-size capture is
structurally the right architecture and removes one piece of per-tab
memory pressure. The body-materialization fix already addressed the
acute leak; this is the architectural cleanup that prevents similar
leaks in the same class.

**Pros:** One listener per browser instead of one per tab.
**Cons:** `Target.setAutoAttach` plumbing is more code than the
straight per-page listener; the marginal memory win is small on top
of the body-fetch fix that already landed.

**Context:** D10 stretch goal on the eng-review. The minimal-risk
fix shipped in v1.49 (replaces `await res.body()` with
`await req.sizes()`, preserving the per-page listener); this is the
architectural follow-up.

**Priority:** P3. **Effort:** M-L.

---

### P3: Real-Chromium peak-RSS reproducer (periodic tier)

**What:** The gate-tier reproducer
(`browse/test/memory-leak-reproducer.test.ts`) pins the invariant
that `res.body()` is never called during a burst of
`requestfinished` events. It uses a fake page; it does NOT spin up a
real Chromium nor measure peak Bun RSS during a real concurrent fetch
burst. A periodic-tier follow-up should: spin up a real headless
Chromium, navigate to a fixture page that concurrently fetches 500
mixed responses (small JSON, 100 KB images, 10 MB chunked,
gzip-compressed 2 MB), sample `process.memoryUsage().heapUsed` every
100 ms during the burst, assert `peak_heap < 200 MB above baseline`
AND `post-gc_heap < 30 MB above baseline`. Also include a single-tab
WebGL canvas variant that grows to >4 GB and asserts the per-tab RSS
toast fires.

**Why:** Codex flagged that the leak's real failure mode is transient
amplification under concurrent burst, not retained leak — a steady-state
heap test misses it. The fake-page gate-tier test catches the
listener-architecture regression; the periodic real-browser test
catches the actual peak-RSS class.

**Pros:** Closes the "did we actually demonstrate the OOM is fixed"
question with hard numbers. Feeds the ANGLE_B_NUMBERS CHANGELOG
release-summary table.
**Cons:** Periodic tier costs minutes of CI time and money per run;
real-browser memory tests are inherently flaky.

**Context:** Codex outside-voice finding on the eng-review; D7
ANGLE_B_NUMBERS CHANGELOG framing needs this reproducer's numbers
before /ship time.

**Priority:** P3. **Effort:** M.

---

## design daemon: follow-ups (filed v1.45.0.0 via /ship review army)

### ✅ DONE (v1.45.0.0): Tighten daemon test coverage

**Resolved in commit `6b037c55` (same PR):** All 5 test gaps filled before
landing. Per-file totals after: serve 16, daemon 34, daemon-discovery 23,
feedback-roundtrip-daemon 4 = 77 (+10 from initial ship). Specifically:
- Idle-shutdown actually fires (spawn-based, daemon process observed exiting,
  state file removed).
- Bare GET polling doesn't reset idle (hammers `/api/progress` in background,
  daemon still idles out).
- Idle-with-active-boards extends, then force-shuts after MAX_EXTENSIONS
  (with `DESIGN_DAEMON_EXTENSION_MS=1500` + `MAX_EXTENSIONS=2`).
- Concurrent `ensureDaemon()` race converges on one daemon (lock wins).
- Stale-lock reclaim (dead PID succeeds, alive unrelated PID refuses).
- Malformed-JSON + non-object + array-body + missing-html negatives for
  `POST /api/boards` and `POST /boards/<id>/api/reload`.

### P3: Minor maintainability nits from /ship review

- `design/src/cli.ts` and `design/src/serve.ts` both have a small `openBrowser`
  helper with identical darwin/linux/else branches. Extract a shared
  `design/src/open-browser.ts`.
- `design/src/daemon-client.ts:320` (`AbortSignal.timeout(2000)`) and `:357`
  (`delay(50)`) use bare numeric literals while sibling timeouts are named
  constants. Promote to `SHUTDOWN_POST_TIMEOUT_MS` and `ALIVE_POLL_INTERVAL_MS`.
- `design/src/daemon-state.ts:21` `serverPath` field is written
  (`daemon.ts:541`) but never read by production code. Either remove or
  document the forensic intent.

### P3: Daemon scope deferred from v1.45.0.0 plan

Originally listed in the plan's "TODOs surfaced for later" section:

- Per-daemon scoped auth tokens (only relevant once a tunnel/share use case appears).
- Optional persistent board history on disk in
  `~/.gstack/projects/$SLUG/designs/history/` so submitted boards survive
  daemon restarts.
- Windows spawn branch lifted from browse (V1 daemon is macOS + Linux;
  Windows users fall back to legacy `--no-daemon` per-process server).
- `$D board list` / `$D board stop <id>` per-board ops CLI (V1 has only
  `$D daemon status` / `stop`).
- Cross-worktree daemon attach (conductor sibling worktrees of the same
  repo currently each spawn their own daemon — matches browse; revisit
  if it causes friction).

---

## Codex model profiles: follow-ups (filed v1.67.2.0 via /ship review army)

### P2: Single owner for the Codex render model (persist the resolved profile)

**What:** `./setup` resolves the Codex generation model from config.toml on every
run, but every OTHER regeneration surface (`bun run build`, direct
`gen:skill-docs --host codex`, the free suite's tree-mutating shard) renders the
host default (gpt), silently reverting a Sol user's live symlinked render until
the next setup. Persist the resolved model (gstack-config key or marker file the
generator reads when `--model` is absent for codex) so all surfaces agree.
**Why:** A Sol-using contributor cannot keep both a correct install and a green
free suite in one tree; CLAUDE.md's "Deploying to the active skill" flow
(bun run build) downgrades the profile. Cross-model consensus finding
(Claude adversarial M4, Codex adversarial P2, red team C-70).
**Priority:** P2. **Effort:** S (human ~half day / CC ~20min).

### P3: Codex periodic CI shards never execute (no codex CLI in Dockerfile.ci)

**What:** `evals-periodic.yml` carries `e2e-codex`, and now `e2e-codex-sol-scope`,
but the CI image installs only claude-code, so both shards boot, skip everything,
and report green weekly. Either bake `@openai/codex` + an auth strategy into the
image, or prune both matrix entries and document codex evals as local-only.
**Why:** A green all-skip shard reads as coverage that does not exist.
**Priority:** P3. **Effort:** M (auth strategy is the hard part).

### P3: `--model` override persistence across upgrades

**What:** `./setup --host codex --model <id>` applies to that run only; the
upgrade flow re-resolves from config.toml. Setup now prints the persistence
hint (set `model` in config.toml). If users keep tripping on it, persist the
override in `~/.gstack/config.yaml` and read it between `--explicit` and the
TOML lookup.
**Why:** Explicit user choices should survive upgrades or say loudly that they
will not (the hint covers the second half today).
**Priority:** P3. **Effort:** S.

---

## browse server: terminal-agent teardown follow-ups (filed v1.41 via /plan-eng-review)

### ✅ DONE (v1.44.0.0): Identity-based terminal-agent kill (replace pkill regex with PID)

**Resolved:** Bundled into the v1.44.0.0 long-lived-sidebar PR as Commit 0.
`browse/src/terminal-agent-control.ts` is the new home for `readAgentRecord`,
`writeAgentRecord`, `clearAgentRecord`, and `killAgentByRecord`. The agent
writes `<stateDir>/terminal-agent-pid` (JSON `{pid, gen, startedAt}`) at boot
and clears it on SIGTERM/SIGINT. `cli.ts` and `server.ts` both route through
`killAgentByRecord` instead of `pkill -f terminal-agent\.ts`. The new
`browse/test/terminal-agent-pid-identity.test.ts` is the static-grep tripwire
that fails CI if `pkill ... terminal-agent` or `spawnSync('pkill', ...)`
reappears in any source file.

---

### P3: shutdown() reads module-level `config`, not `cfg.config` (composition gap)

**What:** `browse/src/server.ts:shutdown()` reads `path.dirname(config.stateFile)`
where `config` is the module-level value resolved at import time, not the
`cfg.config` passed into `buildFetchHandler`. Same gap applies to
`cleanSingletonLocks(resolveChromiumProfile())` at server.ts:1298 — should
read `cfg.chromiumProfile`.

**Why:** Embedders today happen to share state-dir resolution with the CLI
(both go through `resolveConfig()` against the same env), so this doesn't
bite. But if an embedder ever passes a divergent `cfg.config` (e.g., a test
harness pointing at a temp dir), shutdown will operate on the wrong paths.
The `ownsTerminalAgent` flag exposes the problem without fixing it.

**Pros:** Closes the embedder-composition story properly. Pairs with
`cfg.chromiumProfile` to give a single coherent "this factory teardown
respects cfg" contract.

**Cons:** Pre-existing — not a regression. Two call sites today (1285 for
terminal files, 1298 for chromium locks). Threading `cfg.config` and
`cfg.chromiumProfile` into the right closures is straightforward but
broader than the v1.41 fix.

**Context:** Flagged by both Codex and Claude subagent in the /plan-eng-review
dual voices. Documented as out-of-scope in the v1.41 plan; same shape as the
`chromiumProfile` PR-body note to the gbrowser team.

**Depends on:** None.

---

### P3: Ownership-object refactor if a 4th caller-owned teardown gate appears

**What:** Today `ServerConfig` has three caller-owned teardown gates:
`xvfb?` (presence ⇒ don't close), `proxyBridge?` (same), and now
`ownsTerminalAgent` (explicit boolean). If a 4th gate appears, collapse to
`cfg.callerOwns?: Set<'terminalAgent' | 'xvfb' | 'proxyBridge' | ...>` or
similar.

**Why:** Three independent flags is below the refactor threshold — each
field has clear, distinct semantics and the JSDoc voice is consistent. A
fourth tips the cost balance: the per-field surface gets noisy, and
"what does this factory own?" becomes a question you have to ask of three
or four scattered fields instead of one explicit set.

**Pros:** Single source of truth for "what gstack tears down". Trivial
extension surface for future caller-owned resources. Easier to assert in
tests ("the set should contain X, not Y").

**Cons:** Premature today. The polarity-inversion note in the
`ownsTerminalAgent` JSDoc only hurts a little — it's one anomaly, not a
pattern. Refactoring now to an ownership object would touch every embedder.

**Context:** Recommended by Claude subagent during /plan-ceo-review dual
voice (autoplan). Trigger: a 4th caller-owned teardown gate in this same
`ServerConfig` shape.

**Depends on:** A 4th gate to motivate the refactor.

---

## /sync-gbrain memory stage perf follow-up

### P2: Investigate `gbrain import` perf on large staging dirs

**What:** Cold-run time on a 5131-file staging dir is >10 min in `gbrain import`
alone (after gstack's prepare phase, which is now <10s after dropping per-file
gitleaks). On 501 files it took 10s. The scaling is worse than linear and the
bottleneck is inside gbrain, not the gstack orchestrator.

**Why:** With memory-ingest's prepare phase now fast, the remaining cold-run cost
is entirely on the gbrain side. Users with large corpora (5K+ files) currently pay
~15-30 min on first ingest. Likely culprits in `~/git/gbrain/src/core/import-file.ts`:

- N+1 SQL queries: `engine.getPage(slug)` for each file's content_hash check
  (line 242 + 478) — should be batched into a single query
- Per-page auto-link reconciliation that fires even for unchanged content
- FTS / vector index updates without batching transactions

**Pros:** Lives in gbrain (cleaner separation). Fix in gbrain benefits other
gbrain callers too (`gbrain sync`, MCP `put_page` workflows). Likely 10-50x
speedup from batched queries alone.

**Cons:** Cross-repo change, requires gbrain test coverage for the new batched
path. Not on the gstack critical path; gstack's architecture is already correct.

**Context:** Verified on real corpus 2026-05-10. gstack-side prepare with
`--scan-secrets` off runs in <10s. The full gbrain import on the same staged
dir consumes 100% CPU for >10 min. Both observations from
`bin/gstack-memory-ingest.ts:ingestPass` reaching the `runGbrainImport` call
quickly, then the child process taking the bulk of the wall time.

**Depends on:** None — gstack's batch-ingest architecture (D1-D8 in
`docs/designs/SYNC_GBRAIN_BATCH_INGEST.md`) is already shipped and correct.

---

### P3: Cache "no changes since last import" at the prepare-batch level

**What:** Even with the prepare phase fast (<10s for 5135 files), walking and
mtime-stat'ing every file on a true no-op run adds a few seconds and creates
spurious staging dirs. Cache the most-recent-source-mtime per-source in the
state file; if no source dir has a newer mtime, skip the walk + stage + import
entirely.

**Why:** Most `/sync-gbrain` invocations have nothing new to ingest. The
fastest path is "do nothing, fast." `gbrain doctor` should still report state,
but the actual ingest pipeline can short-circuit when last_full_walk is recent
and no source-tree mtime has moved.

**Pros:** Trivial implementation (~20 lines in `ingestPass`). Makes the
incremental fast-path actually live up to "<30s" in the original plan.

**Cons:** Adds a cache invalidation surface. If a user edits a file but its
parent dir's mtime doesn't update (rare on macOS APFS), changes get missed.
Mitigation: only short-circuit when last_full_walk is recent (e.g. <1 min ago).

**Context:** Filed during 2026-05-10 perf testing after `--scan-secrets` was
made opt-in. Lower priority than the gbrain-side perf issue above.

---

## Browser-skills follow-on (Phases 2-4)

### P1: Browser-skills Phase 2 — `/scrape` and `/skillify` skill templates

**What:** Phase 2a of the browser-skills design (`docs/designs/BROWSER_SKILLS_V1.md`). Two new gstack skills: `/scrape <intent>` (read-only) is the single entry point for pulling page data — first call prototypes via `$B` primitives, subsequent calls on a matching intent route to a codified browser-skill in ~200ms. `/skillify` codifies the most recent successful prototype into a permanent browser-skill on disk: synthesizes `script.ts` + `script.test.ts` + fixture from the agent's own context (final-attempt $B calls only), runs the test in a temp dir, asks before committing, atomic rename to `~/.gstack/browser-skills/<name>/`. The mutating-flow sibling `/automate` is split out as its own P0 (below) — same skillify pattern, different trust profile.

**Why:** Phase 1 shipped the runtime — humans can hand-write deterministic browser scripts that gstack runs. Phase 2a unlocks the productivity gain: an agent that gets a flow right once via 20+ `$B` commands says `/skillify` and the script becomes a 200ms call forever after. Same skillify pattern Garry's articles describe, applied to the read-only browser activity (scraping) most amenable to deterministic compression. Mutating actions ship next as `/automate` because the failure mode (unintended writes) needs stronger gates.

**Pros:** The 100x productivity gain lives here. Closes the loop: agents prototype, codify, then reach for the codified skill in future sessions instead of re-exploring. Replaces the original "self-authoring `$B` commands" P1 — same user-visible goal, no in-daemon isolation problem (skill scripts run as standalone Bun processes, never imported into the daemon). Synthesis question (Codex finding #6) is resolved by re-prompting from the agent's own conversation context (option b in the design doc), bounded to final-attempt `$B` calls per `/plan-eng-review` D2.

**Cons:** **Bun runtime distribution** (Codex finding #7). Phase 1 sidesteps this because the bundled reference skill ships inside the gstack install. User-authored skills land on machines without Bun unless we ship a runtime alongside, compile to a self-contained binary, or use Node + the existing `cli.ts` pattern. Deferred to Phase 4 — `/skillify` documents the assumption that gstack is installed (which means Bun is on PATH).

**Context:** The Phase 1 architecture (3-tier lookup, scoped tokens, sibling SDK, frontmatter contract) is locked and exercised by the bundled `hackernews-frontpage` reference skill. Phase 2a plugs `/scrape` and `/skillify` into that runtime via two skill templates plus one new helper (`browse/src/browser-skill-write.ts` for atomic temp-dir-then-rename per `/plan-eng-review` D3) — no new storage primitives.

**Effort:** M (human: ~1 week / CC: ~1 day)
**Priority:** P1 (this branch — `garrytan/browserharness` shipping as v1.19.0.0)
**Depends on:** Phase 1 shipped (this branch).

---

### P2: Browser-skills Phase 3 — resolver injection at session start

**What:** Mirror the domain-skill resolver at `browse/src/server.ts:722-743`. When a sidebar-agent session starts on a host with matching browser-skills, inject a list block telling the agent which skills exist for that host and how to invoke them (`$B skill run <name> --arg ...`). UNTRUSTED-wrapped via the existing L1-L6 security stack. Add `gstack-config browser_skillify_prompts` knob (default `off`) controlling end-of-task nudges in `/qa`, `/design-review`, etc. when activity feed shows ≥N commands on a single host AND no skill exists yet for that host+intent.

**Why:** Without the resolver, browser-skills only work when the user explicitly types `$B skill run <name>`. With the resolver, agents auto-discover existing skills for the current host and reach for them instead of re-exploring. Same compounding pattern as domain-skills.

**Pros:** Closes the discoverability gap. Agents that wouldn't know a skill exists now see it in their system prompt automatically. End-of-task nudges (opt-in via knob) catch the moments where skillify is most valuable.

**Cons:** The resolver block lives in the system prompt and competes with other resolver blocks for prompt budget. Need to gate carefully so it doesn't fire on every host with a skill — only when the skill is plausibly relevant to the current task. v1.8.0.0 domain-skills handles this by only firing for the active tab's hostname; same pattern here.

**Effort:** S (human: ~3 days / CC: ~4 hours)
**Priority:** P2
**Depends on:** Phase 2.

---

### P2: Browser-skills Phase 4 — eval infrastructure + fixture staleness + OS sandbox

**What:** Three loosely-coupled extensions: (a) LLM-judge eval ("did the agent reach for the skill instead of re-exploring?"), classified `periodic` per `test/helpers/touchfiles.ts`. (b) Fixture-staleness detection — periodic comparison of bundled fixtures against live pages, flagging mismatches before they break tests silently. (c) OS-level FS sandbox for untrusted spawns: `sandbox-exec` profile on macOS, namespaces / seccomp on Linux. Drops in cleanly behind the existing trusted/untrusted contract (Phase 1 just stripped env; Phase 4 adds real FS isolation).

**Why:** Phase 1's trust model has the daemon-side capability boundary right (scoped tokens) but the process-side env scrub is hygiene, not a sandbox (Codex finding #1). For genuinely untrusted skills (Phase 2 agent-authored), real FS isolation matters. Eval + fixture staleness keep the skill quality bar honest as flows drift.

**Pros:** Closes the last credible attack surface from Codex finding #1 (FS read of `~/.ssh/id_rsa` etc.). Eval data tells us whether the resolver injection is actually working. Fixture staleness catches HTML drift before users.

**Cons:** Three different concerns, three different design passes. Tempting to bundle. Resist: each can ship independently. OS sandbox is the hardest piece (macOS `sandbox-exec` is Apple-private but stable; Linux requires namespaces + bind mounts).

**Effort:** L (human: ~2-3 weeks / CC: ~3-5 days)
**Priority:** P2
**Depends on:** Phase 2 (need agent-authored skills to motivate sandbox); Phase 3 (eval needs resolver injection).

---

### P2: Migrate `/learn` to SQLite

**What:** The current `~/.gstack/projects/<slug>/learnings.jsonl` storage works (append-only, tolerant parser, idle compactor) but Codex outside-voice (T5) flagged JSONL as "the wrong primitive" for multi-writer canonical state: lost-update on rewrite, partial-line corruption on crash, no transactions. v1.8.0.0 hardened JSONL with flock + O_APPEND but the right long-term primitive is SQLite (which Bun has built in via `bun:sqlite`).

**Why:** Domain skills now live in the same `learnings.jsonl` (per CEO D1 unification). As volume grows, the JSONL hardening compactor + tolerant parser approach becomes the long pole. SQLite gives atomic transactions, indexes (huge for hostname lookup), and crash-safety without a custom compactor.

**Pros:** Atomic writes. Real schema. Fast indexed lookups by hostname/key/type. Crash-safe.

**Cons:** Migration touches every consumer of `learnings.jsonl` — `/learn` scripts (`gstack-learnings-log`, `gstack-learnings-search`), domain-skills.ts read/write, gbrain-sync (which currently treats it as a flat file). Old `learnings.jsonl` files in the wild need a one-shot migration script.

**Context:** The JSONL hardening in v1.8.0.0 was the right call for that release scope (preserve unification, not boil-the-ocean). But the failure modes are bounded, not eliminated. SQLite is the boil-the-ocean fix.

**Effort:** M (human: ~1 week / CC: ~1 day)
**Priority:** P2
**Depends on:** v1.8.0.0 in production for ~1 month to measure JSONL pain (compactor frequency, partial-line drops, write contention).

---

### P2: Remove plan-mode handshake from `/plan-devex-review` SKILL.md.tmpl

**What:** `/plan-devex-review` has a "Plan Mode Handshake" section at the top that contradicts the preamble's "Skill Invocation During Plan Mode" contract (which says AskUserQuestion satisfies plan mode's end-of-turn requirement). The handshake forces an extra exit-plan-mode step that no other interactive review skill needs. `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review` all run fine in plan mode without it.

**Why:** Found during the v1.8.0.0 DevEx review. The inconsistency cost a turn and confused the flow. Either remove the handshake from `plan-devex-review` (clean fix, recommended) OR add it to every interactive skill for consistency.

**Pros:** Fixes a real DX bug for anyone running `/plan-devex-review` in plan mode. Five-minute change.

**Cons:** Need to think about WHY it was added in the first place — there may be context this TODO is missing.

**Context:** The handshake section in `plan-devex-review/SKILL.md.tmpl` says it's needed because plan mode's "this supersedes any other instructions" warning could otherwise bypass the skill's per-finding STOP gates. But the same warning exists for the other review skills, and they all work fine because AskUserQuestion satisfies the end-of-turn contract.

**Effort:** S (human: ~15 min / CC: ~5 min)
**Priority:** P2
**Depends on:** Nothing.

---

### P2: Bump gbrain install-pin in lockstep with gstack memory-feature releases (#1305 part 2)

**What:** `bin/gstack-gbrain-install` pins gbrain to commit `08b3698` (v0.18.2). When gstack ships features that depend on newer gbrain ops or schema (e.g. v1.26.0 manifests + `code-def`/`code-refs`/`reindex-code`), the pin doesn't move with it. Fresh `/setup-gbrain` installs an old gbrain that fails `gbrain doctor` schema_version checks (24 vs latest 32+) until the user manually upgrades.

**Why:** Filed in #1305 alongside the `put_page` CLI bug. Out of scope for the v1.26.5.0 fix wave (separate release-coordination concern: which gbrain version we install vs. how we call it). The install-pin should either (a) auto-bump whenever gstack releases features that need newer gbrain, or (b) detect a stale pin during preamble and either auto-upgrade gbrain or print a one-line FIX hint.

**Pros:** Closes the "fresh-install paper-cut" path. New users land on a healthy schema. Reduces support noise on `/setup-gbrain` flows. Makes the gstack/gbrain release contract visible.

**Cons:** Adds release-cadence coupling between gstack and gbrain. Needs a policy: pin = "minimum version that still works" vs "latest known good." If gbrain ships a breaking change to `put` shape and gstack doesn't update the pin, fresh installs break in a new way.

**Context:** Issue #1305 part 1 (the `put_page` CLI verb bug) was handled in v1.26.5.0. Part 2 (this TODO) is the install-pin staleness. Pin lives in `bin/gstack-gbrain-install` near the top as a constant. Easiest minimal fix: ship the pin as a tracked release artifact (e.g. write it from `package.json` at build time) and add a doctor-style preamble check.

**Effort:** S (human: ~2 days / CC: ~3 hours)
**Priority:** P2
**Depends on:** Nothing.

---

### P3: Source-id host-collision risk in `deriveCodeSourceId` (cross-host duplicate org/repo)

**What:** v1.26.5.0's `deriveCodeSourceId` drops the host segment to fit gbrain's 32-char source-id budget. This means `github.com/acme/foo` and `gitlab.com/acme/foo` collapse to the same `gstack-code-acme-foo`. `ensureSourceRegisteredSync()` in `bin/gstack-gbrain-sync.ts:323` will silently re-register the source when `local_path` differs, evicting one side.

**Why:** Vanishingly rare in practice — same `<org>/<repo>` shape across both github.com and gitlab.com on the same machine almost never happens. But the failure mode is silent (one repo evicts the other in the brain), and the user has no signal anything is wrong.

**Pros:** Closes the silent-eviction edge. Two viable approaches: short host marker (`gh-` / `gl-` / `bb-`) eats 3 chars but keeps cross-host uniqueness; OR include a 3-char hash of the host alongside the org-repo.

**Cons:** Source IDs change shape again — anyone with existing registrations on v1.26.5.0 gets a one-time re-register. Net break-even because the current scheme also changed from v1.26.4.0.

**Context:** Filed in #1320 / #1322 / #1323 / #1331 (the underlying source-id validation bugs), addressed in v1.26.5.0 by dropping host segment + hash-truncating. Cross-host collision was a known accepted tradeoff in PR #1330's design ("vanishingly rare in practice"). Codex outside-voice plan review surfaced it as a long-tail concern; this TODO captures it for a future bump.

**Effort:** XS (human: ~4 hours / CC: ~30 min)
**Priority:** P3
**Depends on:** Nothing.

---

### P3: GBrain skillpack publishing for domain skills

**What:** Domain skills are agent-authored notes per hostname. Right now they're per-machine or per-agent-repo. The natural compounding extension: publish curated skill packs to GBrain (`gstack-brain-sync`) so others can subscribe. "Louise's LinkedIn skills" or "Garry's GitHub skills" become packs anyone can pull.

**Why:** v1.8.0.0 gets us per-machine compounding. Cross-user compounding is the network effect — every user contributes, every user benefits.

**Pros:** Massive compounding potential. Hard part is trust/moderation (existing problem GBrain-sync has thought through).

**Cons:** Publishing infra, signature/redaction model, moderation when packs go bad. Real plan needed.

**Context:** GBrain-sync infra (v1.7.0.0) already does private cross-machine sync for the user's own data. Skillpack publishing is the public/shared layer on top of that.

**Effort:** M (human: ~1 week / CC: ~1 day)
**Priority:** P3
**Depends on:** GBrain-sync stable in production. Some user demand signal first.

---

### P3: Replay/record demonstrated flows to domain-skills

**What:** Watch a human drive a site once (record DOM events + screenshots + nav), generalize to a domain-skill. "Teach by showing." Different research dream than v1.8.0.0's per-site notes.

**Why:** The highest-quality skill content is one a human demonstrated, not one the agent figured out from scratch. Pairs with skillpack publishing — recorded flows are the most valuable packs.

**Pros:** Skill quality jumps. Some sites are too complex for an agent to figure out alone (multi-step OAuth, captcha-gated forms).

**Cons:** Record fidelity vs. selector stability over time. DOM changes break recordings. Real research needed.

**Context:** Browser-use has experimented with this. Playwright has a recorder. Codeception/Cypress recorders exist. None of them do the "generalize the recording into a markdown note" step.

**Effort:** L (human: ~2-3 weeks / CC: ~2-3 days)
**Priority:** P3
**Depends on:** Probably its own `/office-hours` session before committing eng time.

---

### P3: `$B commands review` batch-mode UX

**What:** Originally an alternative for the inline-on-first-use approval gate (DevEx D6 alternative C). Instead of approving each agent-authored command at first invocation, batch them: agent scaffolds many, human reviews `$B commands review` at a convenient time, approves/rejects in one pass.

**Why:** If self-authoring commands ever ships (the P1 above), the inline approval at first-use can interrupt the agent mid-task. Batch review is friendlier for the human.

**Pros:** Reduces interrupt frequency. Lets humans review with full context.

**Cons:** Defers approval — agent can't use the new command until the human comes back. If the agent needs the command immediately, this is worse than inline.

**Context:** Tied to the P1 above. Won't ship before that does.

**Effort:** S (human: ~half day / CC: ~30 min)
**Priority:** P3
**Depends on:** P1 self-authoring `$B` commands.

---

### P3: Heuristic command-gap watcher

**What:** Sidebar-agent watches the activity feed; when an agent repeats a similar action 3+ times (e.g., calls `$B js` with structurally similar arguments), suggest scaffolding a command. From DevEx D4 alternative C.

**Why:** Closes the discoverability loop on self-authoring commands. Agent is most likely to write a command when it just hit the same friction multiple times.

**Pros:** Surgical. Fires only when a command would have demonstrably helped. Uses real telemetry, not heuristics.

**Cons:** False positives (legitimate repeated actions) feel intrusive. Hard to design without telemetry first.

**Context:** Telemetry from v1.8.0.0 (`cdp_method_called`, `cdp_method_denied` counters) gives us the data to design this well. Don't design until we have ~1 month of production data.

**Effort:** M (human: ~1 week / CC: ~1 day)
**Priority:** P3
**Depends on:** v1.8.0.0 telemetry in production. P1 self-authoring commands.

---
## Sidebar Terminal (cc-pty-import follow-ups)

### v1.1: PTY session survives sidebar reload

**What:** Today the Terminal tab's PTY dies with the WebSocket — sidebar
reload, side-panel close, even a quick navigate-away in another tab close
the session. v1.1 should key the PTY on a tab/session id so a reload
reattaches to the existing claude process and you keep `/resume` history.

**Why:** Mid-task resilience. When you've been pair-programming with claude
for 20 minutes and an accidental Cmd-R blows it away, the cost is real.

**Pros:** Better UX, fewer interrupted sessions. **Cons:** Session-tracking
state, ghost-process risk, lifecycle bugs (when DOES the PTY actually go
away?). v1 chose the simple "PTY dies with WS" model deliberately.

**Context:** /plan-eng-review Issue 1C decision (cc-pty-import branch,
2026-04-25). v1 ships with phoenix's lifecycle. **Depends on:**
cc-pty-import landed.

**Priority:** P2 (nice-to-have).
**Effort:** M. Likely needs a per-tab session map keyed by chrome.tabs.id
plus a TTL so abandoned PTYs eventually exit.

---

## Testing

## P2: Per-finding AskUserQuestion count assertion for /plan-ceo-review

**What:** PTY E2E test that drives /plan-ceo-review through Step 0 with a stable fixture diff containing N known findings, asserts that exactly N distinct AskUserQuestions fire (one per finding) before plan_ready.

**Why:** The skill template repeats "One issue = one AskUserQuestion call. Never combine multiple issues into one question." at every review checkpoint. No test enforces it. The current `skill-e2e-plan-ceo-plan-mode.test.ts` smoke (post-v1.21.1.0) only catches "agent skipped Step 0 entirely." Batching findings into one question slips through silently.

**Pros:** Locks in the strongest contract the skill mandates. Catches a real failure mode (the original attachment showed 2 findings batched as 0 questions).
**Cons:** Needs a stable fixture diff to keep finding count deterministic (~1 day human / ~30 min CC). Opus may reasonably consolidate two related findings, so the assertion needs a forgiving lower bound (e.g., `>= ceil(N * 0.6)`) rather than strict equality.

**Context:** The PTY harness (`runPlanSkillObservation`) returns at first terminal outcome — for V2 we need a streaming variant that counts AskUserQuestions across the whole session up to `plan_ready`. Probably a new helper alongside `runPlanSkillObservation`.

**Depends on:** Stable fixture diff (`test/fixtures/plans/multi-finding.diff` or similar) with a small known set of issues that triggers all 4 review sections.

**Priority:** P2.
**Effort:** S (CC: ~30 min once fixture exists). Captured from v1.21.1.0 plan-eng-review D2.

---

## P3: Honor env vars in gstack-config (so QUESTION_TUNING/EXPLAIN_LEVEL actually isolate tests)

**What:** `gstack-config get <key>` reads `~/.gstack/config.yaml`. `runPlanSkillObservation` plumbs `env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' }` through to the spawned `claude` process — but the skill preamble bash uses `gstack-config get question_tuning`, which never looks at env. The env passthrough is theater on current code.

**Why:** Without env honoring, the v1.21.1.0 plan-ceo-review smoke is still flaky on machines with `question_tuning: true` set in YAML. AUTO_DECIDE preferences would skip the rendered AskUserQuestion list, masking the regression we want to catch.

**Pros:** Makes the gate test hermetic across machines. The env wiring is already in place — only `gstack-config` needs to read env first, fall back to YAML.
**Cons:** Touches the gstack-config binary across all 3 platforms (linux/darwin/windows). Cross-binary refactor.

**Context:** Captured from v1.21.1.0 adversarial review. Documented honestly in the test docstring as a known limitation.

**Priority:** P3.
**Effort:** S. Single-file edit to `bin/gstack-config` (~10 LOC for env-first lookup).

---

## P3: Path-confusion hardening on SANCTIONED_WRITE_SUBSTRINGS

**What:** `runPlanSkillObservation`'s silent-write detector uses substring matching on a few sanctioned paths (`.gstack/`, `CHANGELOG.md`, `TODOS.md`, etc). A write to `node_modules/some-pkg/CHANGELOG.md` or `src/foo/.gstack/leak.ts` is currently sanctioned because the substring matches anywhere in the path.

**Why:** Defensive — no current bug exploits this, but a malicious skill or fixture could write to a path that happens to contain `.gstack/` or `CHANGELOG.md` and slip past silent-write detection.

**Pros:** Hardens the harness against future skill misbehavior. Aligns substring rules with their intent.
**Cons:** Need to anchor against absolute prefixes (`os.homedir() + '/.gstack/'`, worktree root) which makes the test less portable across machines.

**Context:** Captured from v1.21.1.0 adversarial review (HIGH/FIXABLE finding, pre-existing). Refactored into a `SANCTIONED_WRITE_SUBSTRINGS` constant in v1.21.1.0 but the substring-includes logic is unchanged from before.

**Priority:** P3.
**Effort:** S.

---

## P1: Structural STOP-Ask forcing function across all skills

**What:** Design and implement a structural forcing function that catches when a skill mandates per-issue AskUserQuestion but the model silently substitutes batch-synthesis. Candidate mechanisms: question-count assertion (skill declares expected question count in frontmatter; post-run audit logs if model fired <N), typed question templates (skill hands the model pre-built AskUserQuestion payloads rather than prose instructions), or a canUseTool-based post-run audit that compares declared-gates-fired vs expected.

**Why:** The authoritative "Skill Invocation During Plan Mode" rule (hoisted to preamble position 1) tells the model AskUserQuestion satisfies plan mode's end-of-turn requirement. That fixes plan-mode entry, but NOT the broader class of failures: the model silently substitutes batch-synthesis for STOP-Ask loops whenever the skill's interactive contract collides with any other rule surface (auto mode, tool-count anxiety, cognitive load). Without structural enforcement, every skill with STOP-per-issue contracts remains vulnerable.

**Pros:** Catches a class-of-bug, not an instance. Applies to every skill that declares STOP gates. Builds on `canUseTool` primitive in `test/helpers/agent-sdk-runner.ts`.

**Cons:** Real design work. How does a skill declare expected question count — static value in frontmatter, or dynamic based on number of review sections that surface findings? Is the audit inline (blocking, same-turn) or post-hoc (after skill completion)? Calibration of expected-vs-actual thresholds depends on real V0 question-log data across skills.

**Context:** Relevant files — `scripts/question-registry.ts` (typed question catalog), `scripts/resolvers/question-tuning.ts` (preference classification), `bin/gstack-question-log` (event log), `bin/gstack-question-preference` (read/write preferences), `test/helpers/agent-sdk-runner.ts` (canUseTool harness). Existing question-log already captures fire events; the gap is declaring expected counts and auditing against them.

**Effort:** L (human: ~1-2 weeks / CC+gstack: ~2-3 hours for design doc + first-pass implementation).
**Priority:** P1 if interactive-skill volume is growing; P2 otherwise.
**Depends on / blocked by:** design doc — likely its own `docs/designs/STOP_ASK_ENFORCEMENT_V0.md`.
## Context skills

### `/context-save --lane` + `/context-restore --lane` for parallel workstreams

**What:** Let users save and restore per-workstream (lane) context independently. On save: `/context-save --lane A "backend refactor"` writes a lane-tagged file. Or `/context-save lanes` reads the "Parallelization Strategy" section of the most recent plan file and auto-generates one saved context per lane. On restore: `/context-restore --lane A` loads just that lane's context. Useful when a plan has 3 independent workstreams and the user wants to pick one up in each of 3 Conductor windows.

**Why:** Plans produced by `/plan-eng-review` already emit a lane table (Lane A: touches `models/` and `controllers/` sequentially; Lane B: touches `api/` independently; etc.). Right now there's no way to transfer that structure into resumable saved state. Users manually re-describe the scope in each window. Lane-tagged save/restore would be the bridge between "here's the plan" and "three people (or three AIs) are now working in parallel on it."

**Pros:** Turns `/plan-eng-review`'s parallelization output into actionable resume state. Reduces context-loss across Conductor workspace handoffs for multi-workstream plans.

**Cons:** Net-new functionality (not a port from the old `/checkpoint` skill). The "spawn new Conductor windows" part needs research into whether Conductor has a spawn CLI. Also requires lane-tagging discipline in the save step (manual or extracted).

**Context:** Source of the lane data model is `plan-eng-review/SKILL.md.tmpl:240-249` (the "Parallelization Strategy" output with Lane A/B/C dependency tables and conflict flags). Deferred from the v0.18.5.0 rename PR so the rename could land as a tight, low-risk fix. Saved files currently live at `~/.gstack/projects/$SLUG/checkpoints/YYYYMMDD-HHMMSS-<title>.md` with YAML frontmatter (branch, timestamp, etc.). The lane feature would add a `lane:` field to frontmatter and a `--lane` filter to both skills.

**Effort:** M (human: ~1-2 days / CC: ~45-60 min)
**Priority:** P3 (nice-to-have, not blocking anyone yet)
**Depends on:** `/context-save` + `/context-restore` rename stable in production (v1.0.1.0+). Research: does Conductor expose a spawn-workspace CLI?

## P0: Browser-skills Phase 2 follow-up — `/automate` skill

**What:** The mutating-flow sibling of `/scrape` (Phase 2b). `/automate <intent>` codifies form fills, click sequences, and multi-step interactions into permanent browser-skills. Reuses Phase 2a's skillify machinery (`/skillify` is shared) and the D3 atomic-write helper. Adds: per-mutating-step UNTRUSTED-wrapped summary + `AskUserQuestion` confirmation gate when running non-codified (codified skills run unattended after the initial human approval). Defaults to `trusted: false` per Phase 1 — env-scrubbed spawn, scoped-token capability, no admin scope.

**Why:** Read-only scraping is the safer wedge to validate the skillify pattern (failure mode: wrong data = benign). Mutating actions are the other half of the 100x productivity gain — agents that codify "log into example.com → click Settings → toggle X" save real time on every future session. Splitting from Phase 2a means we ship the productivity loop first, validate the architecture, then add the higher-trust surface with confidence.

**Pros:** Unlocks deterministic automation authoring without self-authoring safety concerns — Phase 1's scoped-token model applies equally to mutating skills. The codified script enumerates exactly which `$B click`/`$B fill`/`$B type` calls run; nothing else is possible at runtime. Reuses 100% of `/skillify`, the D3 helper, and the storage tier. Per-step confirmation gate surfaces the actions to the user before they run for the first time.

**Cons:** Mutating intents have higher blast radius (the wrong selector clicks "Delete Account" instead of "Delete Comment"). Phase 4 OS-level FS sandbox is a stronger answer; until then, the user trust burden is real. Confirmation-gate UX needs care — too many prompts and users hit "yes" reflexively. Mitigation: only gate first-run; after `/skillify` codifies, the skill runs unattended.

**Context:** Original Phase 2 plan in `docs/designs/BROWSER_SKILLS_V1.md` bundled `/scrape` + `/automate`. Split during the v1.19.0.0 plan review (`/plan-eng-review` on `garrytan/browserharness`) — the user's source doc framed both as primary, but in practice scraping is where users start because the failure mode is benign. Ship `/scrape` + `/skillify` first (this branch), validate the skillify pattern works, then `/automate` lands on top of the same machinery.

**Effort:** M (human: ~3-5 days / CC: ~1 day)
**Priority:** P0 (next branch after v1.19.0.0)
**Depends on:** Phase 2a (`/scrape` + `/skillify`) shipped at v1.19.0.0. The D3 atomic-write helper (`browse/src/browser-skill-write.ts`) and the bundled SDK pattern are reused as-is.

---

## P0: PACING_UPDATES_V0 — Louise's fatigue root cause (V1.1)

**What:** Implement the pacing overhaul extracted from PLAN_TUNING_V1. Full design in `docs/designs/PACING_UPDATES_V0.md`. Requires: session-state model, `phase` field in question-log schema, registry extension for dynamic findings, pacing as skill-template control flow (not preamble prose), `bin/gstack-flip-decision` command, migration-prompt budget rule, first-run preamble audit, ranking threshold calibration from real V0 data, one-way-door uncapped rule, concrete verification values.

**Why:** Louise de Sadeleer's "yes yes yes" during `/autoplan` was pacing + agency, not (only) jargon density. V1 addresses jargon (ELI10 writing). V1.1 addresses the interruption-volume half. Without this, V1 only gets halfway to the HOLY SHIT outcome.

**Pros:** End-to-end answer to Louise's feedback. Ships real calibration data from V1 usage. Completes the V0 → V2 pacing arc started in PLAN_TUNING_V0.

**Cons:** Substantial scope (10 items in `docs/designs/PACING_UPDATES_V0.md`). Needs its own CEO + Codex + DX + Eng review cycle. Calibration depends on real V0 question-log distribution.

**Context:** PLAN_TUNING_V1 attempted to bundle pacing. Three eng-review passes + two Codex passes surfaced 10 structural gaps unfixable via plan-text editing. Extracted to V1.1 as a dedicated plan.

**Depends on / blocked by:** V1 shipping (provides Louise's baseline transcript for calibration).

## Plan Tune (v2 deferrals from v0.19.0.0 rollback)

All six items are gated on v1 dogfood results and the acceptance criteria in
`docs/designs/PLAN_TUNING_V0.md`. They were explicitly deferred after Codex's
outside-voice review drove a scope rollback from the CEO EXPANSION plan. v1
ships the observational substrate only; v2 adds behavior adaptation.

### E1 — Substrate wiring (5 skills consume profile)

**What:** Add `{{PROFILE_ADAPTATION:<skill>}}` placeholder to ship, review,
office-hours, plan-ceo-review, plan-eng-review SKILL.md.tmpl files. Implement
`scripts/resolvers/profile-consumer.ts` with a per-skill adaptation registry
(`scripts/profile-adaptations/{skill}.ts`). Each consumer reads
`~/.gstack/developer-profile.json` on preamble and adapts skill-specific
defaults (verbosity, mode selection, severity thresholds, pushback intensity).

**Why:** v1 observational profile writes a file nobody reads. The substrate
claim only becomes real when skills actually consume it. Without this, /plan-tune
is a fancy config page.

**Pros:** gstack feels personal. Every skill adapts to the user's steering
style instead of defaulting to middle-of-the-road.

**Cons:** Risk of psychographic drift if profile is noisy. Requires calibrated
profile (v1 acceptance criteria: 90+ days stable across 3+ skills).

**Context:** See `docs/designs/PLAN_TUNING_V0.md` §Deferred to v2. v1 ships the
signal map + inferred computation; it's displayed in /plan-tune but no skill
reads it yet.

**Effort:** L (human: ~1 week / CC: ~4h)
**Priority:** P0
**Depends on:** **90+ days of v1 dogfood stable across 3+ skills** (per
`docs/designs/PLAN_TUNING_V0.md` §"Deferred to v2" E1 acceptance criteria).
Distinct from the lighter-weight diversity-display gate
(`sample_size >= 20 AND skills_covered >= 3 AND question_ids_covered >= 8
AND days_span >= 7`) used in /plan-tune to render the inferred column —
display is a UI affordance, promotion to E1 needs a much higher bar
because behavioral adaptation is consequential and hard to revert. Prior
versions of this card cited "2+ weeks" which conflicted with V0 — V0 wins.

**Substrate risk (Codex outside-voice, Phase A review 2026-05-26):** Generated
skill prose is agent-compliance-based. Tests can verify templates contain the
right reads of `~/.gstack/developer-profile.json` and the right decision
points, but tests cannot prove agents obey them at runtime. E1 ships
adaptations as **advisory annotations on AskUserQuestion recommendations**
("Recommended via your profile: <choice>") until there's a hard runtime
execution path. Do NOT gate any AUTO_DECIDE on inferred profile alone in v1
of E1; explicit per-question preferences remain the only AUTO_DECIDE
source.

### E3 — `/plan-tune narrative` + `/plan-tune vibe`

**What:** Event-anchored narrative ("You accepted 7 scope expansions, overrode
test_failure_triage 4 times, called every PR 'boil the lake'") + one-word vibe
archetype (Cathedral Builder, Ship-It Pragmatist, Deep Craft, etc).
scripts/archetypes.ts is ALREADY SHIPPED in v1 (8 archetypes + Polymath
fallback). v2 work is the narrative generator + /plan-tune skill wiring.

**Why:** Makes profile tangible and shareable. Screenshot-able.

**Pros:** Killer delight feature. Social surface for gstack. Concrete, specific
output anchored in real events (not generic AI slop).

**Cons:** Requires stable inferred profile — without calibration it produces
generic paragraphs. Gen-tests need to validate no-slop.

**Context:** Archetypes already defined. Just need the /plan-tune narrative
subcommand + slop-check test.

**Effort:** S+ (human: ~1 day / CC: ~1h)
**Priority:** P0
**Depends on:** Calibrated profile (>= 20 events, 3+ skills, 7+ days span).

### E4 — Blind-spot coach

**What:** Preamble injection that surfaces the OPPOSITE of the user's profile
once per session per tier >= 2 skill. Boil-the-ocean user gets challenged on
scope ("what's the 80% version?"); small-scope user gets challenged on ambition.
`scripts/resolvers/blind-spot-coach.ts`. Marker file for session dedup. Opt-out
via `gstack-config set blind_spot_coach false`.

**Why:** Makes gstack a coach (challenges you) instead of a mirror (reflects
you). The killer differentiation vs. a settings menu.

**Pros:** The feature that makes gstack feel like Garry. Surfaces assumptions
the user hasn't challenged.

**Cons:** Logically conflicts with E1 (which adapts TO profile) and E6 (which
flags mismatch). Requires interaction-budget design: global session budget +
escalation rules + explicit exclusion from mismatch detection. Risk of feeling
like a nag if fires wrong.

**Context:** v2 must redesign to resolve the E1/E4/E6 composition issue Codex
caught. Dogfood required to calibrate frequency.

**Effort:** M (human: ~3 days / CC: ~2h design + ~1h impl)
**Priority:** P0
**Depends on:** E1 shipped + interaction-budget design spec.

### E5 — LANDED celebration HTML page

**What:** When a PR authored by the user is newly merged to the base branch,
open an animated HTML celebration page in the browser. Confetti + typewriter
headline + stats counter. Shows: what we built (PR stats + CHANGELOG entry),
road traveled (scope decisions from CEO plan), road not traveled (deferred
items), where we're going (next TODOs), who you are as a builder (vibe +
narrative + profile delta for this ship). Self-contained HTML (CSS animations
only, no JS deps).

**CRITICAL REVISION from v0 plan:** Passive detection must NOT live in the
preamble (Codex #9). When promoted, moves to explicit `/plan-tune show-landed`
OR post-ship hook — not passive detection in the hot path.

**Why:** Biggest personality moment in gstack. The "one-word thing that makes
you remember why you built this."

**Pros:** Screenshot-worthy. Shareable. The kind of dopamine hit that turns
power users into evangelists.

**Cons:** Product theater if the substrate isn't solid. Needs /design-shotgun
→ /design-html for the visual direction. Requires E2 unified profile for
narrative/vibe data.

**Context:** /land-and-deploy trust/adoption is low, so passive detection is
the right trigger shape. Dedup marker per PR in `~/.gstack/.landed-celebrated-*`.
E2E tests for squash/merge-commit/rebase/co-author/fresh-clone/dedup variants.

**Effort:** M+ (human: ~1 week / CC: ~3h total)
**Priority:** P0
**Depends on:** E3 narrative/vibe shipped. /design-shotgun run on real PR data
to pick a visual direction, then /design-html to finalize.

### E6 — Auto-adjustment based on declared ↔ inferred mismatch

**What:** Currently `/plan-tune` shows the gap between declared and inferred
(v1 observational). v2 auto-suggests declaration updates when the gap exceeds
a threshold ("Your profile says hands-off but you've overridden 40% of
recommendations — you're actually taste-driven. Update declared autonomy from
0.8 to 0.5?"). Requires explicit user confirmation before any mutation (Codex
trust-boundary #15 already baked into v1).

**Why:** Profile drifts silently without correction. Self-correcting profile
stays honest.

**Pros:** Profile becomes more accurate over time. User sees the gap and
decides.

**Cons:** Requires stable inferred profile (diversity check). False positives
nag the user.

**Context:** v1 has `--check-mismatch` that flags > 0.3 gaps but doesn't
suggest fixes. v2 adds the suggestion UX + per-dimension threshold tuning from
real data.

**Effort:** S (human: ~1 day / CC: ~45min)
**Priority:** P0
**Depends on:** Calibrated profile + real mismatch data from v1 dogfood.

### E7 — Psychographic auto-decide

**What:** When inferred profile is calibrated AND a question is two-way AND
the user's dimensions strongly favor one option, auto-choose without asking
(visible annotation: "Auto-decided via profile. Change with /plan-tune."). v1
only auto-decides via EXPLICIT per-question preferences; v2 adds profile-driven
auto-decide.

**Why:** The whole point of the psychographic. Silent, correct defaults based
on who the user IS, not just what they've said.

**Pros:** Friction-free skill invocation for calibrated power users. Over time,
gstack feels like it's reading your mind.

**Cons:** Highest-risk deferral. Wrong auto-decides are costly. Requires very
high confidence in the signal map AND calibration gate.

**Context:** v1 diversity gate is `sample_size >= 20 AND skills_covered >= 3
AND question_ids_covered >= 8 AND days_span >= 7`. v2 must prove this gate
actually catches noisy profiles before shipping.

**Effort:** M (human: ~3 days / CC: ~2h)
**Priority:** P0
**Depends on:** E1 (skills consuming profile) + real observed data showing
calibration gate is trustworthy.

## Browse

### Scope sidebar-agent kill to session PID, not `pkill -f sidebar-agent\.ts`

**What:** `shutdown()` in `browse/src/server.ts:1193` uses `pkill -f sidebar-agent\.ts` to kill the sidebar-agent daemon, which matches every sidebar-agent on the machine, not just the one this server spawned. Replace with PID tracking: store the sidebar-agent PID when `cli.ts` spawns it (via state file or env), then `process.kill(pid, 'SIGTERM')` in `shutdown()`.

**Why:** A user running two Conductor worktrees (or any multi-session setup), each with its own `$B connect`, closes one browser window ... and the other worktree's sidebar-agent gets killed too. The blast radius was there before, but the v0.18.1.0 disconnect-cleanup fix makes it more reachable: every user-close now runs the full `shutdown()` path, whereas before user-close bypassed it.

**Context:** Surfaced by /ship's adversarial review on v0.18.1.0. Pre-existing code, not introduced by the fix. Fix requires propagating the sidebar-agent PID from `cli.ts` spawn site (~line 885) into the server's state file so `shutdown()` can target just this session's agent. Related: `browse/src/cli.ts` spawns with `Bun.spawn(...).unref()` and already captures `agentProc.pid`.

**Effort:** S (human: ~2h / CC: ~15min)
**Priority:** P2
**Depends on:** None

## Sidebar Security

### ML Prompt Injection Classifier — v1 SHIPPED (branch garrytan/prompt-injection-guard)

**Status:** IN PROGRESS on branch `garrytan/prompt-injection-guard`. Classifier swap:
**TestSavantAI** replaces DeBERTa (better on developer content — HN/Reddit/Wikipedia/tech blogs all
score SAFE 0.98+, attacks score INJECTION 0.99+). Pre-impl gate 3 (benign corpus dry-run)
forced this pivot — see `~/.gstack/projects/garrytan-gstack/ceo-plans/2026-04-19-prompt-injection-guard.md`.

**What shipped in v1:**
- `browse/src/security.ts` — canary injection + check, verdict combiner (ensemble rule),
  attack log with rotation, cross-process session state, status reporting
- `browse/src/security-classifier.ts` — TestSavantAI ONNX classifier + Haiku transcript
  classifier (reasoning-blind), both with graceful degradation
- Canary flows end-to-end: server.ts injects, sidebar-agent.ts checks every outbound
  channel (text, tool args, URLs, file writes) and kills session on leak
- Pre-spawn ML scan of user message with ensemble rule (BLOCK requires both classifiers)
- `/health` endpoint exposes security status for shield icon
- 25 unit tests + 12 regression tests all passing

**Branch 2 architecture (decided from pre-impl gate 1):**
The ML classifier ONLY runs in `sidebar-agent.ts` (non-compiled bun script). The compiled
browse binary cannot link onnxruntime-node. Architectural controls (XML framing + allowlist)
defend the compiled-side ingress.

### ML Prompt Injection Classifier — v2 Follow-ups

#### ~~Cut Haiku false-positive rate from 44% toward ~15% (P0)~~ — SHIPPED in v1.5.2.0

Measured result (500-case BrowseSafe-Bench smoke): detection 67.3% → **56.2%**, FP 44.1% → **22.9%**. Gate passes (detection ≥ 55%, FP ≤ 25%). Knobs that landed: label-first ensemble voting (verdict label trumps numeric confidence for transcript layer), hallucination guard (`verdict=block` at conf < 0.40 → warn-vote), new `THRESHOLDS.SOLO_CONTENT_BLOCK = 0.92` for label-less content classifiers, label-first extension to toolOutput path, tighter Haiku prompt + 8 few-shot exemplars, pinned Haiku model, `claude -p` spawn from `os.tmpdir()` so CLAUDE.md can't poison the classifier, timeout bumped 15s → 45s. CI gate: `browse/test/security-bench-ensemble.test.ts` replays fixture, fail-closed on missing fixture + security-layer diff. The original plan's stop-loss revert order didn't move the FP needle (FPs came from single-layer-BLOCK paths, not ensemble); the real levers turned out to be architectural (label-first) plus a new decoupled threshold.

See CHANGELOG.md [1.5.2.0] for the full shipped summary.

#### Original spec (pre-ship, retained for archive)

**What:** v1 ships the Haiku transcript classifier on every tool output (Read/Grep/Bash/Glob/WebFetch). BrowseSafe-Bench smoke measured detection 67.3% + FP 44.1% — a 4.4x detection lift from L4-only, but FP tripled because Haiku is more aggressive than L4 on edge cases (phishing-style benign content, borderline social engineering). The review banner makes FPs recoverable but 44% is too high for a delightful default.

**Why:** User clicks review banner roughly every-other tool output = real UX friction. Tuning these four knobs together should cut FP to ~15-20% while keeping detection in the 60-70% range:

1. **Switch ensemble counting to Haiku's `verdict` field, not `confidence`.** Right now `combineVerdict` treats Haiku warn-at-0.6 as a BLOCK vote. Haiku reserves `verdict: "block"` for clear-cut cases and uses `"warn"` liberally. Count only `verdict === "block"` as a BLOCK vote; `warn` becomes a soft signal that participates in 2-of-N ensemble but doesn't single-handedly BLOCK.
2. **Tighten Haiku's classifier prompt.** Current prompt is generic. Rewrite to: "Return `block` only if the text contains explicit instruction-override, role-reset, exfil request, or malicious code execution. Return `warn` for social engineering that doesn't try to hijack the agent. Return `safe` otherwise." More specific instructions → fewer false flags.
3. **Add 6-8 few-shot exemplars to Haiku's prompt.** Pairs of (injection text → block) and (benign-looking-but-safe → safe). LLM few-shot consistently outperforms zero-shot on classification.
4. **Bump Haiku's WARN threshold from 0.6 to 0.75.** Borderline fires drop out of the ensemble pool.

Ship all four together, re-run BrowseSafe-Bench smoke, record before/after. Target: 60-70% detection / 15-25% FP.

**Effort:** S (human: ~1 day / CC: ~30-45 min + ~45min bench)
**Priority:** P0 (direct UX impact post-ship; ship v1 as-is with review banner, file this as the immediate follow-up)
**Depends on:** v1.4.0.0 prompt-injection-guard branch merged

#### Cache review decisions per (domain, payload-hash-prefix) (P1)

**What:** If Haiku fires on a page twice in the same session (e.g., user does Bash then Grep on the same suspicious file), the second fire shouldn't re-prompt. Cache the user's decision keyed by a per-session (domain, payloadHash-prefix) pair. Small LRU, ~100 entries, session-scoped (not persistent across sidebar restarts — we want fresh decisions on new sessions).

**Why:** Reduces review-banner fatigue when the same bit of sketchy content gets scanned multiple times via different tools. At 44% FP on v1, this matters most.

**Effort:** S (human: ~0.5 day / CC: ~20 min)
**Priority:** P1

#### Fine-tune a small classifier on BrowseSafe-Bench + Qualifire + xxz224 (P2 research)

**What:** TestSavantAI was trained on direct-injection text, wrong distribution for browser-agent attacks (measured 15% recall). Take BERT-base, fine-tune on BrowseSafe-Bench (3,680 cases) + Qualifire prompt-injection-benchmark (5k) + xxz224 (3.7k) combined, ship in ~/.gstack/models/ as replacement L4 classifier.

**Why:** Expected 15% → 70%+ recall on the actual threat distribution without needing Haiku. Would also cut latency (no CLI subprocess) and drop Haiku cost.

**Effort:** XL (human: ~3-5 days + ~$50 GPU / CC: ~4-6 hours setup + ~$50 GPU)
**Priority:** P2 research — validate the lift on a held-out test set before committing to replace TestSavant

#### DeBERTa-v3 ensemble as default (P2)

**What:** Flip `GSTACK_SECURITY_ENSEMBLE=deberta` from opt-in to default. Adds a 3rd ML vote; 2-of-3 agreement rule should reduce FPs while catching attacks that only DeBERTa sees.

**Why:** More votes = better calibration. Currently opt-in because 721MB is a big first-run download; flipping to default requires lazy-download UX.

**Cons:** 721MB first-run download for every user. Costs user bandwidth + disk.

**Effort:** M (human: ~2 days / CC: ~1 hour + UX)
**Priority:** P2 (after #1 tuning to see how much room is left)

#### User-feedback flywheel — decisions become training data (P3)

**What:** Every Allow/Block click is labeled data. Log (suspected_text hash, layer scores, user decision, ts) to ~/.gstack/security/feedback.jsonl. Aggregate via community-pulse when `telemetry: community`. Periodically retrain the classifier on aggregate feedback.

**Why:** The system gets better the more it's used. Closes the loop between user reality and defense quality.

**Cons:** Feedback loop can be poisoned if attacker controls enough devices. Need guardrails (stratified sampling, reviewer validation, k-anon minimums on training batch).

**Effort:** L (human: ~1 week for local logging + aggregation pipe, another week for retrain cron / CC: ~2-4 hours per sub-part)
**Priority:** P3 — only worth building after v2 tuning proves the architecture is the right shape

#### ~~Shield icon + canary leak banner UI (P0)~~ — SHIPPED

Banner landed in commits a9f702a7 (HTML+CSS, variant A mockup) + ffb064af
(JS wiring + security_event routing + a11y + Escape-to-dismiss). Shield
icon landed in 59e0635e with 3 states (protected/degraded/inactive),
custom SVG + mono SEC label per design review Pass 7, hover tooltip with
per-layer detail.

Known v1 limitation logged as follow-up: shield only updates at connect —
see "Shield icon continuous polling" above.

#### ~~Shield icon continuous polling (P2)~~ — SHIPPED

Commit 06002a82: `/sidebar-chat` response now includes `security:
getSecurityStatus()`, and sidepanel.js calls `updateSecurityShield(data.security)`
on every poll tick. Shield flips to 'protected' as soon as classifier warmup
completes (typically ~30s after initial connect on first run), no reload needed.

#### ~~Attack telemetry via gstack-telemetry-log (P1)~~ — SHIPPED

Landed in commits 28ce883c (binary) + f68fa4a9 (security.ts wiring). The
telemetry binary now accepts `--event-type attack_attempt --url-domain
--payload-hash --confidence --layer --verdict`. `logAttempt()` spawns the
binary fire-and-forget. Existing tier gating carries the events.

Downstream follow-up still open: update the `community-pulse` Supabase edge
function to accept the new event type and store in a typed `security_attempts`
table. Dashboard read path is a separate TODO ("Cross-user aggregate attack
dashboard" below).

#### Full BrowseSafe-Bench at gate tier (P2)

**What:** Promote `browse/test/security-bench.test.ts` from smoke-200 (gate) to full-3680
(gate) once smoke/full detection rate correlation is measured (~2 weeks post-ship).

**Why:** BrowseSafe-Bench is Perplexity's 3,680-case browser-agent injection benchmark.
Smoke-200 is a sample; full coverage catches the long tail. Run time ~5min hermetic.

**Effort:** S (CC: ~45min)
**Priority:** P2
**Depends on:** v1 shipped + ~2 weeks real data

#### ~~Cross-user aggregate attack dashboard (P2)~~ — CLI SHIPPED, web UI remains

CLI dashboard shipped in commits a5588ec0 (schema migration) + 2d107978
(community-pulse edge function security aggregation) + 756875a7 (bin/gstack-
security-dashboard). Users can now run `gstack-security-dashboard` to see
attacks last 7 days, top attacked domains, detection-layer distribution,
and verdict counts — all aggregated from the Supabase community-pulse pipe.

Web UI at gstack.gg/dashboard/security is still open — that's a separate
webapp project outside this repo's scope.

#### TestSavantAI ensemble → DeBERTa-v3 ensemble (P2) — SHIPPED (opt-in)

Commits b4e49d08 + 8e9ec52d + 4e051603 + 7a815fa7: DeBERTa-v3-base-injection-onnx
is now wired as an opt-in L4c ensemble classifier. Enable via
`GSTACK_SECURITY_ENSEMBLE=deberta` — sidebar-agent warmup downloads the 721MB
model to ~/.gstack/models/deberta-v3-injection/ on first run. combineVerdict
becomes a 2-of-3 agreement rule (testsavant + deberta + transcript) when
enabled. Default behavior unchanged (2-of-2 testsavant + transcript).

#### ~~TestSavantAI + DeBERTa-v3 ensemble~~ — SHIPPED opt-in (see entry above)

#### ~~Read/Glob/Grep tool-output injection coverage (P2)~~ — SHIPPED

Commits f2e80dd7 + 0098d574: sidebar-agent.ts now scans tool outputs from
Read, Glob, Grep, WebFetch, and Bash via `SCANNED_TOOLS` set. Content >= 32
chars runs through the ML ensemble; BLOCK verdict kills the session and
emits security_event. The content-security.ts envelope path was already
wrapping browse-command output; this extension closes the non-browse path
Codex flagged.

During /ship for v1.4.0.0 this path got additional hardening (commit
407c36b4 + 88b12c2b + c51ebdf4): transcript classifier now receives the
tool output text (was empty before), and combineVerdict accepts a
`toolOutput: true` opt that blocks on a single ML classifier at BLOCK
threshold (user-input default unchanged for SO-FP mitigation).

#### ~~Adversarial + integration + smoke-bench test suites (P1)~~ — SHIPPED

Four test files shipped this round:
  * `browse/test/security-adversarial.test.ts` (94a83c50) — 23 canary-channel
    + verdict-combiner attack-shape tests
  * `browse/test/security-integration.test.ts` (07745e04) — 10 layer-coexistence
    + defense-in-depth regression guards
  * `browse/test/security-live-playwright.test.ts` (b9677519) — 7 live-Chromium
    fixture tests (5 deterministic + 2 ML, skipped if model cache absent)
  * `browse/test/security-bench.test.ts` (afc6661f) — BrowseSafe-Bench 200-case
    smoke harness with hermetic dataset cache + v1 baseline metrics

#### Bun-native 5ms inference (P3 research) — SKELETON SHIPPED, forward pass open

Research skeleton landed this round (browse/src/security-bunnative.ts,
docs/designs/BUN_NATIVE_INFERENCE.md, browse/test/security-bunnative.test.ts):

  * Pure-TS WordPiece tokenizer — reads HF tokenizer.json directly, matches
    transformers.js output on fixture strings (correctness-tested in CI)
  * Stable `classify()` API that current callers can wire against today
  * Benchmark harness with p50/p95/p99 reporting — anchors v1 WASM baseline
    for future regressions

Design doc captures the roadmap:
  * Approach A: pure-TS + Float32Array SIMD — ruled out (can't beat WASM)
  * Approach B: Bun FFI + Apple Accelerate cblas_sgemm — target ~3-6ms p50,
    macOS-only, ~1000 LOC
  * Approach C: Bun WebGPU — unexplored, worth a spike

Remaining work (XL, multi-week):
  * FFI proof-of-concept for cblas_sgemm
  * Single transformer layer implementation + correctness check vs onnxruntime
  * Full forward pass + weight loader + correctness regression fixtures
  * Production swap in security-bunnative.ts `classify()` body

## Builder Ethos

### First-time Search Before Building intro

**What:** Add a `generateSearchIntro()` function (like `generateLakeIntro()`) that introduces the Search Before Building principle on first use, with a link to the blog essay.

**Why:** Boil the Lake has an intro flow that links to the essay and marks `.completeness-intro-seen`. Search Before Building should have the same pattern for discoverability.

**Context:** Blocked on a blog post to link to. When the essay exists, add the intro flow with a `.search-intro-seen` marker file. Pattern: `generateLakeIntro()` at gen-skill-docs.ts:176.

**Effort:** S
**Priority:** P2
**Depends on:** Blog post about Search Before Building

## Chrome DevTools MCP Integration

### Real Chrome session access

**What:** Integrate Chrome DevTools MCP to connect to the user's real Chrome session with real cookies, real state, no Playwright middleman.

**Why:** Right now, headed mode launches a fresh Chromium profile. Users must log in manually or import cookies. Chrome DevTools MCP connects to the user's actual Chrome ... instant access to every authenticated site. This is the future of browser automation for AI agents.

**Context:** Google shipped Chrome DevTools MCP in Chrome 146+ (June 2025). It provides screenshots, console messages, performance traces, Lighthouse audits, and full page interaction through the user's real browser. gstack should use it for real-session access while keeping Playwright for headless CI/testing workflows.

Potential new skills:
- `/debug-browser`: JS error tracing with source-mapped stack traces
- `/perf-debug`: performance traces, Core Web Vitals, network waterfall

May replace `/setup-browser-cookies` for most use cases since the user's real cookies are already there.

**Effort:** L (human: ~2 weeks / CC: ~2 hours)
**Priority:** P0
**Depends on:** Chrome 146+, DevTools MCP server installed

## Browse

### Bundle server.ts into compiled binary

**What:** Eliminate `resolveServerScript()` fallback chain entirely — bundle server.ts into the compiled browse binary.

**Why:** The current fallback chain (check adjacent to cli.ts, check global install) is fragile and caused bugs in v0.3.2. A single compiled binary is simpler and more reliable.

**Context:** Bun's `--compile` flag can bundle multiple entry points. The server is currently resolved at runtime via file path lookup. Bundling it removes the resolution step entirely.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Sessions (isolated browser instances)

**What:** Isolated browser instances with separate cookies/storage/history, addressable by name.

**Why:** Enables parallel testing of different user roles, A/B test verification, and clean auth state management.

**Context:** Requires Playwright browser context isolation. Each session gets its own context with independent cookies/localStorage. Prerequisite for video recording (clean context lifecycle) and auth vault.

**Effort:** L
**Priority:** P3

### Video recording

**What:** Record browser interactions as video (start/stop controls).

**Why:** Video evidence in QA reports and PR bodies. Currently deferred because `recreateContext()` destroys page state.

**Context:** Needs sessions for clean context lifecycle. Playwright supports video recording per context. Also needs WebM → GIF conversion for PR embedding.

**Effort:** M
**Priority:** P3
**Depends on:** Sessions

### v20 encryption format support

**What:** AES-256-GCM support for future Chromium cookie DB versions (currently v10).

**Why:** Future Chromium versions may change encryption format. Proactive support prevents breakage.

**Effort:** S
**Priority:** P3

### State persistence — SHIPPED

~~**What:** Save/load cookies + localStorage to JSON files for reproducible test sessions.~~

`$B state save/load` ships in v0.12.1.0. V1 saves cookies + URLs only (not localStorage, which breaks on load-before-navigate). Files at `.gstack/browse-states/{name}.json` with 0o600 permissions. Load replaces session (closes all pages first). Name sanitized to `[a-zA-Z0-9_-]`.

**Remaining:** V2 localStorage support (needs pre-navigation injection strategy).
**Completed:** v0.12.1.0 (2026-03-26)

### Auth vault

**What:** Encrypted credential storage, referenced by name. LLM never sees passwords.

**Why:** Security — currently auth credentials flow through the LLM context. Vault keeps secrets out of the AI's view.

**Effort:** L
**Priority:** P3
**Depends on:** Sessions, state persistence

### Iframe support — SHIPPED

~~**What:** `frame <sel>` and `frame main` commands for cross-frame interaction.~~

`$B frame` ships in v0.12.1.0. Supports CSS selector, @ref, `--name`, and `--url` pattern matching. Execution target abstraction (`getActiveFrameOrPage()`) across all read/write/snapshot commands. Frame context cleared on navigation, tab switch, resume. Detached frame auto-recovery. Page-only operations (goto, screenshot, viewport) throw clear error when in frame context.

**Completed:** v0.12.1.0 (2026-03-26)

### Semantic locators

**What:** `find role/label/text/placeholder/testid` with attached actions.

**Why:** More resilient element selection than CSS selectors or ref numbers.

**Effort:** M
**Priority:** P4

### Device emulation presets

**What:** `set device "iPhone 16 Pro"` for mobile/tablet testing.

**Why:** Responsive layout testing without manual viewport resizing.

**Effort:** S
**Priority:** P4

### Network mocking/routing

**What:** Intercept, block, and mock network requests.

**Why:** Test error states, loading states, and offline behavior.

**Effort:** M
**Priority:** P4

### Download handling

**What:** Click-to-download with path control.

**Why:** Test file download flows end-to-end.

**Effort:** S
**Priority:** P4

### Content safety

**What:** `--max-output` truncation, `--allowed-domains` filtering.

**Why:** Prevent context window overflow and restrict navigation to safe domains.

**Effort:** S
**Priority:** P4

### Streaming (WebSocket live preview)

**What:** WebSocket-based live preview for pair browsing sessions.

**Why:** Enables real-time collaboration — human watches AI browse.

**Effort:** L
**Priority:** P4

### Headed mode with Chrome extension — SHIPPED

`$B connect` launches Playwright's bundled Chromium in headed mode with the gstack Chrome extension auto-loaded. `$B handoff` now produces the same result (extension + side panel). Sidebar chat gated behind `--chat` flag.

### `$B watch` — SHIPPED

Claude observes user browsing in passive read-only mode with periodic snapshots. `$B watch stop` exits with summary. Mutation commands blocked during watch.

### Sidebar scout / file drop relay — SHIPPED

Sidebar agent writes structured messages to `.context/sidebar-inbox/`. Workspace agent reads via `$B inbox`. Message format: `{type, timestamp, page, userMessage, sidebarSessionId}`.

### Multi-agent tab isolation

**What:** Two Claude sessions connect to the same browser, each operating on different tabs. No cross-contamination.

**Why:** Enables parallel /qa + /design-review on different tabs in the same browser.

**Context:** Requires tab ownership model for concurrent headed connections. Playwright may not cleanly support two persistent contexts. Needs investigation.

**Effort:** L (human: ~2 weeks / CC: ~2 hours)
**Priority:** P3
**Depends on:** Headed mode (shipped)

### Sidebar agent needs Write tool + better error visibility — SHIPPED

**What:** Two issues with the sidebar agent (`sidebar-agent.ts`): (1) `--allowedTools` is hardcoded to `Bash,Read,Glob,Grep`, missing `Write`. Claude can't create files (like CSVs) when asked. (2) When Claude errors or returns empty, the sidebar UI shows nothing, just a green dot. No error message, no "I tried but failed", nothing.

**Completed:** v0.15.4.0 (2026-04-04). Write tool added to allowedTools. 40+ empty catch blocks replaced with `[gstack sidebar]`, `[gstack bg]`, `[browse]`, `[sidebar-agent]` prefixed console logging across all 4 files (sidepanel.js, background.js, server.ts, sidebar-agent.ts). Error placeholder text now shows in red. Auth token stale-refresh bug fixed.

### Sidebar direct API calls (eliminate claude -p startup tax)

**What:** Each sidebar message spawns a fresh `claude -p` process (~2-3s cold start overhead). For "click @e24" that's absurd. Direct Anthropic API calls would be sub-second.

**Why:** The `claude -p` startup cost is: process spawn (~100ms) + CLI init (~500ms-1s) + API connection (~200ms) + first token. Model routing (Sonnet for actions) helps but doesn't fix the CLI overhead.

**Context:** `server.ts:spawnClaude()` builds args and writes to queue file. `sidebar-agent.ts:askClaude()` spawns `claude -p`. Replace with direct `fetch('https://api.anthropic.com/...')` with tool use. Requires `ANTHROPIC_API_KEY` accessible to the browse server.

**Effort:** M (human: ~1 week / CC: ~30min)
**Priority:** P2
**Depends on:** None

### Chrome Web Store publishing

**What:** Publish the gstack browse Chrome extension to Chrome Web Store for easier install.

**Why:** Currently sideloaded via chrome://extensions. Web Store makes install one-click.

**Effort:** S
**Priority:** P4
**Depends on:** Chrome extension proving value via sideloading

### Linux cookie decryption — PARTIALLY SHIPPED

~~**What:** GNOME Keyring / kwallet / DPAPI support for non-macOS cookie import.~~

Linux cookie import shipped in v0.11.11.0 (Wave 3). Supports Chrome, Chromium, Brave, Edge on Linux with GNOME Keyring (libsecret) and "peanuts" fallback. Windows DPAPI support remains deferred.

**Remaining:** Windows cookie decryption (DPAPI). Needs complete rewrite — PR #64 was 1346 lines and stale.

**Effort:** L (Windows only)
**Priority:** P4
**Completed (Linux):** v0.11.11.0 (2026-03-23)

## Ship

### /ship Step 12 test harness should exec the actual template bash, not a reimplementation

**What:** `test/ship-version-sync.test.ts` currently reimplements the bash from `ship/SKILL.md.tmpl` Step 12 inside template literals. When the template changes, both sides must be updated — exactly the drift-risk pattern the Step 12 fix is meant to prevent, applied to our own testing strategy. Replace with a helper that extracts the fenced bash blocks from the template at test time and runs them verbatim (similar to the `skill-parser.ts` pattern).

**Why:** Surfaced by the Claude adversarial subagent during the v1.0.1.0 ship. Today the tests would stay green while the template regresses, because the error-message strings already differ between test and template. It's a silent-drift bug waiting to happen.

**Context:** The fixed test file is at `test/ship-version-sync.test.ts` (branched off garrytan/ship-version-sync). Existing precedent for extracting-from-skill-md is at `test/helpers/skill-parser.ts`. Pattern: read the template, slice from `## Step 12` to the next `---`, grep fenced bash, feed to `/bin/bash` with substituted fixtures.

**Effort:** S (human: ~2h / CC: ~30min)
**Priority:** P2
**Depends on:** None.

### /ship Step 12 BASE_VERSION silent fallback to 0.0.0.0 when git show fails

**What:** `BASE_VERSION=$(git show origin/<base>:VERSION 2>/dev/null || echo "0.0.0.0")` silently defaults to `0.0.0.0` in any failure mode — detached HEAD, no origin, offline, base branch renamed. In such states, a real drift could be misclassified or silently repaired with the wrong value. Distinguish "origin/<base> unreachable" from "origin/<base>:VERSION absent" and fail loudly on the former.

**Why:** Flagged as CRITICAL (confidence 8/10) by the Claude adversarial subagent during the v1.0.1.0 ship. Low practical risk because `/ship` Step 3 already fetches origin before Step 12 runs — any reachability failure would abort Step 3 long before this code runs. Still, defense in depth: if someone invokes Step 12 bash outside the full /ship pipeline (e.g., via a standalone helper), the fallback masks a real problem.

**Context:** Fix: wrap with `git rev-parse --verify origin/<base>` probe; if that fails, error out rather than defaulting. Touches `ship/SKILL.md.tmpl` Step 12 idempotency block (around line 409). Tests need a case where `git show` fails.

**Effort:** S (human: ~1h / CC: ~15min)
**Priority:** P3
**Depends on:** None.

### GitLab support for /land-and-deploy

**What:** Add GitLab MR merge + CI polling support to `/land-and-deploy` skill. Currently uses `gh pr view`, `gh pr checks`, `gh pr merge`, and `gh run list/view` in 15+ places — each needs a GitLab conditional path using `glab ci status`, `glab mr merge`, etc.

**Why:** Without this, GitLab users can `/ship` (create MR) but can't `/land-and-deploy` (merge + verify). Completes the GitLab story end-to-end.

**Context:** `/retro`, `/ship`, and `/document-release` now support GitLab via the multi-platform `BASE_BRANCH_DETECT` resolver. `/land-and-deploy` has deeper GitHub-specific semantics (merge queues, required checks via `gh pr checks`, deploy workflow polling) that have different shapes on GitLab. The `glab` CLI (v1.90.0) supports `glab mr merge`, `glab ci status`, `glab ci view` but with different output formats and no merge queue concept.

**Effort:** L
**Priority:** P2
**Depends on:** None (BASE_BRANCH_DETECT multi-platform resolver is already done)

### Multi-commit CHANGELOG completeness eval

**What:** Add a periodic E2E eval that creates a branch with 5+ commits spanning 3+ themes (features, cleanup, infra), runs /ship's Step 5 CHANGELOG generation, and verifies the CHANGELOG mentions all themes.

**Why:** The bug fixed in v0.11.22 (garrytan/ship-full-commit-coverage) showed that /ship's CHANGELOG generation biased toward recent commits on long branches. The prompt fix adds a cross-check, but no test exercises the multi-commit failure mode. The existing `ship-local-workflow` E2E only uses a single-commit branch.

**Context:** Would be a `periodic` tier test (~$4/run, non-deterministic since it tests LLM instruction-following). Setup: create bare remote, clone, add 5+ commits across different themes on a feature branch, run Step 5 via `claude -p`, verify CHANGELOG output covers all themes. Pattern: `ship-local-workflow` in `test/skill-e2e-workflow.test.ts`.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Ship log — persistent record of /ship runs

**What:** Append structured JSON entry to `.gstack/ship-log.json` at end of every /ship run (version, date, branch, PR URL, review findings, Greptile stats, todos completed, test results).

**Why:** /retro has no structured data about shipping velocity. Ship log enables: PRs-per-week trending, review finding rates, Greptile signal over time, test suite growth.

**Context:** /retro already reads greptile-history.md — same pattern. Eval persistence (eval-store.ts) shows the JSON append pattern exists in the codebase. ~15 lines in ship template.

**Effort:** S
**Priority:** P2
**Depends on:** None


### Visual verification with screenshots in PR body

**What:** /ship Step 7.5: screenshot key pages after push, embed in PR body.

**Why:** Visual evidence in PRs. Reviewers see what changed without deploying locally.

**Context:** Part of Phase 3.6. Needs S3 upload for image hosting.

**Effort:** M
**Priority:** P2
**Depends on:** /setup-gstack-upload

## Review

### Inline PR annotations

**What:** /ship and /review post inline review comments at specific file:line locations using `gh api` to create pull request review comments.

**Why:** Line-level annotations are more actionable than top-level comments. The PR thread becomes a line-by-line conversation between Greptile, Claude, and human reviewers.

**Context:** GitHub supports inline review comments via `gh api repos/$REPO/pulls/$PR/reviews`. Pairs naturally with Phase 3.6 visual annotations.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Greptile training feedback export

**What:** Aggregate greptile-history.md into machine-readable JSON summary of false positive patterns, exportable to the Greptile team for model improvement.

**Why:** Closes the feedback loop — Greptile can use FP data to stop making the same mistakes on your codebase.

**Context:** Was a P3 Future Idea. Upgraded to P2 now that greptile-history.md data infrastructure exists. The signal data is already being collected; this just makes it exportable. ~40 lines.

**Effort:** S
**Priority:** P2
**Depends on:** Enough FP data accumulated (10+ entries)

### Visual review with annotated screenshots

**What:** /review Step 4.5: browse PR's preview deploy, annotated screenshots of changed pages, compare against production, check responsive layouts, verify accessibility tree.

**Why:** Visual diff catches layout regressions that code review misses.

**Context:** Part of Phase 3.6. Needs S3 upload for image hosting.

**Effort:** M
**Priority:** P2
**Depends on:** /setup-gstack-upload

## QA

### QA trend tracking

**What:** Compare baseline.json over time, detect regressions across QA runs.

**Why:** Spot quality trends — is the app getting better or worse?

**Context:** QA already writes structured reports. This adds cross-run comparison.

**Effort:** S
**Priority:** P2

### CI/CD QA integration

**What:** `/qa` as GitHub Action step, fail PR if health score drops.

**Why:** Automated quality gate in CI. Catch regressions before merge.

**Effort:** M
**Priority:** P2

### Smart default QA tier

**What:** After a few runs, check index.md for user's usual tier pick, skip the AskUserQuestion.

**Why:** Reduces friction for repeat users.

**Effort:** S
**Priority:** P2

### Accessibility audit mode

**What:** `--a11y` flag for focused accessibility testing.

**Why:** Dedicated accessibility testing beyond the general QA checklist.

**Effort:** S
**Priority:** P3

### CI/CD generation for non-GitHub providers

**What:** Extend CI/CD bootstrap to generate GitLab CI (`.gitlab-ci.yml`), CircleCI (`.circleci/config.yml`), and Bitrise pipelines.

**Why:** Not all projects use GitHub Actions. Universal CI/CD bootstrap would make test bootstrap work for everyone.

**Context:** v1 ships with GitHub Actions only. Detection logic already checks for `.gitlab-ci.yml`, `.circleci/`, `bitrise.yml` and skips with an informational note. Each provider needs ~20 lines of template text in `generateTestBootstrap()`.

**Effort:** M
**Priority:** P3
**Depends on:** Test bootstrap (shipped)

### Auto-upgrade weak tests (★) to strong tests (★★★)

**What:** When Step 7 coverage audit identifies existing ★-rated tests (smoke/trivial assertions), generate improved versions testing edge cases and error paths.

**Why:** Many codebases have tests that technically exist but don't catch real bugs — `expect(component).toBeDefined()` isn't testing behavior. Upgrading these closes the gap between "has tests" and "has good tests."

**Context:** Requires the quality scoring rubric from the test coverage audit. Modifying existing test files is riskier than creating new ones — needs careful diffing to ensure the upgraded test still passes. Consider creating a companion test file rather than modifying the original.

**Effort:** M
**Priority:** P3
**Depends on:** Test quality scoring (shipped)

## Retro

### Deployment health tracking (retro + browse)

**What:** Screenshot production state, check perf metrics (page load times), count console errors across key pages, track trends over retro window.

**Why:** Retro should include production health alongside code metrics.

**Context:** Requires browse integration. Screenshots + metrics fed into retro output.

**Effort:** L
**Priority:** P3
**Depends on:** Browse sessions

## Infrastructure

### /setup-gstack-upload skill (S3 bucket)

**What:** Configure S3 bucket for image hosting. One-time setup for visual PR annotations.

**Why:** Prerequisite for visual PR annotations in /ship and /review.

**Effort:** M
**Priority:** P2

### gstack-upload helper

**What:** `browse/bin/gstack-upload` — upload file to S3, return public URL.

**Why:** Shared utility for all skills that need to embed images in PRs.

**Effort:** S
**Priority:** P2
**Depends on:** /setup-gstack-upload

### WebM to GIF conversion

**What:** ffmpeg-based WebM → GIF conversion for video evidence in PRs.

**Why:** GitHub PR bodies render GIFs but not WebM. Needed for video recording evidence.

**Effort:** S
**Priority:** P3
**Depends on:** Video recording



### Extend worktree isolation to Claude E2E tests

**What:** Add `useWorktree?: boolean` option to `runSkillTest()` so any Claude E2E test can opt into worktree mode for full repo context instead of tmpdir fixtures.

**Why:** Some Claude E2E tests (CSO audit, review-sql-injection) create minimal fake repos but would produce more realistic results with full repo context. The infrastructure exists (`describeWithWorktree()` in e2e-helpers.ts) — this extends it to the session-runner level.

**Context:** WorktreeManager shipped in v0.11.12.0. Currently only Gemini/Codex tests use worktrees. Claude tests use planted-bug fixture repos which are correct for their purpose, but new tests that want real repo context can use `describeWithWorktree()` today. This TODO is about making it even easier via a flag on `runSkillTest()`.

**Effort:** M (human: ~2 days / CC: ~20 min)
**Priority:** P3
**Depends on:** Worktree isolation (shipped v0.11.12.0)

### E2E model pinning — SHIPPED

~~**What:** Pin E2E tests to claude-sonnet-4-6 for cost efficiency, add retry:2 for flaky LLM responses.~~

Shipped: Default model changed to Sonnet for structure tests (~30), Opus retained for quality tests (~10). `--retry 2` added. `EVALS_MODEL` env var for override. `test:e2e:fast` tier added. Rate-limit telemetry (first_response_ms, max_inter_turn_ms) and wall_clock_ms tracking added to eval-store.

### Eval web dashboard

**What:** `bun run eval:dashboard` serves local HTML with charts: cost trending, detection rate, pass/fail history.

**Why:** Visual charts better for spotting trends than CLI tools.

**Context:** Reads `~/.gstack-dev/evals/*.json`. ~200 lines HTML + chart.js via Bun HTTP server.

**Effort:** M
**Priority:** P3
**Depends on:** Eval persistence (shipped in v0.3.6)

### CI/CD QA quality gate

**What:** Run `/qa` as a GitHub Action step, fail PR if health score drops below threshold.

**Why:** Automated quality gate catches regressions before merge. Currently QA is manual — CI integration makes it part of the standard workflow.

**Context:** Requires headless browse binary available in CI. The `/qa` skill already produces `baseline.json` with health scores — CI step would compare against the main branch baseline and fail if score drops. Would need `ANTHROPIC_API_KEY` in CI secrets since `/qa` uses Claude.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Cross-platform URL open helper

**What:** `gstack-open-url` helper script — detect platform, use `open` (macOS) or `xdg-open` (Linux).

**Why:** The first-time Completeness Principle intro uses macOS `open` to launch the essay. If gstack ever supports Linux, this silently fails.

**Effort:** S (human: ~30 min / CC: ~2 min)
**Priority:** P4
**Depends on:** Nothing

### CDP-based DOM mutation detection for ref staleness

**What:** Use Chrome DevTools Protocol `DOM.documentUpdated` / MutationObserver events to proactively invalidate stale refs when the DOM changes, without requiring an explicit `snapshot` call.

**Why:** Current ref staleness detection (async count() check) only catches stale refs at action time. CDP mutation detection would proactively warn when refs become stale, preventing the 5-second timeout entirely for SPA re-renders.

**Context:** Parts 1+2 of ref staleness fix (RefEntry metadata + eager validation via count()) are shipped. This is Part 3 — the most ambitious piece. Requires CDP session alongside Playwright, MutationObserver bridge, and careful performance tuning to avoid overhead on every DOM change.

**Effort:** L
**Priority:** P3
**Depends on:** Ref staleness Parts 1+2 (shipped)

## Office Hours / Design

### Design docs → Supabase team store sync

**What:** Add design docs (`*-design-*.md`) to the Supabase sync pipeline alongside test plans, retro snapshots, and QA reports.

**Why:** Cross-team design discovery at scale. Local `~/.gstack/projects/$SLUG/` keyword-grep discovery works for same-machine users now, but Supabase sync makes it work across the whole team. Duplicate ideas surface, everyone sees what's been explored.

**Context:** /office-hours writes design docs to `~/.gstack/projects/$SLUG/`. The team store already syncs test plans, retro snapshots, QA reports. Design docs follow the same pattern — just add a sync adapter.

**Effort:** S
**Priority:** P2
**Depends on:** `garrytan/team-supabase-store` branch landing on main

### /yc-prep skill

**What:** Skill that helps founders prepare their YC application after /office-hours identifies strong signal. Pulls from the design doc, structures answers to YC app questions, runs a mock interview.

**Why:** Closes the loop. /office-hours identifies the founder, /yc-prep helps them apply well. The design doc already contains most of the raw material for a YC application.

**Effort:** M (human: ~2 weeks / CC: ~2 hours)
**Priority:** P2
**Depends on:** office-hours founder discovery engine shipping first

## Design Review

### /plan-design-review + /qa-design-review + /design-consultation — SHIPPED

Shipped as v0.5.0 on main. Includes `/plan-design-review` (report-only design audit), `/qa-design-review` (audit + fix loop), and `/design-consultation` (interactive DESIGN.md creation). `{{DESIGN_METHODOLOGY}}` resolver provides shared 80-item design audit checklist.

### Design outside voices in /plan-eng-review

**What:** Extend the parallel dual-voice pattern (Codex + Claude subagent) to /plan-eng-review's architecture review section.

**Why:** The design beachhead (v0.11.3.0) proves cross-model consensus works for subjective reviews. Architecture reviews have similar subjectivity in tradeoff decisions.

**Context:** Depends on learnings from the design beachhead. If the litmus scorecard format proves useful, adapt it for architecture dimensions (coupling, scaling, reversibility).

**Effort:** S
**Priority:** P3
**Depends on:** Design outside voices shipped (v0.11.3.0)

### Outside voices in /qa visual regression detection

**What:** Add Codex design voice to /qa for detecting visual regressions during bug-fix verification.

**Why:** When fixing bugs, the fix can introduce visual regressions that code-level checks miss. Codex could flag "the fix broke the responsive layout" during re-test.

**Context:** Depends on /qa having design awareness. Currently /qa focuses on functional testing.

**Effort:** M
**Priority:** P3
**Depends on:** Design outside voices shipped (v0.11.3.0)

## Document-Release

### Auto-invoke /document-release from /ship — SHIPPED

Shipped in v0.8.4; redesigned twice since. Current design (v0.18.2.0+, carved in
v1.54.0.0): `/ship` Step 18 (`ship/sections/pr-body.md`) dispatches
`/document-release` as a general-purpose subagent AFTER Step 17 (push) and
BEFORE Step 19 (PR creation); the subagent's JSON contract (`files_updated`,
`commit_sha`, `pushed`, `documentation_section`) is baked into the initial PR
body. Subagent failure is non-blocking. The skeleton names "the
/document-release subagent" at three touchpoints (section-index trigger + STOP
pointer, Step 17 handoff, hoisted doc-sync invariant). Pinned by
`test/ship-document-release-dispatch.test.ts` + carve-guards anchors; behavior
proven by the `ship-docsync` gate E2E (`test/skill-e2e-ship-docsync.test.ts`).

### Machine-checkable Step 18 dispatch receipt in /ship's Section self-check

**What:** Make ship's "Section self-check" verify a document-release dispatch
actually occurred (a machine-checkable marker/receipt), instead of relying on
prompt-level invariants alone.

**Why:** Prompt wording deters skipping but can't prove the dispatch happened.
Two residual gaps from the v1.69 review are folded into this scope: (1) an
agent invoking `/document-release` inline via the Skill tool bypasses the
fresh-context subagent + JSON contract and no test can see it; (2) the ship
RE-RUN path names document-release in the re-run list but no test asserts
doc-sync on re-run.

**Context:** The `ship-docsync` E2E asserts the dispatch tool-call on the
primary path; this TODO is the enforcement layer beyond wording. Start from
ship's Section self-check (ship/SKILL.md.tmpl) and the Step 18 parent
processing in ship/sections/pr-body.md.tmpl.

**Effort:** M (human) → S (CC+gstack)
**Priority:** P3
**Depends on:** ship-docsync E2E landed

### Apply the dispatch-pin + E2E pattern to /land-and-deploy → /canary

**What:** Same treatment ship→document-release got: name the handoff at the
skeleton decision points, pin with carve-guards anchors + a free tripwire,
prove with a toolCalls-assert E2E.

**Why:** Identical failure class — a carve or reword can silently strand the
canary handoff out of the always-loaded skeleton, and nothing tests it today.

**Context:** Model files: `test/ship-document-release-dispatch.test.ts` (free
pin) and `test/skill-e2e-ship-docsync.test.ts` (dispatch E2E, gate tier).

**Effort:** M (human) → S (CC+gstack)
**Priority:** P3
**Depends on:** None

### CI gate-lane hollow-coverage burn-down (evals.yml matrix)

**What:** `test/evals-workflow-matrix.test.ts` (added v1.70.1.0) ratchets two
pre-existing CI coverage holes; burn them down. (1) Eight gate-hosting test
files have no `evals.yml` matrix row, so CI never runs them
(`KNOWN_MATRIX_GAPS` in the test enumerates them — notably the plan-mode and
finding-floor smokes and the AUQ format-compliance gate). (2) Four matrix rows
point at whole-file tier-gated files but set no row `tier:` property, so with
`EVALS_TIER` unexported those suites self-skip: `codex-e2e`/`gemini-e2e` run
ZERO tests and report green on every PR (vestigial rows; the periodic cron
lane owns them — consider deleting the rows), and `e2e-pty-plan-smoke` spends
~7 min on setup then skips every describe (hollow-green since the files
adopted `describeE2ETier('gate')` — set `tier: gate` on the row to reactivate,
after confirming the smokes still pass).

**Why:** "Gate tier blocks merge" is silently false for these files. Each fix
is a deliberate cost/flake decision (activating paid suites on every PR), so
they're enumerated instead of drive-by-fixed. The mechanism already exists:
per-row `tier:` property, exported as `EVALS_TIER` by the Run step.

**Context:** Found 2026-08-26 on PR #2700 while adding the `ship-docsync` row.
Fix = add/adjust the matrix row, then DELETE the corresponding burn-down entry
(the tripwire fails on stale entries, so cleanup is enforced).

**Effort:** S per file (mechanical) + one burn-in run each to confirm green
**Priority:** P2
**Depends on:** None

### Periodic paid-test shard census is one ungated file from the detach-timeout floor

**What:** The periodic tier's shard census is 67 files — one ungated slot below
the 68-file (17×4) ceiling. The next paid `skill-e2e-*` file WITHOUT a
whole-file `describeE2ETier` self-gate lands at 68 (still 17 waves, floor
32,130s ≤ 32,400s — passes); the SECOND ungated file trips 18 waves → 34,020s
floor > the 32,400s configured detach timeout, and
`test/eval-detach-timeout-floor.test.ts` fails with a confusing message.

**Why:** Whoever adds the second ungated periodic E2E gets a floor failure
unrelated to their change. Fix options: raise the periodic detach timeout, or
enforce whole-file tier self-gates on all paid files (upgrades them from the
tier-alignment warn-only bucket to the hard invariant, and — bonus — restores
tierless `bun run test:evals` coverage decisions to diff selection alone).

**Context:** `scripts/test-paid-shards.ts` `classifyPaidTestFile` counts
ungated files in both tiers; `ship-docsync` composed `describeE2ETier('gate')`
with diff selection specifically to avoid consuming the last free slot.

**Effort:** S
**Priority:** P3
**Depends on:** None

### `{{DOC_VOICE}}` shared resolver

**What:** Create a placeholder resolver in gen-skill-docs.ts encoding the gstack voice guide (friendly, user-forward, lead with benefits). Inject into /ship Step 5, /document-release Step 5, and reference from CLAUDE.md.

**Why:** DRY — voice rules currently live inline in 3 places (CLAUDE.md CHANGELOG style section, /ship Step 5, /document-release Step 5). When the voice evolves, all three drift.

**Context:** Same pattern as `{{QA_METHODOLOGY}}` — shared block injected into multiple templates to prevent drift. ~20 lines in gen-skill-docs.ts.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Ship Confidence Dashboard

### Smart review relevance detection — PARTIALLY SHIPPED

~~**What:** Auto-detect which of the 4 reviews are relevant based on branch changes (skip Design Review if no CSS/view changes, skip Code Review if plan-only).~~

`bin/gstack-diff-scope` shipped — categorizes diff into SCOPE_FRONTEND, SCOPE_BACKEND, SCOPE_PROMPTS, SCOPE_TESTS, SCOPE_DOCS, SCOPE_CONFIG. Used by design-review-lite to skip when no frontend files changed. Dashboard integration for conditional row display is a follow-up.

**Remaining:** Dashboard conditional row display (hide "Design Review: NOT YET RUN" when SCOPE_FRONTEND=false). Extend to Eng Review (skip for docs-only) and CEO Review (skip for config-only).

**Effort:** S
**Priority:** P3
**Depends on:** gstack-diff-scope (shipped)


## Codex

### Codex→Claude reverse buddy check skill

**What:** A Codex-native skill (`.agents/skills/gstack-claude/SKILL.md`) that runs `claude -p` to get an independent second opinion from Claude — the reverse of what `/codex` does today from Claude Code.

**Why:** Codex users deserve the same cross-model challenge that Claude users get via `/codex`. Currently the flow is one-way (Claude→Codex). Codex users have no way to get a Claude second opinion.

**Context:** The `/codex` skill template (`codex/SKILL.md.tmpl`) shows the pattern — it wraps `codex exec` with JSONL parsing, timeout handling, and structured output. The reverse skill would wrap `claude -p` with similar infrastructure. Would be generated into `.agents/skills/gstack-claude/` by `gen-skill-docs --host codex`.

**Effort:** M (human: ~2 weeks / CC: ~30 min)
**Priority:** P1
**Depends on:** None

## Completeness

### Completeness metrics dashboard

**What:** Track how often Claude chooses the complete option vs shortcut across gstack sessions. Aggregate into a dashboard showing completeness trend over time.

**Why:** Without measurement, we can't know if the Completeness Principle is working. Could surface patterns (e.g., certain skills still bias toward shortcuts).

**Context:** Would require logging choices (e.g., append to a JSONL file when AskUserQuestion resolves), parsing them, and displaying trends. Similar pattern to eval persistence.

**Effort:** M (human) / S (CC)
**Priority:** P3
**Depends on:** Boil the Lake shipped (v0.6.1)

## Safety & Observability

### On-demand hook skills (/careful, /freeze, /guard) — SHIPPED

~~**What:** Three new skills that use Claude Code's session-scoped PreToolUse hooks to add safety guardrails on demand.~~

Shipped as `/careful`, `/freeze`, `/guard`, and `/unfreeze` in v0.6.5. Includes hook fire-rate telemetry (pattern name only, no command content) and inline skill activation telemetry.

### Skill usage telemetry — SHIPPED

~~**What:** Track which skills get invoked, how often, from which repo.~~

Shipped in v0.6.5. TemplateContext in gen-skill-docs.ts bakes skill name into preamble telemetry line. Analytics CLI (`bun run analytics`) for querying. /retro integration shows skills-used-this-week.

### /investigate scoped debugging enhancements (gated on telemetry)

**What:** Six enhancements to /investigate auto-freeze, contingent on telemetry showing the freeze hook actually fires in real debugging sessions.

**Why:** /investigate v0.7.1 auto-freezes edits to the module being debugged. If telemetry shows the hook fires often, these enhancements make the experience smarter. If it never fires, the problem wasn't real and these aren't worth building.

**Context:** All items are prose additions to `investigate/SKILL.md.tmpl`. No new scripts.

**Items:**
1. Stack trace auto-detection for freeze directory (parse deepest app frame)
2. Freeze boundary widening (ask to widen instead of hard-block when hitting boundary)
3. Post-fix auto-unfreeze + full test suite run
4. Debug instrumentation cleanup (tag with DEBUG-TEMP, remove before commit)
5. Debug session persistence (~/.gstack/investigate-sessions/ — save investigation for reuse)
6. Investigation timeline in debug report (hypothesis log with timing)

**Effort:** M (all 6 combined)
**Priority:** P3
**Depends on:** Telemetry data showing freeze hook fires in real /investigate sessions

## Context Intelligence

### Context recovery preamble

**What:** Add ~10 lines of prose to the preamble telling the agent to re-read gstack artifacts (CEO plans, design reviews, eng reviews, checkpoints) after compaction or context degradation.

**Why:** gstack skills produce valuable artifacts stored at `~/.gstack/projects/$SLUG/`. When Claude's auto-compaction fires, it preserves a generic summary but doesn't know these artifacts exist. The plans and reviews that shaped the current work silently vanish from context, even though they're still on disk. This is the thing nobody else in the Claude Code ecosystem is solving, because nobody else has gstack's artifact architecture.

**Context:** Inspired by Anthropic's `claude-progress.txt` pattern for long-running agents. Also informed by claude-mem's "progressive disclosure" approach. See `docs/designs/SESSION_INTELLIGENCE.md` for the broader vision. CEO plan: `~/.gstack/projects/garrytan-gstack/ceo-plans/2026-03-31-session-intelligence-layer.md`.

**Effort:** S (human: ~30 min / CC: ~5 min)
**Priority:** P1
**Depends on:** None
**Key files:** `scripts/resolvers/preamble.ts`

### Session timeline

**What:** Append one-line JSONL entry to `~/.gstack/projects/$SLUG/timeline.jsonl` after every skill run (timestamp, skill, branch, outcome). `/retro` renders the timeline.

**Why:** Makes AI-assisted work history visible. `/retro` can show "this week: 3 /review, 2 /ship, 1 /investigate." Provides the observability layer for the session intelligence architecture.

**Effort:** S (human: ~1h / CC: ~5 min)
**Priority:** P1
**Depends on:** None
**Key files:** `scripts/resolvers/preamble.ts`, `retro/SKILL.md.tmpl`

### Cross-session context injection

**What:** When a new gstack session starts on a branch with recent checkpoints or plans, the preamble prints a one-line summary: "Last session: implemented JWT auth, 3/5 tasks done." Agent knows where you left off before reading any files.

**Why:** Claude starts every session fresh. This one-liner orients the agent immediately. Similar to claude-mem's SessionStart hook pattern but simpler and integrated.

**Effort:** S (human: ~2h / CC: ~10 min)
**Priority:** P2
**Depends on:** Context recovery preamble

### /checkpoint skill

**What:** Manual skill to snapshot current working state: what's being done and why, files being edited, decisions made (and rationale), what's done vs. remaining, critical types/signatures. Saved to `~/.gstack/projects/$SLUG/checkpoints/<timestamp>.md`.

**Why:** Useful before stepping away from a long session, before known-complex operations that might trigger compaction, for handing off context to a different agent/workspace, or coming back to a project after days away.

**Effort:** M (human: ~1 week / CC: ~30 min)
**Priority:** P2
**Depends on:** Context recovery preamble
**Key files:** New `checkpoint/SKILL.md.tmpl`, `scripts/gen-skill-docs.ts`

### Session Intelligence Layer design doc

**What:** Write `docs/designs/SESSION_INTELLIGENCE.md` describing the architectural vision: gstack as the persistent brain that survives Claude's ephemeral context. Every skill writes to `~/.gstack/projects/$SLUG/`, preamble re-reads, `/retro` rolls up.

**Why:** Connects context recovery, health, checkpoint, and timeline features into a coherent architecture. Nobody else in the ecosystem is building this.

**Effort:** S (human: ~2h / CC: ~15 min)
**Priority:** P1
**Depends on:** None

## Health

### /health — Project Health Dashboard

**What:** Skill that runs type-check, lint, test suite, and dead code scan, then reports a composite 0-10 health score with breakdown by category. Tracks over time in `~/.gstack/health/<project-slug>/` for trend detection. Optionally integrates CodeScene MCP for deeper complexity/cohesion/coupling analysis.

**Why:** No quick way to get "state of the codebase" before starting work. CodeScene peer-reviewed research shows AI-generated code increases static analysis warnings by 30%, code complexity by 41%, and change failure rates by 30%. Users need guardrails. Like `/qa` but for code quality rather than browser behavior.

**Context:** Reads CLAUDE.md for project-specific commands (platform-agnostic principle). Runs checks in parallel. `/retro` can pull from health history for trend sparklines.

**Effort:** M (human: ~1 week / CC: ~30 min)
**Priority:** P1
**Depends on:** None
**Key files:** New `health/SKILL.md.tmpl`, `scripts/gen-skill-docs.ts`

### /health as /ship gate

**What:** If health score exists and drops below a configurable threshold, `/ship` warns before creating the PR: "Health dropped from 8/10 to 5/10 this branch — 3 new lint warnings, 1 test failure. Ship anyway?"

**Why:** Quality gate that prevents shipping degraded code. Configurable threshold so it's not blocking for teams that don't use `/health`.

**Effort:** S (human: ~1h / CC: ~5 min)
**Priority:** P2
**Depends on:** /health skill

## Swarm

### Swarm primitive — reusable multi-agent dispatch

**What:** Extract Review Army's dispatch pattern into a reusable resolver (`scripts/resolvers/swarm.ts`). Wire into `/ship` for parallel pre-ship checks (type-check + lint + test in parallel sub-agents). Make available to `/qa`, `/investigate`, `/health`.

**Why:** Review Army proved parallel sub-agents work brilliantly (5 agents = 835K tokens of working memory vs. 167K for one). The pattern is locked inside `review-army.ts`. Other skills need it too. Claude Code Agent Teams (official, Feb 2026) validates the team-lead-delegates-to-specialists pattern. Gartner: multi-agent inquiries surged 1,445% in one year.

**Context:** Start with the specific `/ship` use case. Extract shared parts only after 2+ consumers reveal what config parameters are actually needed. Avoid premature abstraction. Can leverage existing WorktreeManager for isolation.

**Effort:** L (human: ~2 weeks / CC: ~2 hours)
**Priority:** P2
**Depends on:** None
**Key files:** `scripts/resolvers/review-army.ts`, new `scripts/resolvers/swarm.ts`, `ship/SKILL.md.tmpl`, `lib/worktree.ts`

## Refactoring

### /refactor-prep — Pre-Refactor Token Hygiene

**What:** Skill that detects project language/framework, runs appropriate dead code detection (knip/ts-prune for TS/JS, vulture/autoflake for Python, staticcheck/deadcode for Go, cargo udeps for Rust), strips dead imports/exports/props/console.logs, and commits cleanup separately.

**Why:** Dirty codebases accelerate context compaction. Dead imports, unused exports, and orphaned code eat tokens that contribute nothing but everything to triggering compaction mid-refactor. Cleaning first buys back 20%+ of context budget. Reports lines removed and estimated token savings.

**Effort:** M (human: ~1 week / CC: ~30 min)
**Priority:** P2
**Depends on:** None
**Key files:** New `refactor-prep/SKILL.md.tmpl`, `scripts/gen-skill-docs.ts`

## Factory Droid

### Browse MCP server for Factory Droid

**What:** Expose gstack's browse binary and key workflows as an MCP server that Factory Droid connects to natively. Factory users would run /mcp, add the gstack server, and get browse, QA, and review capabilities as Factory tools.

**Why:** Factory already supports 40+ MCP servers in its registry. Getting gstack's browse binary listed there is a distribution play. Nobody else has a real compiled browser binary as an MCP tool. This is the thing that makes gstack uniquely valuable on Factory Droid.

**Context:** Option A (--host factory compatibility shim) ships first in v0.13.4.0. Option B is the follow-up that provides deeper integration. The browse binary is already a stateless CLI, so wrapping it as an MCP server is straightforward (stdin/stdout JSON-RPC). Each browse command becomes an MCP tool.

**Effort:** L (human: ~1 week / CC: ~5 hours)
**Priority:** P1
**Depends on:** --host factory (Option A, shipping in v0.13.4.0)

### .agent/skills/ dual output for cross-agent compatibility

**What:** Factory also reads from `<repo>/.agent/skills/` as a cross-agent compatibility path. Could output there in addition to `.factory/skills/` for broader reach across other agents that use the `.agent` convention.

**Why:** Multiple AI agents beyond Factory may adopt the `.agent/skills/` convention. Outputting there too would give free compatibility.

**Effort:** S
**Priority:** P3
**Depends on:** --host factory

### Custom Droid definitions alongside skills

**What:** Factory has "custom droids" (subagents with tool restrictions, model selection, autonomy levels). Could ship `gstack-qa.md` droid configs alongside skills that restrict tools to read-only + execute for safety.

**Why:** Deeper Factory integration. Droid configs give Factory users tighter control over what gstack skills can do.

**Effort:** M
**Priority:** P3
**Depends on:** --host factory

## GStack Browser

### Anti-bot stealth: Playwright CDP patches (rebrowser-style)

**What:** Write a postinstall script that patches Playwright's CDP layer to suppress `Runtime.enable` and use `addBinding` for context ID discovery, same approach as rebrowser-patches. Eliminates the `navigator.webdriver`, `cdc_` markers, and other CDP artifacts that sites like Google use to detect automation.

**Why:** As of v1.58.3.0 our JS-layer stealth is "Layer C" — always-on `navigator.webdriver` mask + `window.chrome.*` shape + `Notification.permission`/Permissions alignment + per-install `hardwareConcurrency`/`deviceMemory` + a `Function.prototype.toString` proxy + an automation-global sweep + ChromeDriver `cdc_`/`__webdriver` cleanup (still NOT faking plugins/languages, since modern fingerprinters punish inconsistent fakes more than they punish admitted defaults). That closes most JS-observable tells, but Google still triggers captchas because the deepest detection is at the CDP protocol level, which a page-world init script can't reach. rebrowser-patches proved the CDP approach works but their patches target Playwright 1.52.0 and don't apply to our 1.58.2. We need our own patcher using string matching instead of line-number diffs. 6 files, ~200 lines of patches total. (Layer C's toString proxy still has descriptor/Reflect.ownKeys surfaces; pushing the spoofs to native code via CDP suppression or the Chromium fork makes the JS layer obsolete.)

**Context:** Full analysis of rebrowser-patches source: patches 6 files in `playwright-core/lib/server/` (crConnection.js, crDevTools.js, crPage.js, crServiceWorker.js, frames.js, page.js). Key technique: suppress `Runtime.enable` (the main CDP detection vector), use `Runtime.addBinding` + `CustomEvent` trick to discover execution context IDs without it. Our extension communicates via Chrome extension APIs, not CDP Runtime, so it should be unaffected. Write E2E tests that verify: (1) extension still loads and connects, (2) Google.com loads without captcha, (3) sidebar chat still works.

**Effort:** L (human: ~2 weeks / CC: ~3 hours)
**Priority:** P1
**Depends on:** None

### Chromium fork (long-term alternative to CDP patches)

**What:** Maintain a Chromium fork where anti-bot stealth, GStack Browser branding, and native sidebar support live in the source code, not as runtime monkey-patches.

**Why:** The CDP patches are brittle. They break on every Playwright upgrade and target compiled JS with fragile string matching. A proper fork means: (1) stealth is permanent, not patched, (2) branding is native (no plist hacking at launch), (3) native sidebar replaces the extension (Phase 4 of V0 roadmap), (4) custom protocols (gstack://) for internal pages. Companies like Brave, Arc, and Vivaldi maintain Chromium forks with small teams. With CC, the rebase-on-upstream maintenance could be largely automated.

**Context:** Trigger criteria from V0 design doc: fork when extension side panel becomes the bottleneck, when anti-bot patches need to live deeper than CDP, or when native UI integration (sidebar, status bar) can't be done via extension. The Chromium build takes ~4 hours on a 32-core machine and produces ~50GB of build artifacts. CI would need dedicated build infra. See `docs/designs/GSTACK_BROWSER_V0.md` Phase 5 for full analysis.

**Effort:** XL (human: ~1 quarter / CC: ~2-3 weeks of focused work)
**Priority:** P2
**Depends on:** CDP patches proving the value of anti-bot stealth first

## /spec follow-ups (deferred from v1.47.0.0 via /plan-ceo-review SCOPE EXPANSION)

### P2: `/spec --epic` mode (parent issue + child issues + dependency graph)

**Priority:** P2

**What:** Add `--epic` flag that produces an Epic issue (parent) plus N child issues with explicit dependency graph and topological order. Emits multiple `gh issue create` calls with parent linkage in child bodies.

**Why:** Multi-week initiatives often span 3-5 specs that share context but ship sequentially. Today `/spec --epic` would let users author the full initiative in one session and file all linked issues atomically. The Epic template already exists in `spec/SKILL.md.tmpl` (carried over from PR #1698); only the flag routing + multi-issue `gh` orchestration is missing.

**Pros:**
- Closes the multi-issue workflow gap that `/spec` v1 doesn't cover.
- Parent + child linkage means project boards show the full initiative at-a-glance.
- Composes cleanly with existing `--execute` (spawn an agent on the parent epic; agent files children as it works).

**Cons:**
- More gh API surface (one create per child, parent-link edit pass).
- Dependency-graph rendering in markdown is fiddly across GitHub vs GitLab renderers.

**Context:** Considered in `/plan-ceo-review` SCOPE EXPANSION (D5), deferred 2026-05-25 in favor of shipping the 5 critical-path expansions (--execute, --dedupe, archive, quality gate, --audit). Re-evaluate once v1.47 ships and we see how often users hit "this should be 3 issues" in real /spec sessions.

**Depends on:** v1.47.0.0 `/spec` lands first; need real usage data to calibrate the multi-issue surface.

### P3: `/spec --dedupe` semantic matching (LLM-based) for v1.1

**Priority:** P3

**What:** Upgrade `--dedupe`'s string match against `gh issue list --search` to LLM-based semantic similarity. Today's v1 picks string overlap on title keywords; semantic match would catch "the sidebar terminal flakes on reload" matching an existing issue titled "PTY reconnect fails after extension restart" where keyword overlap is zero.

**Why:** String match has high precision but low recall — it misses near-duplicates with different vocabulary. LLM semantic match catches more dupes but costs ~$0.01-0.05 per spec dispatch and adds 5-10s latency.

**Pros:**
- Catches dupes string match misses.
- One more reason `/spec` is more useful than freehand authoring.

**Cons:**
- Paid + slower. Most v1 users probably don't hit enough false-negatives to justify the cost.
- Adds another LLM-judged decision to a skill that already has the quality gate.

**Context:** Considered in `/plan-ceo-review` build-time decisions; chose string match for v1 to keep the dedupe path free + fast. Revisit if v1 produces a meaningful false-negative rate in real use.

**Depends on:** v1.47.0.0 ships; gather real false-negative data from the v1 string matcher.

## Test/evals/CI speedup follow-ups (filed v1.66.0.0 via /ship review army)

### P2: Free-suite shard balancing — LPT by recorded durations instead of stable hash

**What:** Full-suite shard assignment is a stable hash; measured shard durations
spread 69.5s-168.5s (max 2.4x min), so ~35-40s of every run is idle tail. Local
full-suite mode doesn't need deterministic indices (only the CI --shards matrix
does) — bin-pack by recorded per-file durations (bun prints them in the logs the
runner already captures), keep assignFilesToShards untouched for --shard mode.
**Where:** scripts/test-free-shards.ts main() full-suite path.
**Effort:** S (human ~4h, CC ~20min).

### P2: Propagate parent eval selection to shard children (EVALS_SELECTION_JSON)

**What:** The sharded paid runner computes selection once in the parent, but each
shard child re-derives it at e2e-helpers module load (git spawns per shard; plus a
bun child evaluating the old touchfiles-data when map-diff is active). Serialize
the parent's selection into the child env and honor it in computeDiffSelection,
keeping child self-derivation for non-sharded entrypoints. Add a parent/child
selection drift test (same fixture through computePaidDiffSelection and
computeDiffSelection) while there.
**Where:** scripts/test-paid-shards.ts runPaidShards env block; test/helpers/e2e-helpers.ts.
**Effort:** S (human ~4h, CC ~20min).

### P2: evals.yml matrix census tripwire — gate files must appear in the CI matrix

**What:** The branch's headline incident (two rehomed gate files silently never ran
for 48 versions because the monolith's filename missed the hand-listed evals.yml
matrix) has no tripwire binding gate-tier skill-e2e files to the matrix.
e2e-tier-alignment covers the LOCAL sharded runner's mapper; the CI matrix can
still drift. Parse the workflow YAML in a free test and diff against E2E_TIERS
gate files (curated exclude list for deliberately-manual files).
**Where:** new test beside test/e2e-tier-alignment.test.ts; .github/workflows/evals.yml.
**Effort:** S (human ~3h, CC ~15min).

### P2: E2E dep-list self-registration sweep — 129 of 177 keys omit their own test file

**What:** Editing only a test's assertions/prompt selects nothing for most keys
(the adversarial review measured 129/177), and parent-side shard skipping makes
the hole cheaper to hit. This branch fixed the rehomed files' keys; sweep the
rest mechanically (each key's dep list appends the file that declares it) and
upgrade e2e-tier-alignment's report-only mode to enforce self-registration.
**Where:** test/helpers/touchfiles-data.ts; test/e2e-tier-alignment.test.ts.
**Effort:** S (human ~3h, CC ~15min).

### P3: Paid runner spools non-live shard output to disk instead of RAM

**What:** Non-live shards buffer their entire 30-min stream-json stdout+stderr in
memory (Buffer[]), x jobs concurrent shards. Spool to a temp file like the free
runner's per-run log.
**Where:** scripts/test-paid-shards.ts runPaidShard buffered path.
**Effort:** S (human ~2h, CC ~10min).

### P3: Eval Docker image freshness tripwire

**What:** The cache-key trio means the image rebuilds only when Dockerfile/bun.lock
change; freshness of the baked unpinned claude CLI now rides entirely on
ci-image.yml's cron. If the cron silently fails or is disabled, eval CI pins to an
ever-older CLI with no signal. Add an image-age check (fail the eval workflow when
the image tag's created date exceeds N days) or a cron-liveness alert.
**Where:** .github/workflows/ci-image.yml, evals.yml.
**Effort:** S (human ~2h, CC ~10min).

### P3: Detach-floor self-check against runtime knobs (EVALS_JOBS)

**What:** test/eval-detach-timeout-floor.test.ts computes the worst case from
constants; an operator exporting EVALS_JOBS=2 doubles the gate worst case past the
25,200s watchdog and healthy tail shards report never-started. Add a runtime
self-check in test-paid-shards main(): warn/fail when the computed worst case with
LIVE options exceeds a GSTACK_DETACH_TIMEOUT env exported by gstack-detach.
**Where:** scripts/test-paid-shards.ts; bin/gstack-detach.
**Effort:** S (human ~2h, CC ~10min).

### P3: Eval store records the effective judge/capture model per run

**What:** Model defaults moved (capture Opus→Sonnet) and GSTACK_EVAL_MODEL_JUDGE
can silently change graders; eval:compare deltas across a model boundary conflate
model swap with skill regressions. Record the resolved models in the eval-store
record and surface them in eval:compare.
**Where:** test/helpers/eval-store.ts, llm-judge.ts, eval-compare.
**Effort:** S (human ~2h, CC ~10min).

### P3: SECURITY_BENCH periodic lane — classifier behavioral coverage runs nowhere

**What:** Gating the live L4 classifier tests on SECURITY_BENCH=1 fixed local
suite speed but left the prompt-injection classifier with no scheduled lane.
Add SECURITY_BENCH=1 (with model-cache warmup, 112MB first run) to
evals-periodic.yml so behavioral coverage exists weekly.
**Where:** .github/workflows/evals-periodic.yml; browse/test/security-live-playwright.test.ts.
**Effort:** S (human ~2h, CC ~10min).

### P3: Shared child-lifecycle helper for the two shard runners

**What:** runFreeShard and runPaidShard duplicate ~35 lines of spawn/group-kill/
wall-timer scaffold verbatim (and the ShardCommand type). Extract into
scripts/test-strict-output.ts, which already hosts the shared lifecycle
primitives, leaving stream policy per runner.
**Where:** scripts/test-free-shards.ts, scripts/test-paid-shards.ts.
**Effort:** S (human ~3h, CC ~15min).

### P3: DI-refactor gstack-gbrain-detect-mcp-mode test (~40s spawn cost, absorbed but real)

**What:** Plan item 5 of the v1.66.0.0 pass, deferred: the test spawns the real
binary repeatedly. Refactor to import the module with a DI-injected exec seam
(never env-set-before-import), keep 1-2 spawn smokes. Cost is currently absorbed
by shard parallelism; the per-file wall cost remains.
**Where:** test/gstack-gbrain-detect-mcp-mode.test.ts.
**Effort:** S (human ~2h, CC ~15min).

### P2: In-shard eval concurrency (40) is the shared root of the timeout-flake family

**What:** Every timeout-flake member on PR #2593 (document-release 180s->300s,
review-dashboard-via 300s->360s after PR #2472's 180s->300s, retro-base-branch
240s->360s) shares one story: claude session STARTUP queues behind up to 39
siblings under evals.yml's `--max-concurrency 40`, eating the per-test budget
before the first turn. Per-test ratchets treat symptoms. Systemic options:
(a) drop in-shard concurrency to ~15-20 and measure the wall-clock cost,
(b) startup-aware budgets (start the timer at first turn, not spawn),
(c) per-row concurrency overrides like the retries field. Receipts: the
PR #2593 flake ledger comment.
**Where:** .github/workflows/evals.yml:309 (--max-concurrency 40);
test/helpers/session-runner.ts (budget start point).
**Effort:** M (human ~1d, CC ~45min + measurement rounds).

### P2: plan-design-review scope-gate detector is marginal under CI contention

**What:** `plan-design-review reaches a terminal outcome outside plan mode`
(test/skill-e2e-plan-mode-no-op.test.ts) intermittently fails ONLY the
`scopeGateQuestionObserved` check on unchanged code — PR #2593 CI: failed
rounds 3/11 + one rerun, passed rounds 5/6, all attempts reaching a terminal
outcome with no plan-mode leak. Hypothesis: the PTY detector anchors on a
render shape that scrolls out or gets rephrased under 40-way in-shard
contention. The assertion now throws WITH the last-2KB evidence tail, so the
next CI failure carries the screen contents; fix the detector (scan full
scrollback, or widen the anchored shape) from that data.

**Where:** test/helpers/claude-pty-runner.ts (scopeGateQuestionObserved
detector), test/skill-e2e-plan-mode-no-op.test.ts.
**Effort:** S (human ~3h, CC ~20min + one CI round with evidence).

### P3: Diagnose the browser-manager-unit wedge on windows-latest

**What:** The expanded Windows lane wedges to its wall deadline inside
browse/test/browser-manager-unit.test.ts (in-flight at kill, PR #2593 run
31919227507); the file is green on macOS and Linux. Excluded from the Windows
curation with a receipt; needs a Windows repro to find which describe hangs
(fake-timer/unref semantics under bun-windows are the suspects).
**Where:** browse/test/browser-manager-unit.test.ts; scripts/test-free-shards.ts
KNOWN_WINDOWS_INCOMPATIBLE (remove the entry once fixed).
**Effort:** S (human ~2h with a Windows box, CC ~15min + CI rounds).

### P3: skill-census Windows compatibility

**What:** skillCensus() throws at module load on windows-latest
(test/helpers/skill-census.ts:63) — the skills-tree symlink layout needs
Developer Mode CI runners lack. Either branch the census walk on win32
(treat copy-dirs as the setup script's _link_or_copy fallback produces) or
keep the exclusion. Consumers (catalog budget, coverage matrix) currently
have no Windows signal.
**Where:** test/helpers/skill-census.ts; test/skill-census.test.ts.
**Effort:** S (human ~3h, CC ~20min + CI rounds).

### P3: Tighten revived coverage-audit E2E assertions

**What:** The revived skill-e2e-coverage-audit tests assert hasGap OR hasTested
(near-vacuous) and reference skill sections their own DRIFT WARNING says moved.
Tighten to conjunctive assertions and retarget the prompts at live sections;
needs one paid run to validate, so it didn't ride the ship.
**Where:** test/skill-e2e-coverage-audit.test.ts.
**Effort:** S (human ~2h, CC ~15min + one paid run).

## Completed

### P3: Carve the always-loaded `{{PREAMBLE}}` reference blocks into an on-demand doc

**What:** The per-skill section carves (`/ship` v1.54, `/plan-ceo-review` v1.56) yield
real but bounded wins (-42% to -59% on the carved skill) because the shared
`{{PREAMBLE}}` (~40-50KB on every tier-3/4 skill) is the dominant always-loaded cost
and stays inline. Move the rarely-needed preamble REFERENCE blocks (the AskUserQuestion
split-rules and the CJK / lone-surrogate escaping reference) into an on-demand
section-style doc the agent reads only when it hits those edge cases, leaving the hot
path (voice, completeness principle, recommendation format) inline.

**Why:** Highest-ROI remaining token target. One preamble carve helps EVERY tier-≥2
skill at once, not one skill per PR. The eng-review on the plan-ceo carve flagged that
per-skill carves stay modest precisely because the preamble dominates the always-loaded
surface.

**Pros:** A single change reduces always-loaded cost across the whole skill pack.
**Cons:** The preamble is load-bearing and shared; a botched carve regresses every skill.
Needs the same union-parity + per-push freshness guards the section carves use, applied
corpus-wide.

**Context:** Builds on the v2 section pipeline (`scripts/resolvers/sections.ts`,
`{{SECTION:id}}` / `{{SECTION_INDEX}}`). The preamble source is
`scripts/resolvers/preamble.ts`. Measure which sub-blocks are cold (escaping reference,
split-rules) vs hot (voice, recommendation format) before cutting. Validate on one skill,
then roll corpus-wide.

**Effort estimate:** L (human team) → M (CC+gstack)
**Priority:** P3
**Depends on / blocked by:** The section pipeline (shipped v1.54). No hard blocker.
**Completed:** v1.70.0.0 (2026-08-25) — delivered in a stronger form by the token-reduction program: preamble bash moved to `bin/gstack-skill-start`/`-end`, one-time onboarding became gated instruction blocks, AUQ reference rules point at on-demand docs, and 12 more skills got section carves (20 total). Wins locked by the context-budget ratchet.


### ✅ DONE (v1.69.0.0): `./setup --host slate` accepted but installs nothing

**Priority:** P4 (was filed as slate-only — shipped with the whole drift class gated)

**What:** `slate` passed host-arg validation but set no INSTALL_* flag, so the
run configured nothing and exited 0. Now an informational arm (points at
`--host claude`; per docs/designs/SLATE_HOST.md Slate reads `.claude/skills`
as a compatibility fallback), plus a zero-dispatch guard that errors loudly if
any future host is accepted without an install arm, plus a cross-check test
pinning accept-list ⊆ dispatch-arms against the hosts/index.ts registry.

**Completed:** v1.69.0.0 (2026-08-22)

### ✅ DONE (v1.69.0.0, gstack side): ZeroEntropy sunset detect + advisory

**Priority:** P1 (calendar-driven; gbrain-side migration remains open — see
NEXT PRIORITY)

**What:** Wireup warns when ~/.gbrain/config.json names the zeroentropyai
recipe (fail-open grep — never blocks a working setup); setup-gbrain provider
comments say never to select the legacy recipe; USING_GBRAIN_WITH_GSTACK.md
troubleshooting entry names the Sept 4, 2026 deadline and #2365.

**Completed:** v1.69.0.0 (2026-08-22)

### ✅ DONE (v1.68.1.0): Stop-hook registration pins the setup-time absolute path

**Priority:** P1 (was filed Effort S, scoped to the Stop hook — shipped as the full defect class)

**What:** Registering hooks from a dev worktree baked that worktree's physical
path into global settings.json; deleting the worktree left dead hooks erroring
on every AskUserQuestion/session stop. Fixed for ALL gstack hooks, not just
Stop: canonical-only registration via `_hook_command_path`, a KNOWN_HOOKS
identity table in `gstack-settings-hook` (survives Claude Code stripping
`_gstack_source` tags), a `prune-stale [--repoint|--all]` self-healer that
runs heal-first on every `./setup`, per-item mutation safety, a mutation lock,
fail-closed parse, and complete uninstall/no-team teardown.

**Completed:** v1.68.1.0 (2026-08-18)

### ✅ DONE (v1.66.0.0): Free suite exit code is untrustworthy — in-process force-exits mask failures

**Priority:** P1

**What:** At least five browse test files end with `setTimeout(() => process.exit(0), 500)`
(browse/test/commands.test.ts:101, snapshot.test.ts:36, batch.test.ts:47,
handoff.test.ts:31, content-security.test.ts:465). The timer fires inside the SHARED
`bun test` process, exiting 0 before bun prints its final summary — so `bun test` can
report exit 0 while real test failures scrolled by earlier. Remove the force-exits and
fix the underlying handle leaks they paper over (lingering Playwright/daemon handles
that once made the suite hang), or scope the exit to a spawned child process.

**Why:** Observed 2026-08-07: three genuinely failing tests (eval-list-cli,
benchmark-cli, observability check 11) rode green `bun test` exit codes across
multiple runs; the failures only surfaced by grepping logs for "(fail)" lines. A test
suite that exits 0 on failure is worse than no suite — it manufactures false
confidence at commit time and in any CI job that trusts the exit code.

**Pros:** Restores the one contract everything (CI, /ship, humans) relies on: exit
code == truth. Also un-hides the missing final summary block.
**Cons:** The force-exits exist because the suite once hung on leaked handles;
removing them without fixing the leaks trades silent failure for hangs. Needs a
focused pass: find each leaked handle (daemon children, PTY, Playwright contexts),
close them in afterAll, then delete the exits one file at a time.

**Context / where to start:** `grep -rn "process.exit(0)" browse/test/` — the
setTimeout variants are the offenders (server-no-import-side-effects.test.ts:62 is a
spawned-child probe, fine). Repro: run the full free suite and note the log ends at
the browse files with no "Ran N tests" summary. Receipts:
~/.gstack-dev/logs/free-suite-main-check.log (3 masked fails, exit 0).

**Completed:** v1.66.0.0 (2026-08-15) — main's v1.64 removed the force-exits; v1.66.0.0 adds runner-level strict-output classification (a shard without bun's terminal summary FAILS), size-scaled wall deadlines, and the failure-naming epilogue, so exit code == truth is enforced by the runner, not by convention.

### Slim preamble + real-PTY plan-mode E2E harness (v1.13.1.0)

- Compressed 18 preamble resolvers; total `SKILL.md` corpus dropped from 3.08 MB to 2.30 MB across 47 outputs (-25.5%, ~196K tokens saved).
- Built `test/helpers/claude-pty-runner.ts` — real-PTY harness using `Bun.spawn({terminal:})` (Bun 1.3.10+ has built-in PTY, no `node-pty` needed).
- Rewrote 5 plan-mode E2E tests (`plan-ceo`, `plan-eng`, `plan-design`, `plan-devex`, `plan-mode-no-op`); all 5 pass for the first time ever (790s sequential).
- Same tests were 0/5 on `origin/main`, on v1.0.0.0, and on this branch with the SDK harness — the SDK couldn't observe Claude's plan-mode confirmation UI.
- Side fixes folded in: `scripts/skill-check.ts` sidecar-symlink helper, `test/skill-validation.test.ts` exemption for `browse/test/fixtures/security-bench-haiku-responses.json` (resolves the size-warning noise from main's warn-only conversion).

**Completed:** v1.13.1.0 (2026-04-25)

---

### Pre-existing test failures surfaced during v1.12.0.0 ship — RESOLVED

- `test/brain-sync.test.ts` GSTACK_HOME isolation fixed on main in v1.13.0.0.
- `test/model-overlay-opus-4-7.test.ts` updated on main to match the new overlay content (the v1.10.1.0 removal of "Fan out explicitly" was correct — measured −60pp fanout vs baseline).

**Completed:** v1.13.0.0 (2026-04-25, on main)

---

### `security-bench-haiku-responses.json` size gate — RESOLVED

- Main converted the 2 MB tracked-file gate to warn-only in v1.13.0.0.
- v1.13.1.0 added a `knownLargeFixtures` exemption to suppress the warning for this specific intentional fixture.

**Completed:** v1.13.1.0 (2026-04-25)

---

### Bearer-token secret-scan regression fixed + E2E coverage added for privacy gate + gh auto-create (v1.12.0.0)

- **Fixed the `bearer-token-json` regression in `bin/gstack-brain-sync`** — the value charset `[A-Za-z0-9_./+=-]{16,}` didn't permit spaces, so auth headers with the standard `Bearer <token>` form (literal space after the scheme name) slipped past the scanner. Added an optional `(Bearer |Basic |Token )?` prefix to the pattern. Validated against 5 positive cases (including the regression fixture) + 3 negative cases (short tokens, non-secret keys, random JSON). The 7-pattern secret scanner now passes all fixtures including bearer-json.
- **Added `test/gstack-brain-init-gh-mock.test.ts`** — 8 tests exercising the `gh` CLI auto-create path that previously had zero coverage. Stubs `gh` on PATH to record every call, asserts `gh repo create --private --description "..." --source <GSTACK_HOME>` fires with the computed `gstack-brain-<user>` default name. Covers: happy path, fall-through-to-`gh repo view` when create hits already-exists, user-provided-URL-bypasses-gh, gh-not-on-path prompts for URL, gh-not-authed prompts for URL, idempotent `--remote` re-runs, conflicting-remote rejection.
- **Added `test/skill-e2e-brain-privacy-gate.test.ts`** — periodic-tier E2E (~$0.30-$0.50/run). Stages a fake `gbrain` on PATH + `gbrain_sync_mode_prompted=false` in config, runs a real skill via `runAgentSdkTest`, intercepts tool-use via `canUseTool`, and asserts the preamble fires the 3-option privacy AskUserQuestion with canonical prose ("publish session memory" / "artifact" / "decline"). Second test asserts the gate is silent when `prompted=true` (idempotency-within-session).
- **Registered `brain-privacy-gate` in `test/helpers/touchfiles.ts`** (periodic tier) with dependency tracking on `scripts/resolvers/preamble/generate-brain-sync-block.ts`, `bin/gstack-brain-sync`, `bin/gstack-brain-init`, `bin/gstack-config`, and the Agent SDK runner. Diff-based selection will re-run the E2E whenever any of those change.

**Completed:** v1.12.0.0 (2026-04-24)

---

### Overlay efficacy harness + Opus 4.7 fanout nudge removal (v1.10.1.0)
- Built `test/skill-e2e-overlay-harness.test.ts`, a parametric periodic-tier eval that drives `@anthropic-ai/claude-agent-sdk` and measures first-turn fanout rate (overlay-ON vs overlay-OFF) across registered fixtures
- Measured the original "Fan out explicitly" overlay nudge: baseline Opus 4.7 = 70% first-turn fanout on toy prompt, with our nudge = 10%, with Anthropic's own canonical `<use_parallel_tool_calls>` text = 0%
- Removed the counterproductive nudge from `model-overlays/opus-4-7.md`
- Shipped 36-test free-tier unit suite for the SDK runner + strict fixture validator
- Registered `overlay-harness-opus-4-7-fanout-{toy,realistic}` in E2E_TOUCHFILES and E2E_TIERS
- Total investigation cost: ~$7 across 3 eval runs
**Completed:** v1.10.1.0

### CI eval pipeline (v0.9.9.0)
- GitHub Actions eval upload on Ubicloud runners ($0.006/run)
- Within-file test concurrency (test() → testConcurrentIfSelected())
- Eval artifact upload + PR comment with pass/fail + cost
- Baseline comparison via artifact download from main
- EVALS_CONCURRENCY=40 for ~6min wall clock (was ~18min)
**Completed:** v0.9.9.0

### Deploy pipeline (v0.9.8.0)
- /land-and-deploy — merge PR, wait for CI/deploy, canary verification
- /canary — post-deploy monitoring loop with anomaly detection
- /benchmark — performance regression detection with Core Web Vitals
- /setup-deploy — one-time deploy platform configuration
- /review Performance & Bundle Impact pass
- E2E model pinning (Sonnet default, Opus for quality tests)
- E2E timing telemetry (first_response_ms, max_inter_turn_ms, wall_clock_ms)
- test:e2e:fast tier, --retry 2 on all E2E scripts
**Completed:** v0.9.8.0

### Phase 1: Foundations (v0.2.0)
- Rename to gstack
- Restructure to monorepo layout
- Setup script for skill symlinks
- Snapshot command with ref-based element selection
- Snapshot tests
**Completed:** v0.2.0

### Phase 2: Enhanced Browser (v0.2.0)
- Annotated screenshots, snapshot diffing, dialog handling, file upload
- Cursor-interactive elements, element state checks
- CircularBuffer, async buffer flush, health check
- Playwright error wrapping, useragent fix
- 148 integration tests
**Completed:** v0.2.0

### Phase 3: QA Testing Agent (v0.3.0)
- /qa SKILL.md with 6-phase workflow, 3 modes (full/quick/regression)
- Issue taxonomy, severity classification, exploration checklist
- Report template, health score rubric, framework detection
- wait/console/cookie-import commands, find-browse binary
**Completed:** v0.3.0

### Phase 3.5: Browser Cookie Import (v0.3.x)
- cookie-import-browser command (Chromium cookie DB decryption)
- Cookie picker web UI, /setup-browser-cookies skill
- 18 unit tests, browser registry (Comet, Chrome, Arc, Brave, Edge)
**Completed:** v0.3.1

### E2E test cost tracking
- Track cumulative API spend, warn if over threshold
**Completed:** v0.3.6

### Auto-upgrade mode + smart update check
- Config CLI (`bin/gstack-config`), auto-upgrade via `~/.gstack/config.yaml`, 12h cache TTL, exponential snooze backoff (24h→48h→1wk), "never ask again" option, vendored copy sync on upgrade
**Completed:** v0.3.8

---

## Brain-aware planning follow-ups (filed v1.48.0.0 via /plan-ceo-review + /plan-eng-review)

These are the deferred cherry-picks (E2/E3/E4) from the v1.48 brain-aware
planning plan at `~/.claude/plans/hm-interesting-well-why-dapper-eagle.md`.
The foundation (Phase 0 entity model + Phase 0.5 cache + Phase 1 preflight
+ Phase 1.5 trust policy + Phase 2 write-back scaffolding) ships in
v1.48.0.0. These follow-ups extend it.

### P2: /gstack-reflect nightly synthesis skill (E2)

**What:** Scheduled skill that reads weekly `gstack/skill-run` + takes +
`get_recent_salience` and synthesizes a `gstack/insight` page surfaced at
next skill preflight.

**Why:** Cross-time pattern detection is the compounding move. "You ran 4
plan-ceo on infra this week, 0 on product — is product work getting
starved?" surfaces patterns the user wouldn't notice.

**Pros:** Brain compounds across TIME, not just across skills. Patterns
become actionable.

**Cons:** "You're starving product work" is high-judgment territory; needs
opt-out per project, careful insight templates.

**Context:** Deferred from v1.48.0.0 cherry-pick (D4) — wait 4-6 weeks for
real `gstack/skill-run` data to accumulate before designing the reflection
layer against real patterns instead of imagined ones.

**Effort:** L (human ~1-2 days, CC ~4-6h)

**Depends on:** Phase 0 (gstack/skill-run page type from v1.48.0.0) +
~6 weeks of accumulated data

### P3: Cross-machine brain-cache sync (E3)

**What:** Push compressed digests through the gstack-brain-sync git pipeline
so the brain-cache survives moving between Macs / Conductor workspaces.

**Why:** Eliminates the cold-miss tax on every new machine (~1-2s once per
machine per day).

**Pros:** Instant warm cache on new machines.

**Cons:** Cache poisoning risk if not designed carefully (hash invariants,
endpoint-binding, conflict resolution).

**Context:** Deferred from v1.48.0.0 cherry-pick (D5) — single-machine
cache is fine for V1; correctness risk needs its own design pass.

**Effort:** M (human ~4h, CC ~30min)

**Depends on:** Brain-cache layer from v1.48.0.0

### P3: /gstack-onboarding dedicated skill (E4)

**What:** Guided 5-minute setup skill for new gstack installs: walks user
through reading CLAUDE.md + README + recent commits to build `gstack/product`
and active goals with explicit AUQs.

**Why:** Better UX than the inline bootstrap (which only fires when a
planning skill is invoked).

**Pros:** Cleaner cold-start, explicit ceremony.

**Cons:** Inline bootstrap (in scope for v1.48) already covers the
cold-start path adequately.

**Context:** Deferred from v1.48.0.0 cherry-pick (D6) — observe inline
bootstrap performance first; add dedicated skill if friction is real.

**Effort:** S (human ~2h, CC ~15min)

**Depends on:** Inline bootstrap subcommand from v1.48.0.0

### P2: Upstream gbrain takes_add + takes_resolve MCP ops

**What:** Add `mcp__gbrain__takes_add` and `mcp__gbrain__takes_resolve`
ops in `~/git/gbrain/src/core/operations.ts`. Extract the markdown-fence
mirror logic from `commands/takes.ts:570` into a reusable
`engine.resolveTake()` helper.

**Why:** Unlocks Phase 2 calibration write-back without the fence-block
fallback. ~150 LOC. Already on gbrain's v0.31.x roadmap.

**Pros:** Clean Phase 2 path, removes the "fall back to put_page" smell.

**Cons:** Lives in upstream gbrain repo, not helsinki — separate PR.

**Context:** Phase 2 write-back is already wired in v1.48.0.0 behind the
BRAIN_CALIBRATION_WRITEBACK feature flag (default off). Flag flips to
true once upstream gbrain ships these ops. ~50 LOC follow-up in
helsinki to swap the fallback for the preferred op.

**Effort:** S (human ~1d, CC ~1h) in gbrain repo; trivial wire-up in
helsinki.

**Depends on:** None (parallel-track from v1.48.0.0)

### P3: Background-refresh hook supervision

**What:** Codex outside-voice raised that "background refresh at skill END"
is hand-wavy. Add proper process supervision: PID file, timeout, failure
log, cross-platform spawn.

**Why:** Current implementation backgrounds with `&` which works but
leaves no observability when a refresh fails.

**Context:** Deferred from v1.48.0.0 codex tension T3. Stays low priority
until users report stale digests where a background refresh silently
failed.

**Effort:** S (human ~2h, CC ~20min)

### P2: Re-verify calibration takes when gbrain v0.42+ lands

**What:** When upstream gbrain ships `takes_add` MCP op and we flip
`BRAIN_CALIBRATION_WRITEBACK` from FALSE to TRUE, re-run the manual
probe in `docs/gbrain-write-surfaces.md` against `/office-hours` and
confirm `gbrain takes_list` surfaces a `kind=bet` entry with the
expected weight (0.9 for office-hours, per
`scripts/brain-cache-spec.ts:151-157`).

**Why:** Today the calibration take path falls back to writing inside a
`gbrain put` fence block because `takes_add` isn't available yet. Once
v0.42+ ships, the agent will call `takes_add` directly — we should
confirm the new path actually persists a queryable take.

**Context:** v1.50.0.0 plan §"NOT in scope". The fence-block fallback
test (`test/takes-fence-fallback.test.ts`) covers wiring for both paths;
this TODO is about live verification of the preferred path when it
becomes available.

**Effort:** XS (human ~15min, CC ~5min)

**Depends on:** Upstream gbrain v0.42+ release shipping `takes_add` MCP
op (separate TODO above).

### P2: Extend brain-writeback E2E to the other 4 planning skills

**What:** `test/skill-e2e-office-hours-brain-writeback.test.ts` covers
the brain-writeback path for `/office-hours` only. Adding parallel
tests for `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`,
and `/plan-devex-review` would bring per-skill agent-obedience coverage
to parity with the resolver unit test
(`test/resolvers-gbrain-save-results.test.ts`, which covers wiring for
all 5).

**Why:** The resolver test proves the right instructions get emitted;
the E2E proves the agent actually obeys. Today we only have that
end-to-end signal for one of five planning skills.

**Context:** v1.50.0.0 plan §"NOT in scope". Extract `makeFakeGbrain`
into `test/helpers/fake-gbrain.ts` when the second consumer arrives
(YAGNI for one consumer today).

**Effort:** S (human ~1d, CC ~1h). Periodic-tier (~$2-4 total for 4
runs).

**Depends on:** None.

### P2: Real-session carve canary (E3, deferred from carve-guard plan)

**What:** Wire a real-session section-Read-miss canary on top of the
carved skills. When a real user session drives a carved skill and the
agent does NOT Read a section the skeleton's STOP directive pointed it
at, log it (salted, content-free) to
`~/.gstack/analytics/section-reads.jsonl` and surface drift via
`bun run eval:summary`. Non-blocking alert, never a merge gate
(real-session data is non-deterministic).

**Why:** The static (E2) + behavioral (T2) guards prove carves are
structurally sound and that a real agent Reads sections in a controlled
eval. They do NOT see production drift — a prompt-context change that
makes live agents start skipping a section. The canary is the only
mechanism that catches that, from real usage.

**Context:** Deferred from the carve-guard-hardening plan (D5→T2, codex
outside-voice #7). `test/helpers/transcript-section-logger.ts` exists but
is built for deterministic test transcripts + ship action fingerprints,
NOT real-session drift — it needs rework before it can back this. Ship
the deterministic guards first; add this once they've proven useful. The
carved-skill set + each skill's `requiredReads` are already declared in
`test/helpers/carve-guards.ts`, so the canary reads its expectations
from there.

**Effort:** M (human ~2d, CC ~4h).

**Depends on:** `transcript-section-logger.ts` real-session-drift rework.

### P2: Harden behavioral section-loading test hermeticity

**What:** `captureSectionReads` in `test/helpers/auq-sdk-capture.ts` accepts ANY
Read whose path matches `sections/<file>.md`. The skeleton's STOP-Read directive
points at the gstack-root install path (`scripts/resolvers/sections.ts` builds it
from `ctx.paths.skillRoot`), not the planted fixture copy. So a run can satisfy
the section-read assertion by reading the GLOBAL install's section instead of the
hermetic fixture.

**Why:** A behavioral test that passes by reading the global install doesn't prove
THIS branch's carved section loads. If the fixture's section were broken but the
global install's weren't, the test would still pass.

**Context:** Codex outside-voice finding on the carve-guard ship (v1.57.0.0).
Pre-existing in `auq-sdk-capture.ts` — affects `skill-e2e-ship-section-loading`,
`skill-e2e-plan-ceo-review-section-loading`, and the new
`carve-section-loading.test.ts`. Fix: match the fixture's ABSOLUTE sections path
(the `planDir` copy), not a bare `sections/<file>.md` regex; or rewrite the STOP
path to the fixture during the run.

**Effort:** S (human ~3h, CC ~30min). **Depends on:** None.

### P3: Content-hash diagram render cache for make-pdf

**What:** Cache rendered diagram SVG/PNG in `~/.gstack/cache/diagram-render/`,
keyed on `sha256(fence source + bundle version + render options)`, so repeat
`make-pdf` runs skip the browse render tab for unchanged diagrams.

**Why:** Every run currently re-renders every fence (~150-300ms each). Docs with
10+ diagrams pay seconds per iteration during write-preview loops. Codex
outside-voice flagged the missing cache story during the eng review of the
diagram engine plan (2026-06-11, D7).

**Context:** The diagram-render bundle ships a `BUILD_INFO.json` with a content
hash (see `lib/diagram-render/`) — use that as the bundle-version cache key
component so bundle bumps invalidate cleanly. Invalidation surface is the main
risk: stale renders after a mermaid theme change must not survive. Only worth
building once users hit multi-diagram docs; wedge perf is fine without it.

**Effort:** S (human ~1d, CC ~30min). **Depends on:** diagram engine wedge
shipping (lib/diagram-render bundle versioning).

### P3: Dedupe the make-pdf e2e gate-test harness

**What:** Five e2e files (`combined-gate`, `emoji-gate`, `diagram-gate`,
`landscape-gate`, `format-gate`) each hand-roll the same prerequisite probe
(binary/browse/poppler checks with CI hard-fail vs local skip), mkdtemp/rm
lifecycle, and child-timeout constants. Extract a shared
`make-pdf/test/e2e/helpers.ts` (prerequisites(), withWorkDir(), runGenerate()).

**Why:** Review-army maintainability finding on v1.58.0.0 — the boilerplate
diverges a little more with each new gate (diagram-gate now captures stderr
via Bun.spawnSync while the others use execFileSync), and a future fix to the
CI-hard-fail contract has to land five times.

**Context:** Deferred at ship time (D8.2) because it's test-only churn across
five green files at the tail of a release. Zero user-facing value; pure DRY.

**Effort:** S (human ~3h, CC ~20min). **Depends on:** None.

## Egress-receipt follow-ups (filed via /plan-eng-review + /codex on the v1.63 port wave)

### P2: egress ledger rotation with chain-genesis records

**What:** Rotate `~/.gstack/security/egress.jsonl` at a size threshold (match
`attempts.jsonl`'s 10MB/5-generation pattern in `browse/src/security.ts`), where
each new generation's FIRST record embeds the prior file's tail hash so
`gstack-egress verify` can walk across generations.

**Why:** v1.63 ships WARN-at-25MB (visible growth) but nothing bounds the file.
Rotation was deliberately deferred: it changes the verify contract, and a wrong
implementation makes healthy ledgers verify as "broken".

**Pros:** Bounded disk forever; verify stays meaningful across generations.
**Cons:** Chain-genesis semantics are subtle; needs its own focused tests
(cross-generation verify, mid-rotation crash).

**Context:** `lib/egress-receipt.ts` (`appendChained`/`verifyLedger`) carries the
design sketch in its rotation TODO comment. Start from the `attempts.jsonl`
rotation precedent.

**Effort:** S (human ~4h, CC ~25min). **Depends on:** v1.63 port wave landed.

### P3: launch-nonce token bootstrap (local-process impersonation)

**What:** Add a launch-time nonce to the `/extension-token` bootstrap: `browse`
mints a nonce at headed launch, seeds it into the extension (CDP
`chrome.storage` injection or a launcher-written sidecar), and the endpoint
requires it alongside the pinned origin.

**Why:** v1.63's pinned-origin check authenticates browser contexts; any local
PROCESS can still forge an Origin header with curl. That threat is explicitly
outside the current model (any local process can hit the port anyway) — this
TODO documents the deliberate boundary and the designed path across it.

**Pros:** Closes the local-process impersonation path (strongest of the three
options evaluated in the v1.63 plan review).
**Cons:** Largest bootstrap change; CDP seeding is fiddly across the three
launch paths (`--load-extension`, baked-in Browser.app, real-Chrome fallback);
low present-day value.

**Context:** `browse/src/server.ts` `/extension-token` handler +
`GSTACK_EXTENSION_ID`; launch paths in `browse/src/browser-manager.ts` (~358,
~455, ~1562); `extension/background.js` bootstrap.

**Effort:** M (human ~2 days, CC ~1h). **Depends on:** none.

### P3: eval-watch shard-awareness

**What:** Teach `scripts/eval-watch.ts` (hardcoded `_partial-e2e.json` path at
~line 17) about the sharded layout: watch `<evalDir>/shards/*/_partial-e2e.json`
and aggregate live progress across shard subdirs.

**Why:** v1.63's sharded runner gives each shard its own eval subdir (so shards
baseline against their own priors); `findPreviousRun`, `eval-compare`,
`eval-list`, and `eval-summary` were all made shard-aware, but the live watcher
intentionally stayed flat — it shows nothing during sharded runs.

**Pros:** Live progress during `eval:bg:gate` sharded runs again.
**Cons:** Multi-file watch + aggregation UI; low stakes (the run-scoped detach
log already streams per-shard results).

**Context:** `scripts/eval-watch.ts`; shard layout defined in
`scripts/test-paid-shards.ts` (slug = test filename); `listEvalJsonFiles` in
`test/helpers/eval-store.ts` already enumerates the layout — reuse it.

**Effort:** S (human ~2h, CC ~15min). **Depends on:** v1.63 port wave landed.

## v1.63 port-wave review follow-ups (deferred from /ship review army — non-blocking polish)

Genuine review findings deferred from the v1.63 ship because they are
informational/polish, not correctness-blocking, and several want their own
tests. Filed so they are tracked, not dropped.

- **P2 — telemetry-sync HTTP-status outcome is dead code.** `_GSTACK_EGRESS_LAST_RECEIPT`
  is set inside a command-substitution subshell in `bin/gstack-telemetry-sync`, so the
  parent-shell guard that would append the HTTP status to the receipt never fires. The
  generic `exit:N` outcome is still recorded, so the ledger is correct, just less
  precise. Fix: have `_receipted_curl` persist the receipt id to a caller-readable temp
  file, or restructure the call out of the subshell. (Confirmed by 3 review specialists.)
- **P2 — context-bill "TOTAL on disk" double-counts child skills** in a root-as-container
  tree (this repo's own layout): `buildBill` sums the root skill's whole-tree walk plus
  each child's subtree again (~2x the TOTAL line). ALWAYS-ON / EAGER / --diff / --budget
  are all unaffected — only the informational TOTAL is wrong. Fix: compute the tree total
  from a single deduplicated `walkMd(root)` pass, or exclude child dirs from the root
  skill's `totalMd`. Needs a fixture test. (`lib/context-bill.ts`.)
- **P3 — DRY/robustness polish:** one shared `_gstack_egress_host_of` helper for the
  ~11 hand-rolled URL-to-host extractions across the egress shell sinks; extract the
  duplicated tunnel-open `writeReceipt` block in `browse/src/server.ts` (two sites);
  hoist the per-iteration `SharedArrayBuffer` alloc out of the egress-receipt lock spin;
  replace context-bill's exact-mode `errorPct === 0` sentinel with an explicit flag;
  reuse `frontmatterName()` from `skill-census.ts` in `catalog-budget.test.ts`.
- **P3 — test-coverage gaps the audit named:** `PAID_TEST_GLOBS` ↔ `package.json`
  `test:gate` parity test; `GSTACK_EXTENSION_ID` ↔ `manifest.json` key derivation parity
  test (`browse/scripts/extension-id.ts`); a runner test asserting each shard child gets
  its own `GSTACK_EVAL_DIR` under `shards/<slug>`; receipt-refusal branch tests for
  supabase-provision / gbrain-sync / memory-ingest.

## P2: harden or re-tier skill-e2e-plan-design-with-ui PTY detection

**What:** The gate-tier `test/skill-e2e-plan-design-with-ui.test.ts` began executing
for the first time once v1.63's `seedSkills` registered skills in hermetic PTY
children (the fork had deleted this file; it measured nothing before). It now
reliably TIMES OUT even though the skill runs correctly: the transcript shows
`/plan-design-review` reaching its scope-gate AskUserQuestion (5 options, the
`<gstack-qid:plan-design-review-scope-gate>` marker present), but the test's
`isNumberedOptionListVisible`/`parseNumberedOptions` scraping can't classify it out
of the PTY buffer because spinner frames (`[?25l✻Sprouting… still thinking`) are
interleaved character-by-character with the option text.

**Why:** Shipped behavior is correct — this is a test-harness detection limitation,
not a product bug. But a gate test that always times out is worse than no test.

**Fix options:** (a) harden the tail-scraping (drop DEC private-mode + spinner
residue before matching; widen/clean the window); (b) add an LLM-judge fallback
classifier (the file's own comments note the regex detectors are "brittle to PTY
rendering quirks"); or (c) move this test to periodic until (a)/(b) lands.

**Context:** `test/skill-e2e-plan-design-with-ui.test.ts`,
`test/helpers/claude-pty-runner.ts:308` (`isNumberedOptionListVisible`). Evidence:
`~/.gstack-dev/eval-runs/pdwu-verify-*.log`. **Effort:** M (human ~half day / CC ~30min).

### P3: Residuals from the 2026-08-14 tracker-audit waves (mostly shipped in v1.67.0.0)

The four deferred waves (A: browse-daemon lifecycle, B: install integrity,
C: gbrain trust boundary, D: ship/version allocator) LANDED in the v1.67.0.0
fix wave: XProtect self-heal + Playwright bump + busy-daemon iron rule +
signal policy (A); alias shadowing + cursor slice + runtime assets + Windows
refresh (B); brain-sync disposition model + source pins + thin-client
detection (C); version allocator end-state + subdir manifests + diff-scope
globs (D). What remains, re-filed individually:

- Watchdog kills headed handoff sessions (PRs 2565/2405/2346) and the three
  darwin-skipped handoff tests in browse/test/handoff.test.ts — verify
  whether the v1.67 XProtect + rebrand work un-blocks them, then un-skip or
  fix. Effort S.
- Transcript trust/scope/source isolation (PR 2232, issue 2140) — needs the
  never-double-store review. Effort M.
- Versionless-repo onboarding (#1474, issues 2343/2334) — the #2501 JSON
  version-path half landed; the no-version-file-at-all flow did not.
- Playwright bootstrap abort/timeout absorbs (PRs 2233/2359, issues
  1902/2136) — partially superseded by v1.67's bounded bootstrap; verify
  and close or extract the remainder.
