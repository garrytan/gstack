---
status: ACTIVE
skill: /plan-rollout + /spill-check
contribution-target: https://github.com/garrytan/gstack
fork: git@github.com:mastermanas805/gstack.git
generated-by: /plan-ceo-review
generated-on: 2026-04-24
mode: SCOPE_EXPANSION
---

# CEO Plan: /plan-rollout + /spill-check (gstack contribution)

## The Problem

LLM coding tools produce humongous diffs that PR reviewers cannot meaningfully
ingest. "Spills" (unrelated changes sneaking in) compound the problem. Reviewers
approve under cognitive load, real bugs ship, rollback is improvised.

The gstack landscape currently has skills for planning (`/plan-ceo-review`,
`/plan-eng-review`, `/plan-design-review`, `/plan-devex-review`), shipping one PR
(`/ship`), reviewing one diff (`/review`), and post-deploy monitoring (`/canary`,
`/land-and-deploy`). There is **no skill** that addresses PR decomposition, spill
detection, or rollout sequencing as first-class deliverables. This is the gap.

## The User's User

The PR reviewer at 4pm on a Wednesday. They open a gstack-produced PR and feel
relief, not dread. The body reads: *"180 lines. Read `auth.ts:47` first, then
`middleware.ts`. Depends on PR #412 (merged). Next: PR #414 will add the UI
surface. Rollback: `git revert` + disable `flag.new_auth`."* They review it in
4 minutes, catch a real bug, ship with confidence.

## Vision

### 10x Version
An end-to-end reviewer-ergonomics protocol where decomposition declared at
plan-time flows through every downstream skill: `/ship` auto-creates the
stacked PRs with reviewer guides, `/review` verifies each PR stays in its
declared lane, `/land-and-deploy` sequences the rollout, `/canary` watches for
regressions in the declared scope. This skill is the missing spine of gstack's
plan-to-prod pipeline.

### Platonic Ideal
A lightweight protocol, not a heavy tool. Skill produces two declarative
artifacts (`decomposition.md`, `rollout.md`) informed by a declared architectural
truth (`SYSTEM.md`). Every other gstack skill reads them and gets smarter.

### Layer-3 Eureka
Conventional stacking tools (Graphite, git-spr, Aviator) assume a human
developer makes decomposition decisions while coding and clean up the mess
after. The AI-coding inversion: **decomposition is declared at plan-time by a
reviewer-aware planning pass, then enforced during code generation.** gstack
already owns plan-time better than anyone else. This skill is the natural next
link. No other ecosystem does it from this direction.

## Scope Decisions (all accepted under SCOPE EXPANSION)

| # | Proposal | Effort (h / CC+g) | Decision | Rationale |
|---|----------|--------------------|----------|-----------|
| 1 | Reviewer reading-order guide in PR body | 2h / 10min | ACCEPTED | Massive reviewer-UX win, near-free |
| 2 | ASCII stack map (PR-dep Gantt) in decomposition.md | 3h / 15min | ACCEPTED | Fits gstack diagram-mandatory ethos |
| 3 | Inverse rollback auto-generation in rollout.md | 4h / 20min | ACCEPTED | Production-safety critical, boils the lake |
| 4 | Reviewer time-budget estimate per PR | 1d / 30min | ACCEPTED | Novel; user accepted despite deferral suggestion |
| 5 | `/ship` integration — stack-aware auto-PR creation | 2d / 1h | ACCEPTED | The integration spine; mitigate via opt-in gate |
| 6 | `/review` integration — verify diff stays in declared scope | 1d / 30min | ACCEPTED | Low-risk, closes the loop at review time |
| 7 | Cross-skill discoverability hooks | 1h / 10min | ACCEPTED | Near-free; skill only matters if users find it |
| 8 | SYSTEM.md declarative system map | 2d / 1.5h | ACCEPTED | User-introduced; unlocks graph-aware decomposition |

### Temporal Decisions (locked)

| # | Decision | Chosen |
|---|----------|--------|
| 1 | Artifact format | YAML frontmatter + markdown body (matches SKILL.md convention) |
| 2 | `/ship` integration | Extend `/ship` with opt-in stack mode gated on `decomposition.md` existence |
| 3 | `/spill-check` strictness | Adaptive: strict for code, soft for infra/meta files |
| 4 | SYSTEM.md scope | Intra-repo for v1; schema reserves `repo:` and cross-repo fields for v2 |
| 5 | SYSTEM.md scaffolder | Generates `SYSTEM.md.draft`; user reviews + renames before first use |

## Artifact Specifications

### `SYSTEM.md` (repo root) — the semantic contract graph

