# SYSTEM.md — the semantic contract graph

`SYSTEM.md` is a declarative file at the repo root describing what each
component *is*, what it *owns*, and the role-level contracts it has with
other components. Its consumer is `/plan-rollout`, which uses it to slice
a single large change into an ordered PR stack with reader guides and
deploy-edge awareness.

`SYSTEM.md` is optional. `/plan-rollout` works without it — falling back
to path heuristics + import-graph discovery — and improves materially
when present.

## What SYSTEM.md is NOT

It is not a package manifest. It does not list:

- Import graphs or symbol-level callers
- npm / Cargo / Gem / Go module versions
- Build dependencies or linker flags
- Test framework wiring

Everything mechanical is discovered at runtime (AST, grep, package manifests).
Declaring it here would go stale within a week.

## What SYSTEM.md IS

The **semantic contract graph**: the relationships between components that
only a human knows.

| Kind | Example | Lives where |
|------|---------|-------------|
| Role/contract dep | "auth mints session tokens middleware enforces; format change without middleware redeploy breaks sessions" | SYSTEM.md |
| Package/import dep | "`auth.ts` imports `crypto-utils`; `middleware.ts` calls `auth.verify()`" | Discovered (NOT here) |

`/plan-rollout` reads both. Declared contracts give the *why* (what breaks
under coordinated deploy). Discovered imports give the *what* (which files
move together). Disagreements surface in the decomposition output for human
resolution rather than being silently resolved either way.

## Schema (v1 — intra-repo)

```yaml
---
version: 1
components:
  - name: <unique identifier>
    path: <repo-relative path to the component root>
    kind: component            # or: leaf-util | types-only (optional; defaults to 'component')
    role: <one-line description of the component's job>
    owns:
      - <data surface, table, API, or feature this component is source-of-truth for>
    contracts:
      - with: <other component name>
        nature: <what the relationship is in plain English>
        breaks-if: <what human action causes the contract to break>
        rollout-edge: <hard | soft>
        note: <optional; 'runtime-only' | 'types-only' | 'legacy' | free text>
    rollout-order: <integer; lower ships first; same number can ship in parallel>
---

# System Map

<Free-form markdown narrative: component stability, anti-patterns, deploy-edge
semantics the team has learned from incidents. This section is for humans, not
for parsers.>
```

### Field reference

**`name`** — unique identifier used by other artifacts to reference this
component. Keep it short and stable. Renames cascade to every contract
reference.

**`path`** — where the component lives in the repo. Can be a file or
directory. Used for component-membership lookups (is `src/auth/session.ts`
in the `auth` component? yes).

**`kind`** — defaults to `component`. Use:
- `leaf-util` for shared utility dirs (`src/utils/`, `src/helpers/`) that
  components import freely without declaring contracts. The skill skips
  these when reconciling.
- `types-only` for pure type/interface modules. Skipped likewise.

**`role`** — one sentence describing what this component is FOR. Not what
it contains, not how it's built. What it does in the system.

**`owns`** — data surfaces, tables, APIs, or features this component is
the single source of truth for. Two components claiming ownership of the
same surface is a design smell.

**`contracts`** — the heart of SYSTEM.md. Each contract declares a
role-level relationship with another component.

- **`with`** — the other component's name. Must match a declared component.
- **`nature`** — plain-English description of the relationship.
- **`breaks-if`** — the specific human action that violates the contract.
  This is what `/plan-rollout` reads. "Session payload schema changes
  without middleware redeploy" tells the skill these two PRs must ship
  as a coordinated stage.
- **`rollout-edge`**:
  - `hard` = must deploy together (e.g., a session format change). The
    skill places both sides of a hard edge in the same slice or marks
    the slice "coordinated deploy required."
  - `soft` = can lag (e.g., a logging metric addition). Noted but not
    enforced.
- **`note`** (optional):
  - `runtime-only` — coupling via DB, message bus, HTTP, or filesystem;
    no code-level import edge exists. Suppresses the "contract without
    imports" reconcile flag.
  - `types-only` — TypeScript types only, not runtime values.
  - `legacy` — contract exists but is being phased out.

**`rollout-order`** — integer. Components with lower numbers ship first.
Equal numbers can ship in parallel. Used as the default ordering for
PR-stack decomposition; users can override per-call.

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
        nature: middleware enforces session tokens auth mints
        breaks-if: session payload schema changes without middleware redeploy
        rollout-edge: hard
    rollout-order: 1

  - name: middleware
    path: src/middleware
    role: request routing + auth enforcement
    owns:
      - request context shape
    contracts:
      - with: gateway
        nature: gateway consumes req.user set by middleware
        breaks-if: req.user shape changes without gateway redeploy
        rollout-edge: hard
    rollout-order: 2

  - name: gateway
    path: src/gateway
    role: external HTTP surface
    owns:
      - public API schema
    contracts: []
    rollout-order: 3

  - name: utils
    path: src/utils
    kind: leaf-util
    role: shared helpers — imported freely without contracts
    owns: []
    contracts: []
    rollout-order: 0
---

# System Map

auth and middleware are the security boundary. Any change to session format
or the user-context shape is a coordinated deploy (rollout-edge: hard). We
learned this after the Feb 2025 incident where a session serializer change
shipped 40 minutes ahead of middleware and logged everyone out.

utils is declared `leaf-util` so the skill doesn't flag the many imports
into it from other components as missing contracts.
```

## How /plan-rollout uses it

`/plan-rollout` reads `SYSTEM.md` (if present) at the start of every run
and applies it three ways:

1. **File-to-component mapping** — when bucketing changed files into PR
   slices, files matching a component's `path` join that component's
   slice. No SYSTEM.md ⇒ slices fall back to top-level path heuristics
   (one slice per top-level dir of changes).
2. **Slice ordering** — slices are ordered by their components'
   `rollout-order`, lowest first. Files in `leaf-util` or `types-only`
   components float to slice 0 (foundational; no contracts to honor).
3. **Hard-edge enforcement** — if changed files span both sides of a
   `rollout-edge: hard` contract, the skill either merges those slices
   into a single coordinated stage or annotates the decomposition with
   a deploy-coordination warning.

Reconciliation is informational in v1. The skill prints flagged
mismatches between declared contracts and discovered imports
(`import-without-contract`, `contract-without-imports`,
`rollout-order-inversion`) so the human can resolve them, but does not
gate output on them.

## Scaffolding

`/plan-rollout` does NOT scaffold `SYSTEM.md` for you in v1. Scaffolding
(walking top-level dirs, classifying each, inferring `role` from
README/package.json) is a v2 follow-up. For v1, write the file by hand
or copy the example above and edit it.

## Relationship to other declarative files

| File | Purpose | Who writes it |
|------|---------|---------------|
| `CLAUDE.md` | Project-specific instructions for Claude (routing rules, test commands) | Human |
| `CODEOWNERS` | Who reviews changes to which paths | Human |
| `SYSTEM.md` | Semantic contract graph (this file's schema) | Human |
| `decomposition.md` | Per-change PR stack | `/plan-rollout` |

SYSTEM.md is the long-lived, repo-wide truth. `decomposition.md` is a
per-change artifact that references it.
