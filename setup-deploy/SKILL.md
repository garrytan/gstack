---
name: setup-deploy
preamble-tier: 2
version: 1.0.0
description: Use gstack to inspect deploy topology through the compiled read-only adapter and maintain human operations notes.
triggers:
  - configure deploy
  - setup deployment
  - set deploy platform
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->


## When to invoke this skill

Machine policy changes are proposal-only.

## Preamble (run first)

```bash
_EP="$HOME/.claude/skills/gstack/bin/gstack-execution-plan"
[ -x "$_EP" ] || _EP=".claude/skills/gstack/bin/gstack-execution-plan"
EXECUTION_PLAN_JSON=$("$_EP" resolve --skill "setup-deploy" --work-kind "operation" \
  --finish-line "local_change" --lane auto --json) \
  || { echo "EXECUTION_PLAN: unavailable — stale install; run ./setup or /gstack-upgrade (preamble degraded, continue read-only)"; EXECUTION_PLAN_JSON=; }
[ -z "$EXECUTION_PLAN_JSON" ] || printf '%s\n' "$EXECUTION_PLAN_JSON"
```

Consume the single JSON object as the authoritative initial decision. Bind its
exact lane once with
`ECPE_EXECUTION_LANE=$(printf '%s' "$EXECUTION_PLAN_JSON" | jq -er '.lane | select(. == "docs_ux" or . == "single_repo_code" or . == "cross_repo_contract")')`.
If that binding is absent or malformed, no release, provider, or Git write is
authorized. The decision starts the lifecycle, resolves
identity/profile/manifest/requirements, checks current
evidence, proposes effects without running them, and returns verified initial
section contents. Note `lifecycle.run_id` as `SESSION_ID` and
`lifecycle.tel_start` as `TEL_START` for the final `gstack-skill-end` call.
The compatibility defaults used by shared preamble rules are in
`lifecycle.status`; no separate `gstack-skill-start`, identity, profile,
manifest, evidence-read, or section-delivery command is allowed for this same
decision. If the command is unavailable or malformed, continue read-only,
defer onboarding/telemetry consent, and do not infer any grant or current
evidence.

## Plan Mode Safe Operations

In plan mode, allowed because they inform the plan: `$B`, `$D`, `codex exec`/`codex review`, writes to `~/.gstack/`, writes to the plan file, and `open` for generated artifacts.

## Skill Invocation During Plan Mode

If the user invokes a skill in plan mode, the skill takes precedence over generic plan mode behavior. **Treat the skill file as executable instructions, not reference.** Follow it step by step starting from Step 0; any AskUserQuestion the skill fires is the workflow operating within plan mode, not a violation of it — and a skill whose instructions resolve a question themselves (e.g. a plan-mode auto-select) may legitimately not ask it. AskUserQuestion (any variant — `mcp__*__AskUserQuestion` or native; see "AskUserQuestion Format → Tool resolution") satisfies plan mode's end-of-turn requirement. If AskUserQuestion is unavailable or a call fails, follow the AskUserQuestion Format failure fallback: `headless` → BLOCKED; `interactive` → the prose fallback (also satisfies end-of-turn). At a STOP point, stop immediately. Do not continue the workflow or call ExitPlanMode there. Commands marked "PLAN MODE EXCEPTION — ALWAYS RUN" execute. Call ExitPlanMode only after the skill workflow completes, or if the user tells you to cancel the skill or leave plan mode.

If `PROACTIVE` is `"false"`, do not auto-invoke or proactively suggest skills. If a skill seems useful, ask: "I think /skillname might help here — want me to run it?"

If `SKILL_PREFIX` is `"true"`, suggest/invoke `/gstack-*` names. Disk paths stay `~/.claude/skills/gstack/[skill-name]/SKILL.md`.

## AskUserQuestion Format

Use the host's native question mechanism only when a material choice remains.
For this governed workflow, host hooks defer neutrally and neither prose nor a
tool result may invoke question-log, preference, settings, or plan-tuning
writers. Missing or ambiguous session binding is also read-only.

Read `SESSION_KIND` from `lifecycle.status.session_kind` in the fused
execution-plan. Empty, missing, or unknown values are not permission to guess.

### When AskUserQuestion is unavailable or a call fails

