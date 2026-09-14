# GCOMPACTION.md — Design & Architecture (TABLED)

**Target path on approval:** `docs/designs/GCOMPACTION.md`

This is the preserved design artifact for `gstack compact`. Everything above the first `---` divider below gets extracted verbatim to `docs/designs/GCOMPACTION.md` on plan approval. Everything after that divider is archived research (office hours + competitive deep-dive + eng-review notes + codex review + research findings) that informed the design.

---

## Status: TABLED (2026-04-17) — pending Anthropic `updatedBuiltinToolOutput` API

**Why tabled.** The v1 architecture assumed a Claude Code `PostToolUse` hook could REPLACE the tool output that enters the model's context for built-in tools (Bash, Read, Grep, Glob, WebFetch). Research on 2026-04-17 confirmed this is not possible today.

**Evidence:**

1. **Official docs** (https://code.claude.com/docs/en/hooks): The only output-replace field documented for `PostToolUse` is `hookSpecificOutput.updatedMCPToolOutput`, and the docs explicitly state: *"For MCP tools only: replaces the tool's output with the provided value."* No equivalent field exists for built-in tools.
2. **Anthropic issue [#36843](https://github.com/anthropics/claude-code/issues/36843)** (OPEN): Anthropic themselves acknowledge the gap. *"PostToolUse hooks can replace MCP tool output via `updatedMCPToolOutput`, but there is no equivalent for built-in tools (WebFetch, WebSearch, Bash, Read, etc.)... They can only add warnings via `decision: block` (which injects a reason string) or `additionalContext`. The original malicious content still reaches the model."*
3. **RTK mechanism** (source-reviewed at `src/hooks/init.rs:906-912` and `hooks/claude/rtk-rewrite.sh:83-100`): RTK is NOT a PostToolUse compactor. It's a **PreToolUse** Bash matcher that rewrites `tool_input.command` (e.g., `git status` → `rtk git status`). The wrapped command produces compact stdout itself. RTK README confirms: *"the hook only runs on Bash tool calls. Claude Code built-in tools like Read, Grep, and Glob do not pass through the Bash hook, so they are not auto-rewritten."* RTK is Bash-only by architectural constraint, not by choice.
4. **tokenjuice mechanism** (source-reviewed at `src/core/claude-code.ts:160, 491, 540-549`): tokenjuice DOES register `PostToolUse` with `matcher: "Bash"` but has no real output-replace API available — it hijacks `decision: "block"` + `reason` to inject compacted text. Whether this actually reduces model-context tokens or just overlays UI output is disputed. tokenjuice is also Bash-only.
5. **Read/Grep/Glob execute in-process inside Claude Code** and bypass hooks entirely. Wedge (ii) "native-tool coverage" was architecturally impossible from day one regardless of replacement API.

**Consequence.** Both wedges are dead in their original form:
- Wedge (i) "Conditional LLM verifier" — still technically possible, but only for Bash output, via PreToolUse command wrapping (RTK's mechanism). The verifier stops being a differentiator once we're also Bash-only.
- Wedge (ii) "Native-tool coverage" — impossible today. Read/Grep/Glob don't fire hooks. Even if they did, no output-replace field exists.

**Decision.** Shelve `gstack compact` entirely. Track Anthropic issue #36843 for the arrival of `updatedBuiltinToolOutput` (or equivalent). When that API ships, this design doc + the 15 locked decisions below + the research archive at the bottom become the unblocking artifacts for a fresh implementation sprint.

**If un-tabling:** Start from the "Decisions locked during plan-eng-review" block below — most remain valid. Then re-verify the hooks reference against the newly-shipped API, update the Architecture data-flow diagram to use whatever real output-replacement field exists, and re-run `/codex review` against the revised plan before coding.

**What we're NOT doing:**
- Not shipping a Bash-only PreToolUse wrapper. That's RTK's product; they're at 28K stars and 3 years of rule scars. No wedge.
- Not shipping the `decision: block` + `reason` hack. Undocumented behavior, Anthropic could break it, and the model may still see the raw output alongside the compacted overlay — context savings are disputed.
- Not shipping B-series benchmark in isolation. Without a working compactor, there's nothing to benchmark.

**Cost of tabling:** ~0. No code was written. The design doc + research + decisions remain as a ready-to-unblock artifact.

---

## Decisions locked during plan-eng-review (2026-04-17)

Preserved for the un-tabling sprint if/when Anthropic ships the built-in-tool output-replace API.

Summary of every decision made during the engineering review. Full rationale is preserved throughout the sections below; this block is the single source of truth if anything else drifts.

**Scope (Section 0):**
1. **Claude-first v1.** Ship compact + rules + verifier on Claude Code only. Codex + OpenClaw land at v1.1 after the wedge is proven on the primary host. Cuts ~2 days of host integration and derisks launch. The original "wedge (ii) native-tool coverage" claim applies to Claude Code at v1; we make no cross-host claim until v1.1.
2. **13-rule launch library.** v1 ships tests (jest/vitest/pytest/cargo-test/go-test/rspec) + git (diff/log/status) + install (npm/pnpm/pip/cargo). Build/lint/log families defer to v1.1, driven by `gstack compact discover` telemetry from real users.
3. **Verifier default ON at v1.0.** `failureCompaction` trigger (exit≠0 AND >50% reduction) is enabled out of the box. The verifier IS the wedge — defaulting it off hides the differentiating feature. Trigger bounds already keep expected fire rate ≤10% of tool calls.

**Architecture (Section 1):**
4. **Exact line-match sanitization for Haiku output.** Split raw output by `\n`, put lines in a set, only append lines from Haiku that appear verbatim in that set. Tightest adversarial contract; prompt-injection attempts cannot slip in novel text.
5. **Layered failureCompaction signal.** Prefer `exitCode` from the envelope; if the host omits it, fall back to `/FAIL|Error|Traceback|panic/` regex on the output. Log which signal fired in `meta.failureSignal` ("exit" | "pattern" | "none"). Pre-implementation task #1 still verifies Claude Code's envelope empirically, but the system no longer breaks if it doesn't.
6. **Deep-merge rule resolution.** User/project rules inherit built-in fields they don't override. Escape hatch: `"extends": null` in a rule file triggers full replacement semantics. Matches the mental model of eslint/tsconfig/.gitignore — override a piece without losing the rest.

**Code quality (Section 2):**
7. **Per-rule regex timeout, no RE2 dep.** Run each rule's regex via a 50ms AbortSignal budget; on timeout, skip the rule and record `meta.regexTimedOut: [ruleId]`. Avoids a WASM dependency and keeps rule-author syntax unconstrained.
8. **Pre-compiled rule bundle.** `gstack compact install` and `gstack compact reload` produce `~/.gstack/compact/rules.bundle.json` (deep-merged, regex-compiled metadata cached). Hook reads that single file instead of parsing N source files.
9. **Auto-reload on mtime drift.** Hook stats rule source files on startup; if any source file is newer than the bundle, rebuild in-line before applying. Adds ~0.5ms/invocation but eliminates the "I edited a rule and nothing changed" footgun.
10. **Expanded v1 redaction set.** Tee files redact: AWS keys, GitHub tokens (`ghp_/gho_/ghs_/ghu_`), GitLab tokens (`glpat-`), Slack webhooks, generic JWT (three base64 segments), generic bearer tokens, SSH private-key headers (`-----BEGIN * PRIVATE KEY-----`). Credit cards / SSNs / per-key env-pairs deferred to a full DLP layer in v2.

**Testing (Section 3):**
11. **P-series gate subset.** v1 gate-tier P-tests: P1 (binary garbage), P3 (empty output), P6 (RTK-killer critical stack frame), P8 (secrets to tee), P15 (hook timeout), P18 (prompt injection), P26 (malformed user rule JSON), P28 (regex DoS), P30 (Haiku hallucination). Remaining 21 P-cases grow R-series as real bugs hit.
12. **Fixture version-stamping.** Every golden fixture has a `toolVersion:` frontmatter. CI warns when fixture toolVersion ≠ currently installed. No more calendar-based rotation.
13. **B-series real-world benchmark testbench (hard v1 gate).** New component `compact/benchmark/` scans `~/.claude/projects/**/*.jsonl`, ranks the noisiest tool calls, clusters them into named scenarios, replays the compactor against them, and reports reduction-by-rule-family. v1 cannot ship until B-series on the author's own 30-day corpus shows ≥15% reduction AND zero critical-line loss on planted bugs. Local-only; never uploads. Community-shared corpus is v2.

**Performance (Section 4):**
14. **Revised latency budgets.** Bun cold-start on macOS ARM is 15-25ms; the original 10ms p50 target was unrealistic. New budgets: <30ms p50 / <80ms p99 on macOS ARM, <20ms p50 / <60ms p99 on Linux (verifier off). Verifier-fires budget stays <600ms p50 / <2s p99. Daemon mode is a v2 option gated on B-series showing cold-start hurts session savings.
15. **Line-oriented streaming pipeline.** Readline over stdin → filter → group → dedupe → ring-buffered tail truncation → stdout. Any single line >1MB hits P9 (truncate to 1KB with `[... truncated ...]` marker). Caps memory at 64MB regardless of total output size.

Every row above is a `MUST` in the implementation. Drift requires a new eng-review.

---

## Summary

`gstack compact` was designed as a `PostToolUse` hook that reduces tool-output noise before it reaches an AI coding agent's context window. Deterministic JSON rules would shrink noisy test runners, build logs, git diffs, and package installs. A conditional Claude Haiku verifier would act as a safety net when over-compaction risk was high.

**Current status: TABLED.** See "Status" section above. The architecture depends on a Claude Code API (`updatedBuiltinToolOutput` or equivalent for built-in tools) that does not exist as of 2026-04-17. Anthropic issue #36843 tracks the gap.

**Intended goal (preserved for the un-tabling sprint):** 15–30% tool-output token reduction per long session, with zero increase in task-failure rate.

**Original wedge (vs RTK, the 28K-star incumbent) — both invalidated by research:**
1. ~~**Conditional LLM verifier.**~~ Still technically viable via PreToolUse command wrapping, but only for Bash. Stops being a differentiator once we're Bash-only. Reconsider if the built-in-tool API arrives.
2. ~~**Native-tool coverage.**~~ Architecturally impossible today. Read/Grep/Glob execute in-process inside Claude Code and do not fire hooks. Even for tools that do fire `PostToolUse`, no output-replacement field exists for non-MCP tools.

**Original positioning (now moot):** *"RTK is fast. gstack compact is fast AND safe, and it covers every tool in your toolbox, not just Bash."*

## Non-goals

- Summarizing user messages or prior agent turns (Claude's own Compaction API owns that).
- Compressing agent response output (caveman's layer).
- Caching tool calls to avoid re-execution (token-optimizer-mcp's layer).
- Acting as a general-purpose log analyzer.
- Replacing the agent's own judgement about when to re-run a command with `GSTACK_RAW=1`.

## Why this is worth building

**Problem is measured, not hypothetical.**

- [Chroma research (2025)](https://research.trychroma.com/context-rot) tested 18 frontier models. Every model degrades as context grows. Rot starts well before the window limit — a 200K model rots at 50K.
- Coding agents are the worst case: accumulative context + high distractor density + long task horizon. Tool output is explicitly named as a primary noise source.
- The market has voted: Anthropic shipped Opus 4.6 Compaction API; OpenAI shipped a compaction guide; Google ADK shipped context compression; LangChain shipped autonomous compression; sst/opencode has built-in compaction. The hybrid deterministic + LLM pattern is industry consensus.

**Existing field (what gstack compact joins and differentiates from):**

| Project | Stars | License | Layer | Threat | Note |
|---------|-------|---------|-------|--------|------|
| **RTK (rtk-ai/rtk)** | **28K** | Apache-2.0 | Tool output | Primary benchmark | Pure Rust, Bash-only, zero LLM |
| caveman | 34.8K | MIT | Output tokens | Different axis | Terse system prompt; pairs WITH us |
| claude-token-efficient | 4.3K | MIT | Response verbosity | Different axis | Single CLAUDE.md |
| token-optimizer-mcp | 49 | MIT | MCP caching | Different axis | Prevents calls rather than compresses output |
| tokenjuice | ~12 | MIT | Tool output | Too new | 2 days old; inspired our JSON envelope |
| 6-Layer Token Savings Stack | — | Public gist | Recipe | Zero | Documentation; validates stacked compaction thesis |

RTK is the only direct competitor. Everything else compresses a different token source.

**License compatibility:** Every referenced project is permissive-licensed (MIT or Apache-2.0) and compatible with gstack's MIT license. No AGPL, GPL, or other copyleft dependencies. See the "License & attribution" section below for the clean-room policy.

## Architecture

### Data flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Host (Claude Code / Codex / OpenClaw)                          │
│  ─────────────────────────────────────────                      │
│  1. Agent requests tool call: Bash|Read|Grep|Glob|MCP           │
│  2. Host executes tool                                          │
│  3. Host invokes PostToolUse hook with: {tool, input, output}   │
└────────────────────┬────────────────────────────────────────────┘
                     │ stdin (JSON envelope)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  gstack-compact hook binary                                     │
│  ───────────────────────────                                    │
│  a. Parse envelope                                              │
│  b. Match rule by (tool, command, pattern)                      │
│  c. Apply rule primitives: filter / group / truncate / dedupe   │
│  d. Record reduction metadata                                   │
│  e. Evaluate verifier triggers                                  │
│  f. If trigger met: call Haiku, append preserved lines          │
│  g. On failure exit code: tee raw to ~/.gstack/compact/tee/...  │
│  h. Emit JSON envelope to stdout                                │
└────────────────────┬────────────────────────────────────────────┘
                     │ stdout (JSON envelope)
                     ▼
              Host substitutes compacted output into agent context
```

### Rule resolution

Three-tier hierarchy (highest precedence wins), same pattern as tokenjuice and gstack's existing host-config-export model:

1. Built-in rules: `compact/rules/` shipped with gstack
2. User rules: `~/.config/gstack/compact-rules/`
3. Project rules: `.gstack/compact-rules/`

Rules match tool calls by rule ID. A project rule with ID `tests/jest` overrides the built-in `tests/jest` entirely. No merging — replace semantics, to keep reasoning simple.

### JSON envelope contract (adopted from tokenjuice)

Input:
```json
{
  "tool": "Bash",
  "command": "bun test test/billing.test.ts",
  "argv": ["bun", "test", "test/billing.test.ts"],
  "combinedText": "...",
  "exitCode": 1,
  "cwd": "/Users/garry/proj",
  "host": "claude-code"
}
```

Output:
```json
{
  "reduced": "compacted output with [gstack-compact: N → M lines, rule: X] header",
  "meta": {
    "rule": "tests/jest",
    "linesBefore": 247,
    "linesAfter": 18,
    "bytesBefore": 18234,
    "bytesAfter": 892,
    "verifierFired": false,
    "teeFile": null,
    "durationMs": 8
  }
}
```

### Rule schema

Compact, minimal. Total rules-payload must stay <5KB on disk (lesson from claude-token-efficient: rule files themselves consume tokens on every session).

```json
{
  "id": "tests/jest",
  "family": "test-results",
  "description": "Jest/Vitest output — preserve failures and summary counts",
  "match": {
    "tools": ["Bash"],
    "commands": ["jest", "vitest", "bun test"],
    "patterns": ["jest", "vitest", "PASS", "FAIL"]
  },
  "primitives": {
    "filter": {
      "strip": ["\\x1b\\[[0-9;]*m", "^\\s*at .+node_modules"],
      "keep": ["FAIL", "PASS", "Error:", "Expected:", "Received:", "✓", "✗", "Tests:"]
    },
    "group": {
      "by": "error-kind",
      "header": "Errors grouped by type:"
    },
    "truncate": {
      "headLines": 5,
      "tailLines": 15,
      "onFailure": { "headLines": 20, "tailLines": 30 }
    },
    "dedupe": {
      "pattern": "^\\s*$",
      "format": "[... {count} blank lines ...]"
    }
  },
  "tee": {
    "onExit": "nonzero",
    "maxBytes": 1048576
  },
  "counters": [
    { "name": "failed", "pattern": "^FAIL\\s", "flags": "m" },
    { "name": "passed", "pattern": "^PASS\\s", "flags": "m" }
  ]
}
```

The four primitives — `filter`, `group`, `truncate`, `dedupe` — are lifted directly from RTK's technique taxonomy (the only thing every serious compactor needs to handle). Any rule can combine any subset of the four; omitted primitives are no-ops.

### Verifier layer (tiered, opt-in)

The verifier is a cheap Haiku call that fires only under specific triggers. Never on every tool call.

**Trigger matrix (user-configurable):**

| Trigger | Default | Condition |
|---------|---------|-----------|
| `failureCompaction` | **ON** | exit code ≠ 0 AND reduction >50% (diagnosis at risk) |
| `aggressiveReduction` | off | reduction >80% AND original >200 lines |
| `largeNoMatch` | off | no rule matched AND output >500 lines |
| `userOptIn` | on (env-gated) | `GSTACK_COMPACT_VERIFY=1` forces verifier for that call |

Default config ships with `failureCompaction` only — the highest-leverage case (agent is debugging; rule may have filtered the critical stack frame).

**Haiku's job (bounded):**

```
Here is raw output (truncated to first 2000 lines) and a compacted version.
Return any important lines from the raw that are missing from the compacted,
or `NONE` if nothing critical is missing.
```

The verifier never rewrites the compacted output. It only appends missing lines under a header:

```
[gstack-compact: 247 → 18 lines, rule: tests/jest]
[gstack-verify: 2 additional lines preserved by Haiku]
  TypeError: Cannot read property 'foo' of undefined
    at parseConfig (src/config.ts:42:18)
```

**Why Haiku, not Sonnet:** ~1/12th the cost, ~500ms vs ~2s, and the task is simple substring classification, not reasoning.

**Verifier config (`compact/rules/_verifier.json`):**

```json
{
  "verifier": {
    "enabled": true,
    "model": "claude-haiku-4-5-20251001",
    "maxInputLines": 2000,
    "triggers": {
      "aggressiveReduction": { "enabled": false, "thresholdPct": 80, "minLines": 200 },
      "failureCompaction":   { "enabled": true,  "minReductionPct": 50 },
      "largeNoMatch":        { "enabled": false, "minLines": 500 },
      "userOptIn":           { "enabled": true, "envVar": "GSTACK_COMPACT_VERIFY" }
    },
    "fallback": "passthrough"
  }
}
```

**Failure modes (verifier is strictly additive — never breaks the baseline):**

- No `ANTHROPIC_API_KEY` → skip verifier, use pure rule output.
- Haiku call times out (>5s) → skip verifier, use pure rule output.
- Haiku returns malformed JSON → skip, use pure rule output.
- Haiku returns prompt-injection attempt → sanitize: only append lines that are substring-matches of the original raw output.
- Haiku returns hallucinated lines (not present in raw) → drop them.

### Tee mode (adopted from RTK)

On any command with exit code ≠ 0, the full unfiltered output is written to `~/.gstack/compact/tee/{timestamp}_{cmd-slug}.log`. The compacted output includes a tee-file pointer:

```
[gstack-compact: 247 → 18 lines, rule: tests/jest, tee: ~/.gstack/compact/tee/20260416-143022_bun-test.log]
```

The agent can read the tee file directly if it needs the full stack trace. This replaces the earlier `onFailure.preserveFull` mechanic with a cleaner design: compacted output always stays small; raw output is always one `cat` away.

**Tee safety:**

- File mode `0600` — not world-readable.
- Built-in secret-regex set redacts AWS keys, bearer tokens, and common credential patterns before write.
- Failed writes (read-only filesystem, permission denied) degrade gracefully: still emit compacted output, record `meta.teeFailed: true`.
- Tee files auto-expire after 7 days (cleanup on hook startup).

### Host integration matrix

| Host | Hook type | Supported matchers | Config path |
|------|-----------|-------------------|-------------|
| Claude Code | `PostToolUse` | Bash, Read, Grep, Glob, Edit, Write, WebFetch, WebSearch, mcp__* | `~/.claude/settings.json` |
| Codex (v1.1) | `PostToolUse` equivalent | Bash (primary); tool subset TBD — empirical verification is a v1.1 prereq | `~/.codex/hooks.json` |
| OpenClaw (v1.1) | Native hook API | Bash + MCP | OpenClaw config |

**v1 is Claude-first.** Wedge (ii) — native-tool coverage — is confirmed on Claude Code via [the hooks reference](https://code.claude.com/docs/en/hooks). Codex and OpenClaw integration ships at v1.1 only after the wedge is proven on the primary host via B-series benchmark data. CHANGELOG for v1 makes the Claude-only scope explicit.

### Config surface

User config (`~/.config/gstack/compact.toml`):

```toml
[compact]
enabled = true
level = "normal"                            # minimal | normal | aggressive (caveman pattern)
exclude_commands = ["curl", "playwright"]   # RTK pattern

[compact.bundle]
auto_reload_on_mtime_drift = true           # hook rebuilds bundle if source rule files are newer
bundle_path = "~/.gstack/compact/rules.bundle.json"

[compact.regex]
per_rule_timeout_ms = 50                    # AbortSignal budget per regex; timeout → skip rule

[compact.verifier]
enabled = true
trigger_failure_compaction = true
trigger_aggressive_reduction = false
trigger_large_no_match = false
failure_signal_fallback = true              # use /FAIL|Error|Traceback|panic/ when exitCode missing
sanitization = "exact-line-match"           # only append lines present verbatim in raw output

[compact.tee]
on_exit = "nonzero"
max_bytes = 1048576
redact_patterns = ["aws", "github", "gitlab", "slack", "jwt", "bearer", "ssh-private-key"]
cleanup_days = 7

[compact.benchmark]
local_only = true                           # hard-coded; config is documentary, cannot be changed
transcript_root = "~/.claude/projects"
output_dir = "~/.gstack/compact/benchmark"
scenario_cap = 20                           # top-N clusters by aggregate output volume
```

**Intensity levels (caveman pattern):**

- **minimal:** only `filter` + `dedupe`; no truncation. Safest.
- **normal:** `filter` + `dedupe` + `truncate`. Default.
- **aggressive:** adds `group`; more savings, more edge-case risk.

### CLI surface

| Command | Purpose | Source |
|---------|---------|--------|
| `gstack compact install <host>` | Register PostToolUse hook in host config; builds `rules.bundle.json` | new |
| `gstack compact uninstall <host>` | Idempotent removal | new |
| `gstack compact reload` | Rebuild `rules.bundle.json` after editing user/project rules | new |
| `gstack compact doctor` | Detect drift / broken hook config, offer to repair | tokenjuice |
| `gstack compact gain` | Show token/dollar savings over time (per-rule breakdown) | RTK |
| `gstack compact discover` | Find commands with no matching rule, ranked by noise volume | RTK |
| `gstack compact verify <rule-id>` | Dry-run verifier on a fixture | new |
| `gstack compact list-rules` | Show effective rule set after deep-merge (built-in + user + project) | new |
| `gstack compact test <rule-id> <fixture>` | Apply a rule to a fixture and show the diff | new |
| `gstack compact benchmark` | Run B-series testbench against local transcript corpus (see Benchmark section) | new |

Escape hatch: `GSTACK_RAW=1` env var bypasses the hook entirely for the duration of a command (same pattern as tokenjuice's `--raw` flag). Hook also auto-reloads the bundle if any source rule file's mtime is newer than the bundle file.

## File layout

```
compact/
├── SKILL.md.tmpl              # template; regen via `bun run gen:skill-docs`
├── src/
│   ├── hook.ts                # entry point; reads stdin, writes stdout; mtime-checks bundle
│   ├── engine.ts              # rule matching + reduction metadata
│   ├── apply.ts               # primitive application (line-oriented streaming pipeline)
│   ├── merge.ts               # deep-merge of built-in/user/project rules; honors `extends: null`
│   ├── bundle.ts              # compile source rules → rules.bundle.json (install/reload)
│   ├── primitives/
│   │   ├── filter.ts
│   │   ├── group.ts
│   │   ├── truncate.ts        # ring-buffered tail; safe for arbitrary input size
│   │   └── dedupe.ts
│   ├── regex-sandbox.ts       # AbortSignal-bounded regex execution (50ms budget per rule)
│   ├── verifier.ts            # Haiku integration (triggers + failure-signal fallback + sanitization)
│   ├── sanitize.ts            # exact-line-match filter for verifier output
│   ├── tee.ts                 # raw-output archival with secret redaction + 7-day cleanup
│   ├── redact.ts              # secret-pattern set (AWS/GitHub/GitLab/Slack/JWT/bearer/SSH)
│   ├── envelope.ts            # JSON I/O contract parsing + validation
│   ├── doctor.ts              # hook drift detection + repair
│   ├── analytics.ts           # gain + discover queries against local metadata
│   └── cli.ts                 # argv dispatch; one thin dispatch per subcommand
├── benchmark/                 # B-series testbench (hard v1 gate)
│   └── src/
│       ├── scanner.ts         # walk ~/.claude/projects/**/*.jsonl; pair tool_use × tool_result
│       ├── sizer.ts           # tokens per call (ceil(len/4) heuristic); rank heavy tail
│       ├── cluster.ts         # group high-leverage calls by (tool, command pattern)
│       ├── scenarios.ts       # emit B1-Bn real-world scenario fixtures
│       ├── replay.ts          # run compactor against scenarios; measure reduction
│       ├── pathology.ts       # layer planted-bug P-cases on top of real scenarios
│       └── report.ts          # dashboard: per-scenario before/after + overall reduction
├── rules/                     # v1 built-in JSON rule library (13 rules)
│   ├── tests/
│   │   ├── jest.json
│   │   ├── vitest.json
│   │   ├── pytest.json
│   │   ├── cargo-test.json
│   │   ├── go-test.json
│   │   └── rspec.json
│   ├── install/
│   │   ├── npm.json
│   │   ├── pnpm.json
│   │   ├── pip.json
│   │   └── cargo.json
│   ├── git/
│   │   ├── diff.json
│   │   ├── log.json
│   │   └── status.json
│   ├── _verifier.json         # verifier config (not a rule per se)
│   └── _HOLD/                 # v1.1 rule families (not shipped at v1; kept for reference)
│       ├── build/
│       ├── lint/
│       └── log/
└── test/
    ├── unit/
    ├── golden/
    ├── fuzz/                  # P-series — v1 gate subset only (P1/P3/P6/P8/P15/P18/P26/P28/P30)
    ├── cross-host/            # v1: claude-code.test.ts only; codex/openclaw stub files
    ├── adversarial/           # R-series — grows with shipped bugs
    ├── benchmark/             # B-series scenario fixtures + expected reduction ranges
    ├── fixtures/              # version-stamped golden inputs (toolVersion: frontmatter)
    └── evals/
```

## Testing Strategy

The test plan is comprehensive by design. Shipping into a space where the 28K-star incumbent has three years of regex battle-scars, with our wedges (Haiku verifier + native-tool coverage) introducing new failure surfaces, means we get ONE shot at "the compactor made my agent dumb" going viral. Zero appetite for that.

### Test tiers

| Tier | Cost | Frequency | Blocks merge |
|------|------|-----------|--------------|
| Unit | free, <1s | every PR | yes |
| Golden file (with `toolVersion:` frontmatter) | free, <1s | every PR | yes |
| Rule schema validation | free, <1s | every PR | yes |
| Fuzz (P-series gate subset: P1/P3/P6/P8/P15/P18/P26/P28/P30) | free, <10s | every PR | yes |
| Cross-host E2E — Claude Code only at v1 | free, ~1min | every PR (gate tier) | yes |
| E2E with verifier (mocked Haiku) | free, ~15s | every PR | yes |
| E2E with verifier (real Haiku) | paid, ~$0.10/run | PR touching verifier files | yes |
| **B-series benchmark (real-world scenarios)** | **free, ~2min** | **pre-release gate** | **yes (hard gate for v1)** |
| Token-savings eval (E1-E4 synthetic) | paid, ~$4/run | periodic weekly | no (informational) |
| Adversarial regression (R-series) | free, <5s | every PR | yes |
| Tool-version drift warning | free, <1s | every PR | warning only |

Test file layout:

```
compact/test/
├── unit/
│   ├── engine.test.ts         # rule matching + primitive application
│   ├── primitives.test.ts     # filter / group / truncate / dedupe
│   ├── envelope.test.ts       # JSON input/output contract
│   ├── triggers.test.ts       # verifier trigger evaluation
│   └── verifier.test.ts       # Haiku call (mocked)
├── golden/
│   ├── tests/                 # one fixture per test runner
│   │   ├── jest-success.input.txt
│   │   ├── jest-success.expected.txt
│   │   ├── jest-fail.input.txt
│   │   ├── jest-fail.expected.txt
│   │   └── ... (vitest, pytest, cargo-test, go-test, rspec)
│   ├── install/
│   ├── git/
│   ├── build/
│   ├── lint/
│   └── log/
├── fuzz/
│   └── pathological.test.ts   # P-series
├── cross-host/
│   ├── claude-code.test.ts
│   ├── codex.test.ts
│   └── openclaw.test.ts
├── adversarial/
│   └── regression.test.ts     # R-series; past bugs that must never recur
├── fixtures/
│   └── {tool}/                # shared raw output fixtures
└── evals/
    └── token-savings.eval.ts  # periodic-tier; measures real reduction
```

### G-series: good cases (must produce expected reduction)

| ID | Scenario | Expected reduction |
|----|----------|-------------------|
| G1 | `jest` 47 passing tests, clean run | 150+ lines → ≤10 lines |
| G2 | `jest` 47 tests with 2 failures | 200+ lines → keep both failures + summary |
| G3 | `vitest` run with `--reporter=verbose` | 300+ lines → ≤15 lines |
| G4 | `pytest` collection then run | preserve failure tracebacks |
| G5 | `cargo test` with one panic | panic location preserved verbatim |
| G6 | `go test -v` with 200 subtests passing | collapse to `PASS: 200 subtests` |
| G7 | `git diff` on a file with 2 hunks in 500 lines of context | keep hunks, drop context |
| G8 | `git log -50` | preserve SHA + subject + author, drop body |
| G9 | `git status` with 30 modified files | group by directory |
| G10 | `pnpm install` fresh | final count + warnings; drop resolved packages |
| G11 | `pip install -r requirements.txt` | drop download progress; keep final install list + errors |
| G12 | `cargo build` success | drop compilation progress; keep final target |
| G13 | `docker build` success | drop layer pulls; keep final image digest |
| G14 | `tsc --noEmit` clean | compact to `tsc: 0 errors` |
| G15 | `tsc --noEmit` with 3 errors | keep all 3 errors with location |
| G16 | `eslint .` clean | compact to `eslint: 0 problems` |
| G17 | `eslint .` with violations | group by rule; preserve location + fix suggestion |
| G18 | `docker logs -f` with 1000 repeating lines | dedupe with count: `[last message repeated 973 times]` |
| G19 | `kubectl get pods -A` | group by namespace |
| G20 | `ls -la` deep tree | directory grouping (RTK pattern) |
| G21 | `find . -type f` 10K files | group by extension with counts |
| G22 | `grep -r "foo" .` with 500 hits | cap at 50; suffix `[... 450 more matches; use --ripgrep for full]` |
| G23 | `curl -v https://api.example.com` | strip verbose headers; keep response body |
| G24 | `aws ec2 describe-instances` 50 instances | columnar summary |

### P-series: pathological cases (must NOT break the agent)

These turn "nice feature" into "catastrophic regression" if we get any of them wrong.

| ID | Scenario | Required behavior |
|----|----------|-------------------|
| P1 | Binary garbage in output (non-UTF8 bytes) | Pass through unchanged; don't crash |
| P2 | ANSI escape explosion (10K+ codes) | Strip cleanly, don't choke regex |
| P3 | Empty output (`""`) | Pass through empty; do NOT inject header |
| P4 | Stdout+stderr interleaved | Rule matches across both streams |
| P5 | Truncated output (SIGPIPE mid-stream) | Don't mis-compact partial output |
| P6 | **Failed test, critical stack frame at line 4 of 200** | Must NOT filter the frame (the RTK-killer case) |
| P7 | Exit 0 but `ERROR:` in output | Rule must not trust exit code alone |
| P8 | Output contains AWS key / bearer token / password | Tee file must NOT be world-readable; redact in compacted output |
| P9 | Single-line minified JS error (40KB one line) | Truncate to first 1KB; append `[... truncated ...]` |
| P10 | Unicode (emoji, RTL, combining chars, CJK) | Byte-safe truncation; don't split codepoints |
| P11 | Two rules match same command | Deterministic priority: longest `match.commands` prefix wins; tie → rule ID alphabetical |
| P12 | Rule's compacted output matches another rule's pattern | No recursive application; hook runs once per tool call |
| P13 | Command contains embedded newlines in quoted arg | Rule doesn't misparse args |
| P14 | Concurrent tool calls (parallel Bash invocations) | No shared mutable state in hook; each call is isolated |
| P15 | Hook execution >5s | Pass through raw; emit `meta.timedOut: true` |
| P16 | Haiku API offline/rate-limited | Skip verifier silently; use pure rule output |
| P17 | Haiku returns malformed JSON | Skip verifier; do NOT feed raw response to agent |
| P18 | Haiku response contains prompt-injection (`"Ignore all prior instructions..."`) | Sanitize: only append lines that are substring matches of the original raw output |
| P19 | 1M-line output | Stream-process, cap memory at 64MB; truncate with clear marker |
| P20 | Rapid-fire: 50 tool calls / sec | Hook latency stays <15ms p99 |
| P21 | Command with shell redirects (`cmd >file 2>&1`) | Match on the underlying command name, not the redirect wrapper |
| P22 | Deeply nested quotes/escapes in command string | Robust arg parser; no shell injection possible |
| P23 | NULL bytes in output | Strip safely; don't truncate |
| P24 | Command that exits then writes more to stderr after | Hook receives final combined output; handles gracefully |
| P25 | Read-only filesystem / no tee write permission | Degrade gracefully; still emit compacted output; record `meta.teeFailed: true` |
| P26 | User's rule JSON is malformed | Skip that rule; emit warning to stderr; don't break hook |
| P27 | Rule references a non-existent primitive field | Ignore unknown field; apply rest of rule |
| P28 | Rule regex has catastrophic backtracking | RE2-compatible engine (no backtracking) OR per-rule timeout |
| P29 | Exit code 137 (OOM kill) | Rule treats same as generic failure; preserves full output |
| P30 | Haiku returns lines NOT present in raw output (hallucination) | Drop hallucinated lines; keep only substring matches |

### CH-series: cross-host E2E

Run each scenario on each supported host. Same input, same expected output. If a host does not support a matcher, the test is marked `skip-on-{host}` with a comment linking the upstream limitation.

| ID | Scenario | Hosts |
|----|----------|-------|
| CH1 | Install hook via `gstack compact install <host>` | Claude Code, Codex, OpenClaw |
| CH2 | Uninstall hook is idempotent | All |
| CH3 | Re-install doesn't duplicate entries | All |
| CH4 | Hook co-exists with user's other PostToolUse hooks | All |
| CH5 | Hook fires on Bash tool | All |
| CH6 | Hook fires on Read tool | Claude Code (confirmed); Codex/OpenClaw verify-then-require |
| CH7 | Hook fires on Grep tool | Same as CH6 |
| CH8 | Hook fires on Glob tool | Same as CH6 |
| CH9 | Hook fires on MCP tool (`mcp__*` matcher) | Claude Code; verify on others |
| CH10 | Config precedence: project > user > built-in | All |
| CH11 | `GSTACK_RAW=1` env var bypasses hook | All |
| CH12 | Rule ID override works (project rule replaces built-in) | All |
| CH13 | `gstack compact doctor` detects drift on each host | All |
| CH14 | Hook error does not crash the agent session | All |

Implementation note: cross-host tests reuse the fixture corpus from the `golden/` tree; the harness wraps each fixture in a host-specific hook invocation envelope and asserts the output is byte-identical across hosts (modulo the `host` field).

### V-series: verifier tests (paid)

| ID | Scenario | Expected |
|----|----------|----------|
| V1 | Rule reduces 200-line test output to 5 lines, exit=1 | Verifier fires (failure + >50% reduction), appends any missing critical lines |
| V2 | Rule reduces 10-line output to 9 lines, exit=1 | Verifier does NOT fire (reduction too small) |
| V3 | Rule reduces 200-line output to 5 lines, exit=0 | Verifier does NOT fire (success path, default config) |
| V4 | `aggressiveReduction` trigger enabled, 300 lines → 20 lines, exit=0 | Verifier fires |
| V5 | `GSTACK_COMPACT_VERIFY=1` env var set | Verifier fires once for that call |
| V6 | `ANTHROPIC_API_KEY` missing | Verifier silently skipped; raw rule output returned |
| V7 | Verifier mocked to return "NONE" | Output identical to pure-rule path |
| V8 | Verifier mocked to return prompt injection | Injection discarded; only substring-matched lines appended |
| V9 | Verifier mocked to time out >5s | Skipped; `meta.verifierTimedOut: true` |
| V10 | Verifier mocked to return 500 error | Skipped; rule output returned |

### R-series: adversarial regression

Every bug caught after v1 ship gets a permanent R-series test. Starts empty; grows with scars. Template:

```
R{N}: {commit-sha} — {1-line summary}
Scenario: {reproducer}
Fix: {PR link}
```

### Performance budgets (enforced in CI; revised for realistic Bun cold-start)

| Metric | Target | Hard limit |
|--------|--------|-----------|
| Hook overhead macOS ARM (verifier disabled) | <30ms p50 | <80ms p99 |
| Hook overhead Linux (verifier disabled) | <20ms p50 | <60ms p99 |
| Hook overhead (verifier fires) | <600ms p50 | <2s p99 |
| Bundle deserialize (rules.bundle.json) | <2ms | <10ms |
| mtime drift check (stat of source files) | <0.5ms | <3ms |
| Single-regex execution budget (per rule) | <5ms | <50ms (hard abort) |
| Memory per hook invocation (line-streamed) | <16MB typical | <64MB max |
| Total rule-payload size on disk (source files) | <5KB | <15KB |
| Compiled bundle size on disk | <25KB | <80KB |

Daemon mode is a v2 optimization. If B-series benchmark on the author's corpus shows cold-start meaningfully hurts session-total savings (e.g., total hook overhead >5% of saved tokens' wall time), promote to v1.1.

### B-series real-world benchmark testbench (hard v1 gate)

**Why it exists.** Every competing compactor ships with hand-picked fixture numbers. B-series proves the compactor works on the user's *actual* coding sessions before they enable the hook. It's both the ship-gate and the marketing artifact.

**Architecture** (components in `compact/benchmark/src/`):

```
┌──────────────────────────────────────────────────────────────┐
│  1. SCAN     scanner.ts walks ~/.claude/projects/**/*.jsonl  │
│              → pairs tool_use × tool_result blocks           │
│              → emits {tool, command, outputBytes, lineCount, │
│                estimatedTokens, sessionId, timestamp}        │
├──────────────────────────────────────────────────────────────┤
│  2. RANK     sizer.ts sorts corpus by estimatedTokens desc   │
│              → cluster.ts groups by (tool, command-pattern)  │
│              → identifies heavy-tail: which 10% of calls     │
│                produced 80% of the tokens?                   │
├──────────────────────────────────────────────────────────────┤
│  3. SCENARIO scenarios.ts emits fixture files:               │
│              B1_bun_test_heavy.jsonl                         │
│              B2_git_diff_huge.jsonl                          │
│              B3_tsc_errors_production.jsonl                  │
│              B4_pnpm_install_fresh.jsonl ... (one per        │
│              high-leverage cluster, up to ~20 scenarios)     │
├──────────────────────────────────────────────────────────────┤
│  4. REPLAY   replay.ts runs compactor against each scenario, │
│              measures token reduction + diff of dropped lines│
│              → per-rule reduction numbers                    │
│              → per-scenario before/after token counts        │
├──────────────────────────────────────────────────────────────┤
│  5. PATHOLOGY pathology.ts injects planted critical lines    │
│              (line 4 of 200 in a failing test fixture) into  │
│              real B-scenarios. Confirms verifier restores    │
│              them. Real data + real threats = real proof.    │
├──────────────────────────────────────────────────────────────┤
│  6. REPORT   report.ts emits HTML + JSON dashboard to        │
│              ~/.gstack/compact/benchmark/latest/              │
│              "On YOUR 30 days of Claude Code data, gstack    │
│              compact would save X tokens in Y scenarios."    │
└──────────────────────────────────────────────────────────────┘
```

**v1 ship gate (hard):**
- ≥15% total-token reduction across the aggregated scenario corpus on the author's own 30-day transcript set.
- Zero critical-line loss on planted-bug scenarios (every planted stack frame must survive either the rule or the verifier).
- No scenario regresses to <5% reduction under the new rules (catch over-compaction edge cases).

**Privacy (non-negotiable):**
- Reads `~/.claude/projects/**/*.jsonl` locally only. Never uploads. Never shares. Never logs scenarios to telemetry.
- Output files live under `~/.gstack/compact/benchmark/` with mode `0600`.
- The command prints a confirmation banner: *"Scanning local transcripts at ~/.claude/projects/ (local-only; nothing leaves this machine)."*
- Any future community corpus is a separate v2 workstream built from hand-contributed, secret-scanned fixtures on OSS projects.

**Ports from analyze_transcripts (TypeScript reimplementation; not a subprocess call):**
- JSONL parsing + tool_use/tool_result pairing pattern (from `event_extractor.rb`).
- Token estimate `ceil(len/4)` (same char-ratio heuristic; sufficient for ranking).
- Event-type taxonomy (`bash_command`, `file_read`, `test_run`, `error_encountered`) for scenario clustering.
- Stress-fixture generation pattern for pathology layering.

**What we do NOT port:** behavioral scoring, pgvector embeddings, decision-exchange graphs, velocity metrics, the Rails/ActiveRecord layer. Out of scope; not what we're measuring.

### Synthetic token-savings evals (E-series, periodic/informational only)

Retained from the original plan but now informational-only because B-series is the real gate.

- **E1:** simulated 30-min coding session on a medium TypeScript project. Measure total tokens with/without gstack compact enabled. Target: ≥15% reduction.
- **E2:** same session at `level=aggressive`. Target: ≥25% reduction, zero test-failure increase.
- **E3:** same session with verifier on `failureCompaction` only. Verifier fire rate ≤10% of tool calls.
- **E4:** adversarial — inject a planted bug in a test output and confirm the verifier restores the critical stack frame.

### Test corpus sourcing

For each rule family, capture 3+ real outputs:

1. Run the tool against a real project (gstack itself for TS; popular OSS for Rust/Go/Python).
2. Capture stdout+stderr+exit code into a fixture file with `toolVersion:` frontmatter (e.g., `jest@29.7.0`).
3. Hand-author the expected compacted output once.
4. Golden file test: rule application must produce byte-identical output.
5. CI drift warning: if installed tool version differs from fixture's `toolVersion:`, CI warns (not fails). Drift-warning dashboard is checked pre-release.

Draw from:
- tokenjuice's fixture directory patterns (`tests/fixtures/`)
- RTK's per-command examples (their README lists real before/after metrics; verify independently)
- gstack's own test output (eat our own dog food)
- Real failure archives from `~/.gstack/compact/tee/` (once volunteers contribute)
- **B-series real-world scenarios are the primary corpus for reduction measurements.**

## Pattern adoption table

Concrete patterns borrowed from the competitive landscape:

| From | Adopt as | Why |
|------|----------|-----|
| RTK | 4 reduction primitives (filter/group/truncate/dedupe) as JSON rule verbs | Table stakes for a serious compactor |
| RTK | `gstack compact tee` for failure-mode raw save | Better than the original `onFailure.preserveFull` design |
| RTK | `gstack compact gain` + `gstack compact discover` | Trust + continuous improvement |
| RTK | `exclude_commands` per-user blocklist | Must-have config |
| tokenjuice | JSON envelope contract for hook I/O | Clean machine adapter |
| tokenjuice | `gstack compact doctor` | Hooks drift; self-repair matters |
| caveman | Intensity levels (minimal/normal/aggressive) | User-tunable safety/savings knob |
| claude-token-efficient | Rules-file size budget (<5KB total) | Don't bloat context |

## Rollout plan

**ALL PHASES TABLED pending Anthropic `updatedBuiltinToolOutput` API.** See Status section at the top of this doc. The rollout below is the intended sequence if/when the API ships and this design un-tables.

### Un-tabling checklist (do in order when the API arrives)

1. **Confirm the new API's shape.** Read the updated Claude Code hooks reference. Capture a real envelope containing the new output-replacement field for Bash, Read, Grep, Glob. Record in `docs/designs/GCOMPACTION_envelope.md`.
2. **Re-validate the wedge.** Does the new API cover Read/Grep/Glob (do they fire `PostToolUse` now), or just Bash/WebFetch? If Bash-only, wedge (ii) stays dead and the product needs a new pitch before implementation.
3. **Re-run `/plan-eng-review`** against the revised plan with the new API. Most of the 15 locked decisions should carry forward; adjust the Architecture data-flow and any envelope-dependent decisions.
4. **Re-run `/codex review`** against the revised plan. The prior BLOCK verdict's concerns about hook substitution disappear once the API exists; remaining criticals (B-series privacy, regex DoS, JSON-envelope streaming) still apply.
5. **Execute the original rollout below.**

### Original rollout (preserved for un-tabling)

Each tier blocks on the prior passing all gate-tier tests. Claude-first — Codex and OpenClaw land at v1.1 after the wedge is proven on the primary host.

1. **v0.0 (1 day):** rule engine + 4 primitives + line-oriented streaming pipeline + deep-merge + bundle compiler + envelope contract + golden tests for `tests/*` family only. No host integration yet. Measure savings on offline fixtures.
2. **v0.1 (1 day):** Claude Code hook integration + `gstack compact install` + mtime-based auto-reload. Ship as opt-in; off by default. Ask 10 gstack power users to try it; collect feedback.
3. **v0.5 (1 day):** B-series benchmark testbench (`compact/benchmark/`). Ship `gstack compact benchmark` so users can measure on their own data. Collect anonymous-from-the-start (nothing uploaded) reduction numbers from dogfooders.
4. **v1.0 (1 day):** verifier layer with `failureCompaction` trigger on by default + exact-line-match sanitization + layered exitCode/pattern fallback + expanded tee redaction set. **Hard ship gate:** B-series on the author's 30-day local corpus shows ≥15% total reduction AND zero critical-line loss on planted bugs. Publish CHANGELOG entry leading with wedge framing (Claude Code only at v1).
5. **v1.1 (+1 day):** Codex + OpenClaw hook integration. Cross-host E2E suite green. Build/lint/log rule families land with `gstack compact discover`-derived priorities.
6. **v1.2+:** expand rule families, community rule contribution workflow, community-corpus benchmark (hand-authored public fixtures, separate from local B-series).

## Risk analysis

| Risk | Severity | Mitigation |
|------|----------|------------|
| RTK adds an LLM verifier in response | Low | Creator is vocal about zero-dependency Rust. Ship first, build the pattern library. |
| Platform compaction subsumes us (Anthropic Compaction API in Claude Code) | Medium | We operate at a different layer (per-tool output vs whole-context). Position as complementary. |
| Rules drop something critical → "compactor made my agent dumb" | High | B-series real-world benchmark as hard ship gate; tee mode always available; verifier default-on for failures; exact-line-match sanitization. |
| Haiku cost creep (triggers fire more than expected) | Medium | E3 eval + B-series fire-rate metric; cost visible in `gstack compact gain`; per-session rate cap in v1.1 if rate >10%. |
| Rule maintenance debt (jest/vitest output formats change) | Medium | `toolVersion:` fixture frontmatter + CI drift warning; community rule PRs; `discover` flags bypassing commands. |
| Rules file bloats context | Low | CI-enforced <5KB source + <25KB compiled bundle budget; per-rule size warning at schema-validation. |
| Regex DoS blocks the agent | Medium | 50ms AbortSignal budget per rule; timeout logged to `meta.regexTimedOut`; stale rules quarantined on repeated failure. |
| Bundle staleness silently breaks user edits | Low | mtime-check on every hook invocation auto-rebuilds; `gstack compact reload` is a backup not a requirement. |
| Benchmark leaks user's private data | High | Local-only by construction: no network call, mode-0600 output, explicit banner at runtime. Privacy review before v1 ship. |

## Open questions

1. ~~Does Codex's PostToolUse hook support matchers for Read/Grep/Glob?~~ (Deferred to v1.1 — Claude-first at v1.)
2. ~~Does OpenClaw's hook API support PostToolUse specifically?~~ (Deferred to v1.1.)
3. Should the verifier model be pinned, or version-tracked like gstack's other AI calls? (Inclined to pin `claude-haiku-4-5-20251001` and bump explicitly in CHANGELOG.)
4. ~~Built-in secret-redaction regex set for tee files~~ **(resolved: expanded set — AWS/GitHub/GitLab/Slack/JWT/bearer/SSH-private-key. See decision #10.)**
5. Should `gstack compact discover` propose auto-generated rules via Haiku? (Deferred to v2; skill-creep risk.)
6. **New:** Does Claude Code's PostToolUse envelope include `exitCode`? (Still needs empirical verification per pre-implementation task #1; system now has a layered fallback regardless.)
7. **New:** What's the right scenario-count cap for B-series? Cluster.ts can produce 5-50 scenarios depending on heavy-tail shape. Plan: cap at top 20 clusters by aggregate output volume.

## Pre-implementation assignment (must complete before coding)

1. **Verify Claude Code's PostToolUse envelope contents empirically.** Ship a no-op hook; confirm `exitCode`, `command`, `argv`, `combinedText` are all present. This is the pivot for wedge (ii) native-tool coverage AND for the failureCompaction trigger. Output: `docs/designs/GCOMPACTION_envelope.md` with real captured envelopes for Bash + Read + Grep + Glob.
2. **Read RTK's rule definitions** (`ARCHITECTURE.md`, `src/rules/`) and write a 1-paragraph summary of which of the 4 primitives they handle best. Inform our v1 rule set. This is the Search Before Building layer.
3. **Port analyze_transcripts JSONL parser to TypeScript.** `compact/benchmark/src/scanner.ts`. Write a quick-look output that lists the top-50 noisiest tool calls on the author's `~/.claude/projects/`. Confirms the testbench premise before we build the replay loop. This is the B-series foundation.
4. **Write the CHANGELOG entry FIRST.** Target sentence: *"Every tool in your agent's toolbox on Claude Code now produces less noise — test runners, git diffs, package installs — with an intelligent Haiku safety net that restores critical stack frames when our rules over-compact, and a local benchmark that proves the savings on your actual 30 days of coding sessions. Codex + OpenClaw land in v1.1."* If we cannot write that sentence honestly, the wedge isn't there yet.
5. **Ship a rule-only v0** (no Haiku verifier, no benchmark). Measure real token savings with current gstack evals + early B-series prototype. If <10% on local corpus, the whole premise is weaker than claimed — iterate the rules before adding the verifier on top.

## License & attribution

gstack ships under MIT. To keep the license clean for downstream users, this project follows a strict clean-room policy for everything borrowed from the competitive landscape:

- **Every project referenced above is permissive-licensed** (MIT or Apache-2.0). No AGPL, GPL, SSPL, or other copyleft exposure.
  - RTK (rtk-ai/rtk): **Apache-2.0** — MIT-compatible; Apache patent grant is a bonus for us.
  - tokenjuice, caveman, claude-token-efficient, token-optimizer-mcp, sst/opencode: **MIT**.
- **Patterns, not code.** We read these projects to understand what they solved and why. We implement independently in TypeScript inside `compact/src/`. We do not copy source files, translate source files line-for-line, or lift test fixtures verbatim.
- **Attribution.** Where a pattern is directly borrowed (the 4 primitives from RTK, the JSON envelope from tokenjuice, intensity levels from caveman, rules-file size budget from claude-token-efficient), we credit the source inline in comments and in the "Pattern adoption table" above. The project's `README` and `NOTICE` file (if we add one) list the inspirations.
- **Fixture sourcing.** Golden-file fixtures come from running real tools against real projects — they are our own captures, not imported from RTK or tokenjuice. This keeps the test corpus free of license-tangled content.
- **Forbidden sources.** Before adding any new reference project, run `gh api repos/OWNER/REPO --jq '.license'` and verify the license key is one of: `mit`, `apache-2.0`, `bsd-2-clause`, `bsd-3-clause`, `isc`, `cc0-1.0`, `unlicense`. If the project has no license field, treat it as "all rights reserved" and do not draw from it. Reject `agpl-3.0`, `gpl-*`, `sspl-*`, and any custom or source-available license.

CI enforcement: a `scripts/check-references.ts` script parses `docs/designs/GCOMPACTION.md` for GitHub URLs and re-runs the license check, failing if any referenced project's license moves off the allowlist.

## References

- [RTK (Rust Token Killer) — rtk-ai/rtk](https://github.com/rtk-ai/rtk)
- [RTK issue #538 — native-tool gap](https://github.com/rtk-ai/rtk/issues/538)
- [tokenjuice — vincentkoc/tokenjuice](https://github.com/vincentkoc/tokenjuice)
- [caveman — juliusbrussee/caveman](https://github.com/juliusbrussee/caveman)
- [claude-token-efficient — drona23](https://github.com/drona23/claude-token-efficient)
- [token-optimizer-mcp — ooples](https://github.com/ooples/token-optimizer-mcp)
- [6-Layer Token Savings Stack — doobidoo gist](https://gist.github.com/doobidoo/e5500be6b59e47cadc39e0b7c5cd9871)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Chroma context rot research](https://research.trychroma.com/context-rot)
- [Morph: Why LLMs Degrade as Context Grows](https://www.morphllm.com/context-rot)
- [Anthropic Opus 4.6 Compaction API — InfoQ](https://www.infoq.com/news/2026/03/opus-4-6-context-compaction/)
- [OpenAI compaction docs](https://developers.openai.com/api/docs/guides/compaction)
- [Google ADK context compression](https://google.github.io/adk-docs/context/compaction/)
- [LangChain autonomous context compression](https://blog.langchain.com/autonomous-context-compression/)
- [sst/opencode context management](https://deepwiki.com/sst/opencode/2.4-context-management-and-compaction)
- [DEV: Deterministic vs. LLM Evaluators — 2026 trade-off study](https://dev.to/anshd_12/deterministic-vs-llm-evaluators-a-2026-technical-trade-off-study-11h)
- [MadPlay: RTK 80% token reduction experiment](https://madplay.github.io/en/post/rtk-reduce-ai-coding-agent-token-usage)
- [Esteban Estrada: RTK 70% Claude Code reduction](https://codestz.dev/experiments/rtk-rust-token-killer)

**End of GCOMPACTION.md canonical section.** On plan approval, everything above is copied verbatim to `docs/designs/GCOMPACTION.md` as a **tabled design artifact**. No code is written; no hook is installed; no CHANGELOG entry is added. The doc exists so a future sprint can unblock quickly when Anthropic ships the built-in-tool output-replace API.
