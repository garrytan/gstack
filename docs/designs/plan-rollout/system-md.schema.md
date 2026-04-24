# SYSTEM.md — the semantic contract graph

`SYSTEM.md` is a declarative file at the root of a repository that describes
what each component *is*, what it *owns*, and the role-level contracts it has
with other components. It is the input to `/plan-rollout`, consumed by
`/spill-check`, `/ship` (stack mode), and `/review` (scope verification).

## What SYSTEM.md is NOT

It is not a package manifest. It does not list:

- Import graphs or symbol-level callers
- NPM / Cargo / Gem / Go module versions
- Build dependencies or linker flags
- Test-framework wiring

**Everything mechanical is discovered by the LLM at runtime** (AST, grep,
package manifests, git history). Declaring it here would go stale within a
week and cause more harm than good.

## What SYSTEM.md IS

It is the **semantic contract graph**: the relationships between components
that only a human knows.

| Kind | Example | Where it belongs |
|------|---------|------------------|
| Role/contract dependency | "auth mints session tokens that middleware enforces; format change without middleware redeploy breaks sessions" | SYSTEM.md |
| Package/import dependency | "`auth.ts` imports `crypto-utils`; `middleware.ts` calls `auth.verify()`" | Discovered (NOT here) |

The payoff: `/plan-rollout` reasons over the declared graph (semantic) jointly
with the discovered graph (mechanical). When they disagree, it surfaces the
disagreement for human resolution — either a contract is missing, a layering
violation exists, or the coupling is runtime-only and should be noted.

## Schema (v1 — intra-repo)

```yaml
---
version: 1
components:
  - name: <string, unique within repo>
    path: <string, repo-relative path to the component root>
    repo: <string, optional; reserved for v2 multi-repo>
    role: <string, one-line description of the component's job>
    owns:
      - <string, a data surface, table, API, or feature this component is source-of-truth for>
    contracts:
      - with: <string, name of another component>
        nature: <string, what the relationship is in plain English>
        breaks-if: <string, what human action causes the contract to break>
        rollout-edge: <hard | soft>
        note: <string, optional; e.g., "runtime-only coupling via message bus">
    rollout-order: <integer, lower = ship first; components with the same number can ship in parallel>
---

# System Map

<Free-form markdown narrative. Document anti-patterns, incidents that shaped
current structure, deploy-edge semantics the team has learned the hard way.
This section is for humans, not parsers.>
```

### Field reference

**`name`** — unique identifier used by other gstack artifacts
(`decomposition.md`, `rollout.md`) to reference the component. Keep short
and stable.

**`path`** — where the component lives in the repo. Can be a file or a
directory. Used by `/spill-check` to classify which component a touched file
belongs to.

**`role`** — one sentence describing what the component is FOR. Not what it
contains, not how it's built. What it does in the system.

**`owns`** — data surfaces, tables, APIs, or features this component is the
single source of truth for. Two components claiming ownership of the same
surface is a design smell; the skill will flag it.

**`contracts`** — the heart of SYSTEM.md. Each contract declares a role-level
relationship with another component.

- **`with`**: the other component's name.
- **`nature`**: plain-English description of the relationship.
- **`breaks-if`**: the specific human action that violates the contract. This
  is the field rollout planning reads — "session payload schema changes
  without middleware redeploy" tells `/plan-rollout` these two PRs must ship
  as a coordinated stage.
- **`rollout-edge`**:
  - `hard` = must deploy together (e.g., a session-format change); `/plan-rollout`
    will enforce same-step deploy, or block with explanation.
  - `soft` = can lag (e.g., a logging metric addition); `/plan-rollout` will
    note but not enforce simultaneity.
- **`note`** (optional): free-form annotation. Common values:
  - `runtime-only` — coupling happens via DB, message bus, HTTP, or filesystem;
    no code-level import exists. Prevents reconciliation from flagging it as
    "contract without supporting imports."
  - `legacy` — contract exists but is being phased out; useful context for
    human reviewers.

**`rollout-order`** — integer. Components with lower numbers ship first.
Components with the same number can ship in parallel (no inter-dependency in
this direction). Used as the default ordering for `/plan-rollout`, which the
user can override per-decomposition.

## Example

