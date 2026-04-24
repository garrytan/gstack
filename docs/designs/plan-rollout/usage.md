# Using `/plan-rollout` and `/spill-check`

These two skills work together to solve a specific class of pain: **an
LLM-generated change set that is too big for a reviewer to meaningfully
ingest, with scope creep ("spills") hiding inside it.** If your change is one
file and one afternoon, you do not need these skills. If it's a feature that
naturally splits into a 3-PR stack, these skills make the stack obvious and
keep you in scope while you implement.

---

## The three artifacts

### `SYSTEM.md` (repo root, committed)

The semantic contract graph for your repo. Declares each component's role,
what it owns, and the role-level contracts it has with other components.
Long-lived. Authored once per repo, edited as components are added or renamed.

See [`SYSTEM-MD.md`](./SYSTEM-MD.md) for the full schema.

### `decomposition.md` (per change, generated)

The PR stack for a specific piece of work. Written by `/plan-rollout`.
Contains: PR units with files, dependencies, reading-order for reviewers,
time-budget estimates, and an ASCII stack map. Consumed by `/spill-check`,
`/ship`, and `/review`.

### `rollout.md` (per change, generated)

The rollout plan for a specific piece of work. Written by `/plan-rollout`.
Contains: strategy (flag / canary / migration-first / big-bang), step
sequence with inverse rollback auto-generated, verify metrics per step.
Consumed by `/land-and-deploy`.

---

## The core flow

```
  1. /plan-eng-review     (or /plan-ceo-review — or your own plan)
         │
         ▼
  2. /plan-rollout        ──▶  decomposition.md + rollout.md
         │                      (and SYSTEM.md if not present)
         ▼
  3. Implement PR-1   ────┐
         │                │
         ▼                │  /spill-check runs on demand
      commit              │  or as /ship pre-gate
         ▼                │
  4. /ship (stack mode) ──┘  ──▶  PR-1 opened with reader guide,
                                   time budget, dep narration
         ▼
  5. Review + merge PR-1
         ▼
  6. Repeat 3-5 for PR-2, PR-3, ...
         ▼
  7. /land-and-deploy    ──▶  reads rollout.md, sequences deploy steps
```

---

## Step-by-step: your first run

### 0. Prerequisite — commit a plan

Have a plan on disk. The plan can come from `/plan-eng-review`, `/plan-ceo-review`,
a design doc you wrote yourself, or just a well-scoped GitHub issue you've
captured locally. `/plan-rollout` will not guess at scope — it starts from
your plan.

### 1. First-time SYSTEM.md setup

If your repo has no `SYSTEM.md` at the root, `/plan-rollout` offers to
scaffold one on first run:

```
> /plan-rollout

No SYSTEM.md found at the repo root. /plan-rollout needs it to reason about
role-level contracts between components.

A) Scaffold SYSTEM.md.draft now (recommended)
B) Let me hand-write SYSTEM.md, then re-run /plan-rollout
C) Run /plan-rollout without SYSTEM.md (degraded mode — flag-level only)
```

Pick **A**. The scaffolder writes `SYSTEM.md.draft` with every top-level
directory as a component, role inferred from README/module docs, and TODO
markers for the fields only you can fill in (`owns`, `contracts`,
`rollout-order`).

Now edit `SYSTEM.md.draft`:

- Refine each `role` line to one sentence describing what the component is FOR
- Fill `owns` with data surfaces, tables, or APIs the component is source-of-truth for
- Fill `contracts` with role-level dependencies on other components, including
  `breaks-if:` (the concrete human action that violates the contract) and
  `rollout-edge: hard | soft`
- Assign `rollout-order` integers (lower = ships first)

Rename `SYSTEM.md.draft` → `SYSTEM.md`. Commit.

You only do this once per repo. Rerun `/plan-rollout`.

### 2. Running /plan-rollout

```
> /plan-rollout
```

The skill does:

