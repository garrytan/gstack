---
name: design
description: >-
  Explore, generate, critique, or implement product design. Use for design systems, visual alternatives, HTML, live web UI, accessibility, or iOS HIG review.
---

# GStack Design

Infer the existing design thesis first, then create or audit only the requested surface.

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
| `Explore` | Competing design directions | The user needs alternatives and structured preference discovery before committing. | `references/legacy/design-shotgun.md` |
| `Generate` | A design system or visual artifact | The user wants a coherent new artifact without product-code implementation. | `references/legacy/design-consultation.md`, `references/legacy/diagram.md`, `references/legacy/make-pdf.md` |
| `Critique` | A plan, live surface, or iOS interface | The user wants design judgment and evidence without authorizing implementation changes. | `references/legacy/plan-design-review.md`, `references/legacy/design-review.md`, `references/legacy/ios-design-review.md` |
| `Implement` | Production HTML or an existing web UI | The user authorizes design code generation or validated visual fixes. | `references/legacy/design-html.md`, `references/legacy/design-review.md` |

## Hard rules

- Infer the design system before scoring deviations.
- Treat a coherent design thesis as valid even when headings use different language.
- Do not substitute generated mockups for inspection of an existing implementation.
- Use host-native image generation when it is available and materially useful, but keep it optional. Never install an image provider, local model, weights, GPU runtime, or background image server; continue with HTML/CSS, screenshots, diagrams, wireframes, or code-generated variants when no native tool exists.

## Internal specialist routing aliases

Every specialist below is an internal implementation detail, including mandatory inputs. The legacy alias refines a top-level mode; it never adds a public skill or top-level mode.

| Legacy invocation | Legacy alias | Public mode | Role | Module |
|---|---|---|---|---|
| `/design-consultation` | `consult` | `Generate` | mandatory | `references/legacy/design-consultation.md` |
| `/design-shotgun` | `alternatives` | `Explore` | mandatory | `references/legacy/design-shotgun.md` |
| `/design-html` | `html` | `Implement` | mandatory | `references/legacy/design-html.md` |
| `/plan-design-review` | `plan-review` | `Critique` | mandatory | `references/legacy/plan-design-review.md` |
| `/design-review` | `live-review` | `Implement` | mandatory | `references/legacy/design-review.md` |
| `/ios-design-review` | `ios-review` | `Critique` | mandatory | `references/legacy/ios-design-review.md` |
| `/diagram` | `diagram` | `Generate` | supporting | `references/legacy/diagram.md` |
| `/make-pdf` | `pdf` | `Generate` | supporting | `references/legacy/make-pdf.md` |

## Completeness invariant

Do not work from this dispatcher summary when a module is active. Read the referenced module completely, including its provenance marker, specialist workflow, lazy-phase directives, behavioral contract, and bug-fix overlays. The pinned 1.x shared onboarding wrapper is provenance-only and never runs during canonical execution.
