---
name: plan-arch-review
description: Advisory second-pass software architecture review for plans after /plan-eng-review. Use when you want ADR-lite decisions, C4-lite diagrams, domain boundaries, async/distributed systems checks, backpressure analysis, and operational readiness without modifying upstream gstack or creating a shipping gate.
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# Plan Arch Review

This skill is a **companion** to gstack, not a replacement for it.

Use it after `/plan-eng-review` when the plan is technically plausible but you want
one more pass from a **systems architect** lens:

- architecture decisions made explicit
- subsystem boundaries and coupling called out
- distributed systems risks checked when relevant
- overload, retries, and backpressure reviewed
- operational readiness made concrete

This skill is **advisory only**. It does not write to gstack dashboards, review logs,
or shipping gates. It should not edit repo-tracked files unless the user explicitly
asks for a follow-up change.

## When To Use

Use this skill when the user:

- asks for an architecture second opinion after planning
- wants a deeper architecture pass than `/plan-eng-review`
- wants ADR-lite or C4-lite outputs
- is planning async jobs, queues, workers, webhooks, or multi-service flows
- wants to know what is overbuilt, under-specified, or operationally risky

Do not use this skill as a generic code review or product review. It is for
**plan-stage architecture rigor**.

## Inputs And Outputs

Primary inputs:

- the active plan doc, if one exists
- targeted repo context around the planned change
- optional gstack design artifacts in `~/.gstack/projects/...`

Primary outputs:

- inline executive verdict
- numbered findings with severity and confidence
- a "patch the plan like this" section with suggested text or bullets
- an advisory artifact written to:
  `~/.gstack/projects/{slug}/{user}-{branch}-arch-review-{timestamp}.md`

## Review Posture

Your default posture is:

- concise but opinionated
- architecture-first, not implementation-first
- boring by default
- skeptical of unnecessary infra
- skeptical of hand-wavy async flows
- skeptical of architecture astronautics

Always include a **"Not worth adding"** section when the temptation to over-architect
is part of the story.

## Step 1: Ground In The Actual Plan

Start by locating the best available plan artifact.

1. If the conversation already names an active plan file, use that.
2. Otherwise detect repo context:

```bash
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-' || echo "no-branch")
SLUG=$(~/.claude/skills/gstack/browse/bin/remote-slug 2>/dev/null || basename "$ROOT")
USER_NAME=$(whoami)
echo "ROOT=$ROOT"
echo "BRANCH=$BRANCH"
echo "SLUG=$SLUG"
```

3. Search for likely plan/design artifacts, newest first:

```bash
_CANDIDATES=$(find "$HOME/.gstack/projects/$SLUG" -maxdepth 1 -type f \
  \( -name "*-$BRANCH-design-*.md" -o -name "*-$BRANCH-plan-*.md" -o -name "*-$BRANCH-*.md" \) \
  -print 2>/dev/null)
[ -n "$_CANDIDATES" ] && while IFS= read -r _F; do
  printf '%s\0' "$_F"
done <<< "$_CANDIDATES" | xargs -0 ls -t 2>/dev/null | head -10
```

4. If nothing is found there, search the repo for plan-like docs:

```bash
_REPO_DOCS=$(find "$ROOT" -maxdepth 3 -type f \
  \( -iname "*plan*.md" -o -iname "*design*.md" -o -iname "*spec*.md" \) \
  -print 2>/dev/null)
[ -n "$_REPO_DOCS" ] && while IFS= read -r _F; do
  printf '%s\0' "$_F"
done <<< "$_REPO_DOCS" | xargs -0 ls -t 2>/dev/null | head -10
```

5. Choose the single best candidate and read it first.

If no plan doc exists, say so plainly and continue with a **repo-context-only**
architecture memo. Do not pretend there was a plan.

## Step 2: Load Only Targeted Context

After reading the plan, inspect only the repo areas needed to review it:

- relevant services, modules, or app boundaries
- queue/job/webhook config if async work is proposed
- deployment, observability, or CI config if operational claims are proposed
- schemas/types/interfaces that define system boundaries

Prefer targeted reads and `rg` searches over broad repo wandering.

Good search prompts:

- symbol or subsystem names mentioned in the plan
- `queue|worker|job|webhook|async|retry|outbox|inbox|saga`
- `otel|opentelemetry|metrics|logging|feature flag|slo|runbook`
- `routes|api|controller|service|handler|consumer|processor`

## Step 3: Decide Whether Distributed Systems Review Goes Deep

Read [references/architecture-lenses.md](references/architecture-lenses.md) before
writing findings.

Always run the **core architecture pass**.

Only run the **deep distributed systems pass** when the plan or repo context includes
clear indicators such as:

- queues
- workers
- background jobs
- webhooks
- multi-service workflows
- async processing
- eventual consistency
- external event delivery

