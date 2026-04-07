# Adoption Proposal: dag-toml-templates v2, Token Optimization, and AI Slop Detection
**gstack / feat/sqry-add-in**
Date: 2026-04-07

---

## 1. Executive Summary

This proposal makes the case for three coordinated improvements to gstack's skill
infrastructure: adopting dag-toml-templates v2 to replace prose-based methodology with
machine-readable TOML contracts and a queryable dagdb runtime backed by SurrealDB;
applying systematic token optimization across all SKILL.md templates to cut inference cost
by 35-70% without removing any behavioral instruction; and integrating the 25-pattern AI
slop detection guide into the /review and /cso skills as a structured checklist phase. The
combined effect is a cheaper, faster, and more reliably enforced review and shipping pipeline
-- replacing ad-hoc markdown parsing and prose-based gatekeeping with structured contracts,
deterministic gate evaluation, and evidence-backed pattern detection for the exact failure
modes AI code generation is statistically known to produce. Extrapolating from three
demonstrated optimizations, full rollout reduces the 404K-token generated footprint to
approximately 220K tokens and saves an estimated $150-1,500/year at current pricing
depending on user base scale, while making every methodology rule auditable, diffable, and
invokable without re-reading prose each session.

---

## 2. Current State

gstack operates through a collection of SKILL.md files generated from `.tmpl` templates and
read by agents at runtime. The architecture is legible and easily modified, but it has
accumulated structural friction that compounds as the skill set grows.

**Prose-based instructions with no machine-readable contracts.** The 36 SKILL.md.tmpl
templates total 131K tokens. The generated SKILL.md files (before host multiplication
across 7 host directories) total 404K tokens. Agents parse prose to determine current
state, check step completion, and decide whether to proceed. There is no structured DAG
of tasks, no dependency graph, and no programmatic way to ask "what is the critical path?"
or "which gates are blocking?"

**JSONL tracking with prose-based query logic.** The Review Readiness Dashboard reads from
`~/.gstack/reviews/review-log.jsonl` and instructs the agent to parse the output, find the
most recent entry per skill, ignore entries older than 7 days, distinguish "(DIFF)" from
"(PLAN)" sources, and compute a VERDICT. This is 80+ lines of prose describing what is
effectively a database query. The same log file is read by both `/review` and `/ship`, with
a `via:"ship"` field added specifically to let two prose-parsing paths distinguish their
entries -- a sign the system has outgrown its format.

**Narrative methodology across scattered resolvers.** The gen-skill-docs pipeline composes
skills from five resolver modules: `scripts/resolvers/preamble.ts` (749 lines),
`review.ts` (1,021 lines), `design.ts` (950 lines), `utility.ts` (417 lines), and
`testing.ts` (573 lines). Each contains prose instructions. There is no versioned schema
capturing "this skill requires these reviewer checks" in a way that is queryable or diffable
across skill updates.

**Voice rules as inline TypeScript strings.** The AI vocabulary blacklist, banned phrases,
and tone guidance live in `generateVoiceDirective()` in `scripts/resolvers/preamble.ts`
(lines 610-666). They are TypeScript string constants embedded in a function return value.
An agent checking for AI vocabulary in a PR description must re-read and re-apply these
rules from prose each session. The blacklist is not importable by test infrastructure, not
diffable as data, and not accessible to /review or /cso without parsing the TypeScript
function.

**No named AI slop detection phase.** The existing `/review` checklist covers structural
issues like SQL safety, LLM trust boundary violations, and conditional side effects. It does
not have a named, research-backed pattern library for the specific failure modes AI code
generation statistically produces. The `/cso` skill does extensive OWASP analysis but has
no "AI-specific antipattern" phase. Both skills are flying partially blind on the category
of defect most likely to appear in AI-assisted submissions.

---

## 3. Proposed Changes

### 3a. dag-toml-templates v2: Structured Methodology Contracts