```yaml
---
version: 1
components:
  - name: auth
    path: src/auth
    role: authentication + session lifecycle
    owns:
      - user table
      - session table
      - JWT minting
    contracts:
      - with: middleware
        nature: middleware enforces session tokens that auth mints
        breaks-if: session payload schema changes without middleware redeploy
        rollout-edge: hard
      - with: api-gateway
        nature: gateway consumes tenant claims auth populates in user context
        breaks-if: auth stops populating tenant claims
        rollout-edge: soft
    rollout-order: 1

  - name: middleware
    path: src/middleware
    role: request routing + auth enforcement
    owns:
      - request context shape
      - rate-limit tables
    contracts:
      - with: api-gateway
        nature: gateway consumes req.user context middleware sets
        breaks-if: req.user shape changes without gateway redeploy
        rollout-edge: hard
    rollout-order: 2

  - name: api-gateway
    path: src/gateway
    role: external HTTP surface — only component exposed to the internet
    owns:
      - public API schema
      - CORS policy
    contracts: []
    rollout-order: 3

  - name: metrics-pipeline
    path: src/metrics
    role: emit product analytics to the warehouse
    owns:
      - event schema registry
    contracts:
      - with: auth
        nature: auth emits login/logout events consumed by pipeline
        breaks-if: event schema version changes without consumer update
        rollout-edge: soft
        note: runtime-only (message bus)
    rollout-order: 2
---

# System Map

auth and middleware are the security boundary. Any change that touches
session format or the user-context shape is a coordinated deploy —
rollout-edge:hard. We learned this the hard way after the Feb 2025 incident
where a session serializer change shipped 40 minutes ahead of middleware
and logged every user out.

metrics-pipeline is runtime-only coupled to auth via the event bus. No import
edge exists. Reconciliation tools will flag the contract as "no supporting
imports" — that's expected; the `note: runtime-only` field suppresses the
flag after first acknowledgment.

api-gateway is the one component we can deploy independently most of the
time. It has no declared contracts OUT, only contracts IN.
```

## Scaffolding a new SYSTEM.md

If your repo has no SYSTEM.md, `/plan-rollout` offers to scaffold one. The
scaffolder (`lib/plan-rollout/system-map-scaffolder.ts`):

1. Lists top-level directories that contain source files
2. Reads each directory's README / package.json / Cargo.toml / go.mod for a
   description — drafts the `role:` field if one is found
3. Leaves `owns:`, `contracts:`, and `rollout-order:` empty with TODO markers
4. Reads CODEOWNERS (if present) — adds owner teams as comments for reference
5. Writes to `SYSTEM.md.draft`, never directly to `SYSTEM.md`

The user is expected to:

1. Review the draft
2. Fill in the TODO markers (role refinement, owns, contracts, rollout-order)
3. Rename `SYSTEM.md.draft` → `SYSTEM.md`
4. Commit

**Why the draft-rename dance:** prevents an LLM-hallucinated SYSTEM.md from
becoming load-bearing without human review. The whole point of SYSTEM.md is
that it encodes knowledge the LLM does not have.

## Keeping SYSTEM.md fresh

SYSTEM.md drifts when components are renamed, split, or merged. `/plan-rollout`
treats drift as a reconciliation flag:

- Component `path` no longer exists → block and prompt user to update
- No imports from a component that claims `contracts: [...]` → flag for review
- New top-level directory with source files → suggest adding as component

A future `/system-map-audit` skill (v2) could run periodically to detect and
surface drift. Not in v1 scope.

## Relationship to other declarative files

| File | Purpose | Who writes it |
|------|---------|---------------|
| `CLAUDE.md` | Project-specific instructions for Claude (routing rules, test commands, etc.) | Human |
| `CODEOWNERS` | Who reviews changes to which paths | Human |
| `SYSTEM.md` | Semantic contract graph | Human (scaffolded, then edited) |
| `decomposition.md` | Per-change PR stack | `/plan-rollout` (ephemeral per feature) |
| `rollout.md` | Per-change rollout plan | `/plan-rollout` (ephemeral per feature) |

SYSTEM.md is the long-lived, repo-wide truth. The `decomposition.md` and
`rollout.md` are per-change artifacts that reference it.
