# Testing internals: env keys, hermetic E2E

Moved verbatim from CLAUDE.md (token-load reduction). Read this before
writing or debugging E2E tests, passing `env:` to a runner, or touching
`test/helpers/hermetic-env.ts`.

**Env keys in Conductor workspaces.** The `GSTACK_*` env-shim (v1.39.2.0+,
`lib/conductor-env-shim.ts`) promotes `GSTACK_ANTHROPIC_API_KEY` /
`GSTACK_OPENAI_API_KEY` to their canonical names inside gstack's TS binaries.
Tests run through gstack entrypoints inherit this promotion automatically.
Don't echo the key value to stdout, logs, or shell history. The historical
"never pass `env:` to `runAgentSdkTest`" rule is retired: the failure was
partial-env replacement (the SDK's `Options.env` REPLACES the child's entire
environment, so an object without the key broke auth). The runner now always
passes a COMPLETE hermetic env with per-test `env:` merged last, so per-test
overrides are safe; ambient `process.env.ANTHROPIC_API_KEY` mutation also
still works (the env builder reads process.env at call time).

**Hermetic local E2E (default).** Every E2E runner (claude -p, PTY, Agent
SDK, codex, gemini) spawns children through `test/helpers/hermetic-env.ts`:
allowlist-scrubbed env (operator `CONDUCTOR_*`, `CLAUDE_*`, `GSTACK_*`,
`MCP_*`, `GBRAIN_*`, and credentials like `GH_TOKEN` never reach children),
a fresh seeded `CLAUDE_CONFIG_DIR` (no operator `~/.claude` CLAUDE.md /
MCP servers / skills), a temp `GSTACK_HOME`, and `--strict-mcp-config`.
Local eval signal matches CI. Debug against real operator state with
`EVALS_HERMETIC=0` (restores the legacy env AND drops the strict-MCP flag).
Per-test `env:` overrides merge last, so deliberate contamination
(`CONDUCTOR_WORKSPACE_PATH`, per-test `GSTACK_HOME`) keeps working. The
hermetic config dir seeds NO skills by default; a PTY test that types a
`/skill` slash command must pass `seedSkills: true` to the PTY runner, which
points the child's `CLAUDE_CONFIG_DIR` at `hermeticSkillsConfigDir()` — a
seeded registry that symlinks the LIVE working tree's SKILL.md files (by
design: the skills ARE the subject under test; a snapshot would measure stale
copies). Wiring is pinned by `test/hermetic-wiring.test.ts` (static tripwire),
two gate-tier canaries in `test/skill-e2e-hermetic-canary.test.ts`, and the
seeding tripwires in `test/hermetic-skills-seeding.test.ts` /
`test/pty-skill-seeding-wiring.test.ts`.