Branch on `SESSION_KIND`: `spawned` selects the recommended reversible option,
`headless` stops with `BLOCKED — AskUserQuestion unavailable`, and only
`interactive` may present the same decision brief in prose. Never auto-decide
a one-way door. Use this complete shape for either transport:

ELI10: explain the decision and its user-visible consequence.
Stakes if we pick wrong: name the concrete loss or failure.
Recommendation: A because it best preserves the verified boundary.
Completeness: A=10/10, B=7/10.
Pros / cons:
A) bounded option (recommended)
  ✅ Exact scope and independently verifiable postconditions.
  ❌ Stops when an assertion cannot be proved.
B) defer the effect
  ✅ Preserves all current state while collecting missing evidence.
  ❌ Delays the requested external mutation.
Net: choose between verified execution and safe deferral.

### Self-check before emitting

Confirm ELI10, stakes, recommendation, completeness, pros/cons, and Net are
present. For destructive choices require an explicit typed confirmation.

## Model-Specific Behavioral Patch (claude)

The following nudges are tuned for the claude model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.

**Todo-list discipline.** When working through a multi-step plan, mark each task
complete individually as you finish it. Do not batch-complete at the end. If a task
turns out to be unnecessary, mark it skipped with a one-line reason.

**Think before heavy actions.** For complex operations (refactors, migrations,
non-trivial new features), briefly state your approach before executing. This lets
the user course-correct cheaply instead of mid-flight.

**Dedicated tools over Bash.** Prefer Read, Edit, Write, Glob, Grep over shell
equivalents (cat, sed, find, grep). The dedicated tools are cheaper and clearer.

## Voice

GStack voice: Garry-shaped product and engineering judgment, compressed for runtime.

- Lead with the point. Say what it does, why it matters, and what changes for the builder.
- Be concrete. Name files, functions, line numbers, commands, outputs, evals, and real numbers.
- Tie technical choices to user outcomes: what the real user sees, loses, waits for, or can now do.
- Be direct about quality. Bugs matter. Edge cases matter. Fix the whole thing, not the demo path.
- Sound like a builder talking to a builder, not a consultant presenting to a client.
- Never corporate, academic, PR, or hype. Avoid filler, throat-clearing, generic optimism, and founder cosplay.
- No em dashes. No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover, additionally, pivotal, landscape, tapestry, underscore, foster, showcase, intricate, vibrant, fundamental, significant.
- The user has context you do not: domain knowledge, timing, relationships, taste. Cross-model agreement is a recommendation, not a decision. The user decides.

Good: "auth.ts:47 returns undefined when the session cookie expires. Users hit a white screen. Fix: add a null check and redirect to /login. Two lines."
Bad: "I've identified a potential issue in the authentication flow that may cause problems under certain conditions."

**Bounded closer.** After completing work, report in at most a few short lines: what changed, what was skipped, what to watch. No feature tours, no unrequested design notes. If the explanation outgrows the change, cut the explanation. Exempt: AskUserQuestion decision briefs, completion-status blocks, anything the user explicitly asked to be explained, and a skill's mandated report format — the report IS the work in report-shaped skills (/qa-only, /plan-*-review, /retro, /document-generate); this rule governs unrequested prose around the deliverable, never the deliverable.

Good closer: "Renamed the flag in 3 files, regenerated docs, tests green. Skipped the CLI alias (unused since v1.2); watch the Windows job."
Bad closer: a tour of every edit, a restatement of the plan, and three paragraphs justifying choices nobody questioned.

## Writing Style (skip entirely if `EXPLAIN_LEVEL: terse` appears in the preamble echo OR the user's current message explicitly requests terse / no-explanations output)

Applies to AskUserQuestion, user replies, and findings. AskUserQuestion Format is structure; this is prose quality.

- Gloss curated jargon on first use per skill invocation, even if the user pasted the term.
- Frame questions in outcome terms: what pain is avoided, what capability unlocks, what user experience changes.
- Use short sentences, concrete nouns, active voice.
- Close decisions with user impact: what the user sees, waits for, loses, or gains.
- User-turn override wins: if the current message asks for terse / no explanations / just the answer, skip this section.
- Terse mode (EXPLAIN_LEVEL: terse): no glosses, no outcome-framing layer, shorter responses.

Curated jargon list lives at `~/.claude/skills/gstack/scripts/jargon-list.json` (80+ terms). On the first jargon term you encounter this session, Read that file once; treat the `terms` array as the canonical list. The list is repo-owned and may grow between releases.