dag-toml-templates v2 introduces TOML-based contract files that live alongside SKILL.md
files and are parsed by agents at runtime via the dagdb runtime (a Python package backed by
SurrealDB). Three contract types are relevant to gstack:

**IMPLEMENTATION_DAG** -- replaces ad-hoc plan completion tracking with a queryable DAG.
The agent calls `dagdb get_progress()` instead of parsing prose step-completion state.
`dagdb check_critical_path()` replaces the agent having to infer which steps are blocking.
Each unit declares its `layer`, `depends_on`, `conflict_group`, and `reviewer_checks`,
making dependencies explicit and machine-traversable.

```toml
[[units]]
id = "review"
label = "Step 3.5: Pre-landing review"
layer = 2
depends_on = ["preflight"]
conflict_group = "review"
reviewer_checks = ["no_injection", "no_god_functions", "no_unhandled_errors"]
```

**REVIEW_READINESS** -- replaces the 80-line prose JSONL-parsing dashboard instruction in
`scripts/resolvers/review.ts` with structured gate declarations. The agent calls
`dagdb check_gate("eng_review")` instead of reading JSONL, applying 7-day expiry logic,
and attributing source labels from prose.

```toml
[[gates]]
id = "eng_review"
label = "Eng Review"
required = true
log_key = "review"
max_age_days = 7
source_labels = { diff = "DIFF", plan = "PLAN" }
```

**SKILL_CONTRACTS** -- a single per-skill TOML capturing the reviewer checks, voice rules,
and methodology invariants currently scattered across resolver modules. The voice blacklist
moves from an inline TypeScript string to a machine-scannable TOML array. The SurrealDB
migration `001_contract_clause_style_fields` already exists in dag-toml-templates, adding
`blacklist`, `examples`, `reviewer_checks`, and `applies_to` fields -- no schema work
required.

```toml
[voice_rules]
blacklist = ["leverage", "robust", "seamless", "delve", "crucial", "utilize",
             "comprehensive", "cutting-edge", "paradigm", "synergy"]

[[reviewer_checks]]
id = "unhandled_errors"
category = "safety"
patterns = ["catch (e) {}", "catch (_)", "except: pass", "rescue nil"]
severity = "CRITICAL"
```

### 3b. Token Optimization: 35-70% Reduction Across All Skills

Three files were optimized during the research session to demonstrate the reduction rate.
All behavioral instructions were preserved -- every step, every decision point, every bash
block, every placeholder. Only framing prose, narrative repetition, and verbose structure
were removed.

Demonstrated reductions (see Section 5 for full numbers):

- **CLAUDE.md:** 65% reduction by moving contributor-only narrative to CONTRIBUTING.md and
  keeping only agent-relevant config (commands, structure, preamble behavior, guardrails).
- **preamble.ts:** 53% reduction by tier-gating the completeness section, context recovery,
  and ask-format sections so they only appear in skills that need them, and by extracting
  the one-time onboarding flows to a separate file read only on first run.
- **ship/SKILL.md.tmpl:** 70% reduction by compressing prose methodology into terse rule
  lists while preserving every step number, every bash block, and every decision gate.

The preamble reduction has a multiplicative effect: it is injected into every generated
SKILL.md, so each token saved in `preamble.ts` saves 36 tokens in the full generated
corpus.

### 3c. AI Slop Detection Integration into /review and /cso

Add a new checklist phase to `/review` (after Step 4, the critical pass) and to `/cso --code`
(new Phase 9.5) that applies the 25-pattern guide from `AI_SLOP_REVIEW_GUIDE.md`.

The guide is grounded in four published data sets: CodeRabbit's analysis of 470 PRs finding
1.7x more issues in AI-authored code; GitClear's 211M-line study showing copy/paste rising
from 8.3% to 12.3% since AI tools went mainstream; Snyk's finding that 36-40% of
AI-generated snippets contain security vulnerabilities; and OX Security's observation that
90-100% of AI-generated repos exhibit mass trivial documentation. Agents cite these sources
when flagging findings rather than asserting opinions.

