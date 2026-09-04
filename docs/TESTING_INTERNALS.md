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
free tests that pin its linker, cleanup, and Chromium-bootstrap behavior never
run the whole thing. They slice the source by anchor (`extractFn(name)` takes
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
`test/setup-cleanup-orphans.test.ts`, `test/setup-playwright-best-effort.test.ts`.
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
