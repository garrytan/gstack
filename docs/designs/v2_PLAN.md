# gstack v2 — the lightest opinionated skill pack

## Context

gstack has an externally documented reputation for being "fat." Third-party reviews (dev.to, May 2026) explicitly say gstack "can feel bloated when all roles are turned on... potentially consuming 10K+ tokens before any real code is written, and daily usage burns through tokens fast... making even straightforward tasks feel sluggish and redundant." Anthropic's own canonical Skills guidance prescribes the "progressive disclosure" pattern (`SKILL.md` skeleton + `references/` loaded on demand) — gstack diverges from this.

The numbers back the criticism:

- 31 skills, 2.1MB total generated SKILL.md corpus
- 28 of 31 skills exceed the 40KB soft ceiling (~10K tokens each)
- ship.md is 164KB (~41K tokens); ship.md.tmpl is only 48KB — **115KB is resolver-injected**, the highest-leverage compression target
- Catalog in always-loaded system prompt: 50+ skills × multi-paragraph descriptions, voice triggers, proactive-suggest paragraphs

This plan ships gstack v2 in two coordinated releases: v1.45.0.0 lands the foundation + low-risk wins, then v2.0.0.0 ships the architectural break + marketing-grade repositioning 2-4 weeks later. The split came out of cross-model review: Codex argued v2 looks like posturing without real breakage; the hybrid shape gives the genuinely-breaking sections/ pattern the major bump it earns, while letting the risk-free wins ship immediately.

## Release shape

```
v1.45.0.0 (Foundation Release)          v2.0.0.0 (gstack v2 Launch)
─────────────────────────────           ─────────────────────────────
~1-2 weeks of CC work                   2-4 weeks later, coordinated
                                        
Phase 0: Eval coverage matrix           Phase B: sections/ pattern
  gate + periodic for all 31 skills       on 5 heavyweights
                                          (ship, plan-ceo, office-hours,
Phase A: Build-time compression           plan-eng, plan-design)
  conditional resolver injection
  jargon dedup                          Phase C: Eval annotations
  terse-mode actually compresses          + CI orphan check (WARN→FAIL)
                                        
Catalog trim (Codex high-leverage win)  Lighter-touch migration
  one-line skill descriptions             release note + auto-regenerate
  drop voice triggers/proactive blocks    on /gstack-upgrade
                                        
Hard token budgets defined              Marketing-grade CHANGELOG
  enforced via budget-regression          v1 vs v2 numbers table
                                          README v2 banner
Normal release voice                      "lightest opinionated skill pack"
```

## Premise check (Step 0A findings)

1. **Is this the right problem?** YES — externally validated. The bloat criticism is quotable and represents real user pain (token cost, sluggish sessions). Doing nothing means losing users to Cursor/Codex for their "lighter touch" reputation.
2. **Doing nothing:** the criticism compounds. Recent releases (v1.38 → v1.44) all added features; no release has gone the other direction. Without an explicit reversal, the reputation calcifies.
3. **Risk of acting:** the lazy-section pattern introduces silent-behavior-loss as a new failure class. Mitigated by the eval-first foundation + mechanical enforcement + canary rollout (see Phase B integrity section).

## What already exists (reuse-first audit)

| Asset | Reuse |
|---|---|
| `scripts/gen-skill-docs.ts` lines 439-450 | Already does string substitution and per-host suppression; extend with `appliesTo` resolver gate (~15 LOC) |
| `scripts/resolvers/types.ts` | Add `ResolverEntry` union type |
| `scripts/resolvers/preamble.ts` | Already does tier-gated composition (1-4); add per-resolver gating |
| `scripts/jargon-list.json` | Already a single file; just stop inlining it 37× |
| `test/skill-e2e-budget-regression.test.ts` (existing gate-tier) | Extend with per-skill hard budgets |
| Real-PTY harness from v1.13.2.0 | Reuse for behavioral-contract evals (~$0.50/eval) |
| SDK harness | Reuse for cheap shape evals (~$0/eval where possible) |
| `gstack-upgrade/migrations/` | Pattern exists for state-format migrations; reuse for v2 auto-regenerate |
| `~/.gstack/analytics/skill-usage.jsonl` | Already collected; powers deferred `gstack budget` CLI |

We are catching up to Anthropic's canonical Skills pattern, not inventing one.

## Dream state delta

```
TODAY                              v1.45.0.0                         v2.0.0.0
──────                             ─────────                         ────────
2.1MB corpus                       ~1.3MB corpus (-40%)              ~700KB corpus (-67%)
ship.md: 164KB                     ship.md: ~80KB (-50%)             ship.md: ~15KB skeleton
                                                                     + 5×~5KB sections
28/31 over 40KB ceiling            ~10/31 over ceiling                ~3/31 over ceiling
                                                                     (cso, document-release,
                                                                      design-consultation
                                                                      kept as monoliths)
Catalog: multi-paragraph           Catalog: one-line per skill        Catalog: one-line per skill
descriptions, voice triggers       (~70% catalog cut)                 (same)
No eval coverage matrix            Every skill: ≥1 gate eval          Section-level eval
                                   + ≥1 periodic eval                 annotations + CI orphan check
"Fat" reputation in third-party    "Compressed, eval-protected"       "Lightest opinionated skill
reviews                            internally measured                pack" externally measured
```

## Phase 0 — Eval coverage matrix (v1.45.0.0)

**Goal:** every skill in gstack ships with at least one gate-tier eval AND one periodic-tier eval that asserts a must-have behavior. The eval suite becomes the design spec. This is the load-bearing claim of the plan — must come first.

**Cross-model tension noted:** Codex argued this is a procrastination trap and shape-asserts are shallow. User explicitly chose full tiered coverage anyway (D9 = A), with rationale: "the eval suite IS the design spec; that commitment is the load-bearing claim of the whole plan." We accept the larger upfront investment.

**Mitigation of Codex's "shape vs quality" critique:** for orchestration/judgment skills (plan-ceo, office-hours, autoplan), the must-have isn't deterministic output — it's structural compliance (does it call AskUserQuestion in the right shape? does it follow the section order? does it persist artifacts?). Eval design must capture structural contracts, not output content. Where structural eval is impossible, that section is explicitly noted as "judgment-dependent, not eval-protected" — Codex's #2 critique is honored by NOT then stripping unprotected judgment prose.

**Skills currently lacking dedicated E2E coverage** (eval-writing target):

| Skill | Gate eval (target) | Periodic eval (target) | Est. cost/run |
|---|---|---|---|
| qa-only | report-only flag triggers | full QA flow with fix-loop disabled | $0.30 / $1.50 |
| retro | weekly aggregate runs without error | full retro produces ranked output | $0.20 / $2.00 |
| document-release | reads CHANGELOG, produces Diataxis map | full post-ship doc update | $0.30 / $1.80 |
| document-generate | generates 4 doc types from prompt | E2E generation passes quality bar | $0.30 / $2.00 |
| context-save | persists state to expected path | round-trip restore preserves context | $0.10 / $0.50 |
| context-restore | reads latest save, applies to session | cross-workspace restore works | $0.10 / $0.50 |
| gstack-upgrade | detects install type, runs upgrade | full upgrade + migration round-trip | $0.20 / $1.00 |
| sync-gbrain | refreshes index without error | full sync produces searchable corpus | $0.20 / $1.50 |
| setup-gbrain | path 1-4 detection works | end-to-end setup for each path | $0.20 / $2.00 |
| setup-browser-cookies | picker UI loads without error | cookie import round-trip | $0.20 / $1.00 |
| setup-deploy | detects config, writes expected files | full deploy config setup | $0.20 / $1.00 |
| design-consultation | DESIGN.md template renders | full design system generation | $0.30 / $2.50 |
| design-shotgun | variants generated and saved | full multi-variant exploration | $0.30 / $2.00 |
| open-gstack-browser | launches browser without error | sidebar attaches and shows activity | $0.20 / $0.80 |
| pair-agent | setup key generated, instructions printed | full pair flow with second agent | $0.20 / $1.50 |
| land-and-deploy | merge gates check correctly | full merge → deploy → canary | $0.30 / $3.00 |
| canary | post-deploy loop runs, exits cleanly | full canary cycle with alert simulation | $0.20 / $1.50 |
| benchmark | runs and produces score | full regression detection | $0.20 / $2.00 |
| plan-devex-review | mode routing works | full DX review with scoring | $0.40 / $3.00 |
| devex-review | live DX audit produces scorecard | E2E DX measurement vs plan baseline | $0.40 / $2.50 |