**For /review -- new Step 4.5:** Apply Category 1 (Safety, P1-P5) as CRITICAL findings.
Apply Categories 2-6 (P6-P25) as INFORMATIONAL, participating in the existing Fix-First
Heuristic triage from `review/checklist.md`.

**For /cso -- new Phase 9.5:** Apply all 25 patterns to the full codebase. This is distinct
from OWASP: it covers structural and quality failure modes specific to AI-generated code,
not just security vulnerabilities.

---

## 4. Mapping Table

| gstack Section | Current | Proposed (v2) | Benefit |
|---|---|---|---|
| Plan Completion (ship 3.45) | Ad-hoc markdown parsing | IMPLEMENTATION_DAG + dagdb get_progress() | Queryable progress, critical path, conflict detection |
| Pre-Landing Review (ship 3.5) | Prose checklist | REVIEW_READINESS gates + AI slop patterns | Machine-enforceable gates |
| Review Dashboard | JSONL parsing | dagdb check_gate() | Programmatic gate evaluation |
| Voice Rules | Prose in preamble.ts | Contract clauses with blacklist/examples/reviewer_checks fields (SurrealDB migration 001 already exists) | Machine-scannable, auditable |
| Methodology Rules | Scattered across resolvers | SKILL_CONTRACTS TOML | Centralized, versioned, reviewer_checks |
| TODOS.md | Flat markdown | IMPLEMENTATION_DAG units | Dependencies, layers, conflict groups |
| autoplan pipeline | Sequential skill invocation | REVIEW_READINESS gates per review type | Structured pass/block/next_step |

---

## 5. Token Impact

All three demonstrated reductions were measured on actual files in this repository as of
2026-04-07. Reduction method: remove filler phrases, narrative repetition, and verbose
structure; preserve all behavioral instructions, bash blocks, step numbers, and placeholders.

| Asset | Before | After | Reduction | Method |
|---|---|---|---|---|
| CLAUDE.md | 4,837 tokens | 1,701 tokens | **65%** | Direct (Opus) -- demonstrated |
| preamble.ts | 8,298 tokens | 3,937 tokens | **53%** | Direct (Opus) -- demonstrated |
| ship/SKILL.md.tmpl | 6,689 tokens | 1,983 tokens | **70%** | Direct (Opus) -- demonstrated |
| All SKILL.md.tmpl (36 files) | 131K tokens | ~72K tokens | **~45%** | Extrapolated at demonstrated rates |
| All generated SKILL.md | 404K tokens | ~220K tokens | **~46%** | Extrapolated (preamble effect x36) |

**Why preamble has multiplicative leverage:** `preamble.ts` is injected into every
generated SKILL.md. The 4,361-token reduction (8,298 → 3,937) multiplies to ~157K tokens
saved across the 36-skill generated corpus. This single file is the highest-leverage
optimization target in the codebase.

**Why the ship template achieved 70%:** The ship workflow template is the most
prose-heavy in the codebase. Steps 3.45, 3.5, 3.75, and 5 each contain multi-paragraph
narrative framing around their actual instructions. Compressing narrative framing to terse
rule lists while keeping every step intact achieves the highest reduction ratio.

**Annual savings at $3/Mtok input** (Claude Sonnet pricing), 1,000 skill invocations/day:

| Scenario | Current | After Optimization | Annual Saving |
|---|---|---|---|
| 1,000 invocations/day | ~146M tok/year = ~$438 | ~80M tok/year = ~$240 | ~$198/year |
| 10,000 invocations/day (mid-size org) | ~1.46B tok/year = ~$4,380 | ~800M tok/year = ~$2,400 | ~$1,980/year |

Token reduction also directly reduces latency: smaller context windows produce faster
first-token response, which compounds across multi-step skill workflows like /ship and
/autoplan that invoke 6-12 steps sequentially.

---

## 6. Implementation Effort

Using gstack's standard effort compression table. All tasks are single-branch, no phased
rollout -- the complete implementation ships together.

