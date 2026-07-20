---
name: plan
description: >-
  Plan products, scope, architecture, developer experience, or executable specs before implementation. Use for ideas, strategic or engineering reviews, autoplan, and planning preferences.
---

# GStack Plan

Choose one planning specialist, preserve its question pressure and gates, and produce an executable decision artifact.

## Required execution header

Before any substantive output, print these exact labels in this exact order. Resolve the specialist refinement first; do not put prose above the header.

```text
Target: <concrete repository, product, URL, device, PR, or artifact>
Mode: <selected top-level mode>
Depth: <readiness, standard, or deep>
Mutation: <report-only or exact authorized mutation boundary>
Active modules: <comma-separated internal specialist modules>
Skipped modules: <comma-separated non-active mandatory modules with compact reasons>
Web context: <none, optional, local-browser, or production>
```

## Dispatch protocol

1. Infer the mode from product stage, surface, requested artifact, mutation authorization, evidence needs, and deployment state. Do not route by keyword alone.
2. Refine the public mode to the smallest applicable internal specialist set, then print the required execution header before any substantive output.
3. Read each active module in full from the path shown in the mode/alias tables. Its specialist body, behavioral contract, STOP gates, and appended upstream judgment ports are binding. Read a lazy specialist phase in full only when the workflow reaches its package-local reference.
4. Read `references/EXECUTION-PROFILES.md`, `references/SHARED-JUDGMENT.md`, and `references/AUTHORITY-POLICY.md` for every invocation. Infer Depth from structured operating conditions, then obey its mandatory modules, legal skips, artifacts, and claim limits. Read `references/RUNTIME.md` before capability-dependent work and `references/WEB-CONTEXT.md` before public-web work.
5. If an old asset path is unavailable, use `references/ASSETS.md`. If legacy prose invokes another retired skill, resolve it through `references/COMPATIBILITY.md` and stay inside these six dispatchers.
6. Preserve report-only versus mutation boundaries. Missing mutation authorization fails closed: do not edit merely because a specialist can fix. Commits, pushes, PRs, merges, deploys, messages, and other external mutations still require affirmative authority from the user.
7. Match the user's language. Keep code identifiers, commands, and source quotations original when translation would reduce accuracy.
8. At exit, report completed artifacts, evidence, unresolved decisions, skipped modules with reasons, and any blocked gate.


## Top-level modes

| Mode | Target | Infer when | Candidate internal specialists |
|---|---|---|---|
| `Discovery` | Unshaped idea or product premise | The problem, user, wedge, or value proposition is still fluid. | `references/legacy/office-hours.md` |
| `Product` | Product scope and strategic plan | The plan exists and the main uncertainty is scope, ambition, or product trajectory. | `references/legacy/plan-ceo-review.md` |
| `Engineering` | Architecture and implementation plan | The plan needs architecture, data, failure-mode, performance, or test review. | `references/legacy/plan-eng-review.md` |
| `DX` | Developer-facing plan | Developers, SDK/CLI/API consumers, onboarding, or documentation are the product surface. | `references/legacy/plan-devex-review.md` |
| `Specification` | Backlog-ready executable specification | Intent must become acceptance criteria, issue structure, testing, rollback, and handoff. | `references/legacy/spec.md` |
| `Full chain` | Cross-functional plan | The user wants the full CEO/design/engineering/DX chain with automatic routing. | `references/legacy/autoplan.md` |

## Hard rules

- Never silently expand scope.
- Never skip a selected review phase without listing the evidence for the skip.
- Do not implement product code from this dispatcher unless the user explicitly changes Mutation.

- Global Context search is deprecated. Use explicit context-save/context-restore state; do not imply an unbounded global search capability.

## Internal specialist routing aliases

Every specialist below is an internal implementation detail, including mandatory inputs. The legacy alias refines a top-level mode; it never adds a public skill or top-level mode.

| Legacy invocation | Legacy alias | Public mode | Role | Module |
|---|---|---|---|---|
| `/gstack` | `catalog` | `Discovery` | supporting | `references/legacy/gstack.md` |
| `/office-hours` | `product` | `Discovery` | mandatory | `references/legacy/office-hours.md` |
| `/plan-ceo-review` | `ceo` | `Product` | mandatory | `references/legacy/plan-ceo-review.md` |
| `/plan-eng-review` | `eng` | `Engineering` | mandatory | `references/legacy/plan-eng-review.md` |
| `/plan-devex-review` | `dx` | `DX` | mandatory | `references/legacy/plan-devex-review.md` |
| `/autoplan` | `auto` | `Full chain` | mandatory | `references/legacy/autoplan.md` |
| `/spec` | `spec` | `Specification` | mandatory | `references/legacy/spec.md` |
| `/plan-tune` | `preferences` | `Discovery` | mandatory | `references/legacy/plan-tune.md` |
| `/context-save` | `context-save` | `Discovery` | supporting | `references/legacy/context-save.md` |
| `/context-restore` | `context-restore` | `Discovery` | supporting | `references/legacy/context-restore.md` |
| `/learn` | `learning` | `Discovery` | supporting | `references/legacy/learn.md` |
| `/retro` | `retro` | `Discovery` | supporting | `references/legacy/retro.md` |
| `/setup-gbrain` | `memory-setup` | `Discovery` | supporting | `references/legacy/setup-gbrain.md` |
| `/sync-gbrain` | `memory-sync` | `Discovery` | supporting | `references/legacy/sync-gbrain.md` |

## Completeness invariant

Do not work from this dispatcher summary when a module is active. Read the referenced module completely, including its provenance marker, specialist workflow, lazy-phase directives, behavioral contract, and bug-fix overlays. The pinned 1.x shared onboarding wrapper is provenance-only and never runs during canonical execution.