1. **Reads your plan** (from `/plan-eng-review` output, your plan file, or the current conversation)
2. **Parses SYSTEM.md** and builds the contract graph
3. **Discovers the import graph** via AST walk across your source tree
4. **Reconciles both graphs** — flags "import without declared contract",
   "declared contract with no supporting imports", "rollout-order inversion"
   cases for you to resolve (each via AskUserQuestion)
5. **Proposes a PR decomposition** applying these heuristics:
   - Component boundary — different SYSTEM.md components → different PR units
   - Migration-first — DB migrations ship in PR #1
   - Interface-first — types and schemas before implementations
   - Pure additions first, mutations later
   - Tests travel with their code
   - Flag-gate before flag-flip
   - Reviewer-budget cap (no PR unit > 30 min review time)
6. **Shows the stack as an ASCII Gantt** with reviewer time totals —
   asks you to confirm, revise, or split further
7. **Proposes a rollout strategy** (big-bang / flag / canary / migration-first)
8. **Auto-generates inverse rollback lines** for each rollout step
9. **Writes the two artifacts** to `~/.gstack/projects/$SLUG/`
10. **Logs the review** for the Review Readiness Dashboard

Output when done:

```
+================================================================+
|            /plan-rollout — COMPLETION SUMMARY                   |
+================================================================+
| SYSTEM.md           | present                                   |
| Reconciliation      | 3 flags, 3 resolved, 0 suppressed         |
| PR units            | 3                                          |
| Total reviewer mins | 55                                        |
| Rollout strategy    | big-bang                                  |
| Rollout steps       | 3 with auto-rollback, 0 manual            |
| Artifacts           | decomposition.md, rollout.md              |
| Next                | start PR #1                               |
+================================================================+
```

### 3. Implementing with /spill-check discipline

Start PR #1. As you code, `/spill-check` tells you whether the diff you've
built is in scope for the PR unit you declared:

```
> /spill-check

Current PR unit: [1] "feat(router): add optional findAllowedMethods..."

In scope (declared, touched):
  ✓ src/router.ts
  ✓ src/router/trie-router/router.ts
  ✓ src/router/trie-router/router.test.ts

Declared but untouched (maybe you're not done):
  - src/router/trie-router/node.ts

Soft spills (warned, allowed — infra/meta files):
  - CHANGELOG.md
  - bun.lock

Hard spills (out of scope for this PR unit):
  ✗ src/hono-base.ts — intended for PR unit [3]

1 hard spill. Resolve before shipping.

A) Carve src/hono-base.ts to a separate branch
B) Extend decomposition.md to add this file to current unit
C) Revert the change
D) Add soft-spill rule for this path
```

Pick the right resolution. `/spill-check` stages the change for you.

Run `/spill-check` as often as you like. It's also the automatic pre-ship gate
when you invoke `/ship` with a decomposition.md present.

### 4. Shipping PR-1 with stack-aware /ship

```
> /ship
```

When `decomposition.md` exists, `/ship` enters **stack mode**:

- Detects which PR unit the branch represents
- Runs `/spill-check` as a gate (halts if hard spills present)
- Titles the PR from `decomposition.md` (conventional commits format)
- Generates the PR body with:
  - The declared rationale for this unit
  - Reader guide block: "Read `<file>` first, then `<file>`..."
  - Dependency note: "Depends on PR #412 (merged)" / "Followed by PR #414"
  - Reviewer time budget: "Est. 18 min"
  - Rollout link: "Part of issue #4633; see rollout.md"
- Creates the PR

Reviewers open a PR that is **immediately legible**: they know what to read
first, how long it should take, and what comes next. That's the whole point.

### 5. Repeat for each PR unit

After PR-1 merges, create PR-2's branch from PR-1's branch (standard stacking
mechanic). `/plan-rollout`'s decomposition.md says which files belong to PR-2.
Implement → /spill-check → /ship. Same flow.

When the whole stack is merged, `/land-and-deploy` reads `rollout.md` and
sequences the rollout steps with their verify blocks.

---

## When NOT to use these skills

- **One-file, one-afternoon changes.** `/plan-rollout`'s ceremony costs 5-10
  minutes. Not worth it for a 50-line bug fix.
