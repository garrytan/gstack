---
name: review
description: >-
  Review code with validated evidence. Use for normal, security, performance, or deep audits of diffs, architecture, data, tests, dependencies, docs, and code health.
---

# GStack Review

Classify the change, select relevant review modules, validate findings, and distinguish report-only from safe fixes.

## Required execution header

Before any substantive output, print these exact labels in this exact order. Resolve the specialist refinement first; do not put prose above the header.

```text
Target: <concrete repository, product, URL, device, PR, or artifact>
Mode: <selected top-level mode>
Depth: <quick, standard, or deep>
Mutation: <report-only or exact authorized mutation boundary>
Active modules: <comma-separated internal specialist modules>
Skipped modules: <comma-separated non-active mandatory modules with compact reasons>
Web context: <none, optional, local-browser, or production>
```

## Dispatch protocol

1. Infer the mode from product stage, surface, requested artifact, mutation authorization, evidence needs, and deployment state. Do not route by keyword alone.
2. Refine the public mode to the smallest applicable internal specialist set, then print the required execution header before any substantive output.
3. Read each active module in full from the path shown in the mode/alias tables. Its specialist body, behavioral contract, STOP gates, and appended upstream judgment ports are binding. Read a lazy specialist phase in full only when the workflow reaches its package-local reference.
4. Read `references/SHARED-JUDGMENT.md` and `references/AUTHORITY-POLICY.md` for every invocation. Read `references/RUNTIME.md` before capability-dependent work and `references/WEB-CONTEXT.md` before public-web work.
5. If an old asset path is unavailable, use `references/ASSETS.md`. If legacy prose invokes another retired skill, resolve it through `references/COMPATIBILITY.md` and stay inside these six dispatchers.
6. Preserve report-only versus mutation boundaries. Missing mutation authorization fails closed: do not edit merely because a specialist can fix. Commits, pushes, PRs, merges, deploys, messages, and other external mutations still require affirmative authority from the user.
7. Match the user's language. Keep code identifiers, commands, and source quotations original when translation would reduce accuracy.
8. At exit, report completed artifacts, evidence, unresolved decisions, skipped modules with reasons, and any blocked gate.


## Top-level modes

| Mode | Target | Infer when | Candidate internal specialists |
|---|---|---|---|
| `Normal` | A current branch diff | A standard pre-landing or broad code review is requested. | `references/legacy/review.md` |
| `Security` | The repository threat surface | The primary risk is auth, secrets, supply chain, abuse, infrastructure, or threat modeling. | `references/legacy/cso.md` |
| `Performance` | Changed performance behavior | The review should concentrate on latency, memory, resource use, hot paths, or regressions. | `references/legacy/review.md` |
| `Deep` | A high-risk or cross-cutting change | The change warrants health evidence and every genuinely independent outside voice available. | `references/legacy/review.md`, `references/legacy/health.md`, `references/legacy/codex.md`, `references/legacy/claude.md` |

## Hard rules

- Validate critical findings against current code and provenance.
- Trace loosened inputs into unchanged consumers and re-read unchanged user-facing strings.
- Never invoke the current model as its own outside voice.

## Internal specialist routing aliases

Every specialist below is an internal implementation detail, including mandatory inputs. The legacy alias refines a top-level mode; it never adds a public skill or top-level mode.

| Legacy invocation | Legacy alias | Public mode | Role | Module |
|---|---|---|---|---|
| `/review` | `diff` | `Normal` | mandatory | `references/legacy/review.md` |
| `/cso` | `security` | `Security` | mandatory | `references/legacy/cso.md` |
| `/health` | `health` | `Deep` | mandatory | `references/legacy/health.md` |
| `/codex` | `outside-codex` | `Deep` | mandatory | `references/legacy/codex.md` |
| `/claude` | `outside-claude` | `Deep` | mandatory | `references/legacy/claude.md` |

## Completeness invariant

Do not work from this dispatcher summary when a module is active. Read the referenced module completely, including its provenance marker, specialist workflow, lazy-phase directives, behavioral contract, and bug-fix overlays. The pinned 1.x shared onboarding wrapper is provenance-only and never runs during canonical execution.