Estimated added CI cost: **~$5/run gate, ~$30/run periodic.** Combined with existing E2E suite (~$15/gate, ~$30/periodic), total: ~$20/gate (every PR), ~$60/periodic (weekly). Acceptable.

**Eval matrix lives at:** `test/helpers/skill-coverage-matrix.ts` — a single source of truth mapping each skill to its gate + periodic eval test files. CI check in `test/skill-coverage-matrix.test.ts` fails the build if any skill is missing an entry.

**Critical files to add:**
- `test/skill-coverage-matrix.ts` — registry mapping skill → eval paths
- `test/skill-e2e-*.test.ts` — 20 new test files (gate-tier subset starts in gate config, periodic-tier subset in periodic config)
- `test/helpers/touchfiles.ts` — register new tests for diff-based selection

## Phase A — Build-time compression (v1.45.0.0)

**A.1 Conditional resolver injection** — extend `scripts/gen-skill-docs.ts` and `scripts/resolvers/`:

```ts
// scripts/resolvers/types.ts
export type ResolverFn = (ctx: TemplateContext, args?: string[]) => string;
export type ResolverEntry = ResolverFn | {
  resolve: ResolverFn;
  appliesTo?: (ctx: TemplateContext) => boolean;
};
```

```ts
// scripts/resolvers/index.ts — gate the heavy ones
QUESTION_TUNING: {
  resolve: generateQuestionTuning,
  appliesTo: (ctx) => ['plan-ceo-review','plan-eng-review','office-hours'].includes(ctx.skillName),
},
REVIEW_ARMY: {
  resolve: generateReviewArmy,
  appliesTo: (ctx) => ['ship','review'].includes(ctx.skillName),
},
REVIEW_DASHBOARD: {
  resolve: generateReviewDashboard,
  appliesTo: (ctx) => ['ship','plan-ceo-review','plan-eng-review','plan-design-review','plan-devex-review','devex-review'].includes(ctx.skillName),
},
// ... audit all 21 resolvers, gate per actual usage
```

```ts
// scripts/gen-skill-docs.ts (~line 444) — check the gate
const entry = RESOLVERS[resolverName];
const resolver = typeof entry === 'function' ? entry : entry.resolve;
const gate = typeof entry === 'function' ? undefined : entry.appliesTo;
if (gate && !gate(ctx)) return '';
return args.length > 0 ? resolver(ctx, args) : resolver(ctx);
```

**A.2 Jargon-list dedup** — currently `scripts/resolvers/preamble/generate-writing-style.ts` inlines the full 1.8KB jargon glossary into 37 skills. Replace inline with a reference: "For the canonical jargon list, Read `~/.claude/skills/gstack/scripts/jargon-list.json` on first use." Saves ~66KB total corpus.

**A.3 Terse-mode actually compresses** — read `~/.gstack/config.yaml` once in `gen-skill-docs.ts`, pass `explainLevel` into `TemplateContext`, and have `generate-writing-style.ts` / `generate-completeness.ts` / `generate-confusion-protocol.ts` / `generate-context-health.ts` return `''` when terse. Today the bytes ship regardless of config — the flag only changes runtime model behavior. Add `--explain-level=terse` build flag for benchmarking.