- **Research/spike work.** If you're exploring, not shipping, the
  decomposition step is premature.
- **Hotfixes.** A production incident demands fast; use `/ship` directly, do
  the post-mortem decomposition later if you want.
- **Docs-only PRs.** Trivial scope; the overhead doesn't pay back.

The skills pay back hardest on changes that span 3+ files across 2+
components with meaningful rollout risk.

---

## Common issues and how to resolve them

### "The scaffolder inferred nonsense roles for my components"

Expected — the scaffolder is a starting point, not a finished product. It
aims for ~60% accuracy so you can edit rather than write from blank. If a
role field is wrong, overwrite it. If a whole component is wrong (e.g., the
scaffolder treated your `scripts/` dir as a component), delete the block.
The scaffolder only runs on the first pass; you own `SYSTEM.md` after that.

### "Reconciliation flagged an 'import without contract' but it's legitimate"

Three legitimate cases:

1. **It's actually a layering violation.** Fix the code.
2. **It's a transitive import through a leaf utility** (e.g., `src/utils/`).
   Declare the utility dir as `kind: leaf-util` — reconciler will ignore
   edges through it.
3. **The contract is runtime-only** (coupling via DB, message bus, or
   filesystem; no code-level import). Add the contract to SYSTEM.md with
   `note: runtime-only`.

### "The reviewer time-budget estimate feels off"

It's uncalibrated in v1. Treat the numbers as directional (PR-1 is smaller
than PR-2), not absolute. Predicted-vs-actual data is logged to analytics so
the coefficients improve in v2.

### "/spill-check is flagging a legit touch on a file I need to change"

You have three paths:

1. **Extend the decomposition** — the file genuinely belongs to the current
   unit; you missed it in planning. Pick option B in the spill prompt.
2. **Carve the change** — the file is needed but unrelated to this unit's
   purpose. Pick option A; the change goes to a separate branch.
3. **Project-level allowlist** — the file is infrastructure/meta and should
   never be considered a spill in this repo (e.g., a custom codegen config).
   Pick option D; adds the file to `.gstack/spill-check.yml`.

### "I want the decomposition.md visible in the PR description"

The artifact lives in `~/.gstack/projects/$SLUG/` by default. Run
`/plan-rollout --also-project-root` (or symlink manually) to mirror it into
your repo. Reviewers who don't use gstack can then read it directly.

### "I'm shipping a library, but the rollout.md template talks about services"

Known gap in v1. Library rollouts look different from service rollouts
(publish-and-revert vs. coordinated deploy). The `package-type:` field in
SYSTEM.md addresses this in v2; for now, edit the generated rollout.md by
hand to fit your context.

---

## Relationship to other gstack skills

| Skill | Produces | Consumes |
|-------|----------|----------|
| `/plan-eng-review` | eng plan | — |
| `/plan-ceo-review` | CEO plan | — |
| **`/plan-rollout`** | **`decomposition.md`, `rollout.md`** | **eng/CEO plan, `SYSTEM.md`** |
| **`/spill-check`** | **spill report, carve-branch if needed** | **`decomposition.md`** |
| `/ship` (stack mode) | stacked PRs with reader guides | `decomposition.md`, `rollout.md` |
| `/review` (scope-aware) | scope-verified review | `decomposition.md` |
| `/land-and-deploy` | deployed rollout | `rollout.md` |
| `/canary` | post-deploy regression watch | `rollout.md` verify blocks |

Every skill downstream of `/plan-rollout` reads its artifacts. That is the
integration spine — the reason this skill exists as the spine of
gstack's plan-to-prod pipeline, not a standalone tool.

---

## Command reference

```
/plan-rollout                        # standard run
/plan-rollout --trim                 # remove declared-but-untouched files (v2)
/plan-rollout --also-project-root    # mirror artifacts into repo root (v2)
/plan-rollout --dry-run              # preview decomposition without writing (v2)

/spill-check                         # interactive — asks what to do with spills
/spill-check --gate                  # non-interactive; exits non-zero if hard spills
/spill-check --unit <id>             # override auto-inferred PR unit
```
