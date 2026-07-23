# GaryGoal — goal-to-production orchestration

Why /garygoal is built the way it is. For usage, see
[docs/skills.md](../skills.md#garygoal); for the enforced contracts, read
`lib/garygoal-state.ts` and `test/garygoal-*.test.ts` — the tests are the
specification.

## The core idea

gstack already has every specialist a delivery pipeline needs. What it lacked
was a conductor: something that takes ONE objective, routes it through the
right specialists in the right order, survives context loss, and refuses to
call anything done without evidence. GaryGoal is that conductor, split into
two layers with a hard boundary between them:

```
User objective
   │
   ▼
┌────────────────────────────┐   judgment: routing, reading specialists,
│ garygoal/SKILL.md (prompt) │   interpreting artifacts, writing reports
└─────────────┬──────────────┘
              │  every fact crosses this line as a CLI call
              ▼
┌────────────────────────────┐   facts: legal transitions, evidence rules,
│ bin/gstack-garygoal        │   SHA-tied gates, invalidation matrix,
│ + lib/garygoal-state.ts    │   budgets, locks, schema versions, redaction
└─────────────┬──────────────┘
              ▼
$GSTACK_STATE_ROOT/projects/<slug>/garygoal/<run-id>/
  run.json  events.jsonl  gate-results.json
  objective-contract.md  blockers.md  final-report.md
```

The agent cannot advance the pipeline by prose. `state set` validates the
transition AND the evidence; `gate record` demands a commit SHA; `merge-check`
evaluates the full never-merge list; `budget spend` fails at the cap. An LLM
that hallucinates progress gets a non-zero exit code, not a green pipeline.

## Pipeline flow

```
INTAKE → REPOSITORY_AUDITED → OBJECTIVE_CONTRACT_WRITTEN → [SPECIFIED] → PLANNED
  → IMPLEMENTING ⇄ IMPLEMENTATION_COMPLETE → CODE_REVIEW → [SECURITY_REVIEW]
  → [DESIGN_REVIEW] → [DEVEX_REVIEW] → [BROWSER_QA] → [PERFORMANCE_REVIEW]
  → DOCUMENTATION → SHIPPING → PR_OPEN → CI_PENDING ⇄ CI_REPAIR
  → REVIEW_PENDING ⇄ REVIEW_REPAIR → READY_TO_MERGE
  → MERGING → MERGED → DEPLOYING → CANARY → VERIFIED | ROLLED_BACK
[bracketed] states are conditional on routing. BLOCKED is reachable from any
active state and resumes only to the state it blocked from. VERIFIED and
FAILED are terminal.
```

Review states form an ordered flow — each may advance forward or drop back to
IMPLEMENTING for a fix loop, never skip backwards. The repair-pr entry jump
(REPOSITORY_AUDITED → PR_OPEN) is legal only in repair-pr mode: a normal run
earns its PR through SHIPPING.

## Skill routing

GaryGoal never re-implements a specialist. Each phase is a
`{{INVOKE_SKILL:<name>}}` block — the generated skill Reads the specialist's
SKILL.md from the trusted install root and executes it at full depth (the same
mechanism /autoplan uses for the plan-review triad). Routed skills:

| Skill | When |
|---|---|
| /office-hours | vague product intent only |
| /spec | concrete but under-specified ask only |
| /autoplan | always for feature work (the premise gate lives here) |
| /review | always |
| /cso --diff | sensitive touchpoints (auth, payments, uploads, UGC, admin, APIs, webhooks, secrets, CI/CD, infra, DB policies, migrations, LLM boundaries, deps) |
| /design-review, /qa | visible interface / browser-facing changes |
| /devex-review | developer-facing output (API, SDK, CLI, package, skill, MCP, onboarding) |
| /benchmark | rendering-critical, data-heavy, query/caching/bundle/latency paths |
| /codex | when installed — evidence to evaluate, never unquestioned truth |
| /ship | always (release authority; stop-loop handled with a bounded budget) |
| /land-and-deploy, /canary | merge mode + policy only |

## Gate invalidation matrix

`classifyPaths()` buckets a diff into categories; `invalidationFor()` maps
categories to exactly the gates that stop being evidence. The matrix is code
(`lib/garygoal-state.ts`) and pinned by tests:

| Change | Invalidates |
|---|---|
| docs-only | docs (+ merge_readiness) — browser QA survives |
| frontend/CSS | design_review, browser_qa, tests — NOT security_review |
| backend | tests, code_review |
| tests-only | tests — visual evidence survives |
| auth/authz | tests, security_review, browser_qa, code_review |
| migrations | tests, security_review, code_review |
| deps / CI config | tests, security_review |
| anything | merge_readiness (the final PR-head-SHA check) |

## Why a CLI instead of asking the model to remember

Three failure modes drove this: (1) context compaction silently drops "we
already ran security review" mid-run; (2) a model under pressure to finish
will claim a gate passed; (3) two concurrent sessions on one branch each
believe they own it. run.json + O_EXCL branch locks + schema-versioned
fail-safe loads solve all three deterministically. Unknown schema versions and
corrupt state REFUSE to load — a state file we can't fully parse is forensics,
not input.

## Safety posture

- events.jsonl goes through lib/jsonl-store (injection patterns rejected) and
  lib/redact-engine (HIGH and MEDIUM findings rejected — the store is
  non-interactive, so there is no confirm path). Same audited plumbing as the
  decision and learnings stores.
- Merge policy defaults OFF: `garygoal_autonomous_merge: false`,
  `garygoal_deploy_after_merge: false`. mergeAllowed() reports EVERY blocker,
  never short-circuits, and treats a recorded-then-invalidated gate as a
  refusal — invalidation cannot un-require a gate.
- Budgets are the infinite-loop backstop: 3 CI hypotheses per check, 3 review
  cycles, 5 ship reruns, then BLOCKED with an investigation report. Caps fail
  closed (a garbled cap is an error, not infinity) and CLI-supplied caps clamp
  to policy — an agent may tighten its budget, never raise it.
- The branch lock anchors to the orchestrating session's pid (`--owner-pid
  $PPID`), with same-owner supersede and atomic rename-steal reclaim of stale
  locks. `init` refuses while an incomplete run exists (budgets can't be
  laundered by re-initing); `--abandon-incomplete` is the explicit, audited
  escape. Every mutating CLI command verifies the lock names its target run.
- MERGING is unreachable outside merge/repair-pr modes at the state-machine
  level, requires the recorded merge-check verdict, and cross-checks the head
  SHA against READY_TO_MERGE's. merge-check additionally derives MANDATORY
  review gates from the PR's diff (`--diff-files-file`) — an auth diff without
  a security_review gate refuses even if routing never ran /cso.
- Free text sourced from untrusted content reaches the CLI via files
  (`--evidence-file`, `--text-file`), never inline shell arguments; evidence
  is scanned deeply (nested values included) with the same injection/secret
  rejection as events, and replayed text is datamarked on render.
- Skill provenance: each phase records the specialist's path, frontmatter
  version, and sha256 into events.jsonl.

## Limitations (deliberate)

- Forge operations (PR, checks, review threads, merge) are GitHub-only via
  `gh`, matching the pipeline skills GaryGoal conducts (/ship,
  /land-and-deploy). GitLab remains a documented non-goal for GaryGoal until
  those skills grow `glab` support end to end.
- GaryGoal trusts specialist artifacts the way /ship trusts test output: it
  verifies existence, SHA-currency, and verdicts, not the specialist's
  internal reasoning.
- The state CLI serializes one run per branch. Parallelism lives inside
  phases (independent read-only reviews), never across them.