**Critical principle:** SYSTEM.md declares **role/contract dependencies only** —
the semantic relationships between components that only a human knows. Package
dependencies, import graphs, symbol references, and other mechanical coupling
are **discovered by the LLM at runtime** (AST, grep, manifests). They do NOT
belong in SYSTEM.md because they go stale within a week.

| Kind | Example | Lives where |
|------|---------|-------------|
| Role/contract dep | "auth mints session tokens that middleware enforces; format change without middleware redeploy breaks sessions" | SYSTEM.md (declared) |
| Package/import dep | "`auth.ts` imports `crypto-utils`; `middleware.ts` calls `auth.verify()`" | Discovered by LLM |

The skill reasons over BOTH graphs jointly: declared contracts give the *why*,
discovered imports give the *what*. When they disagree (e.g., middleware.ts
imports from auth.ts but no contract declared), the skill flags it for the user
to resolve — that's the signal that either a contract is missing from SYSTEM.md
or the import is a layering violation.

```yaml
---
components:
  - name: <component-name>
    path: <repo-relative-path>
    repo: <owner/repo>              # reserved for v2 multi-repo; optional
    role: <one-line role description>
    owns: [<data surfaces, tables, APIs this component is source-of-truth for>]
    contracts:
      - with: <other component name>
        nature: <what the relationship IS in plain english>
        breaks-if: <what human action causes the contract to break>
        rollout-edge: <hard | soft>   # hard = must deploy together; soft = can lag
    rollout-order: <integer, lower = ship first>
---

# System Map

<narrative: which components are stable vs hot, anti-patterns specific to this
system, deploy-edge semantics the team has learned from incidents>
```

**Example:**

```yaml
components:
  - name: auth
    path: src/auth
    role: authentication + session lifecycle
    owns: [user table, session table, JWT minting]
    contracts:
      - with: middleware
        nature: middleware enforces session tokens auth mints
        breaks-if: session payload schema changes without middleware redeploy
        rollout-edge: hard
      - with: api-gateway
        nature: gateway expects `req.user` context set by middleware downstream of auth
        breaks-if: auth stops populating tenant claims
        rollout-edge: soft
    rollout-order: 1
  - name: middleware
    path: src/middleware
    role: request routing + auth enforcement
    owns: [request context shape]
    contracts:
      - with: api-gateway
        nature: gateway consumes req.user set by middleware
        breaks-if: req.user shape changes
        rollout-edge: hard
    rollout-order: 2
```

### Package/import dependency discovery (LLM responsibility at runtime)

Everything mechanical is **discovered, not declared**:
- Import graph via AST (`ts-morph`, `tree-sitter`, or existing parsers)
- Package dependencies from `package.json`, `Cargo.toml`, `go.mod`, etc.
- Symbol-level call graph via `grep` + `ripgrep`
- File-touch correlation from recent git history (`git log --name-only`)

This runs per-invocation. Never cached into SYSTEM.md. Stale package deps in a
declared artifact cause more harm than good.

### Reconciliation rules (joint reasoning over both graphs)

When the discovered package graph and the declared contract graph disagree, the
skill surfaces a flag for user resolution. It does not silently pick a side.

| Discovered | Declared | Signal |
|------------|----------|--------|
| `X` imports from `Y` | No contract between their components | "Layering violation or missing contract — add to SYSTEM.md or refactor." |
| Contract declared | No imports/calls found | "Contract may be stale, or coupling is runtime-only (DB reads, message bus, HTTP). Add a note." |
| Rollout-order says X→Y | X depends on Y at import level | "Order inverted vs. imports. Usually wrong; may be legitimate for types-only imports." |

### `~/.gstack/projects/$SLUG/decomposition.md`

```yaml
---
status: ACTIVE
plan-ref: <path to source plan, if any>
generated-on: <ISO date>
total-prs: N
reviewer-time-budget-total-min: <sum>
pr-units:
  - id: 1
    title: <conventional-commits style>
    component: <SYSTEM.md component>
    files: [<list>]
    depends-on: []
    reviewer-time-budget-min: <estimated>
    reading-order: [<file in order>]
    rationale: <why this is a unit>
  - id: 2
    title: ...
    depends-on: [1]
    ...
---

# Decomposition: <feature name>

## Stack Map (ASCII Gantt)

PR-1 [auth]       ████████
PR-2 [middleware] ────────████████
PR-3 [gateway]    ────────────────████

## Per-PR Detail
<narrative per PR unit>
```

### `~/.gstack/projects/$SLUG/rollout.md`