| Task | Human | CC+gstack | Ratio |
|------|-------|-----------|-------|
| Token optimization (all templates) | 2 weeks | 2 hours | ~40x |
| TOML contract creation | 1 week | 30 min | ~70x |
| dagdb integration | 2 weeks | 4 hours | ~20x |
| AI slop guide integration | 3 days | 1 hour | ~25x |

**Total estimated wall time with CC+gstack:** approximately 8 hours in a single focused
session. The boilerplate-heavy tasks (TOML file generation, resolver module scaffolding,
golden fixture updates for all 36 skills) benefit most from AI compression. The full E2E
eval suite (`bun run test:evals:all`) is the gating validation step and is the largest
single time investment.

The entire implementation is a lake, not an ocean. There are no multi-quarter migrations,
no external service integrations requiring procurement, and no breaking changes to the
public API. The dagdb resolver is local-only (reads TOML files from the skill directory,
no network calls). TOML contracts are additive alongside existing SKILL.md files --
existing behavior is preserved while new behavior is enabled.

---

## 7. Risks and Mitigations

**Risk: TOML contracts diverge from SKILL.md.tmpl prose over time.**
The same logic exists in two representations. If one is updated and the other is not,
agents receive contradictory guidance.
Mitigation: The gen-skill-docs.ts generator validates that every SKILL_CONTRACTS.toml
`reviewer_checks` entry has a corresponding prose section in the template. `bun run
skill:check` fails if contracts reference patterns absent from the skill. The contract
file is the authoritative source; prose instructions become a human-readable view of it.

**Risk: dagdb resolver adds a runtime dependency.**
If SurrealDB or dagdb is unavailable, every skill that calls `dagdb get_progress()` could
block.
Mitigation: The dagdb resolver is local-only and wraps gracefully -- non-critical calls use
`|| true` so they never block skill execution. Fallback is current behavior: the agent
parses prose. The fallback path is tested in the gate-tier E2E suite so regressions are
caught before landing.

**Risk: Token reduction changes agent behavior on long-running skills.**
Removing 150 lines from the preamble changes context window composition. Skills that rely
on preamble bash output being present for later steps could regress.
Mitigation: Run `bun run test:e2e:all` (not diff-gated) before and after each compression
change. The eval store (`test/helpers/eval-store.ts`) provides before/after score
comparison. Any gate-tier regression blocks the change. Score comparison is the proof
required before claiming "not related to our changes" per the E2E eval failure blame
protocol in CLAUDE.md.

**Risk: AI slop patterns produce noisy findings on legitimate code.**
P13 (premature abstraction) and P17 (verbose patterns) require judgment. An interface with
one implementation may be an intentional testing seam or future extension point. Mechanical
application flags valid architectural choices.
Mitigation: Classify P1-P5 (Safety Slop) as CRITICAL -- injected into the existing
critical pass. Classify P6-P25 as INFORMATIONAL -- separate section, not gate-blocking by
default. The Fix-First Heuristic in `review/checklist.md` already handles INFORMATIONAL vs
CRITICAL triage. AI slop findings participate in the same triage flow with no new policy
required.

**Risk: CLAUDE.md compression removes context agents need during ship workflows.**
The current CLAUDE.md contains detailed contributor guidance (commit bisection rules,
upgrade migration format, community PR guardrails) that agents rely on.
Mitigation: Agent-relevant content stays in CLAUDE.md. Community PR guardrails stay
complete -- they are explicitly agent-relevant for PR review workflows. Contributor-only
documentation (upgrade migration format, compiled binary warnings, dev symlink awareness)
moves to CONTRIBUTING.md. The split is audited by running `bun run test:evals` to verify
no regressions before landing.

**Risk: All 36 template optimizations introduce cumulative regressions.**
Individually each template compresses cleanly. Together, 36 simultaneous changes are more
likely to affect one golden fixture or one gate-tier eval.
Mitigation: Optimize in waves with `bun run test:evals` between each wave (preamble first,
top-6 templates second, remaining 30 third). Each wave's eval run is a checkpoint. The
CI gate (`bun run test:gate`) catches any regression that reaches a PR.