**A.4 Catalog trim** (moved up per Codex #6) — shorten skill descriptions in the always-loaded system prompt to one line per skill. Voice triggers move from catalog descriptions into in-skill content. Proactive-suggest paragraphs move to a separate `~/.claude/skills/gstack/scripts/proactive-suggestions.json` loaded only when the agent needs routing guidance. Per-skill description format:

```
- <skill-name>: <one-line outcome description, ≤80 chars> (gstack)
```

Estimated catalog cut: ~70% (largest single always-loaded reduction).

**A.5 cso/ targeted compression** (Codex #9) — cso gets resolver dedup + catalog trim. Security guidance prose stays uncompressed monolithically until Phase B audit shows specific sections can safely move to sections/ with eval coverage. Not "exempt" — just sequenced last.

**A.6 Hard token budgets** (Codex #10) — define and enforce in `test/skill-e2e-budget-regression.test.ts`:

| Budget | v1.44 actual | v1.45 target | v2.0 target |
|---|---|---|---|
| Max system-prompt catalog tokens | ~25K | ~8K | ~6K |
| Max per-skill SKILL.md size | 164KB (ship) | 100KB | 30KB (heavyweights) |
| Max corpus total | 2.1MB | 1.3MB | 700KB |
| Max first-invocation latency (heavyweight) | ~immediate | ~immediate | <500ms section reads |

CI fails if any budget exceeded. Tracked over time via existing budget-regression jsonl.

## Phase B — sections/ pattern for heavyweights (v2.0.0.0)

Convert 5 heavyweights to Anthropic-canon skeleton + `sections/*.md`:

```
ship/
├── SKILL.md              # 12-15KB decision-tree skeleton + section manifest
├── SKILL.md.tmpl         # source for the skeleton
├── sections/
│   ├── manifest.json     # NEW: structured section registry (Codex #3 mitigation)
│   ├── version-bump.md
│   ├── changelog.md
│   ├── review-army.md
│   ├── todos-cleanup.md
│   ├── pr-body.md
│   └── ...
```

**Silent-behavior-loss mitigations** (Codex #3) — layered defense, not just self-check:

1. **Section manifest** (`sections/manifest.json`) — structured registry: `{section_file, applies_when, required_for}`. Decision-tree skeleton references entries by ID, not free-form prose.
2. **Imperative skeleton phrasing** — "STOP. Read `sections/version-bump.md` before computing the bump." Not "see ... for details."
3. **Top-of-file section index table** — situation → section file mapping.
4. **End-of-skill self-check** — "Confirm you Read every section your decision tree pointed to. List them." (weakest layer, kept as fallback.)
5. **Eval harness `requiredReads` declaration** — E2E test asserts which sections must appear in transcript Read calls for a given fixture. Mechanical enforcement at the test layer, not just prompt layer.
6. **Transcript inspection in canary cohort** — first week post-ship, log which sections actually get read by real sessions; alert on Read-miss for marked-required sections.

**Conversion order** (one at a time, validate each before next):
1. `ship/` — most invocations, biggest cost, riskiest. Land alone, observe 1 week.
2. `plan-ceo-review/` — conversational; risk of breaking flow. Land second, observe carefully.
3. `office-hours/` — most conversational. Land third only if 1+2 went clean.
4. `plan-eng-review/` and `plan-design-review/` — bundle, similar shape.

**Do not convert** unless explicitly approved later: `autoplan` (orchestrator that already chains skills), `design-review` (UI flow already tight), `qa` (single-purpose), `investigate` (single-purpose).

## Phase C — Eval annotations + CI orphan check (v2.0.0.0)

Per Codex #4 — warn-before-fail progression, not immediate strict gate.

```md
<!-- eval: test/skill-e2e-ship-version-bump.test.ts -->
<!-- coverage: asserts the queue-aware bump picks the next available version when the claimed version is taken -->
```

Annotations include **coverage semantics** (what behavior is protected) per Codex #5, not just paths. Path-only would be false confidence.

CI check in `gen-skill-docs.ts` walker:
- v2.0.0.0 ships in WARN mode — orphans logged to PR summary but build passes
- v2.1.0.0 (or 2 release cycles after v2.0): WARN escalates to FAIL
- Waiver: `<!-- eval: none — accept loss, reviewed YYYY-MM-DD by @user -->`

This avoids "maintenance theater" of mandatory annotations with no semantics, and gives users a transition window.

## Migration approach (v2.0.0.0, lighter touch per D11)

- Release note in v2.0.0.0 CHANGELOG explains the sections/ format change and concrete user impact: forks/copy-pasted SKILL.md files need re-fetch; first-invocation of heavyweight skills has ~200-500ms section-read latency added.
- `/gstack-upgrade` auto-regenerates on next invocation. No interactive migration prompts.
- Vendored installs get a single one-line warning at session start on first v2 contact (re-use existing vendored-install warning pattern in skill preamble).
- `gstack-upgrade --explain-v2` flag for users who want the full explanation on demand.

## Forks / customization compatibility (Codex #11)

Documented in v2.0.0.0 release note:

- Anyone who reads/copies/edits a heavyweight SKILL.md file directly: the file is now a skeleton; behavior lives in `sections/*.md`. They need to either treat the skill as a black box (recommended) or fork the full `skill/` directory including `sections/`.
- Anyone with local SKILL.md.tmpl edits in a fork: the templates are smaller; conflicts likely on regenerate. Fork docs updated with migration guidance.
- Anyone with docs/blog posts linking to specific lines of a generated SKILL.md: line numbers will shift; recommend linking to template + section name instead.

## Rollout strategy (Codex #12)

v1.45.0.0:
- Land in one PR; existing budget-regression test catches any per-skill size regression; eval matrix CI check catches any skill missing its evals.
- Dogfood: 1 week active use across all of Garry's workspaces before announcing.

v2.0.0.0:
- **Canary cohort**: ship to dogfood users (Garry + active agents) first via a v2.0.0-rc.1 tag. Real-PTY harness logs section Reads for top 5 workflows (`/ship`, `/qa`, `/review`, `/plan-ceo-review`, `/autoplan`); alert on Read-miss for required sections.
- **Manual verification**: top 5 workflows manually run before tagging v2.0.0.0 final, with before/after transcripts saved as eval baselines.
- **Regression dashboard**: existing `bun run eval:summary` extended with v1 vs v2 per-skill token + behavioral compliance comparison.
- **Rollback**: revert PR + `bun run gen:skill-docs` regenerates old shape. Documented in CONTRIBUTING.md.

## Review-section findings (Sections 1-11, condensed)

| Section | Findings | Status |
|---|---|---|
| 1. Architecture | Lazy-section silent-loss risk; mitigated via 6-layer defense above | Findings addressed in plan |
| 2. Errors/Rescues | gen-skill-docs gate-fail loud; missing sections fall back to skeleton; CI orphan check loud | Findings addressed |
| 3. Security | cso targeted dedup not blanket exemption (Codex #9); migration script runs at user-shell trust boundary, same as existing migrations | Findings addressed |
| 4. Data/UX edge cases | v1→v2 muscle-memory break warned in release note; vendored installs get one-line warning; concurrent dev-symlink sessions risk is existing CLAUDE.md caveat | Findings addressed |
| 5. Code quality | ~150 LOC additive across gen-skill-docs/types/index; ~20 new eval test files; sections/ extraction is mechanical | OK |
| 6. Tests | Phase 0 IS the test plan. Coverage matrix CI gate enforces every skill has its evals | Findings addressed |
| 7. Performance | Build time <2× current; runtime adds 200-500ms first-invocation for sectioned heavyweights; catalog trim reduces always-loaded prompt size on every session | Documented |
| 8. Observability | budget-regression test already exists; canary cohort transcript logging in Phase B; migration outcome logged to ~/.gstack/analytics/migrations.jsonl | Findings addressed |
| 9. Deployment | Two-release split + warn-before-fail eval annotations + rollback via revert | Findings addressed |
| 10. Long-term trajectory | Reversibility 3/5; sections/ pattern becomes template for future skills; deferred TODOs extend v2 narrative for v2.1+ | OK |
| 11. Design/UX | README v2 banner + CHANGELOG numbers table land in v2.0.0.0; concrete numbers, gstack voice, no AI slop | OK |

## NOT in scope

- **Skill removals.** User said "keep all functions." qa-only, design-shotgun, pair-agent, open-gstack-browser all stay. They get evals + catalog trim like everyone else.
- **Skill renames.** No `qa` → `qa-fix` collapses. Keep CLI surface stable.
- **gstack lite/pro install profiles.** Deferred to TODOS for post-v2.
- **gstack budget CLI.** Deferred to TODOS for post-v2.
- **Per-skill eval coverage badge in README.** Deferred to TODOS.
- **Cross-tool portability test/demo (Codex/Cursor compat).** Deferred to TODOS.
- **Token-cost preview on invocation.** Deferred to TODOS.
- **Skill autoload telemetry.** Deferred to TODOS.
- **gstack diff PR comment.** Deferred to TODOS.

## TODOS.md updates (deferred items, recommend bulk-add post-merge)

| TODO | Priority | Effort (human / CC) | Depends on |
|---|---|---|---|
| `gstack lite` install profile (5-skill core) | P2 | 2 days / 3-4 hrs | v2.0.0.0 |
| `gstack pro` opt-in upgrade path | P2 | 1 day / 1 hr | gstack lite |
| `gstack budget` CLI (per-skill token usage telemetry) | P2 | 1 day / 1 hr | v1.45.0.0 |
| Per-skill eval coverage badge in `gstack-skills list` + README | P3 | 1 day / 1 hr | Phase 0 |
| Cross-tool portability test/demo (Codex CLI, Cursor) | P3 | 2 days / 2 hrs | v2.0.0.0 |
| Token-cost preview on skill invocation | P3 | 1 day / 1 hr | gstack budget CLI |
| Skill autoload telemetry (dead-weight detection) | P3 | 2 days / 2 hrs | v1.45.0.0 |
| `gstack diff` PR comment (per-PR budget delta) | P3 | 1 day / 1 hr | budget-regression extended |
| Section-level eval annotations visible to user (confidence signal) | P3 | half day / 30 min | Phase C |

## Critical files

| Path | Change | Phase |
|---|---|---|
| `scripts/gen-skill-docs.ts` | Add resolver gate check (~line 444); read explain_level from config; add CI orphan walker | A, C |
| `scripts/resolvers/types.ts` | Add `ResolverEntry` union type | A |
| `scripts/resolvers/index.ts` | Wrap heavy resolvers with `appliesTo` predicates (audit all 21) | A |
| `scripts/resolvers/preamble/generate-writing-style.ts` | Replace inline jargon; return `''` on terse | A |
| `scripts/resolvers/preamble/generate-completeness.ts` | Return `''` on terse | A |
| `scripts/resolvers/preamble/generate-confusion-protocol.ts` | Return `''` on terse | A |
| `scripts/resolvers/preamble/generate-context-health.ts` | Return `''` on terse | A |
| `scripts/skill-catalog.ts` (new or in gen-skill-docs) | One-line catalog generator + voice-triggers JSON splitter | A.4 |
| `scripts/proactive-suggestions.json` (new) | Voice triggers + proactive suggestions, loaded on demand | A.4 |
| `test/skill-coverage-matrix.ts` (new) | Single-source-of-truth eval registry | Phase 0 |
| `test/skill-coverage-matrix.test.ts` (new) | CI gate: every skill has entries | Phase 0 |
| `test/skill-e2e-*.test.ts` (~20 new files) | New evals for skills currently lacking coverage | Phase 0 |
| `test/skill-e2e-budget-regression.test.ts` | Extend with per-skill hard budgets | A.6 |
| `test/helpers/touchfiles.ts` | Register new tests for diff-based selection | Phase 0 |
| `ship/SKILL.md.tmpl` → `ship/sections/manifest.json` + `ship/sections/*.md` | Skeleton extraction | B |
| `plan-ceo-review/SKILL.md.tmpl` → sections/ | Skeleton extraction | B |
| `office-hours/SKILL.md.tmpl` → sections/ | Skeleton extraction | B |
| `plan-eng-review/SKILL.md.tmpl` → sections/ | Skeleton extraction | B |
| `plan-design-review/SKILL.md.tmpl` → sections/ | Skeleton extraction | B |
| `gstack-upgrade/migrations/v2.0.0.0.sh` (new) | Auto-regenerate + vendored-install warning | B |
| `CHANGELOG.md` | v1.45.0.0 entry (normal), v2.0.0.0 entry (marketing-grade w/ numbers table) | A, B |
| `README.md` | v2.0.0.0 banner; "lightest opinionated skill pack" positioning | B |
| `CONTRIBUTING.md` | Document sections/ pattern + rollback procedure | B |

## Verification

**v1.45.0.0:**
1. `bun run gen:skill-docs` succeeds with no errors
2. `bun test` passes (skill-validation, gen-skill-docs.test.ts, browse integration, NEW skill-coverage-matrix.test.ts)
3. `bun run test:evals` passes — all new gate evals green; no regression on existing evals
4. `bun run test:evals:periodic` passes — all new periodic evals green
5. Catalog system-prompt size measured: target ≤8K tokens (vs ~25K current). Capture before/after in PR body.
6. Total SKILL.md corpus byte count: target ≤1.3MB (vs 2.1MB). Capture in PR body.
7. Top 3 heaviest skills under 100KB.
8. Manual smoke: invoke `/ship`, `/plan-ceo-review`, `/office-hours` in fresh Claude Code sessions; confirm no missing behavior. Save transcripts as v1.45 baselines.

**v2.0.0.0:**
1. All v1.45 checks pass
2. Sectioned skills: total corpus ≤700KB; heavyweight skeletons ≤30KB each
3. `test/skill-e2e-ship-section-loading.test.ts` (new): asserts `/ship` Reads expected sections per decision tree
4. Canary cohort: 1 week dogfood at v2.0.0-rc.1 with transcript logging; zero Read-miss for marked-required sections
5. Top 5 workflows manually verified; transcripts compared against v1.45 baselines
6. Migration: `gstack-upgrade` on a v1.45 install successfully regenerates without prompts; vendored-install warning appears once
7. CHANGELOG numbers table matches measured reality
8. WARN-mode orphan check: PR summary shows orphan list; build passes

## Cross-model agreements baked in

Items from Codex's review accepted and integrated above:

- #4 Warn-before-fail eval annotations (Phase C)
- #5 Coverage semantics in annotation comments, not just paths
- #6 Catalog trim moved up to Phase A (was buried after sections/)
- #9 cso gets resolver dedup + catalog trim (not blanket exempt)
- #10 Hard token budgets defined + enforced (Phase A.6)
- #11 Forks/customization compatibility documented (Migration section)
- #12 Rollout strategy with canary cohort + manual top-5-workflows verification (Rollout section)

Items from Codex's review explicitly rejected by user (D9, D10):
- #1 Eval-first scope: user kept full tiered coverage. Mitigated by structural-eval guidance (not output-content) for orphan/judgment skills.
- #7 v2.0.0.0 vs v1.x: user chose HYBRID. v1.45 absorbs low-risk wins; v2.0.0.0 carries the genuinely-breaking sections/ change.

Item where user accepted Codex over original pick:
- #8 Migration approach: user moved from hard-cut (D7) to lighter touch (D11) once v1.45 absorbed the low-risk work.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific phase/finding above. T1-T8 land in v1.45.0.0; T9-T16 land in v2.0.0.0.

- [ ] **T1 (P1, human: ~3 days / CC: ~7 hours)** — Phase 0 / coverage matrix — write gate+periodic evals for all 20 skills lacking coverage
  - Surfaced by: Phase 0 section
  - Files: `test/skill-coverage-matrix.ts`, `test/skill-coverage-matrix.test.ts`, ~20 new `test/skill-e2e-*.test.ts`, `test/helpers/touchfiles.ts`
  - Verify: `bun test test/skill-coverage-matrix.test.ts` and `bun run test:evals` both pass with new evals
- [ ] **T2 (P1, human: ~1 day / CC: ~1 hour)** — A.1 conditional resolver injection — add `appliesTo` gate
  - Surfaced by: Phase A section, Codex #10 (measurement before architecture)
  - Files: `scripts/resolvers/types.ts`, `scripts/gen-skill-docs.ts:444`, `scripts/resolvers/index.ts`
  - Verify: `bun run gen:skill-docs` produces smaller SKILL.md files; `bun test` passes
- [ ] **T3 (P1, human: ~half day / CC: ~30 min)** — A.2 + A.3 jargon dedup + terse-mode gen-time compression
  - Surfaced by: Phase A section
  - Files: `scripts/resolvers/preamble/generate-writing-style.ts`, `generate-completeness.ts`, `generate-confusion-protocol.ts`, `generate-context-health.ts`
  - Verify: jargon-list no longer appears inlined in generated SKILL.md; `gstack-config set explain_level terse && bun run gen:skill-docs` produces shorter files
- [ ] **T4 (P1, human: ~1 day / CC: ~2 hours)** — A.4 catalog trim — one-line skill descriptions; voice triggers + proactive paragraphs moved to JSON
  - Surfaced by: Codex #6 (highest-leverage), Phase A.4
  - Files: `scripts/skill-catalog.ts` (new), `scripts/proactive-suggestions.json` (new), per-skill SKILL.md.tmpl frontmatter for one-line description field
  - Verify: catalog system-prompt size <8K tokens; voice-triggered invocation still works
- [ ] **T5 (P1, human: ~half day / CC: ~30 min)** — A.6 hard token budgets in budget-regression
  - Surfaced by: Codex #10
  - Files: `test/skill-e2e-budget-regression.test.ts`
  - Verify: budget-regression fails when artificially inflated test SKILL.md exceeds budget
- [ ] **T6 (P1, human: ~1 day / CC: ~1 hour)** — A.5 cso resolver dedup + catalog trim (NOT broader compression)
  - Surfaced by: Codex #9
  - Files: `cso/SKILL.md.tmpl` (no structural change, only resolver gate audit)
  - Verify: cso SKILL.md size drops 20-30%; cso E2E evals still pass
- [ ] **T7 (P1, human: ~1 day / CC: ~1 hour)** — Regenerate all SKILL.md atomically + measure
  - Surfaced by: Phase A
  - Files: all `*/SKILL.md` regenerated
  - Verify: PR body includes before/after corpus size, top 10 skill sizes, catalog size; budget-regression confirms targets met
- [ ] **T8 (P2, human: ~half day / CC: ~30 min)** — v1.45.0.0 CHANGELOG entry (normal voice; note that Phase 0 + Phase A landed)
  - Surfaced by: Release shape section
  - Files: `CHANGELOG.md`, `VERSION`
  - Verify: CHANGELOG lints clean; reverse-chrono order preserved; entry covers the diff

- [ ] **T9 (P1, human: ~2 days / CC: ~3 hours)** — Phase B.1 convert ship/ to skeleton + sections/
  - Surfaced by: Phase B section
  - Files: `ship/SKILL.md.tmpl` → skeleton; `ship/sections/manifest.json` + `ship/sections/*.md`
  - Verify: new `test/skill-e2e-ship-section-loading.test.ts` asserts expected Reads per decision tree; existing ship evals pass; ship.md skeleton <15KB
- [ ] **T10 (P1, human: ~1 day / CC: ~1 hour)** — Canary cohort for ship/ (1 week dogfood at v2.0.0-rc.1)
  - Surfaced by: Rollout strategy section, Codex #12
  - Files: `test/helpers/transcript-section-logger.ts` (new)
  - Verify: zero Read-miss on marked-required sections in dogfood transcripts
- [ ] **T11 (P1, human: ~2 days / CC: ~3 hours)** — Phase B.2 convert plan-ceo-review/ (after ship/ proven)
  - Surfaced by: Phase B section
  - Files: `plan-ceo-review/SKILL.md.tmpl` + `plan-ceo-review/sections/`
  - Verify: section-loading test green; plan-ceo evals pass
- [ ] **T12 (P2, human: ~3 days / CC: ~4 hours)** — Phase B.3 + B.4 convert office-hours/ + plan-eng-review/ + plan-design-review/
  - Surfaced by: Phase B section
  - Files: respective `SKILL.md.tmpl` + `sections/` directories
  - Verify: section-loading tests green; respective evals pass
- [ ] **T13 (P1, human: ~1 day / CC: ~1 hour)** — Phase C eval annotations + WARN-mode CI orphan check
  - Surfaced by: Phase C section, Codex #4 + #5
  - Files: `scripts/gen-skill-docs.ts` (orphan walker), all `sections/*.md` (annotations with coverage semantics)
  - Verify: orphan check reports correctly in PR summary; build still passes in WARN mode
- [ ] **T14 (P1, human: ~half day / CC: ~30 min)** — `gstack-upgrade/migrations/v2.0.0.0.sh` lighter-touch auto-regenerate
  - Surfaced by: Migration approach section
  - Files: `gstack-upgrade/migrations/v2.0.0.0.sh`
  - Verify: upgrade from v1.45 install produces clean v2 state without prompts; vendored install gets one-line warning
- [ ] **T15 (P1, human: ~half day / CC: ~1 hour)** — v2.0.0.0 marketing-grade CHANGELOG with v1 vs v2 numbers table
  - Surfaced by: D5, Release shape, Codex #7 (real breakage documented)
  - Files: `CHANGELOG.md`, `VERSION`, `README.md` (v2 banner)
  - Verify: numbers table matches measured corpus; release note documents concrete breakage (sections/ format change, first-invocation latency, vendored-install deprecation); positioning past-tenses bloat reputation
- [ ] **T16 (P2, human: ~1 day / CC: ~1 hour)** — Bulk-add 9 deferred TODOS to TODOS.md (gstack lite, gstack budget, etc.)
  - Surfaced by: TODOS.md updates section
  - Files: `TODOS.md`
  - Verify: TODOS format matches `.claude/skills/review/TODOS-format.md`

## Failure Modes Registry

| Codepath | Failure mode | Rescued? | Test? | User sees | Logged |
|---|---|---|---|---|---|
| gen-skill-docs.ts gate check | resolver `appliesTo` throws | Y — try/catch logs + skips resolver | Y (test/gen-skill-docs.test.ts extended) | "resolver X errored, skipped" in build output | stderr |
| sections/ Read at runtime | section file missing | Y — agent falls back to skeleton-only behavior | Y (test/skill-e2e-ship-section-loading.test.ts) | warning in agent prose | session transcript |
| CI orphan walker | sections/*.md missing eval annotation | WARN mode v2.0; FAIL v2.1+ | Y (test/skill-coverage-matrix.test.ts) | PR summary lists orphans | PR comment |
| Migration script v2.0.0.0.sh | regenerate fails on damaged install | Y — script aborts, prints repair steps | Y (migration test) | clear error + repair steps | ~/.gstack/analytics/migrations.jsonl |
| Catalog one-line generator | skill missing one-line description in frontmatter | Y — gen-skill-docs fails build loudly | Y (gen-skill-docs.test.ts extended) | build error | stderr |
| Canary section-Read logger | logger missing for a heavyweight skill | Y — silently skipped, gap visible in dashboard | Y (transcript-logger test) | none directly; surfaced in canary dashboard | ~/.gstack/analytics/section-reads.jsonl |

No critical gaps — every failure mode has a rescue, a test, and visibility.

## Diagrams

System architecture (build pipeline):
```
  CONFIG (~/.gstack/config.yaml)
     |
     v
  +-----------------+      +--------------------+
  | gen-skill-docs  | <--- | resolvers/*.ts     |
  | (with gate)     |      | (w/ appliesTo)     |
  +-----------------+      +--------------------+
     |
     v
  +--------------------------+
  | SKILL.md.tmpl per skill  |
  | + sections/manifest.json | (heavyweights only, v2)
  | + sections/*.md          | (heavyweights only, v2)
  +--------------------------+
     |
     v
  +--------------------+         +--------------------------+
  | generated SKILL.md | <-----> | scripts/jargon-list.json |
  | (skeleton for      |         | (referenced, not inlined)|
  |  heavyweights v2)  |         +--------------------------+
  +--------------------+
     |
     v
  +-------------------+      +----------------------+
  | catalog (system   | <--- | proactive-suggestions|
  |  prompt, one-line |      | .json (loaded on     |
  |  per skill)       |      |  demand only)        |
  +-------------------+      +----------------------+
```

Section-Read flow (v2 runtime):
```
  USER /ship
     |
     v
  +-----------------------+
  | ship/SKILL.md         |
  | (12-15KB skeleton)    |
  | reads:                |
  |  - manifest.json      |
  |  - decision tree      |
  +-----------------------+
     |
     v  Agent walks decision tree, identifies which sections apply
     |
     +-----> Read sections/version-bump.md   (if bumping)
     +-----> Read sections/changelog.md      (if writing entry)
     +-----> Read sections/review-army.md    (if pre-ship review)
     +-----> ... only sections that apply
     |
     v
  +-------------------------+
  | end-of-skill self-check |
  | "list sections I read"  |
  +-------------------------+
     |
     v  Canary cohort: transcript-section-logger compares
     |  actual Reads vs manifest's required_for declarations
     |  alerts on miss
```

## Stale diagram audit

ASCII diagrams in CLAUDE.md / ARCHITECTURE.md that this plan affects:

| Diagram | File | Still accurate post-v2? |
|---|---|---|
| Sidebar message flow | `docs/designs/SIDEBAR_MESSAGE_FLOW.md` | YES (unrelated subsystem) |
| Dual-listener tunnel architecture | `ARCHITECTURE.md` | YES (unrelated) |
| Unicode sanitization at server egress | `ARCHITECTURE.md` | YES (unrelated) |
| (none for skill build pipeline) | — | New diagrams above are NEW, not updates |

No stale diagrams to fix.

## Completion summary

```
+====================================================================+
|            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
+====================================================================+
| Mode selected        | SCOPE EXPANSION                              |
| System Audit         | bloat externally documented; prior design   |
|                      | doc unrelated; budget-regression infra exists|
| Step 0               | EXPANSION + Approach C + eval-first +       |
|                      | hybrid v1.45/v2.0 split + lighter migration |
| Section 1  (Arch)    | 1 finding — silent-loss risk, 6-layer mit   |
| Section 2  (Errors)  | 6 failure modes mapped, 0 CRITICAL GAPS     |
| Section 3  (Security)| cso targeted dedup (Codex #9 absorbed)      |
| Section 4  (Data/UX) | v1→v2 muscle memory warned, vendored noted  |
| Section 5  (Quality) | ~150 LOC additive, mechanical extraction    |
| Section 6  (Tests)   | Phase 0 IS the test plan                    |
| Section 7  (Perf)    | <2× build time; +200-500ms first-invoke v2  |
| Section 8  (Observ)  | budget-regression + canary + migrations.log |
| Section 9  (Deploy)  | 2-release split + warn-before-fail + revert |
| Section 10 (Future)  | Reversibility 3/5; sections/ becomes template|
| Section 11 (Design)  | README banner + numbers table              |
+--------------------------------------------------------------------+
| NOT in scope         | written (9 items deferred)                   |
| What already exists  | written (9 reuse points)                    |
| Dream state delta    | written (TODAY / v1.45 / v2.0)              |
| Error/rescue registry| 6 modes, 0 CRITICAL GAPS                    |
| Failure modes        | covered in registry                         |
| TODOS.md updates     | 9 items, bulk-add post-merge                |
| Scope proposals      | 3 surfaced, 1 accepted (launch positioning) |
| CEO plan             | this plan IS the CEO plan                   |
| Outside voice        | ran (codex); 3 tensions surfaced            |
| Lake Score           | 11/11 recommendations chose complete option |
| Diagrams produced    | 2 (build pipeline, section-read flow)       |
| Stale diagrams found | 0                                           |
| Unresolved decisions | 0                                           |
+====================================================================+
```

## Eng-review additions (from /plan-eng-review session)

### Architectural decisions locked in

- **D1 (manifest format):** `sections/manifest.json` is the structured per-heavyweight registry (JSON, machine-readable for gen-skill-docs CI checks). SKILL.md skeleton is markdown headers + imperative prose blocks ("STOP. If X, Read `sections/Y.md`"). Matches Anthropic's documented `references/` style. No invented DSL.
- **D2 (drift control):** `sections/*.md.tmpl` is the source of truth; `sections/*.md` is generated. gen-skill-docs walks `<skill>/sections/*.tmpl` and writes `<skill>/sections/*.md` using the same resolver pipeline as SKILL.md. Cost: ~30 LOC in `scripts/gen-skill-docs.ts`. Eliminates the drift class that `test/ship-version-sync.test.ts` already suffers from (TODOS:1120).
- **D3 (CI cost cap):** `EVALS_BUDGET_HARD_CAP=$30` env var enforced by `test/skill-e2e-budget-regression.test.ts`; build fails if a single run exceeds. Section-loading tests (Phase B) use minimal-bash fixtures (~$0.30 each) because they assert STRUCTURAL behavior (was the right file Read?) not output quality.

### Adjacent TODOS surfaced (informational, not blocking)

- **TODOS:161** — planned "resolver injection at session start" for browser-skills (P2). Has architectural overlap with this plan's `appliesTo` predicate. Decision: keep separate for now — browser-skill resolver injection is runtime (session-start hostname matching); our `appliesTo` is build-time (gen-skill-docs.ts). Different lifecycles, different concerns. Revisit only if the browser-skills work needs the same predicate shape.
- **TODOS:1120** — `test/ship-version-sync.test.ts` reimplements ship/SKILL.md.tmpl Step 12 bash. D2 (sections/*.md.tmpl pipeline) is the structural fix. Phase B work obviates this TODO; mark as resolved when ship/ extraction lands.
- **TODOS:1136** — `git show` fallback in ship/SKILL.md.tmpl Step 12 line 409. Phase B touches this; bundle the `git rev-parse --verify` fix into the version-bump section extraction.

### Test plan artifact

Test plan written to `~/.gstack/projects/garrytan-gstack/garrytan-garrytan-slim-skill-tokens-eng-review-test-plan-<timestamp>.md`. `/qa` and `/qa-only` consume this as primary test input. Covers: per-phase test coverage targets, fixture design for section-loading tests, CI budget enforcement check, migration round-trip test.

### Failure modes additions

Adding to the registry from §Failure Modes (already complete; new rows):

| Codepath | Failure mode | Rescued? | Test? | User sees | Logged |
|---|---|---|---|---|---|
| sections/*.md.tmpl generator | template references missing resolver | Y — gen-skill-docs fails build loudly | Y (gen-skill-docs.test.ts extended) | build error | stderr |
| Manifest ↔ filesystem consistency | manifest references section file that doesn't exist | Y — CI check fails | Y (new `test/section-manifest-consistency.test.ts`) | build error | PR summary |
| Manifest ↔ filesystem consistency | section file exists but not in manifest (orphan) | WARN v2.0; FAIL v2.1+ | Y (same test) | PR summary | PR comment |
| Budget cap exceeded | single test or aggregate exceeds `EVALS_BUDGET_HARD_CAP` | Y — CI fails | Y (budget-regression extended) | build error w/ cost breakdown | stderr |

Still 0 critical gaps. All new failure modes have rescue + test + visibility.

### Execution sequencing (sequential v1.45, integration-branch v2.0)

v1.45 runs **sequentially** in a single branch, T1 → T8. The parallelization map was reconsidered after codex's second-pass critique flagged that T2 (gen-skill-docs.ts TemplateContext changes) and T4 (catalog frontmatter additions) almost certainly touch each other at compile time — both branches passing alone, failing at integration. Sequential lands cleaner and avoids 3-way merge surprise. AI compression makes the wall-clock cost of sequential acceptable.

| Step | Modules touched | Depends on |
|---|---|---|
| T1 Phase 0 evals (~20 files) | `test/skill-e2e-*.test.ts`, `test/skill-coverage-matrix.ts`, `test/helpers/touchfiles.ts` | — |
| T2 conditional resolver gate | `scripts/gen-skill-docs.ts`, `scripts/resolvers/types.ts`, `scripts/resolvers/index.ts` | T1 |
| T3 jargon dedup + terse compression | `scripts/resolvers/preamble/*` | T2 |
| T4 catalog trim | `scripts/skill-catalog.ts`, `scripts/proactive-suggestions.json`, all SKILL.md.tmpl frontmatter | T2 |
| T5 hard token budgets + override path | `test/skill-e2e-budget-regression.test.ts` (per-suite caps + `EVALS_BUDGET_OVERRIDE_REASON`) | T1 |
| T6 cso targeted dedup | `cso/SKILL.md.tmpl` | T2, T3 |
| T7 regenerate all SKILL.md atomically | all `*/SKILL.md` | T1-T6 |
| T8 v1.45 CHANGELOG | `CHANGELOG.md`, `VERSION` | T7 |
| **— v1.45.0.0 ship boundary —** | | |
| T9 ship/ sections/ extraction | `ship/SKILL.md.tmpl`, `ship/sections/*`, gen-skill-docs (sections pipeline w/ TemplateContext contract) | T8 + sections-pipeline (T2/D2) |
| T10 ship/ canary cohort | `test/helpers/transcript-section-logger.ts` | T9 |
| T11 plan-ceo-review sections/ | `plan-ceo-review/SKILL.md.tmpl` + sections | T10 (ship/ proven) |
| T12 office-hours + plan-eng + plan-design sections/ | respective directories | T11 |
| T13 Phase C eval annotations + 3-tier orphan check | gen-skill-docs.ts orphan walker, all sections/*.md | T9-T12 |
| T14 migration script | `gstack-upgrade/migrations/v2.0.0.0.sh` | T13 |
| T15 v2.0.0.0 CHANGELOG + README banner | `CHANGELOG.md`, `README.md`, `VERSION` | T14 |
| T16 TODOS bulk-add | `TODOS.md` | — anytime |

**Execution recommendation:** single-worktree sequential for both v1.45 (T1→T8) and v2.0 (T9→T15). T16 lands whenever. The CC speedup comes from per-step compression (each step is ~1 hour vs human-days), not from parallel branches.

## Codex consult additions (second pass, post eng-review)

### Cathedral parity-eval suite (Phase 0 add-on, expanded to "11")

User said "do it like 11, not just 10. max it out and then some." Maxed-out scope:

- **ALL 31 skills** get golden-baseline transcripts (not just top 5)
- **Multiple fixtures per skill** (3-5 representative invocation paths each)
- **Quantitative + qualitative scoring:** LLM-as-judge similarity score (1-10) AND transcript-diff highlights (added/removed sections, missing nuance)
- **Token-efficiency ratio measured:** quality-per-token = judge_score / tokens_consumed (forces v2 to be measurably MORE efficient, not just smaller)
- **"Quality budget" alongside "token budget":** both enforced in CI. A v2 skill that compressed to half size but dropped from 9/10 quality to 6/10 fails the gate.
- **Side-by-side PR comment:** every PR that touches a heavyweight skill auto-posts a v1.45-baseline vs current parity comparison in the PR summary
- **Public benchmark page:** `gstack.benchmarks.md` (new), continuously updated. Quotable: "v2 average parity score: 9.2/10, average token reduction: 67%."
- **Continuous monitoring:** parity suite runs weekly on main; alerts if any skill drifts below baseline (Discord webhook or similar)
- **Baseline-capture script:** `test/helpers/capture-parity-baseline.ts` — run once at v1.44 HEAD to lock in golden transcripts before any Phase A work lands

Effort: human ~3-4 days / CC ~6-8 hours one-time + ~$30/week ongoing for continuous monitoring. Cost is justified — this is the ONLY mechanism that catches "looks green, feels worse" silent regression that section-loading and budget tests both miss. Adds new tasks T0a (baseline capture) and T0b (parity eval harness) BEFORE T1.

### Absorbed refinements from codex consult (no further user decision needed)

1. **TemplateContext contract for sections pipeline (codex D2 critique):** explicit spec required in T9. Section generation uses the SAME `TemplateContext` as SKILL.md generation — same `skillName`, same host suppression, same `explainLevel`, same tier gating. Documented in code comments + asserted by `test/template-context-parity.test.ts` (new).
2. **3-tier orphan classification (codex orphan-semantics critique):** the CI check (T13) distinguishes:
   - **Generated orphan** (`sections/foo.md` exists, no `sections/foo.md.tmpl`) → FAIL immediately, every release
   - **Manifest orphan** (`sections/foo.md.tmpl` exists, not in `manifest.json`) → WARN in v2.0, FAIL in v2.1+
   - **Hand-edited generated file** (`sections/foo.md` diverges from what regen would produce) → FAIL immediately, with "this file is generated, edit `.tmpl` instead" message
3. **Budget cap override path (codex D3 critique):** `EVALS_BUDGET_HARD_CAP=$30` becomes the default; per-suite caps via `EVALS_BUDGET_HARD_CAP_GATE=$25`, `EVALS_BUDGET_HARD_CAP_PERIODIC=$70`; override path `EVALS_BUDGET_OVERRIDE_REASON="<text>"` env required to exceed cap (CI prints the reason in build output for audit trail); daily org-level spend alert via existing analytics (`~/.gstack/analytics/skill-usage.jsonl` aggregator).
4. **Manifest as passive data (codex D1 critique):** `manifest.json` fields are IDs, file paths, and human-readable trigger text ONLY. No `applies_when` predicate. The skill skeleton's decision-tree prose is the ONLY place "when to read X" is decided. Avoids inventing a fourth condition language alongside tier-gating + `appliesTo` + `requiredReads`.
5. **T7 as integration-branch flow (codex parallelization critique, now obviated by sequential):** sequential execution means T7 is just "atomic regenerate within the single v1.45 branch." Integration-branch dance not needed. The critique's intent (no 3-way merge surprise) is honored by collapsing to sequential.

### New failure modes (additions to registry)

| Codepath | Failure mode | Rescued? | Test? | User sees | Logged |
|---|---|---|---|---|---|
| Sections pipeline TemplateContext | sections generated with divergent ctx (e.g. wrong skillName) | Y — parity test fails | Y (`test/template-context-parity.test.ts`) | build error | stderr |
| Hand-edited generated section | user edits `sections/foo.md` directly instead of `.tmpl` | Y — CI fails with explicit message | Y (orphan-check 3-tier classification) | "this file is generated, edit `.tmpl` instead" | PR summary |
| Quality budget exceeded | v2 skill compressed but dropped >2 points on LLM-judge parity | Y — CI fails | Y (parity-eval suite) | "v2 X.md dropped from 9.2 to 6.4 vs v1.45 baseline" | PR comment with diff |
| Budget cap override audit | EVALS_BUDGET_OVERRIDE_REASON used | N (intentional escape valve) | Y (audit-log test) | reason printed in CI output, logged to spend-audit jsonl | analytics/spend-overrides.jsonl |
| Parity baseline drift on main | weekly continuous monitor detects regression | Y — Discord alert + ticket | Y (continuous-monitor test) | alert in team channel | analytics/parity-drift.jsonl |

Still 0 critical gaps.

## v2 launch copy specs (from /plan-devex-review)

These drafts become the source of truth for v2.0.0.0 launch tone. T15 implements them verbatim (unless workshopping at ship time produces a measurably better take, in which case update both plan and implementation in lockstep).

### JUST_UPGRADED notice (Persona A — existing user upgrading)

Triggered by `gstack-update-check` showing `JUST_UPGRADED v1.x v2.0.0.0`. Replaces the generic v1 "Running gstack v{to} (just updated!)" with persona-A-aware copy that names the perceived speed win AND signals "your muscle memory still works."

```
Running gstack v2.0.0.0 (just updated!) — your sessions are now ~67% lighter.
Heavyweight skills load only the sections they need; the catalog dropped to
one line per skill. Everything still works the same way — your /ship, /qa,
/review commands haven't changed. Run `/gstack-upgrade --explain-v2` for the
full migration story, or just keep working.
```

Voice rules honored: lead with the win ("67% lighter"); concrete numbers; reassurance that workflows are unchanged ("everything still works the same way"); escape hatch (`--explain-v2`). No em dashes. Aimed at a 5-second read.

Implementation: update `~/.claude/skills/gstack/gstack-upgrade/SKILL.md.tmpl` Inline upgrade flow with v2-aware message; existing `JUST_UPGRADED <from> <to>` detection in skill preamble fires it.

### CHANGELOG numbers table (Persona A's magical moment + Persona B's evaluation evidence)

Lands in `## [v2.0.0.0]` entry of CHANGELOG.md, immediately under the headline. Compare measured v1.44 actuals (baseline captured by `test/helpers/capture-parity-baseline.ts` BEFORE Phase A starts) vs v2.0.0.0 measured. Numbers must be REAL, not estimated; replace placeholders during T15.

| Metric | v1.44.1 (baseline) | v2.0.0.0 (measured) | Δ |
|---|---|---|---|
| Total SKILL.md corpus | 2.1 MB | ~700 KB | **−67%** |
| ship.md (heaviest) | 164 KB | ~15 KB skeleton + 5×~5 KB sections | **−76% first-Read** |
| plan-ceo-review.md | 131 KB | ~12 KB skeleton + sections on demand | **−68% first-Read** |
| office-hours.md | 111 KB | ~10 KB skeleton + sections on demand | **−71% first-Read** |
| Catalog tokens (always-loaded system prompt) | ~25K tokens | ~6K tokens | **−76%** |
| Per-invocation tokens (typical /ship session) | ~41K | ~14K skeleton + on-demand sections | **~60% drop** |
| Eval coverage (skills with E2E protection) | ~16 of 31 | **31 of 31 + parity baselines** | quality gate enabled |
| Parity score vs v1.44 baseline (LLM judge, all 31 skills) | — | **≥9.0/10 floor** | (CI-enforced; see parity-eval suite) |

Below the table, one paragraph in gstack voice: "v1 was the heaviest opinionated skill pack. v2 is the lightest. The compression isn't free — every skill ships with both gate-tier and periodic-tier E2E evals, and a continuous parity-monitor catches silent quality regressions. The numbers above are measured against `test/helpers/parity-baseline-v1.44.1/` and reproduced by `bun run eval:parity`."

### README v2 banner

Placement: top of README.md, immediately under the existing Karpathy pull-quote, above "When I heard Karpathy say this..." Stays in place for 60 days post-launch, then collapses to a one-line "v2 released May 2026" entry in the Quick start section.

```markdown
> **gstack v2.0.0.0 — the lightest opinionated skill pack (May 2026)**
>
> Heavyweight skills now load only the sections they need. Total SKILL.md
> corpus dropped from 2.1 MB to ~700 KB. Every skill ships with E2E eval
> protection and a continuous parity-monitor against v1.44 baselines.
> See the [v2.0.0.0 release notes](CHANGELOG.md) for per-skill numbers and
> the migration story. Existing users: `/gstack-upgrade` auto-regenerates.
```

Voice rules honored: lead with the position ("lightest opinionated skill pack"); concrete numbers (2.1 MB → 700 KB); proof of rigor (eval protection + parity monitor); migration path explicit. No em dashes. Aimed at a 10-second read.

### Implementation notes (for T15)

- Lock the actual v1.44 baseline numbers into `test/helpers/parity-baseline-v1.44.1/` BEFORE Phase A regeneration starts. The "v1 vs v2" delta only quotes accurately if v1.44 was measured in the same units (token count via `tiktoken`, byte count via `wc -c`, eval coverage via `test/skill-coverage-matrix.ts`).
- If the measured v2 numbers come in LESS impressive than the drafts above (e.g., ship.md ends up at 25 KB instead of 15 KB), update the drafts to reflect reality. Never invent numbers; the marketing-grade ship moment dies the moment readers find a number they can disprove with `wc -c`.
- The JUST_UPGRADED notice fires automatically via existing `gstack-upgrade` detection — no new mechanism required.
- The README banner placement above the existing Karpathy quote is intentional: persona B (new evaluator) sees the v2 win BEFORE the Karpathy framing, anchoring "this is May 2026's most-current gstack."

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | SCOPE_EXPANSION mode; 3 expansion proposals (1 accepted: v2 launch positioning; 2 deferred: gstack lite, gstack budget); 11/11 sections reviewed; 0 critical gaps |
| Codex Review | `/codex review` | Independent 2nd opinion (outside voice) | 1 | issues_found | 12 challenges surfaced; 7 absorbed into plan (#4, #5, #6, #9, #10, #11, #12); 3 surfaced as user-decision (#1 user kept original pick, #7 hybrid split adopted, #8 user accepted codex) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 architectural decisions locked (D1 JSON manifest, D2 sections/*.md.tmpl pipeline, D3 CI cost cap); 4 new failure modes added (all rescued+tested); test plan artifact written; parallelization map produced (3 lanes parallel in v1.45, sequential in v2.0); 0 critical gaps; 0 unresolved decisions |
| Codex Consult (2nd pass) | `/codex` (consult on eng-review additions) | Independent challenge of D1/D2/D3 + parallelization | 1 | issues_found | 7 additional findings on eng-review additions; 5 absorbed (TemplateContext contract, 3-tier orphan classification, budget cap override path, manifest as passive data not predicates, T7 as integration-flow obviated by sequential); 2 surfaced as user-decision (attention-architecture risk → cathedral parity-eval suite added at "11"; parallelization collapsed to sequential v1.45 per codex critique) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not required (no significant UI scope; README/CHANGELOG only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CLEAR | DX POLISH mode; product type = Claude Code Skill; 2 personas tracked equally (existing-user upgrader + new-user evaluator); initial 7.9/10 → 9.0/10 after launch-copy specs added to plan (JUST_UPGRADED notice, CHANGELOG numbers table, README v2 banner all drafted as T15 deliverables); all 8 passes evaluated; skill DX checklist passes |

**CODEX:** First pass (CEO): 12 findings, 7 absorbed, 3 cross-model user-decided, 2 baked into tasks. Second pass (post eng-review): 7 findings on the new D1/D2/D3 additions, 5 absorbed, 2 user-decided. Both passes preserved as audit trail. 19 total codex findings → 12 absorbed without friction, 5 user-decided across both passes, 2 quality-of-life refinements baked into tasks. DX review skipped fresh codex pass (3 prior passes already covered structural blind spots; remaining DX work is copy-craft, where codex adds less value than user taste).

**CROSS-MODEL:** Strong agreement on (a) phasing (catalog trim early, sections/ later), (b) measurement-first (hard token budgets + override audit trail), (c) forks/rollout-strategy gaps. Tensions resolved across all passes: eval-first scope (user kept), v2 vs v1.x (HYBRID adopted), migration heaviness (lighter touch adopted), parallelization (user accepted codex's sequential critique), attention-architecture risk (user expanded scope to cathedral parity-eval suite covering ALL 31 skills with quality budget alongside token budget), launch copy artifacts (user drafted all three in plan vs deferring to T15 implementation).

**UNRESOLVED:** 0 decisions outstanding across all 5 reviews.

**VERDICT:** CEO + ENG + CODEX×2 + DX CLEARED — ready to implement. The hybrid v1.45/v2.0 split de-risks the bloat-reputation fix; the sections/*.md.tmpl pipeline (D2) prevents drift; the CI cost cap with override audit (D3 + codex absorbed refinement) prevents runaway eval spend; the cathedral parity-eval suite (codex 2nd pass) catches silent attention-architecture regressions that section-loading + budget tests alone would miss; sequential v1.45 execution (codex absorbed) trades wall-clock for integration safety; v2 launch copy specs (DX review) make the marketing-grade ship moment land for both persona A (existing upgrader) and persona B (new evaluator). Plan is now executable.
