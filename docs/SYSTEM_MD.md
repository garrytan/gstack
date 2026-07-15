# SYSTEM.md — the semantic contract graph

`SYSTEM.md` is an optional repo-root file declaring what each component
*is*, what it *owns*, and the role-level contracts between components.
Its consumer is `/plan-rollout`. The skill reads it to sharpen slice
ordering and surface coordinated-deploy edges; it falls back to path
heuristics when absent.

Not a package manifest. Not an import graph. Those are discovered at
runtime (AST, grep, manifests) and would go stale within a week if
declared. SYSTEM.md captures only what a human knows: "auth mints
session tokens middleware enforces; session-format change without
middleware redeploy breaks sessions."

## Schema (v1 — intra-repo)

```yaml
---
version: 1
components:
  - name: <unique identifier>
    path: <repo-relative path>
    kind: component            # or: leaf-util | types-only (default: component)
    role: <one-line job description>
    owns:
      - <data surface, table, API, or feature this component owns>
    contracts:
      - with: <other component name>
        nature: <plain-English relationship>
        breaks-if: <specific human action that violates the contract>
        rollout-edge: <hard | soft>
        note: <runtime-only | types-only | legacy | free text>   # optional
    rollout-order: <integer; lower ships first; equal = parallel>
---

# System Map

<Free-form human notes: stability, anti-patterns, deploy-edge lessons
from past incidents. Not parsed.>
```

### Field reference

| Field | Meaning |
|-------|---------|
| `name` | Unique identifier referenced by other components' contracts. Renames cascade. |
| `path` | File or dir under the repo root. Used for component-membership lookups. |
| `kind` | `component` (default), `leaf-util` (utils dirs, no contracts), `types-only` (interfaces, no runtime). leaf/types are skipped during reconciliation. |
| `role` | One sentence: what this component does in the system. Not what it contains. |
| `owns` | Data surfaces / tables / APIs / features this component is source-of-truth for. Dual ownership is a design smell. |
| `contracts[].with` | Other component's name. Must match a declared component. |
| `contracts[].nature` | Plain-English description of the relationship. |
| `contracts[].breaks-if` | Specific human action that violates the contract. This is what `/plan-rollout` reads to detect coordinated-deploy stages. |
| `contracts[].rollout-edge` | `hard` = must deploy together. `soft` = can lag. |
| `contracts[].note` | `runtime-only` (DB/HTTP/bus coupling — no import edge expected), `types-only`, `legacy`, or free text. |
| `rollout-order` | Integer. Lower ships first. Equal values can ship in parallel. |

## Example

```yaml
---
version: 1
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
    rollout-order: 1

  - name: middleware
    path: src/middleware
    role: request routing + auth enforcement
    owns: [request context shape]
    contracts:
      - with: gateway
        nature: gateway consumes req.user set by middleware
        breaks-if: req.user shape changes without gateway redeploy
        rollout-edge: hard
    rollout-order: 2

  - name: gateway
    path: src/gateway
    role: external HTTP surface
    owns: [public API schema]
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

auth and middleware are the security boundary. Session-format or
user-context shape changes are coordinated deploys (rollout-edge: hard).
We learned this in Feb 2025 when a session serializer change shipped
40 minutes ahead of middleware and logged everyone out.
```

## How /plan-rollout uses it

1. **File → component mapping.** Changed files are bucketed into the
   slice for their component (matched by `path`, longest-match wins).
   Without SYSTEM.md, the skill falls back to top-level-dir bucketing.
2. **Slice ordering.** Slices are sorted by `rollout-order`. `leaf-util`
   and `types-only` components float to slice 0.
3. **Hard-edge enforcement.** When a changed-file set spans both sides
   of a `rollout-edge: hard` contract, those files merge into one slice
   tagged "coordinated deploy required — \<breaks-if reason\>".
4. **Reconciliation flags (informational).** Mismatches between declared
   contracts and discovered imports surface in the output:
   `import-without-contract`, `contract-without-imports`,
   `rollout-order-inversion`. Never blocking.

## Out of scope (v1)

No scaffolder. Write SYSTEM.md by hand or copy the example. Scaffolding
that walks top-level dirs and infers `role` from README/`package.json`
is a v2 follow-up.