E2E tests stream progress in real-time (tool-by-tool via `--output-format stream-json
--verbose`). Results are persisted to `~/.gstack/projects/<slug>/evals/` (legacy
fallback `~/.gstack-dev/evals/`) with auto-comparison
against the previous finalized run (in-flight `_partial` files are never used as
a baseline, so a run can't compare against itself).

## Runners: how the suites execute (2026-08 overhaul)

**Aside-only E2E tests self-skip without a live Aside; browser-driving tests
run on either engine.** Every skill that opens a web page drives the Aside AI
browser first (`scripts/resolvers/aside.ts`) and falls back to gstack's own
browse engine when Aside is absent (and Chromium bootstrapped). The cases that
need Aside itself (`test/skill-e2e-aside.test.ts`, `design-review-fix` in
`test/skill-e2e-design.test.ts`) call `asideAvailable()` from
`test/helpers/aside-available.ts` (the same probe the skills run in BROWSER
SETUP) and skip when the `aside` CLI or the Aside app is absent. CI runners have
no Aside, so those run only on macOS dev machines and sit in the periodic tier;
set `GSTACK_SKIP_ASIDE=1` to force the skip locally (which also exercises the
fallback hand-off). The qa E2E files (`test/skill-e2e-qa-workflow.test.ts`,
`test/skill-e2e-qa-bugs.test.ts`) gate on `asideAvailable() ||
fs.existsSync(browseBin)`: the skill's own BROWSER SETUP picks the engine, so
on a Mac they drive Aside and on Linux CI they drive the built browse binary,
skipping only when neither exists. The `$B`-driven E2E cases and `browse/test/`
run on every platform as before, so Linux CI proves the fallback engine live.

**The renderer picks the same way, so the render gates are engine-agnostic.**
`/make-pdf`, `/diagram`, and design previews print and screenshot their local
HTML through `lib/aside-render.ts` / `bin/gstack-render.ts`, which render in
Aside when `probeAside()` says `READY` and through the browse engine otherwise.
make-pdf's `*-gate.test.ts` and `test/skill-e2e-diagram.test.ts` (periodic,
paid) gate on `browserAvailable()` (`make-pdf/test/e2e/browser-available.ts`:
`asideAvailable() || resolveBrowseBin() !== null`) — on a Mac they print
through Aside, on Linux CI through the browse binary `bun run build:gates`
compiles, and they skip only when neither exists. Only
`test/aside-render.test.ts`'s two live Aside cases (a full round-trip and a
late-readiness `--wait-expr` poll) are Aside-only: its option
mapping and generated-script pins run everywhere, and its fake-executable cases
drive both engines hermetically (fake `aside` / `browse` scripts on PATH pin
probe classification, the stdout contract, loopback-server policy, the timeout
kill, engine choice and the mid-run fallback). `test/gstack-render-cli.test.ts`
does the same for `bin/gstack-render.ts` with `GSTACK_SKIP_ASIDE=1` and
`GSTACK_BROWSE_BIN` pointed at a fake daemon that logs every argv line. A green
gate on Linux proves the fallback engine, not Aside; the Mac run is the Aside
evidence.
The browse-binary leg presumes Chromium bootstrapped: `resolveBrowseBin()`
only checks that the binary (or the `find-browse` shim) exists, never that
Chromium can launch, so on an install where the best-effort Chromium step
was skipped (`GSTACK_SKIP_PLAYWRIGHT=1`) or failed, these gates run and fail
at browser launch instead of skipping. Fix the bootstrap (or move the binary
aside) before running them locally; CI always installs Chromium first.
`test/dom-dump-hygiene.test.ts` is the one free-suite case on the same leg: it
runs `lib/dom-dump.js` (the rendered-DOM dump `/design-review` hands the design
detector) inside a real Chromium page through the built browse binary, so it
self-skips when the binary is absent and, because a cold Chromium launch is
load-sensitive on a busy dev box, runs only in CI or on explicit opt-in
(`GSTACK_DOM_DUMP_HYGIENE=1`).

**Free suite (`bun run test:free`).** `scripts/test-free-shards.ts` runs N
concurrent shard processes (serial within each) with strict-output
classification per shard. Full-suite shards are packed by RECORDED PER-FILE
DURATIONS (LPT, `packShardsByDuration`) when the committed seed
`scripts/free-test-durations.json` exists — refresh it occasionally with
`bun run test:free --record-durations` (each file timed in its own child;
CI never records). Missing seed → silent hash-shard fallback; corrupt seed →
one warning + fallback; unknown files get 75th-percentile pessimism. Packed
shards get duration-aware walls (`max(base, predicted × 3)`); the `--shard`
CI-matrix path keeps stable hash indices untouched. `TREE_MUTATING` is EMPTY:
`gen-skill-docs.ts` has a `main()` guard (imports never regenerate; pinned by
`test/gen-skill-docs-import-purity.test.ts`) and `--out-dir` renders every
host, so all former mutators render into mkdtemps and the trailing serial
shard is gone. The map remains a mechanism — a test that genuinely must write
shared artifacts in place earns a reasoned entry and is serialized again.

