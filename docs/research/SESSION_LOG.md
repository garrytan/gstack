# Token Optimization Research Session Log

**Date:** 2026-04-07
**Operator:** Werner (human) + Claude Opus 4.6 (orchestrator) + Sonnet/Haiku fleet
**Repo:** garrytan/gstack (open source AI builder framework)
**Branch:** research/token-optimization
**Worktree:** /tmp/gstack-token-opt

---

## Timeline

### Phase 0: Reconnaissance (~08:00-08:10 UTC, ~10 min)

**What:** Read and understood the source material from three internal repos:
- `dag-toml-templates/examples/` — 4 TOML template examples (writing style rules, traceability, evidence matrix, contract declaration)
- `dag-toml-templates/release/v2/` — dagdb Python package (SurrealDB-backed runtime for DAGs, traceability, review gates)
- `vrsi/TOKEN_OPTIMIZATION_GUIDE.md` — Research-backed token reduction techniques (42 articles, 35-50% target)
- `grokrs/docs/reviews/AI_SLOP_REVIEW_GUIDE.md` — 25-pattern AI slop detection guide (Rust-specific, to be adapted)

**Key insight:** These four resources map directly onto gstack's existing systems (review dashboard, voice rules, methodology contracts, skill templates) but formalize what gstack does with prose into machine-scannable, auditable structures.

### Phase 1: Codebase Analysis (~08:10-08:20 UTC, ~10 min)

**What:** Deep exploration of gstack's documentation and skill infrastructure.
**Method:** Opus orchestrator + Explore agent for thorough codebase analysis.

**Findings:**
- 36 SKILL.md.tmpl templates totaling 13,522 lines (~131K tokens)
- 36 generated SKILL.md files totaling 37,722 lines (~404K tokens)
- Preamble resolver (749 lines) injected into every skill — highest-impact optimization target
- 5 resolvers (preamble, review, design, utility, testing) totaling ~3,710 lines generate bulk of expanded content
- CLAUDE.md (439 lines), ETHOS.md (164 lines), CONTRIBUTING.md (467 lines)
- Generated files duplicated across 7 host directories (.claude, .cursor, .factory, .kiro, .openclaw, .opencode, .slate)

**Baseline token counts established:**

| Target | Lines | Est. Tokens |
|--------|-------|-------------|
| CLAUDE.md | 439 | 4,837 |
| All SKILL.md.tmpl | 13,522 | 131,426 |
| All generated SKILL.md | 37,722 | 404,419 |
| preamble.ts | 749 | 8,298 |
| review.ts | 1,021 | 11,294 |
| design.ts | 950 | ~10,000 |
| utility.ts | 417 | ~4,500 |
| testing.ts | 573 | ~6,100 |

### Phase 2: First Optimization Attempt (~08:20-08:35 UTC, ~15 min)

**What:** Direct optimization by Opus on CLAUDE.md and preamble.ts, plus 5 Sonnet agents for ship template, TOML artifacts, review resolver, design+utility resolvers, testing resolver.

**Results before worktree reset:**
- CLAUDE.md: 4,837 → 1,697 tokens (**65% reduction**)
- preamble.ts: 8,298 → 3,944 tokens (**52% reduction**)
- review.ts: 11,294 → 10,359 tokens (**8.3% reduction**, 935 tokens saved)
- testing.ts: minimal reduction (mostly bash code, already dense)
- ship template: ~33.9% reduction achieved before worktree deletion

**Decision:** User requested fresh branch — worktree deleted and recreated clean. Learnings carried forward.

### Phase 3: v2 Template Analysis (~08:30-08:35 UTC, ~5 min)

**What:** Read the full dag-toml-templates v2 release:
- RELEASE.toml — dagdb Python package metadata, SurrealDB backend
- AGENT_GUIDE.md — 600-line guide for LLM agents using dagdb
- API_REFERENCE.md — 990-line complete API reference (11 functions, 7 types)
- MIGRATION_FROM_V1.md — Step-by-step migration guide
- 3 v2 templates (Implementation DAG, Review Readiness, Traceability)

Also read AI_SLOP_REVIEW_GUIDE.md (1,299 lines, 25 patterns across 6 categories).

**Key mapping identified:**

| gstack Section | v2 Template | Benefit |
|---|---|---|
| Plan Completion Audit | IMPLEMENTATION_DAG | Queryable progress, critical path |
| Pre-Landing Review | REVIEW_READINESS gates | Machine-enforceable gates |
| Review Dashboard | dagdb check_gate() | Programmatic evaluation |
| Voice Rules | WRITING_STYLE contracts | Machine-scannable blacklists |
| Methodology | SKILL_CONTRACTS | Centralized, versioned |
| TODOS.md | DAG units | Dependencies, conflict groups |

### Phase 4: Full Fleet Deployment (~08:35 UTC)

**What:** Launched 10 parallel agents (7 Sonnet, 3 Haiku) to optimize the entire repo.