If those indicators are absent, do **not** invent outbox/saga/backpressure issues.
Stay with:

- ADR-lite
- C4-lite
- boundary/coupling review
- operational readiness

## Step 4: Review Sections

Work through these sections in order.

### 1. Architecture Decisions

Check whether the plan makes the important decisions explicit:

- chosen approach
- rejected alternatives
- why this approach wins
- rollback trigger, kill switch, or "we chose wrong" signal

If the plan lacks this, produce an **ADR-lite** block with:

- Decision
- Alternatives considered
- Rationale
- Rollback trigger

### 2. Boundaries And Coupling

Evaluate:

- subsystem ownership
- coupling between modules/services
- boundary leaks
- unclear data ownership
- duplicated responsibilities
- missing state-transition clarity

When the domain is workflow-heavy, identify:

- bounded contexts
- key domain events
- ownership seams
- core state transitions

### 3. Async And Distributed Risks

Run this section lightly unless deep review was triggered.

Evaluate:

- idempotency expectations
- retries and retry storms
- deduplication needs
- outbox/inbox patterns where delivery guarantees matter
- saga or compensation needs for multi-step workflows
- user-visible consistency tradeoffs

Be specific about when these are **required**, **nice to have**, or **not worth it**.

### 4. Capacity And Backpressure

Evaluate:

- queue growth and consumer lag
- rate limits and burst behavior
- load shedding or overload behavior
- retry fan-out
- synchronous bottlenecks that should move off the request path
- hotspots likely to fail under success, not just under bugs

### 5. Operational Readiness

Evaluate:

- observability, metrics, tracing, structured logs
- alertability and "how we know this is broken"
- rollback path or reversibility
- feature flag / staged rollout where useful
- runbook-level clarity

## Step 5: Output Format

Always produce a compact advisory memo with these sections:

1. `## Verdict`
2. `## Findings`
3. `## Patch The Plan Like This`
4. `## ADR-lite`
5. `## C4-lite / Diagram Prompts`
6. `## Not Worth Adding`

### Verdict

Use one of:

- `READY WITH MINOR PATCHES`
- `NOT READY, IMPORTANT GAPS`
- `OVER-ARCHITECTED`
- `UNDER-SPECIFIED`

### Findings

Number findings. Use this format:

`1. [P1] (confidence: 8/10) Missing idempotency story for webhook retries.`

Severity guide:

- `P1` architectural risk likely to cause production pain
- `P2` meaningful gap or ambiguity
- `P3` polish or maintainability improvement

Confidence guide:

- `8-10` strong evidence from plan/repo
- `5-7` likely, but verify
- `<5` avoid unless the downside is severe

### Patch The Plan Like This

This section is for **suggested edits**, not actual file edits.

Give concrete bullets or short markdown snippets the user can drop into the plan.
Prefer 3-8 bullets over a giant rewrite.

### ADR-lite

If the plan already contains a crisp decision record, summarize it.
If not, generate one in this format:

```markdown
## ADR-lite

- Decision:
- Alternatives considered:
- Rationale:
- Rollback trigger:
```

### C4-lite / Diagram Prompts

If the plan crosses subsystem boundaries, provide a minimal diagram scaffold:

- Context view: system, users, external dependencies
- Container view: app, worker, queue, DB, external APIs
- Component view: only if one container is internally complex

ASCII is preferred. Keep it simple.

### Not Worth Adding

Name tempting ideas that should **not** be added now, for example:

- sagas for a single-process CRUD flow
- outbox for a purely synchronous local-only feature
- service splits without ownership pressure
- tracing everywhere when logs + metrics are enough for v1

## Step 6: Save The Advisory Artifact

After producing the memo, save it to the gstack-style project area.

```bash
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-' || echo "no-branch")
SLUG=$(~/.claude/skills/gstack/browse/bin/remote-slug 2>/dev/null || basename "$ROOT")
USER_NAME=$(whoami)
STAMP=$(date +%Y%m%d-%H%M%S)
OUT_DIR="$HOME/.gstack/projects/$SLUG"
OUT_FILE="$OUT_DIR/${USER_NAME}-${BRANCH}-arch-review-${STAMP}.md"
mkdir -p "$OUT_DIR"
echo "$OUT_FILE"
```

Write the full memo to that file.

If writing fails, still provide the full memo inline and say the save failed.

## Guardrails

- Do not write to gstack review logs or dashboards.
- Do not change `/ship` semantics.
- Do not silently escalate this into a gate.
- Do not drift into generic code review.
- Do not recommend distributed systems machinery without a concrete trigger.
- Do not modify the plan file unless the user explicitly asks you to apply the patch suggestions afterward.

## Good Outcomes

A good run of this skill feels like:

- "Now the architecture decisions are explicit."
- "Now I know which async risks are real and which are fake sophistication."
- "Now the plan has just enough diagrams to be buildable."
- "Now I know what not to add."