---

## 8. Next Steps

The following sequence reflects logical dependencies for a single-branch complete
implementation. This is not a phased rollout -- all of it ships together. The ordering
is for execution clarity only.

**Step 1: Schema and resolver foundation (additive, no skill changes)**
- Define dag-toml-templates v2 TOML schema as TypeScript types in
  `scripts/resolvers/types.ts`
- Implement `scripts/resolvers/dagdb.ts` as the TOML-reading resolver with graceful
  fallback
- Add schema validation to `bun run skill:check` so contract/prose divergence is caught
  at CI time
- Run `bun test` to confirm no regressions before touching any skill file

**Step 2: TOML contract files for the three highest-value skills**
- `ship/IMPLEMENTATION_DAG.toml` -- 21 units across 4 layers covering Steps 1-6
- `review/REVIEW_READINESS.toml` -- 3 gates (eng_review, adversarial, plan)
- `review/SKILL_CONTRACTS.toml` and `cso/SKILL_CONTRACTS.toml` -- voice rules +
  reviewer_checks for the two skills that benefit most from machine-scannable contracts

**Step 3: Token optimization for the preamble (highest-leverage)**
- Extract the one-time onboarding flows (lake intro, telemetry, proactive prompt) to
  `preamble-flows/ONBOARDING.md`, read only when the relevant env vars are unset
- Tier-gate the completeness section, context recovery, and ask-format sections
- Update golden fixtures in `test/fixtures/` to match compressed output
- Run `bun run test:evals` and verify no gate-tier regressions before proceeding

**Step 4: AI slop detection integration**
- Add `review/ai-slop-patterns.md` (the 25-pattern guide adapted for agent use,
  with citations for CodeRabbit, GitClear, Snyk, OX Security)
- Add Step 4.5 to `review/SKILL.md.tmpl` -- apply P1-P5 as CRITICAL, P6-P25 as
  INFORMATIONAL
- Add Phase 9.5 to `cso/SKILL.md.tmpl` -- full 25-pattern scan distinct from OWASP
- Add at least one gate-tier E2E test covering P1 (unhandled errors) detection
- Update `test/fixtures/review-golden.json` with Step 4.5 expected output shape

**Step 5: Review Readiness Dashboard compression**
- Replace the 80-line prose dashboard instruction in `scripts/resolvers/review.ts`
  with a 10-line instruction referencing `dagdb check_gate()` per gate in
  `REVIEW_READINESS.toml`
- Update ship workflow references to the same dashboard in `ship/SKILL.md.tmpl`
- Run `bun run test:evals` -- the review dashboard is the most eval-covered section;
  any regression here surfaces immediately

**Step 6: Remaining template optimization (30 templates)**
- Apply the same compression techniques demonstrated on ship/SKILL.md.tmpl to the
  remaining 30 templates, targeting 35-50% reduction each
- Run in batches of 8-10 with `bun run test:evals` between batches
- Update golden fixtures for each batch before proceeding to the next

**Step 7: CLAUDE.md compression**
- Audit every section: agent-relevant vs contributor-only classification
- Keep in CLAUDE.md: commands, project structure, preamble behavior, community PR
  guardrails, CHANGELOG style, platform-agnostic design, skill routing
- Move to CONTRIBUTING.md: upgrade migration format, compiled binary warnings, dev
  symlink awareness, publishing to ClawHub details
- Run full eval suite to confirm no behavior regressions

**Step 8: Regenerate all SKILL.md files and ship**
- `bun run gen:skill-docs` to regenerate all 36 canonical SKILL.md files and all 7
  host directory variants
- Run `bun run test:evals:all` (not diff-gated -- this is a broad infrastructure change
  that touches every generated file)
- Ship via `/ship` with the standard review pipeline
- Record before/after token counts in CHANGELOG as a "For contributors" entry