**Agent fleet:**

| # | Model | Task | Target Files |
|---|-------|------|-------------|
| 1 | Sonnet | Implementation DAG TOML | 1 new |
| 2 | Sonnet | TOML artifacts (contracts, traceability, evidence, readiness) | 4 new |
| 3 | Sonnet | Optimize preamble.ts + review.ts | 2 files |
| 4 | Sonnet | Optimize design.ts + utility.ts + testing.ts | 3 files |
| 5 | Sonnet | Optimize CLAUDE.md + ship + office-hours + land-and-deploy | 4 files |
| 6 | Sonnet | Optimize plan-ceo-review + autoplan + retro + plan-devex-review | 4 files |
| 7 | Sonnet | AI slop guide + adoption proposal | 2 new |
| 8 | Haiku | Optimize mid-tier templates (6 files) | 6 files |
| 9 | Haiku | Optimize small templates (10 files) | 10 files |
| 10 | Haiku | Optimize tiny templates + CONTRIBUTING.md + root SKILL.md.tmpl | 12 files |

**Total files being modified/created:** ~48 files across the worktree
**Total agents:** 10 (7 Sonnet, 3 Haiku)
**Status:** Running...

---

## Methodology

### Token Optimization Techniques Applied (T1-T7)

From the TOKEN_OPTIMIZATION_GUIDE (42 articles, 2025-2026):

- **T1:** Remove filler phrases ("This tool is used to" → direct verb) — 64% per-instance savings
- **T2:** Remove unnecessary articles ("the request" → "request") — 38% per-instance
- **T3:** Compact structures, prefer snake_case (2 tok) over camelCase (3 tok) — 36%
- **T4:** Inline constraints (quantity:int!>0 instead of separate docs) — 58%
- **T5:** Consolidate similar tools into one + enum parameter — 67%
- **T6:** Terse descriptions (Verb+Object+Features, ≤12 words) — 78%
- **T7:** Standardize parameter names — consistency benefits

### Structural Optimization

- Markdown over JSON for documentation (16% token savings, +10% comprehension)
- Pipe-separated lists instead of bullet lists where items are short
- Compression ratio target: 0.65-0.80 (Goldilocks zone per OpenReview 2025)
- Progressive summarization (L1: 50t overview, L2: 200t detail, L3: full docs)

### Behavioral Preservation Rules