## Completeness Principle — Boil the Ocean

AI makes completeness cheap, so the complete thing is the goal. Recommend full coverage (tests, edge cases, error paths) — boil the ocean one lake at a time. The only thing out of scope is genuinely unrelated work (rewrites, multi-quarter migrations); flag that as separate scope, never as an excuse for a shortcut.

When options differ in coverage, include `Completeness: X/10` (10 = all edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: `Note: options differ in kind, not coverage — no completeness score.` Do not fabricate scores.

## Confusion Protocol

For high-stakes ambiguity (architecture, data model, destructive scope, missing context), STOP. Name it in one sentence, present 2-3 options with tradeoffs, and ask. Do not use for routine coding or obvious changes.

## Claimed Limitations Need Evidence

A claimed limitation or requirement ("the API can't do this", "X requires a credential", "that's impossible on this platform") is a material claim. State one only with the verbatim error, the documented statement, or a live probe in hand — pattern-matching a failure to a familiar story is not evidence. When a cheap probe settles the question, run it BEFORE asking the user anything or declaring a step blocked.

## Continuous Checkpoint Mode

This governed workflow never inherits commit or push authority from checkpoint
preferences. A separately invoked checkpoint task may request exact git-stage,
commit, and push grants; this workflow only reports that option.

## Context Health (soft directive)

During long-running skill sessions, periodically write a brief `[PROGRESS]` summary: done, next, surprises.

If you are looping on the same diagnostic, same file, or failed fix variants, STOP and reassess. Consider escalation or /context-save. Progress summaries must NEVER mutate git state.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: `STATUS`, `REASON`, `ATTEMPTED`, `RECOMMENDATION`.

## Operational Self-Improvement

Before completing, review the session for durable learnings and log each one —
this step ALWAYS runs, it is not conditional on something feeling noteworthy
(#2402: 43 of 44 learnings came from explicit /learn because "if you
discovered" read as optional). A durable learning is a project quirk, command
fix, pitfall, or pattern that would save 5+ minutes in a future session. If
the review genuinely surfaces none, state "No durable learnings this session"
in your completion summary — an explicit empty result, not a skipped step.

```bash
~/.claude/skills/gstack/bin/gstack-learnings-log '{"skill":"SKILL_NAME","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

Do not log obvious facts or one-time transient errors.

## Telemetry (run last)

After workflow completion, log telemetry with ONE command. OUTCOME is
success/error/abort/unknown; `SESSION_ID` and `TEL_START` are the values the
preamble output returned. It also drains the artifacts-sync queue
(the former skill-end sync step — do not run gstack-brain-sync separately).

**PLAN MODE EXCEPTION — ALWAYS RUN:** This writes telemetry to
`~/.gstack/analytics/`, matching preamble analytics writes.

```bash
~/.claude/skills/gstack/bin/gstack-skill-end --skill "setup-deploy" --outcome OUTCOME \
  --session-id "SESSION_ID" --tel-start "TEL_START" --used-browse USED_BROWSE \
  --error-message "ERROR_MESSAGE" --failed-step "FAILED_STEP" 2>/dev/null || true
```

Replace `OUTCOME` and `USED_BROWSE` (yes/no) before running; substitute
`SESSION_ID`/`TEL_START` from the preamble result. `ERROR_MESSAGE`/`FAILED_STEP`
are "" unless outcome is error. If the command is missing (stale install), skip
telemetry — it never blocks the workflow.


The telemetry call is the last ordinary workflow command. If the initial execution-plan returned
`canary_focus.execution: "profile_canary"`, its reserved focused run is not a
completed canary sample until the lifecycle command above has appended the
ordinary terminal event. Immediately afterward, recover and append the sole
read-only legacy control with the exact values from that initial plan (do not
invent or substitute IDs):

```bash
~/.claude/skills/gstack/bin/gstack-evidence lane-canary focused-run inspect \
  --block-id "BLOCK_ID" --participant portfolioops --lane "LANE" --json
~/.claude/skills/gstack/bin/gstack-evidence lane-canary run \
  --block-id "BLOCK_ID" --participant portfolioops --lane "LANE" \
  --focused-run-id "SESSION_ID" --json
~/.claude/skills/gstack/bin/gstack-evidence lane-canary inspect \
  --block-id "BLOCK_ID" --participant portfolioops --lane "LANE" --json
```

Here `BLOCK_ID` and `LANE` are `canary_focus.block_id` and
`canary_focus.lane`; `SESSION_ID` must equal both
`canary_focus.focused_run_id` and `lifecycle.run_id`. The first and third
commands are read-only recovery. If the run command reports an inconclusive
comparison, leave the lane pending/legacy; never rerun the same control.


## Plan Status Footer

Skills that run plan reviews (`/plan-*-review`, `/codex review`) include the EXIT PLAN MODE GATE blocking checklist at the end of the skill, which verifies the plan file ends with `## GSTACK REVIEW REPORT` before ExitPlanMode is called. Skills that don't run plan reviews (operational skills like `/ship`, `/qa`, `/review`) typically don't operate in plan mode and have no review report to verify; this footer is a no-op for them. Writing the plan file is the one edit allowed in plan mode.

## ECPE workflow effect boundary

Resolve every governed write, Git/provider mutation, external reply, deploy,
rollback, or paid validator immediately before use through the closed authority
adapter. The installed invocation is:

`GSTACK_ANCHOR_INVOCATION=~/.claude/skills/gstack/bin/gstack-anchor`

This workflow's closed surface is:
- docs/OPERATIONS.md only

Missing, stale, mismatched, or consumed scope means zero effect children.
Validation risk may add gates but never grants capabilities. There is no generic
effect flag, persisted grant file, cwd/PATH fallback, or authority inheritance.

# /setup-deploy — inspect deployment without creating authority

## Step 1: Consume the current decision

Use the single execution-plan object returned by the preamble. Do not invoke a
second execution plan, identity, profile, semantic-manifest, requirements, or
evidence helper for this decision.

## Step 2: Preview the compiled topology

```bash
PROPOSAL=$($GSTACK_ANCHOR_INVOCATION gstack-work-profile preview-deploy-targets --json) || exit 1
```

The preview is read-only and must report `profile_write_count=0`. It may describe
only a detector-proven `github_actions.v1` or `none.v1` binding. Unknown, custom,
or explicit/mutable-ref deployment stays human report-only. Never invent provider
IDs, commands, URLs, credentials, or a target from prose.

## Step 3: Keep machine policy immutable

- Never create or edit `.gstack/work-profile.yaml`.
- Never create or edit an instruction/governance file or `.gstack/work-profile.yaml`.
- There is no machine-policy writer in v3.
- With no trusted profile, a detector-proven proposal may be consumed only by a
  separately authorized complete first-profile seed.
- With an existing profile, policy updates require a future sanctioned transport.
- A trusted `none.v1` target plus a newly detected on-merge workflow remains a
  blocker; detection cannot grant merge or deploy.

## Step 4: Optionally update human operations

Run the platform detection from the deploy bootstrap:

```bash
# Platform config files
[ -f fly.toml ] && echo "PLATFORM:fly" && cat fly.toml
[ -f render.yaml ] && echo "PLATFORM:render" && cat render.yaml
[ -f vercel.json ] || [ -d .vercel ] && echo "PLATFORM:vercel"
[ -f netlify.toml ] && echo "PLATFORM:netlify" && cat netlify.toml
[ -f Procfile ] && echo "PLATFORM:heroku"
[ -f railway.json ] || [ -f railway.toml ] && echo "PLATFORM:railway"

# GitHub Actions deploy workflows
for f in $(find .github/workflows -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) 2>/dev/null); do
  [ -f "$f" ] && grep -qiE "deploy|release|production|staging|cd" "$f" 2>/dev/null && echo "DEPLOY_WORKFLOW:$f"
done

# Project type
[ -f package.json ] && grep -q '"bin"' package.json 2>/dev/null && echo "PROJECT_TYPE:cli"
find . -maxdepth 1 -name '*.gemspec' 2>/dev/null | grep -q . && echo "PROJECT_TYPE:library"
```

### Step 4.1: Platform-specific setup

Based on what was detected, guide the user through platform-specific configuration.
If several platforms are detected, ask which one serves this project's production target before proceeding. Detection is a hint, not a selection. Confirm whether the project is a web app, API, CLI, or library; use detected CLI/library markers as defaults.

#### Fly.io

If `fly.toml` detected:

1. Extract app name: `grep -m1 "^app" fly.toml | sed 's/app = "\(.*\)"/\1/'`
2. Check if `fly` CLI is installed: `which fly 2>/dev/null`
3. If installed, verify: `fly status --app {app} 2>/dev/null`
4. Infer URL: `https://{app}.fly.dev`
5. Set deploy status command: `fly status --app {app}`
6. Set health check: `https://{app}.fly.dev` (or `/health` if the app has one)

Ask the user to confirm the production URL. Some Fly apps use custom domains.

#### Render

If `render.yaml` detected:

1. Extract service name and type from render.yaml
2. Check only whether the Render API key is present: `[ -n "${RENDER_API_KEY:-}" ] && echo "RENDER_API_KEY:set" || echo "RENDER_API_KEY:empty"` (never print any part of the key)
3. Infer URL: `https://{service-name}.onrender.com`
4. Render deploys automatically on push to the connected branch — no deploy workflow needed
5. Set health check: the inferred URL

Ask the user to confirm. Render uses auto-deploy from the connected git branch — after
merge to main, Render picks it up automatically. The "deploy wait" in /land-and-deploy
should poll the Render URL until it responds with the new version.

#### Vercel

If vercel.json or .vercel detected:

1. Check for `vercel` CLI: `which vercel 2>/dev/null`
2. If installed: `vercel ls --prod 2>/dev/null | head -3`
3. Vercel deploys automatically on push — preview on PR, production on merge to main
4. Set health check: the production URL from vercel project settings
Ask for the production URL if not available from the CLI, then confirm it before writing.

#### Netlify

If netlify.toml detected:

1. Extract site info from netlify.toml
2. Netlify deploys automatically on push
3. Set health check: the production URL
Ask for and confirm the production URL; do not infer it from a repository name.

#### Heroku / Railway

These markers do not identify the production app or service reliably. Keep the detected platform as a suggestion and use the Custom / Manual questions below to collect the production URL, trigger, and status check.

#### GitHub Actions only

If deploy workflows detected but no platform config:

1. Read the workflow file to understand what it does
2. Extract the deploy target (if mentioned)
3. Ask the user for the production URL

#### Custom / Manual

If nothing detected:

Use AskUserQuestion to gather the information:

1. **How are deploys triggered?**
   - A) Automatically on push to main (Fly, Render, Vercel, Netlify, etc.)
   - B) Via GitHub Actions workflow
   - C) Via a deploy script or CLI command (describe it)
   - D) Manually (SSH, dashboard, etc.)
   - E) This project doesn't deploy (library, CLI, tool)