**Paid suite (sharded runner, local AND CI).** `scripts/test-paid-shards.ts`
is the single selection engine: 1 file per shard, `EVALS_JOBS` shard
processes × `EVALS_CONCURRENCY` within-shard, per-shard `GSTACK_EVAL_DIR`,
full-stream spooling to per-shard log files (path printed at START and on
failure), never-started/timed-out taxonomy, and parent-computed diff
selection propagated to children via `EVALS_SELECTION_JSON` (fail-open: a
child that can't parse it recomputes locally with one warning). Retry parity
lives in `RETRY_OVERRIDES` (literals; old matrix rows' earned `retries: 2`).
Flake telemetry rides the store: every recorded test carries its 1-based
`attempt` (a pass-on-attempt-2 stays visible forever — bun's own stream hides
it), runs list `flaky_retries`, the report warns on passed-only-on-retry
tests, and `bun run eval:flake-rank` ranks the series (retried passes first,
then failure rate; 60-day recency bound on eval files; the free lane's flake
ledger is folded in from `flakeLedgerPath()` — override with
`GSTACK_FLAKE_LEDGER`, the same env var the CI free lane sets before
uploading the ledger as the `flake-ledger` artifact). Census integrity is
enforced from the free suite: every `E2E_TOUCHFILES` / `LLM_JUDGE_TOUCHFILES`
key must name a living paid test (`test/touchfiles.test.ts`'s reverse
invariant), and `git show <sha>:path` fixtures are banned — vendor the bytes
instead (`test/git-ref-fixture-tripwire.test.ts`).

**CI planner/executor/report.** `--emit-plan <path> --slices K` computes
selection + the slice plan ONCE (killing per-slice selector divergence);
`--plan <path> --slice i` executors consume the manifest and write
slice-result artifacts; `--report <dir>` reconciles them FAIL-CLOSED (a slice
whose artifact never landed, or a planned shard nobody reported, is a
failure). Under `EVALS_ALL` the hollow-shard guard marks exit-0 shards with
ZERO executed tests `passed-empty` (a failure) — census-health, not just
test runs. evals.yml runs the sliced gate lane per PR — the ONLY paid lane
since the legacy 17-row matrix (22.6 min/$21 per PR serialized ahead of the
slices) was deleted after demonstrated parity; its
`KNOWN_MATRIX_GAPS`/`KNOWN_TIER_UNSET` ratchets retired with it and
`test/evals-workflow-wiring.test.ts` pins the surviving wiring (slice-count
agreement, tier consistency, the shared register-skills composite with its
fail-fast verification loop). evals-periodic.yml runs ALL
periodic-tier files weekly (the coverage contract) minus the reasoned
exclusions in `test/helpers/periodic-exclude-data.ts` (reason + tracking
required per entry; removal re-activates the file), plus a weekly
`EVALS_ALL` gate census, plus a tracking-issue UPSERT on red weeks. The CI
image pins the claude CLI to an exact version (`.github/docker/Dockerfile.ci`,
enforced by `test/ci-image-cli-pin.test.ts` — bumps ride PRs that run the PTY
gate), and every eval-store run records `claude --version`, resolved once in
the runner parent and handed to shard children as `GSTACK_CLAUDE_CLI_VERSION`
(never spawned on a test thread), so a TUI-drift flake hunt is a grep, not
archaeology.

**Timeout policy.** Paid tests use the tiers in
`test/helpers/eval-budgets.ts` (JUDGE/CAPTURE/CAPTURE_LONG/PTY/PTY_LONG);
`test/eval-budgets-policy.test.ts` pins that every tier fits the shard wall
minus overhead and ratchets raw literals. Budget above the wall is fiction.
Session timeouts are two-phase: a silent API dies at the startup grace (90s
local / 300s CI floor, distinct exit reason `timeout_startup`) and the work
budget arms on the first byte — the total wall never grows
(`test/session-runner-startup-grace.test.ts` pins the floor). A timed-out
session kills its whole detached process group (claude, codex, and gemini
runners alike — `test/session-runner-groupkill.test.ts`), so a stray
grandchild can't stretch a 600s budget past 1400s. And sync spawns can't
wedge a shard: every `spawnSync`/`execSync`/`execFileSync`/`Bun.spawnSync`
in the test trees must carry a `timeout`, enforced by
`test/spawnsync-timeout-tripwire.test.ts` with a shrink-only exemption
ratchet.

**Anchor-sliced `setup` harnesses.** `setup` is one large bash script, so the
free tests that pin its linker, cleanup, retired-skill prune, browser hint,
rebuild decision, and Chromium-bootstrap behavior never run the whole thing.
They slice the source by anchor (`extractFn(name)` takes
`name() {` through the next `\n}\n`; `test/setup-playwright-best-effort.test.ts`
slices the `# 2. Ensure Playwright's Chromium is available` block up to
`# 2b.`), join the extracted functions with stubbed collaborators, and execute
the REAL bash under a temp `HOME` with stubbed probes and installers. Two rules
keep the harness honest: renaming a function or anchor comment in `setup` fails
the test with `function not found` / `anchor not found` instead of silently
testing nothing, and `test/setup-link-ownership.test.ts` and
`test/setup-playwright-best-effort.test.ts` throw on any `command not found` on
stderr as harness drift (a helper the test forgot to extract) rather than
letting it degrade into a pass. Files: `test/setup-link-ownership.test.ts`,
`test/setup-cleanup-orphans.test.ts`, `test/setup-playwright-best-effort.test.ts`,
`test/setup-prune-stale-generated.test.ts` (`_prune_stale_generated` against a
temp render tree plus host dirs: host cleanup after the generator already
pruned, symlink targets survive, frontmatter-renamed skills, foreign links),
`test/setup-browser-hint.test.ts` (`_browser_hint` and the bootstrap summary
across Aside present/absent, bootstrap ok/failed/skipped, `GSTACK_SKIP_ASIDE`),
and `test/setup-needs-build.test.ts` (the `NEEDS_BUILD` block sliced between
two anchors: every binary and source set flips it, Windows `.exe` suffixes).
`test/relink.test.ts` shells out to a copy of the real `bin/gstack-relink`
against a temp `GSTACK_INSTALL_DIR` / `GSTACK_SKILLS_DIR`, and
`test/hook-scripts.test.ts` runs the real `careful/bin/check-careful.sh` and
`freeze/bin/check-freeze.sh` with JSON payloads on stdin (including the
`GSTACK_HOME` state-root parity against `bin/gstack-paths`).

## Cloud sandboxes (Vercel / Conductor cloud workspaces)

Syscall-supervised sandboxes need environment setup before `bun run test` can
run green: run `scripts/sandbox-doctor.sh` once per boot. It documents and
treats the full failure taxonomy (missing /dev/fd, 64M /dev/shm, spurious
access(2) EACCES from the seccomp supervisor under load, full-capability
processes defeating chmod-denial tests, no X server, no git identity, and
Conductor's git-shim exit-code laundering). The doctor seeds `TMPDIR`,
`DISPLAY`, and the runner knobs into `~/.bashrc`, so open a new shell (or
`source ~/.bashrc`) before running the suite. Then:

```bash
setpriv --ambient-caps=-all --bounding-set=-all bun run test
```

Two runner knobs exist for these environments (both no-ops unless set):
`GSTACK_FREE_JOBS` overrides the shard count in either direction (2 is the measured sweet spot — one
serial mega-shard and 6-way sharding both saturate the per-process syscall
supervisor), and `GSTACK_FREE_RETRY_FLAKY=1` re-runs attributed failures once
serially, downgrading a clean retry to a loud FLAKY-PASS (capped at 5 files so
a broken tree can't masquerade as flaky). The required CI free lane sets the
retry knob too, appending every flaky pass to the JSONL ledger it uploads
(`GSTACK_FLAKE_LEDGER`) — a flaky pass never reds the lane, but it never
disappears either.