```yaml
---
status: ACTIVE
strategy: <flag | canary | big-bang | migration-first>
rollout-steps:
  - step: 1
    action: <e.g., run migration M-up>
    component: <SYSTEM.md component>
    rollback: <e.g., run migration M-down; re-deploy previous binary>
    verify: <metric/dashboard to watch>
    wait: <duration before next step>
  - step: 2
    ...
flags:
  - name: <flag identifier>
    provider: <LaunchDarkly | Unleash | GrowthBook | GrowthbookCli | env-var>
    default: off
    enable-runbook: <path or inline>
    kill-switch: <path or inline>
---

# Rollout Plan
<narrative>

## Rollback Playbook
<inverse of rollout-steps, tested mentally>
```

## Skill Files to Create / Modify in Fork

### New files in `mastermanas805/gstack`:

```
plan-rollout/
└── SKILL.md                          # main skill file

spill-check/
└── SKILL.md                          # enforcement skill

lib/plan-rollout/
├── system-map-parser.ts              # parse SYSTEM.md YAML
├── system-map-scaffolder.ts          # generate SYSTEM.md.draft
├── decomposition-parser.ts
├── rollout-parser.ts
└── reviewer-time-estimator.ts        # LOC + files + complexity → minutes

test/plan-rollout/
├── system-map-parser.test.ts
├── scaffolder.test.ts
├── decomposition-roundtrip.test.ts
└── reviewer-time-estimator.test.ts
```

### Existing files to modify:

```
ship/SKILL.md                          # add opt-in stack mode gated on decomposition.md
review/SKILL.md                        # add scope-verification step when decomposition.md exists
plan-ceo-review/SKILL.md               # add /plan-rollout to Next Steps — Review Chaining
plan-eng-review/SKILL.md               # add /plan-rollout to Next Steps — Review Chaining
docs/skills.md                         # register new skills
CHANGELOG.md                           # add entry
README.md                              # add /plan-rollout + /spill-check to feature list
```

## Contribution PR Stack (meta: this skill decomposes its own contribution)

**The ultimate demo.** Land this skill as the PR stack it is designed to produce:

- **PR #1 — Foundation.** Adds `SYSTEM.md` schema + parser + scaffolder + tests.
  Touches `lib/plan-rollout/system-map-*.ts`, `test/plan-rollout/system-map-*.test.ts`.
  Ships standalone; no other skills modified. Reviewer time: ~15 min.

- **PR #2 — /plan-rollout skill (depends on #1).** Adds the skill, decomposition
  and rollout artifact writers, ASCII stack-map renderer, reviewer-time estimator,
  inverse rollback generator. Touches `plan-rollout/SKILL.md`, `lib/plan-rollout/*`.
  Reviewer time: ~25 min.

- **PR #3 — /spill-check skill (depends on #1).** Adaptive enforcement. Touches
  `spill-check/SKILL.md`, uses the SYSTEM.md parser from PR #1. Reviewer time: ~15 min.

- **PR #4 — Integration (depends on #2 and #3).** Modifies `/ship`, `/review`,
  `/plan-ceo-review`, `/plan-eng-review` to consume the artifacts and surface the
  skill in Next Steps. Highest review risk — touches hot paths. Covered by the
  existing golden-fixture tests. Reviewer time: ~20 min.

**Rollout**: v1 ships behind no flag (pure addition; absent `decomposition.md`
means every existing skill behaves identically). `/ship` opt-in mode activates
only when artifact exists — zero regression surface for existing users.

## Dogfood findings (from 2026-04-25 simulation against honojs/hono issue #4633)

Simulated the full `/plan-rollout` + `/spill-check` workflow end-to-end on a
real open-source issue. Produced SYSTEM.md, decomposition.md, rollout.md;
implemented PR-1 (171 LOC, 3 files, 86/86 tests passing, zero regressions
across 4 other router implementations). Findings that change v1 scope:

### Must-fix before v1 ships (add to scope)

1. **SYSTEM.md `kind` field.** Add `kind: component | leaf-util | types-only`.
   Shared utility dirs (e.g., `src/utils/`) don't fit the component schema and
   force awkward workarounds. Reconciler ignores leaf-util edges.

2. **`package-type` field for rollout templating.** `library | service | cli`.
   Rollout for an npm library ("publish patch revert") differs materially from
   rollout for a service ("coordinated deploy + state restore"). Current
   rollout.md template is service-shaped and doesn't fit libraries. Add field;
   rollout.md generator picks template accordingly.

3. **Heuristic #8 — shared test fixtures.** Current 7 heuristics don't cover:
   "PR unit extends a shared interface; which shared fixtures need updating
   and which PR unit owns them?" I caught this mid-implementation; the skill
   should prompt proactively during the decomposition ceremony.

### Should-fix in v1 (quality polish)

