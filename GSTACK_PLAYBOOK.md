# GStack Playbook

Practical guide for using gstack from idea to shipped product.

If your host installs prefixed skills, replace `/skill-name` with `gstack-skill-name`.

## Core Rule

- `office-hours` decides what problem you are really solving.
- `plan-ceo-review` decides what should be in scope.
- `plan-eng-review` decides how to build it.
- `review` checks the real diff.
- `qa` checks the real app.
- `ship` and `land-and-deploy` finish the job.

## Default Workflow

### 1. Start from zero

Use when the idea is fuzzy or you want sharper framing.

```text
/office-hours I want to build an internal support copilot for our sales team.
```

Pass:
- Idea or problem statement
- Optional context: startup/business vs builder/hackathon

Output:
- Design doc in `~/.gstack/projects/...`

### 2. Challenge scope

Use if scope, ambition, or wedge is still uncertain.

```text
/plan-ceo-review hold scope on this plan
```

Pass:
- The current plan or design doc
- Optional mode:
  - `scope expansion`
  - `selective expansion`
  - `hold scope`
  - `scope reduction`

Output:
- Updated plan guidance
- Review report in the plan file
- Sometimes a separate CEO plan artifact

### 3. Make it buildable

Use after the direction is approved.

```text
/plan-eng-review break this into PR-sized migration phases with rollback points
```

Pass:
- The approved plan
- Optional focus:
  - architecture
  - migration phases
  - tests
  - performance
  - failure modes
  - rollout and rollback

Output:
- Buildable implementation plan
- Test plan artifact for `/qa`

### 4. Add specialist reviews only when needed

For user-facing UI:

```text
/plan-design-review focus on onboarding, empty states, and mobile
```

For developer-facing products:

```text
/plan-devex-review dx polish for first-time API users
```

If you want the whole plan stack automatically:

```text
/autoplan
```

### 5. Build

Implement from the reviewed plan file, not from scattered notes.

Recommended pattern:
- Build in phases
- Keep diffs small
- Re-run `/review` after each meaningful phase

### 6. Debug when something breaks

```text
/investigate checkout sometimes double-submits on refresh
```

Use for:
- bugs
- regressions
- 500s
- confusing behavior

### 7. Review the actual diff

```text
/review
```

Optional focus:

```text
/review focus on concurrency and trust boundaries
```

Use after code exists, before merge.

### 8. QA the real app

If you want testing plus fixes:

```text
/qa
/qa https://staging.myapp.com
```

If you want report-only:

```text
/qa-only
/qa-only https://staging.myapp.com
```

Useful modes:

```text
/qa --quick
/qa --regression baseline.json
```

If authentication is needed:

```text
/setup-browser-cookies
/setup-browser-cookies github.com
```

### 9. Run specialist post-build audits if needed

Visual polish:

```text
/design-review https://myapp.com
```

Developer onboarding:

```text
/devex-review try the quickstart for this CLI
```

Performance:

```text
/benchmark https://myapp.com
```

Security:

```text
/cso
/cso comprehensive
```

### 10. Ship

Create or update the PR and do release prep:

```text
/ship
```

### 11. Merge and deploy

One-time deploy setup:

```text
/setup-deploy
```

Then:

```text
/land-and-deploy
```

### 12. Watch production

```text
/canary https://myapp.com
```

### 13. Sync docs

```text
/document-release
```

### 14. Close the loop

Project retro:

```text
/retro
```

Cross-project retro:

```text
/retro global
```

## Decision Tree

### If the problem is still fuzzy

- Run `/office-hours`

### If scope is unclear

- Add `/plan-ceo-review`

### If you need a technical plan

- Run `/plan-eng-review`

### If UI/UX is central

- Add `/plan-design-review`

### If developers are the user

- Add `/plan-devex-review`

### If you want all plan reviews automatically

- Run `/autoplan`

### If code already exists and you want risk review

- Run `/review`

### If you want real browser testing

- Run `/qa` or `/qa-only`

### If something is broken and root cause is unclear

- Run `/investigate`

### If the branch is ready to land

- Run `/ship`

## Invocation Cheat Sheet