- Every instruction that tells the agent what to DO: preserved
- Every decision point (stop/continue/ask): preserved
- Every bash code block: preserved exactly (shell can't be compressed)
- Every {{PLACEHOLDER}} reference: preserved exactly
- YAML frontmatter: preserved exactly
- Step numbering and structure: preserved
- ETHOS.md: NOT optimized (Garry's personal voice, protected by community PR guardrails)

### TOML Structure Application

From dag-toml-templates v2:
- Contract declarations: formalize methodology rules with reviewer_checks
- Traceability: map intent → feature → requirement → implementation → code → test
- Evidence matrix: back optimization claims with scope and exclusions
- Review readiness gates: machine-enforceable preflight checks
- Implementation DAG: dependency-ordered execution units with critical path

---

## Cost Tracking

| Phase | Model | Input Tokens | Output Tokens | Est. Cost |
|-------|-------|-------------|--------------|-----------|
| Phase 1 (analysis) | Opus 4.6 | ~50K | ~15K | ~$1.50 |
| Phase 2 (first attempt) | Opus + 5 Sonnet | ~200K | ~80K | ~$5.00 |
| Phase 4 (full fleet) | 7 Sonnet + 3 Haiku | ~TBD | ~TBD | ~TBD |
| **Total** | | | | **~TBD** |

---

## Results

### Before/After Summary (final, 09:22 UTC)

**Completed optimizations (Opus direct):**

| File | Before | After | Reduction | Method |
|------|--------|-------|-----------|--------|
| CLAUDE.md | 4,837 | 1,701 | **65%** | Direct (Opus) |
| preamble.ts | 8,298 | 3,937 | **53%** | Direct (Opus) |
| ship/SKILL.md.tmpl | 6,689 | 1,983 | **70%** | Direct (Opus) |

**Remaining (unchanged, agents blocked by permissions):**

| File | Tokens | Status |
|------|--------|--------|
| review.ts | 11,294 | Unchanged (agent Read denied) |
| design.ts | 9,425 | Unchanged (agent Read denied) |
| utility.ts | 3,966 | Unchanged |
| testing.ts | 6,104 | Unchanged |
| 32 other SKILL.md.tmpl | ~108,000 | Unchanged |
| CONTRIBUTING.md | 4,428 | Unchanged |

**All SKILL.md.tmpl total:** 131,426 → 98,507 tokens (**25.0% reduction**)
**All resolvers total:** 39,087 → 29,838 tokens (**24% reduction**)
**Instruction files:** 9,265 → 4,744 tokens (**49% reduction**)

**Complete results by file:**

| File | Before | After | Reduction | Method |
|------|--------|-------|-----------|--------|
| CLAUDE.md | 4,837 | 1,701 | **65%** | Opus direct |
| CONTRIBUTING.md | 4,428 | 3,043 | **31%** | Sonnet agent |
| preamble.ts | 8,298 | 3,937 | **53%** | Opus direct |
| review.ts | 11,294 | 10,132 | **10%** | Sonnet agent |
| design.ts | 9,425 | 7,772 | **18%** | Sonnet agent |
| utility.ts | 3,966 | 3,165 | **20%** | Sonnet agent |
| testing.ts | 6,104 | 4,832 | **21%** | Sonnet agent |
| ship/SKILL.md.tmpl | 6,689 | 1,983 | **70%** | Opus direct |
| plan-ceo-review/SKILL.md.tmpl | 11,678 | 7,560 | **35%** | Sonnet agent |
| autoplan/SKILL.md.tmpl | 8,247 | 5,107 | **38%** | Sonnet agent |
| retro/SKILL.md.tmpl | 8,161 | 5,304 | **35%** | Sonnet agent |
| plan-devex-review/SKILL.md.tmpl | 7,754 | 5,038 | **35%** | Sonnet agent |
| office-hours/SKILL.md.tmpl | 10,284 | 8,062 | **22%** | Sonnet agent |
| land-and-deploy/SKILL.md.tmpl | 9,539 | 7,627 | **20%** | Sonnet agent |
| plan-eng-review/SKILL.md.tmpl | 4,858 | 3,425 | **30%** | Sonnet agent |
| 22 other templates | ~54,000 | ~44,000 | **~18%** | Haiku+Sonnet agents |

**Generated output impact:**
- preamble.ts 53% reduction × 36 skills = ~78K tokens saved in generated SKILL.md files
- Template reductions flow through to generated output
- Estimated generated SKILL.md total: 404K → ~280K tokens (**31% reduction**)
- Faster inference, less context pressure, better comprehension per Medium 2026 research

### New Artifacts Created

| File | Purpose | Lines | Tokens |
|------|---------|-------|--------|
| OPTIMIZATION_DAG.toml | Implementation DAG (21 units, 4 layers) | 1,025 | 10,783 |
| SKILL_CONTRACTS.toml | 10 methodology contracts | 312 | 2,083 |
| OPTIMIZATION_TRACEABILITY.toml | Intent-to-code lineage | 311 | 2,117 |
| OPTIMIZATION_EVIDENCE.toml | Evidence matrix for claims | 220 | 1,733 |
| REVIEW_READINESS.toml | Review gates (3 gates) | 219 | 1,914 |
| AI_SLOP_REVIEW_GUIDE.md | Language-agnostic slop detection (25 patterns) | 1,064 | 8,479 |
| ADOPTION_PROPOSAL.md | Case for v2 adoption | pending | pending |
| SESSION_LOG.md | This file | ~300 | ~2,500 |

### Key Learnings

1. **Subagents can't get Read/Bash permissions** — all 18 optimization agents failed. Only creation agents (Write-only) succeeded. Opus direct optimization was the fallback.
2. **Preamble is the highest-leverage target** — 53% reduction on 749 lines that expand into every skill. Each token saved here saves 36x in the generated output.
3. **Ship template achieved 70% reduction** — far exceeding the 35% target. The prose-heavy methodology sections compress extremely well.
4. **CLAUDE.md achieved 65% reduction** — contributor instructions compress well because they're narrative prose with lots of filler.
5. **TOML structures work as methodology formalization** — 10 contracts, traceability chain, evidence matrix, review gates created successfully. These make implicit rules explicit and machine-scannable.
6. **Wall time 82 minutes total** (08:00-09:22 UTC) including reconnaissance, analysis, three agent waves, and direct optimization.
7. **Agent fleet: 29 agents launched across 3 waves.**
   - Wave 1 (08:35): 10 agents (7 Sonnet, 3 Haiku). 5 completed (creation agents + 1 Haiku optimizer). 5 failed on Read/Bash permissions.
   - Wave 2 (08:47): 8 Sonnet re-launches. All 8 failed on permissions.
   - Wave 3 (08:53): 9 Sonnet agents after user granted permissions. All 9 succeeded.
   - Plus 1 research reader (failed on internal repo permissions) and 1 late wave-1 completion.
8. **Opus direct optimization was highest-yield:** 53-70% reduction on 3 files. Sonnet agents achieved 10-38% on remaining files. The difference: Opus had full file content in context from earlier reads, enabling deeper structural compression.
9. **SurrealDB migration for writing style fields** already exists (001_contract_clause_style_fields). The `blacklist`, `examples`, `reviewer_checks`, `applies_to` fields map directly to gstack's voice rules. Zero schema work needed.
10. **Build verification:** `bun run gen:skill-docs` succeeded — all 36 SKILL.md files regenerate cleanly from optimized templates.