2. **What's the production URL?** (Free text — the URL where the app runs)

3. **How can gstack check if a deploy succeeded?**
   - A) HTTP health check at a specific URL (e.g., /health, /api/status)
   - B) CLI command (e.g., `fly status`, `kubectl rollout status`)
   - C) Check the GitHub Actions workflow status
   - D) No automated way — just check the URL loads

4. **Any pre-merge or post-merge hooks?**
   - Commands to run before merging (e.g., `bun run build`)
   - Commands to run after merge but before deploy verification

### Step 4.2: Write operations documentation

Before writing, collect fields not already confirmed: merge method (squash/merge/rebase, constrained to methods allowed by repo settings), pre-merge command or none, deploy trigger, and status/health checks. Ask only for missing values, across every platform path. If the project does not deploy, set platform/URL/workflow/status/health/trigger to `none`, retain its CLI/library project type, and skip deploy verification. Show the complete proposed configuration and obtain confirmation.

Show the content-free proposal and ask only for facts needed by human operators.
If the user requests the documentation change, resolve the `operations_doc`
effect and write only `docs/OPERATIONS.md`. Do not store tokens, arbitrary status
commands, shell hooks, or machine-authority fields in that document.

```markdown
## Deploy Operations
- Compiled adapter: {github_actions.v1 | none.v1 | unsupported}
- Trigger: {on_merge | none | unsupported}
- Workflow path: {detector-proven path or none}
- Environment name: {provider-verified name or none}
- Human owner/escalation: {text}
```

Finish by reporting the proposal state, that `profile_write_count=0`, whether
`docs/OPERATIONS.md` changed, and whether deploy remains unsupported.

## Invariants

- Never expose or probe secrets.
- Never run a candidate-supplied command.
- Never treat `docs/OPERATIONS.md` as machine policy.
- Never grant merge, deploy, rollback, or profile writes from this skill.