| Skill | What to pass | Example |
|-------|--------------|---------|
| `/office-hours` | idea/problem statement | `/office-hours We want to simplify support handoffs.` |
| `/plan-ceo-review` | plan + optional scope mode | `/plan-ceo-review scope reduction` |
| `/plan-eng-review` | plan + optional technical focus | `/plan-eng-review focus on migration safety` |
| `/plan-design-review` | plan + optional UI focus | `/plan-design-review focus on mobile and empty states` |
| `/plan-devex-review` | plan + optional DX mode | `/plan-devex-review dx triage for this CLI` |
| `/autoplan` | current plan | `/autoplan` |
| `/design-consultation` | product, audience, desired feel | `/design-consultation B2B analytics app, serious and high-trust` |
| `/design-shotgun` | screen/page description | `/design-shotgun pricing page for a dev tools product` |
| `/design-html` | approved design, mockup, or description | `/design-html build the approved dashboard design` |
| `/investigate` | bug/error/symptom | `/investigate users get logged out after password reset` |
| `/review` | usually nothing, optional focus | `/review` |
| `/qa` | optional URL or mode | `/qa https://staging.myapp.com` |
| `/qa-only` | optional URL | `/qa-only https://staging.myapp.com` |
| `/design-review` | live URL | `/design-review https://myapp.com` |
| `/devex-review` | onboarding or docs target | `/devex-review try the getting-started flow` |
| `/benchmark` | usually URL | `/benchmark https://myapp.com` |
| `/cso` | optional mode | `/cso daily` |
| `/ship` | usually nothing | `/ship` |
| `/setup-deploy` | usually nothing | `/setup-deploy` |
| `/land-and-deploy` | usually nothing | `/land-and-deploy` |
| `/canary` | production URL | `/canary https://myapp.com` |
| `/document-release` | usually nothing | `/document-release` |
| `/retro` | optional `global` | `/retro global` |
| `/learn` | plain-English action | `/learn show project learnings` |
| `/open-gstack-browser` | usually nothing | `/open-gstack-browser` |
| `/setup-browser-cookies` | optional domain | `/setup-browser-cookies github.com` |
| `/pair-agent` | target agent in plain English | `/pair-agent connect Codex to this browser session` |
| `/careful` | nothing | `/careful` |
| `/freeze` | directory path | `/freeze src/payments` |
| `/guard` | usually a directory path | `/guard src/billing` |
| `/unfreeze` | nothing | `/unfreeze` |
| `/context-save` | optional note | `/context-save save release prep context` |
| `/context-restore` | optional hint | `/context-restore resume payment refactor` |
| `/plan-tune` | plain-English preference | `/plan-tune stop asking repeated scope questions` |
| `/gstack-upgrade` | nothing | `/gstack-upgrade` |

## Recommended Flows

### New product

```text
/office-hours
/plan-ceo-review
/plan-eng-review
/plan-design-review or /plan-devex-review if needed
build
/review
/qa
/ship
/land-and-deploy
/document-release
/retro
```

### Internal refactor

```text
/plan-eng-review
build in phases
/review after each phase
/qa if behavior changed
/ship
```

### UI-heavy feature

```text
/office-hours
/plan-ceo-review
/plan-design-review
/plan-eng-review
build
/design-review
/qa
/ship
```

### API, SDK, CLI, docs feature

```text
/office-hours
/plan-ceo-review
/plan-devex-review
/plan-eng-review
build
/devex-review
/review
/ship
```

## Utility Notes

### `/browse`

`/browse` is a browser toolbelt, not just a one-shot skill. After invoking it, use `$B ...` commands.

Examples:

```text
$B goto https://myapp.com
$B snapshot -i
$B click @e3
$B screenshot /tmp/homepage.png
```

### Safety defaults

When work is risky:

```text
/careful
/freeze src/payments
```

Or both:

```text
/guard src/payments
```

### Context management

If work spans sessions:

```text
/context-save
/context-restore
```

## One-line Summary

Use `office-hours` to frame, `plan-ceo-review` to scope, `plan-eng-review` to build, `review` to check the diff, `qa` to test the app, and `ship` plus `land-and-deploy` to finish the job.