4. **Reviewer-time formula recalibration.** Replace fixed `test_bonus: 5min`
   with `test_loc / 30`. Add `change_kind: additive | refactor | mutation`
   multiplier (additive reviews faster). **Ship v1 with conservative defaults
   and log predicted-vs-actual to analytics from day one** — data compounds.

5. **Scaffolder effort level.** Current draft is ~10% accurate (every role is
   "TODO — inferred from directory: X"). Should aim for 60%: parse top-level
   README, `index.ts` exports, `@module` jsdoc, CODEOWNERS. User edits, not
   writes from blank.

### v2 candidates (defer but log)

6. **`/plan-rollout --trim` mode.** After implementation, offer to drop
   declared-but-untouched files. Decomposition tends to over-specify; trim
   discipline keeps the artifact honest.

7. **Dual-location artifacts.** User-dir (`~/.gstack/`) default plus optional
   `--also-project-root` flag to write/symlink to repo root for team
   visibility and PR reviewers who don't run gstack.

8. **Rollout pattern library.** The "hard-edge → soft via optionality +
   feature detection" move is reusable. Add a pattern library to the rollout
   ceremony: optionality cutover, dual-write/dual-read, flag-gated cutover,
   shadow-traffic canary.

### What the dogfood did NOT stress-test

Hono is a library with additive API change — no migrations, no flags, no
canary. Before shipping v1, run a second dogfood on a **service-shaped
change** (DB migration + feature flag + canary sequence). Good candidates:
open issues in `drizzle-orm`, `prisma`, or any real service repo. This will
stress the rollout side of the skill, which the Hono test under-exercised.

---

## Open Questions (for Section 6 / Section 9 of the deep review)

1. Reviewer-time-budget formula: what LOC-to-minutes coefficient? Needs calibration
   data. Proposal: ship with a conservative default (1 min per 20 LOC + 3 min per
   file + 5 min if tests present), log predicted-vs-actual to analytics, calibrate
   in v2. This IS reasonable premature optimization — the initial coefficients
   don't need to be perfect, they need to be directionally useful.

2. Feature flag detection: string-match on common flag libraries (LaunchDarkly,
   Unleash, GrowthBook, env-var patterns) or user declares in rollout.md? Proposal:
   both. Auto-detect and prompt user to confirm, defer to user declaration if
   conflict.

3. `/spill-check` infra-file allowlist: what's on it? Proposal: `CLAUDE.md`,
   `.gitignore`, `package.json`, `bun.lock`, `yarn.lock`, `package-lock.json`,
   `.env.example`, `*.md` docs, CI config. Anything in this list can be touched
   without declaration; everything else is strict.

4. Integration with existing `~/.gstack/projects/$SLUG/` artifacts — does
   decomposition.md supersede or compose with CEO plan? Proposal: compose.
   decomposition.md references the CEO plan via `plan-ref:` frontmatter.

5. Review log integration — does `/plan-rollout` add an entry to
   `~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl`? Proposal: yes, to surface in
   the Review Readiness Dashboard as a non-required entry.

## NOT in Scope (v1)

- Multi-repo workspaces (SYSTEM.md schema reserved, unused)
- Automatic code-generation constrained to declared scope (this is the natural v2
  — today's approach is post-hoc enforcement via `/spill-check`)
- Integration with Graphite / git-spr / Aviator — gstack produces the
  decomposition artifact; external stacking tools can read it
- Reviewer-time-budget calibration based on historical data (needs usage to
  collect; v2)
- Cross-model outside-voice on decomposition decisions (Codex consult could
  validate "is this a sensible decomposition?" — v2)
- UI for visualizing the stack (ASCII diagram is v1; future could render via
  `/design-html`)

## Next Steps

1. Complete the 11-section engineering deep review (architecture, error maps,
   security, tests, observability, deployment) — run it next, or run
   `/plan-eng-review` on this CEO plan.
2. Clone the fork locally: `git clone git@github.com:mastermanas805/gstack.git`
3. Run `bin/dev-setup` to activate dev mode.
4. Implement PR #1 (SYSTEM.md foundation) first; land it; demonstrate value.
5. Stack PR #2, #3, #4 using whatever interim decomposition approach (manual, or
   once PR #2 lands, `/plan-rollout` itself).

## Contribution Strategy Note

This is a substantial first contribution — 4 PRs, new skills, cross-skill edits.
Mitigations:
- File an issue in `garrytan/gstack` first describing the proposal + linking this
  CEO plan. Get directional buy-in before sinking implementation time.
- Offer to start with just PR #1 (SYSTEM.md) as proof-of-concept; a minimal,
  standalone, high-value artifact that establishes the schema. If merged, the
  rest becomes lower-risk.
- The meta-demo (this skill decomposing its own contribution) is a strong
  rhetorical asset — lead with it in the issue/PR description.
