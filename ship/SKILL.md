---
name: ship
preamble-tier: 4
version: 1.0.0
description: "Ship workflow: detect + merge base branch, run tests, review diff, bump VERSION, update CHANGELOG, commit, push, create PR. (gstack)"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
triggers:
  - ship it
  - create a pr
  - push to main
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->


## When to invoke this skill

Use when asked to ship, perform an
exact push, or create/update a PR. Deployment and landing
remain separate workflows.

## Preamble (run first)

```bash
_EP="$HOME/.claude/skills/gstack/bin/gstack-execution-plan"
[ -x "$_EP" ] || _EP=".claude/skills/gstack/bin/gstack-execution-plan"
EXECUTION_PLAN_JSON=$("$_EP" resolve --skill "ship" --work-kind "release" \
  --finish-line "pr_open" --lane auto --json) \
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

## Repo Ownership — See Something, Say Something

`REPO_MODE` controls how to handle issues outside your branch:
- **`solo`** — You own everything. Investigate and offer to fix proactively.
- **`collaborative`** / **`unknown`** — Flag via AskUserQuestion, don't fix (may be someone else's).

Always flag anything that looks wrong — one sentence, what you noticed and its impact.

## Search Before Building

Before building anything unfamiliar, **search first.** See `~/.claude/skills/gstack/ETHOS.md`.
- **Layer 1** (tried and true) — don't reinvent. **Layer 2** (new and popular) — scrutinize. **Layer 3** (first principles) — prize above all.

**The reuse ladder — before writing new code, stop at the first rung that holds:**
1. A helper, util, or pattern already in this repo — re-implementing what's a few files over is the most common slop.
2. The standard library.
3. A native platform feature (CSS over JS, DB constraint over app code, `<input type="date">` over a picker lib).
4. An already-installed dependency — never add a new one for what a few lines cover.

Then build the complete version of what remains.

**Bug fixes hit root cause, not symptom:** one guard in the shared function beats a guard in every caller — grep the callers, fix it once where they all route through.

**Eureka:** When first-principles reasoning contradicts conventional wisdom, name it and log:
```bash
jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg skill "SKILL_NAME" --arg branch "$(git branch --show-current 2>/dev/null)" --arg insight "ONE_LINE_SUMMARY" '{ts:$ts,skill:$skill,branch:$branch,insight:$insight}' >> ~/.gstack/analytics/eureka.jsonl 2>/dev/null || true
```

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
~/.claude/skills/gstack/bin/gstack-skill-end --skill "ship" --outcome OUTCOME \
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
- readiness
- separately resolved delivery capabilities

Missing, stale, mismatched, or consumed scope means zero effect children.
Validation risk may add gates but never grants capabilities. There is no generic
effect flag, persisted grant file, cwd/PATH fallback, or authority inheritance.

## Step 0: Detect platform and base branch

First, detect the git hosting platform from the remote URL:

```bash
git remote get-url origin 2>/dev/null
```

- If the URL contains "github.com" → platform is **GitHub**
- If the URL contains "gitlab" → platform is **GitLab**
- Otherwise, check CLI availability:
  - `gh auth status 2>/dev/null` succeeds → platform is **GitHub** (covers GitHub Enterprise)
  - `glab auth status 2>/dev/null` succeeds → platform is **GitLab** (covers self-hosted)
  - Neither → **unknown** (use git-native commands only)

Determine which branch this PR/MR targets, or the repo's default branch if no
PR/MR exists. Use the result as "the base branch" in all subsequent steps.

**If GitHub:**
1. `gh pr view --json baseRefName -q .baseRefName` — if succeeds, use it
2. `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` — if succeeds, use it

**If GitLab:**
1. `glab mr view -F json 2>/dev/null` and extract the `target_branch` field — if succeeds, use it
2. `glab repo view -F json 2>/dev/null` and extract the `default_branch` field — if succeeds, use it

**Git-native fallback (if unknown platform, or CLI commands fail):**
1. `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'`
2. If that fails: `git rev-parse --verify origin/main 2>/dev/null` → use `main`
3. If that fails: `git rev-parse --verify origin/master 2>/dev/null` → use `master`

If all fail, fall back to `main`.

Print the detected base branch name. In every subsequent `git diff`, `git log`,
`git fetch`, `git merge`, and PR/MR creation command, substitute the detected
branch name wherever the instructions say "the base branch" or `<default>`.

---

# Ship: Fully Automated Ship Workflow

You are running the `/ship` workflow. Automate routine work without confirmation. The user said `/ship` which authorizes that work, but does not waive the explicit safety and user-decision gates below. Run through to the PR URL unless a gate requires input or reports a blocker.

### ECPE T0 observation batch

Maintain one bounded in-memory `ECPE_BATCH_JSON` array for content-free
decision, receipt, helper/model-spawn, validator, and gate observations. Use
only closed IDs/enums and measured numbers; never include prompts, code,
filenames, tool arguments, logs, diffs, secrets, or narrative. Do not spawn a
telemetry process per step. Flush the array once by adding
`--ecpe-batch-json "$ECPE_BATCH_JSON"` to the existing final
`gstack-skill-end` call. Omit unavailable fields and never infer token counts.
Git/provider effects are recorded by their adapters, not by this host batch.

**Stop for blockers and explicit decision gates.** Follow every STOP or AskUserQuestion instruction in the steps below and the preamble. Common gates include:
- On the base branch (abort)
- Merge conflicts that can't be auto-resolved (stop, show conflicts)
- In-branch test failures (pre-existing failures are triaged, not auto-blocking)
- Pre-landing review finds ASK items that need user judgment
- MINOR or MAJOR version bump needed (ask — see Step 12)
- Greptile review comments that need user decision (complex fixes, false positives)
- AI-assessed coverage below target (see Step 7 for minimum/target decisions)
- Plan items NOT DONE or UNVERIFIABLE (see Step 8)
- Plan verification failures (see Step 8.1)

**Never stop for:**
- Uncommitted changes (always include them)
- Version bump choice (auto-pick MICRO or PATCH — see Step 12)
- CHANGELOG content (auto-generate from diff)
- Commit message approval (auto-commit)
- Multi-file changesets (auto-split into bisectable commits)
- TODOS.md reporting (report only; maintenance is a separate explicit task)
- Auto-fixable review findings (dead code, N+1, stale comments — fixed automatically)
- Test coverage gaps within target threshold (auto-generate and commit, or flag in PR body)

**Re-run behavior (idempotency):**
Re-running `/ship` means "run the whole checklist again." Every verification step
(tests, coverage audit, plan completion, pre-landing review, adversarial review,
VERSION/CHANGELOG check, TODOS, document-release) runs on every invocation.
Only *actions* are idempotent:
- Step 12: If VERSION already bumped, skip the bump but still read the version
- Step 17: If already pushed, skip the push command
- Step 19: If PR exists, update the body instead of creating a new PR
Never skip a verification step because a prior `/ship` run already performed it.

---

## Section index — Read each section when its situation applies

This skill is a decision-tree skeleton. The steps below point to on-demand
sections. Read a section in full before doing its step; do not work from memory.

| When | Read this section |
|------|-------------------|
| the ship target is an Apple platform app (.xcodeproj, .xcworkspace, or an app-product Swift package) — read BEFORE Step 1's branch gate and any preflight; store distribution never routes through the branch/PR ceremony | `sections/apple-release.md` |
| running the test suites and (if prompt files changed) the eval suites (Steps 4-6) | `sections/tests.md` |
| auditing test coverage of the diff (Step 7) | `sections/test-coverage.md` |
| auditing plan completion, verification, and scope drift (Step 8) | `sections/plan-completion.md` |
| the pre-landing review and specialist dispatch (Step 9) | `sections/review-army.md` |
| addressing Greptile review comments when a PR exists (Step 10) | `sections/greptile.md` |
| the adversarial review and learnings capture (Step 11) | `sections/adversarial.md` |
| writing the CHANGELOG entry (Step 13) | `sections/changelog.md` |
| reusing the Step 11.5 documentation result (Step 18) and then creating or updating the PR/MR (Step 19) | `sections/pr-body.md` |

---

## Step 0.9: Apple target detection

If the repository contains an `.xcodeproj`, `.xcworkspace`, or an app-product
Swift package, read `~/.claude/skills/gstack/ship/sections/apple-release.md`
before the branch gate. Inspection is report-only. An explicit App Store or
TestFlight effect returns `adapter_operation_unsupported` with zero children;
repository landing continues through the normal branch pipeline.

## Step 1: Pre-flight

1. Check the current branch. If on the base branch or the repo's default branch, **abort**: "You're on the base branch. Ship from a feature branch."

2. Run `git status` (never use `-uall`). Uncommitted changes are always included — no need to ask.

3. Run `git diff <base>...HEAD --stat` and `git log <base>..HEAD --oneline` to understand what's being shipped.

4. Check review readiness:

## Review Readiness Dashboard

During pre-flight, read the existing review log and config to display readiness; the new pre-landing review runs in Step 9.

```bash
~/.claude/skills/gstack/bin/gstack-review-read
```

Parse the output. Find the most recent entry for each skill (plan-ceo-review, plan-eng-review, review, plan-design-review, design-review-lite, adversarial-review, codex-review, codex-plan-review). Ignore entries with timestamps older than 7 days. For the Eng Review row, show whichever is more recent between `review` (diff-scoped pre-landing review) and `plan-eng-review` (plan-stage architecture review). Append "(DIFF)" or "(PLAN)" to the status to distinguish. For the Adversarial row, show whichever is more recent between `adversarial-review` (new auto-scaled) and `codex-review` (legacy). For Design Review, show whichever is more recent between `plan-design-review` (full visual audit) and `design-review-lite` (code-level check). Append "(FULL)" or "(LITE)" to the status to distinguish. For the Outside Voice row, show the most recent `codex-plan-review` entry — this captures outside voices from both /plan-ceo-review and /plan-eng-review.

**Source attribution:** If the most recent entry for a skill has a \`"via"\` field, append it to the status label in parentheses. Examples: `plan-eng-review` with `via:"autoplan"` shows as "CLEAR (PLAN via /autoplan)". `review` with `via:"ship"` shows as "CLEAR (DIFF via /ship)". Entries without a `via` field show as "CLEAR (PLAN)" or "CLEAR (DIFF)" as before.

Note: `autoplan-voices` and `design-outside-voices` entries are audit-trail-only (forensic data for cross-model consensus analysis). They do not appear in the dashboard and are not checked by any consumer.

Display:

```
+====================================================================+
|                    REVIEW READINESS DASHBOARD                       |
+====================================================================+
| Review          | Runs | Last Run            | Status    | Required |
|-----------------|------|---------------------|-----------|----------|
| Eng Review      |  1   | 2026-03-16 15:00    | CLEAR     | YES      |
| CEO Review      |  0   | —                   | —         | no       |
| Design Review   |  0   | —                   | —         | no       |
| Adversarial     |  0   | —                   | —         | no       |
| Outside Voice   |  0   | —                   | —         | no       |
+--------------------------------------------------------------------+
| VERDICT: CLEARED — Eng Review passed                                |
+====================================================================+
```

**Review tiers:**
- **Eng Review (required by default):** The only review that gates shipping. Covers architecture, code quality, tests, performance. Can be disabled globally with \`gstack-config set skip_eng_review true\` (the "don't bother me" setting).
- **CEO Review (optional):** Use your judgment. Recommend it for big product/business changes, new user-facing features, or scope decisions. Skip for bug fixes, refactors, infra, and cleanup.
- **Design Review (optional):** Use your judgment. Recommend it for UI/UX changes. Skip for backend-only, infra, or prompt-only changes.
- **Adversarial Review (automatic):** Always-on for every review. Every diff gets both Claude adversarial subagent and Codex adversarial challenge. Large diffs (200+ lines) additionally get Codex structured review with P1 gate. No configuration needed.
- **Outside Voice (optional):** Independent plan review from a different AI model when Codex is available (falls back to a same-family Claude subagent otherwise — fresh context, not cross-model). Offered after all review sections complete in /plan-ceo-review and /plan-eng-review. Never gates shipping.

**Verdict logic:**
- **CLEARED**: Eng Review has >= 1 entry within 7 days from either \`review\` or \`plan-eng-review\` with status "clean" (or \`skip_eng_review\` is \`true\`)
- **NOT CLEARED**: Eng Review missing, stale (>7 days), or has open issues
- CEO, Design, and Codex reviews are shown for context but never block shipping
- If \`skip_eng_review\` config is \`true\`, Eng Review shows "SKIPPED (global)" and verdict is CLEARED

**Staleness detection:** After displaying the dashboard, check if any existing reviews may be stale:
- **Content-first rule (diff-scoped rows only: \`review\`, \`adversarial-review\`, \`codex-review\`, ship-stage entries).** Parse the \`---WTREE---\` and \`---DIRTY---\` sections from the bash output. If an entry has a \`wtree\` field AND it equals the current \`---WTREE---\` value, the review is CURRENT — identical content, regardless of commit count, rebase, amend, or whether it was committed yet (wtree equality alone proves identical content; that is the keystone property). Skip the commit-count heuristic for that entry and show no staleness note.
- Plan-tier rows (plan-ceo-review, plan-eng-review, plan-design-review) grade a plan file, not the repo tree — never apply the wtree rule to them; they keep the 7-day freshness logic. If such an entry carries a \`plan_sha256\` field, you MAY compare it against the current plan file's sha256 and note "plan changed since review" on mismatch.
- Fallback (no \`wtree\` on the entry, or wtree mismatch): parse the \`---HEAD---\` section to get the current HEAD commit hash. For each review entry that has a \`commit\` field: compare it against the current HEAD. If different, count elapsed commits: \`git rev-list --count STORED_COMMIT..HEAD\`. If that command FAILS (the stored commit was rebased away), grade UNKNOWN and treat as stale — do not error. Display: "Note: {skill} review from {date} may be stale — {N} commits since review"
- For entries without a \`commit\` field (legacy entries): display "Note: {skill} review from {date} has no commit tracking — consider re-running for accurate staleness detection"
- If all reviews grade CURRENT (wtree match or HEAD match), do not display any staleness notes

**ECPE observation:** Record the dashboard result only as closed capability and
receipt disposition/reason IDs in the run-local batch. If an outside model or
helper actually launches, add one corresponding `spawn` partial; a bounded
pass by the current host is not a spawn. Never copy review text, paths, prompts,
commands, or logs, and do not invoke telemetry from this resolver.

If the Eng Review is NOT "CLEAR":

Print: "No prior eng review found — ship will run its own pre-landing review in Step 9."

Check diff size: `git diff <base>...HEAD --stat | tail -1`. If the diff is >200 lines, add: "Note: This is a large diff. Consider running `/plan-eng-review` or `/autoplan` for architecture-level review before shipping."

If CEO Review is missing, mention as informational ("CEO Review not run — recommended for product changes") but do NOT block.

For Design Review, consume the `ui` role from the current fused execution-plan
manifest. Do not run a second diff classifier. If `ui` is present and no design
review (plan-design-review or design-review-lite) exists in the dashboard, mention:
"Design Review not run — this PR changes frontend code. The lite design check will
run automatically in Step 9, but consider running /design-review for a full visual
audit post-implementation." Still never block.

Continue to Step 2 — do NOT block or ask. Ship runs its own review in Step 9.

---

## Step 2: Distribution Pipeline Check

If the diff introduces a new standalone artifact (CLI binary, library package, tool) — not a web
service with existing deployment — verify that a distribution pipeline exists.

1. Check if the diff adds a new `cmd/` directory, `main.go`, or `bin/` entry point:
   ```bash
   git diff origin/<base> --name-only | grep -E '(cmd/.*/main\.go|bin/|Cargo\.toml|setup\.py|package\.json)' | head -5
   ```

2. If new artifact detected, check for a release workflow:
   ```bash
   ls .github/workflows/ 2>/dev/null | grep -iE 'release|publish|dist'
   grep -qE 'release|publish|deploy' .gitlab-ci.yml 2>/dev/null && echo "GITLAB_CI_RELEASE"
   ```

3. **If no release pipeline exists and a new artifact was added:** Use AskUserQuestion:
   - "This PR adds a new binary/tool but there's no CI/CD pipeline to build and publish it.
     Users won't be able to download the artifact after merge."
   - A) Add a release workflow now (CI/CD release pipeline — GitHub Actions or GitLab CI depending on platform)
   - B) Defer — add to TODOS.md
   - C) Not needed — this is internal/web-only, existing deployment covers it

4. **If release pipeline exists:** Continue silently.
5. **If no new artifact detected:** Skip silently.

---

## Step 3: Base-sync boundary (BEFORE tests)

Inspect the exact already-fetched trusted base snapshot through the compiled
`ship.base_sync` adapter. Use the lane and target ref returned by trusted policy:

```bash
~/.claude/skills/gstack/bin/gstack-effect-scope git-base-sync inspect \
  --skill ship --lane "$LANE" --assert-target-ref "$TARGET_REF" --json
```

If `result.status=already_contained`, continue. Otherwise, the host must separately
authorize this base synchronization, tracked writes, staging, and committing
(`ECPE_BASE_SYNC_AUTHORIZED`, `ECPE_TRACKED_WRITE_AUTHORIZED`,
`ECPE_GIT_STAGE_AUTHORIZED`, and `ECPE_GIT_COMMIT_AUTHORIZED`, each `1`). These
flags record explicit task-local grants; never set them merely because `/ship`
was invoked. Pass the inspection's exact `head_oid`, `base_oid`, `index_sha256`,
and `repository` values as equality assertions:

```bash
~/.claude/skills/gstack/bin/gstack-effect-scope git-base-sync apply \
  --skill ship --lane "$LANE" --assert-target-ref "$TARGET_REF" \
  --expected-head "$SYNC_HEAD" --expected-base "$SYNC_BASE" \
  --assert-index-preimage "$SYNC_INDEX" --assert-repository "$SYNC_REPOSITORY" --json
```

This adapter fast-forwards or merges a clean feature branch with the exact
trusted base snapshot; its result proves base ancestry, expected tree and parents,
matching index, and a clean worktree. It does not fetch or establish remote
freshness. If the needed remote snapshot has not been fetched through a separately
authorized workflow, STOP. Do not substitute an arbitrary ref or remote.

Conflicts return `git_base_sync_conflict` during preflight, preserving the
exact pre-sync HEAD, index, and worktree. Dirty state, assertion drift, repository Git
drivers, attributes, and submodules fail closed. STOP on any failure; do not claim
recovery after an unexpected Git execution or postcondition failure. Never invoke
raw `git fetch` or `git merge` from workflow prose or use `git-stage-commit` as a
base-sync substitute. Never auto-resolve VERSION, schema.rb, or CHANGELOG conflicts.
Push and PR effects remain zero after any failed sync. After a successful sync,
re-resolve the profile/plan and rerun validation for the new HEAD before delivery.

---

> **STOP.** Before running the test suites and (if prompt files changed) the eval suites (Steps 4-6), Read `~/.claude/skills/gstack/ship/sections/tests.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

> **STOP.** Before auditing test coverage of the diff (Step 7), Read `~/.claude/skills/gstack/ship/sections/test-coverage.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

> **STOP.** Before auditing plan completion, verification, and scope drift (Step 8), Read `~/.claude/skills/gstack/ship/sections/plan-completion.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

Before launching another model review, check the exact current review
capability from the protected review ledger:

```bash
~/.claude/skills/gstack/bin/gstack-review-read --require-current review.code --assert-target-ref origin/<base> --json
```

When this returns `current:true`, reuse its `run_id` and skip a duplicate model
review. Any stable stale reason requires the normal review path below.

> **STOP.** Before the pre-landing review and specialist dispatch (Step 9), Read `~/.claude/skills/gstack/ship/sections/review-army.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

> **STOP.** Before addressing Greptile review comments when a PR exists (Step 10), Read `~/.claude/skills/gstack/ship/sections/greptile.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

> **STOP.** Before the adversarial review and learnings capture (Step 11), Read `~/.claude/skills/gstack/ship/sections/adversarial.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

## Step 11.5: Documentation sync (before the release transaction)

Resolve a separate current-task `document_release` grant for the exact
documentation paths through the closed authority adapter before dispatch. The
parent chooses the task ID and supplies one `--path` per explicitly authorized
documentation file (no directories, globs, VERSION, package metadata, or CHANGELOG):

```bash
~/.claude/skills/gstack/bin/gstack-effect-scope document-release prepare --skill ship --task-id <current-task-id> --path <exact-doc-path> --json
```

Only the parent may invoke this with the separately authorized
`ECPE_DOCUMENT_RELEASE_AUTHORIZED=1` grant signal; never set it merely to make the
command succeed. Save the returned `result` object as the dispatch contract:
`grant_id`, `task_id`, exact `paths`, `preimage_sha256`, `preimage` (HEAD, index,
and per-path content hashes), and `expires_at`. Pass that complete object to the
helper below, replacing the placeholder; an omitted object means no dispatch.
The `/ship` invocation and prior review evidence do not grant this effect.
Missing or invalid authority means no helper: report documentation sync as
not run, retain `documentation_section: null`, and continue to Step 12.

Dispatch `/document-release` as one content-free helper subagent with the Agent
tool, `subagent_type: "general-purpose"`, and `run_in_background: false`. Never
substitute the Skill tool or inline execution. The adapter records the exact
pre-dispatch HEAD, index bytes, and tracked/non-ignored worktree snapshot.
It runs its full workflow before release allocation and the final ship commit, so every
documentation change is included in the tree that the release writer and
ShipReceipt bind. Never copy documentation text, filenames, URLs, or command
output into telemetry.

**Subagent prompt:**

> You are executing the /document-release workflow before the release
> transaction and final ship commit/push. Read the full skill file
> `${HOME}/.claude/skills/gstack/document-release/SKILL.md` and apply its
> audit and factual corrections within this guard. Branch: `<branch>`, base: `<base>`.
>
> Parent-issued dispatch contract (literal JSON): `<complete prepare result>`.
> Verify each granted file matches its preimage content hash before editing;
> null means the path must be absent. Echo this contract's `grant_id`, `task_id`,
> and `preimage_sha256` unchanged in your final JSON. Never mint or finish a
> grant yourself, widen `paths`, or access the parent's private lease store.
>
> **Scope guard — docs sync ONLY:** edit only the documentation paths bound by
> the parent's exact current-task grant. Preserve doc exclusions and risky-change
> gates. Do not stage, commit, push, post replies, or invoke a paid model.
> Do NOT attempt to edit the PR body. The parent owns Git delivery after the
> final tree is validated; this dispatch does not inherit those capabilities.
>
> Prefix the skill's `gstack-skill-start` invocation with
> `GSTACK_SESSION_KIND=spawned` so its spawned-session contract is active.
> Auto-choose only recommended reversible gates; for a destructive option take
> the conservative non-destructive choice. Record each decision in the final
> `decisions` array, and never wait for interactive input. Do not
> change VERSION, package metadata, or CHANGELOG; the parent release
> transaction owns them.
>
> Preserve file permissions and regular-file type; never create symlinks or
> hardlinks. Output a single JSON object on the LAST LINE of your response:
> `{"grant_id":"<issued-id>","task_id":"<task-id>","preimage_sha256":"<issued-hash>","files_updated":["README.md"],"content_sha256":{"README.md":"<SHA-256 of final file bytes>"},"commit_sha":null,"pushed":false,"documentation_section":"<markdown>","decisions":[]}`
> `files_updated` must equal the actual changed path set. `content_sha256` must
> contain exactly those paths and their final byte hashes (null for deletion).
> If no files need updating, use `files_updated: []`, `content_sha256: {}`,
> and `documentation_section: null`, retaining all three binding fields.
> If the workflow cannot run, return the same shape with an `error` string;
> never report a failed audit as clean documentation.

Once the helper is fully stopped, save only its final JSON line to a temporary
file outside the repository, then consume the original grant through the parent:

```bash
~/.claude/skills/gstack/bin/gstack-effect-scope document-release finish --skill ship --task-id <current-task-id> --grant-id <issued-grant-id> --result-file <helper-result-json> --json
```

Only `status: "verified"` permits Step 12 after a helper was dispatched. Retain
only the adapter-verified `documentation_section` for Step 19. The adapter checks
HEAD/index invariance, changed paths as a subset of the exact grant, unchanged
file permissions, and the helper's complete changed-path/content-hash report.
Failure, expiration, or an invalid result blocks Step 12; retain no section and
report the violation without resetting, staging, or committing recovery changes.
The private, owner-validated lease has a random nonce, expires after 30 minutes,
and is durably consumed before completion checks; the same task cannot reissue
or replay it. ProcessLocalGrant alone cannot prevent cross-process replay.
This is a completion gate, not an OS sandbox: same-account processes, ignored
files, submodule contents, transient Git actions, and external/paid effects are
not fully observable. Those effects remain forbidden, and helper output is not
evidence they never occurred.

If the foreground call returns only launch
metadata, check that same task a bounded number of times (2-3 checks across
about 10 minutes); never
dispatch a second documentation helper. After a timeout or invalid result, stop
any still-running helper, pass the failure through `finish` to burn the original
lease, and stop before Step 12. Never infer a clean result from a timeout.
Warn, retain no section, and continue only after the workspace is stable and a
separately authorized recovery resolves the failed gate. Do not
dispatch documentation work again after the release write.

## Step 12: Resolve and apply the release decision

Resolve the trusted release decision once through the anchored authority. The
optional explicit release request is intent only; mode and title policy are
equality-checked values returned by the trusted-base policy.

```bash
RELEASE_REQUEST_ARGS=()
[ "${RELEASE_REQUESTED:-0}" = "1" ] && RELEASE_REQUEST_ARGS=(--release-requested)
RELEASE_JSON=$($GSTACK_ANCHOR_INVOCATION gstack-version-bump classify \
  --lane "$ECPE_EXECUTION_LANE" --assert-target-ref origin/<base> "${RELEASE_REQUEST_ARGS[@]}") || exit 1
RELEASE_APPLICABLE=$(printf '%s' "$RELEASE_JSON" | jq -er '.applicable') || exit 1
RELEASE_MODE=$(printf '%s' "$RELEASE_JSON" | jq -er '.release_mode') || exit 1
RELEASE_TITLE_POLICY=$(printf '%s' "$RELEASE_JSON" | jq -er '.title_policy') || exit 1
NEW_VERSION=$(printf '%s' "$RELEASE_JSON" | jq -r '.version // empty')
RELEASE_ASSERTIONS=(--lane "$ECPE_EXECUTION_LANE" --assert-target-ref origin/<base> --assert-release-mode "$RELEASE_MODE" "${RELEASE_REQUEST_ARGS[@]}")
```

When `RELEASE_APPLICABLE=false`, set `RELEASE_DRIFT_STATUS=not_applicable` and
skip every allocator, queue, version writer, repair, and retirement command.
`NEW_VERSION` remains empty. When it is true, decide `BUMP_LEVEL` from the diff
using the existing MICRO/PATCH/MINOR/MAJOR feature signal rules, then use only
the same strict assertions for allocation and writing:

```bash
if [ "$RELEASE_APPLICABLE" = "true" ]; then
  RELEASE_DRIFT_STATUS=active
  ALLOCATION_JSON=$($GSTACK_ANCHOR_INVOCATION gstack-version-bump allocate \
    "${RELEASE_ASSERTIONS[@]}" --bump "$BUMP_LEVEL") || exit 1
  NEW_VERSION=$(printf '%s' "$ALLOCATION_JSON" | jq -er '.version') || exit 1
else
  RELEASE_DRIFT_STATUS=not_applicable
fi
```

The writer owns queue/collision selection and the atomic version/changelog
transaction. Do not run a parallel local fallback or a raw compatibility
binary. Final validation must run after the write and before the PR effect.
The closed writer must preserve upstream release metadata behavior: validate
four-part gstack versions (or an explicitly pinned three-part semver), update
the resolved package manifest and existing npm lockfiles without creating new
lockfiles, and refresh an existing version-stamped agents digest atomically.
If any projection cannot be updated, report the half-write/drift state and stop;
do not repair it through an ambient script.

> **STOP.** Before writing the CHANGELOG entry (Step 13), Read `~/.claude/skills/gstack/ship/sections/changelog.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

After the bounded changelog entry is available, perform the single atomic
release write. For a profile with no changelog projection, pass no
`--entry-stdin`; otherwise pipe exactly the generated entry bytes.

```bash
if [ "$RELEASE_APPLICABLE" = "true" ]; then
  if [ -n "${CHANGELOG_ENTRY+x}" ]; then
    RELEASE_WRITE_JSON=$(printf '%s' "$CHANGELOG_ENTRY" | \
      $GSTACK_ANCHOR_INVOCATION gstack-version-bump write \
        "${RELEASE_ASSERTIONS[@]}" --bump "$BUMP_LEVEL" \
        --assert-version "$NEW_VERSION" --entry-stdin) || exit 1
  else
    RELEASE_WRITE_JSON=$($GSTACK_ANCHOR_INVOCATION gstack-version-bump write \
      "${RELEASE_ASSERTIONS[@]}" --bump "$BUMP_LEVEL" \
      --assert-version "$NEW_VERSION") || exit 1
  fi
fi
```

## Step 14: TODOS.md report

If `TODOS.md` exists, inspect it and report items that appear completed by this
diff. Do not create, reorganize, edit, or move TODO entries in the governed ship
workflow. Any TODO maintenance requires a separate explicit write task.

---

## Step 15: Commit (bisectable chunks)

### Step 15.0: WIP Commit Squash (continuous checkpoint mode only)

If `CHECKPOINT_MODE` is `"continuous"`, the branch likely contains `WIP:` commits
from auto-checkpointing. These must be squashed INTO the corresponding logical
commits before the bisectable-grouping logic in Step 15.1 runs. Non-WIP commits
on the branch (earlier landed work) must be preserved.

**Detection:**
```bash
WIP_COUNT=$(git log <base>..HEAD --oneline --grep="^WIP:" 2>/dev/null | wc -l | tr -d ' ')
echo "WIP_COMMITS: $WIP_COUNT"
```

If `WIP_COUNT` is 0: skip this sub-step entirely.

If `WIP_COUNT` > 0, inspect the WIP commit messages in memory. Do not create
`.gstack/wip-context-before-squash.md` or any other context file.

**Non-destructive squash strategy:**

`git reset --soft <merge-base>` WOULD uncommit everything including non-WIP commits.
DO NOT DO THAT. Instead, use `git rebase` scoped to filter WIP commits only.

Option 1 (preferred, if there are non-WIP commits mixed in):
Only rewrite unpublished commits. If any are already on the remote, stop and ask
before rewriting; never force-push. Prepare a rebase todo in a temporary file:
list commits oldest-first, keep every non-WIP commit as `pick` in its original
relative order, move each WIP directly after its corresponding logical commit,
and mark it `fixup`. Inspect the diffs to choose each target; if a WIP's target
is ambiguous or outside this branch, stop and ask. Every commit must appear
exactly once, and the first entry must be `pick`. Set `WIP_TODO` below to that
prepared file's absolute path. Do not run with an empty or unreviewed todo.

```bash
export WIP_TODO="<absolute path to prepared todo>"
test -s "$WIP_TODO" || exit 1
ORIGINAL_TREE=$(git rev-parse 'HEAD^{tree}')
GIT_SEQUENCE_EDITOR='cp "$WIP_TODO"' git rebase -i "$(git merge-base HEAD origin/<base>)" || {
    echo "Rebase conflict. Aborting: git rebase --abort"
    git rebase --abort
    echo "STATUS: BLOCKED — manual WIP squash required"
    exit 1
  }
test "$ORIGINAL_TREE" = "$(git rev-parse 'HEAD^{tree}')" || {
  echo "STATUS: BLOCKED — squash changed file contents; inspect before continuing"
  exit 1
}
```

Option 2 (simpler, if the branch is ALL WIP commits so far — no landed work):
```bash
# Branch contains only WIP commits. Reset-soft is safe here because there's
# nothing non-WIP to preserve. Verify first.
NON_WIP=$(git log <base>..HEAD --oneline --invert-grep --grep="^WIP:" 2>/dev/null | wc -l | tr -d ' ')
if [ "$NON_WIP" -eq 0 ]; then
  git reset --soft $(git merge-base HEAD origin/<base>)
  echo "WIP-only branch, reset-soft to merge base. Step 15.1 will create clean commits."
fi
```

Decide at runtime which option applies. If unsure, prefer stopping and asking the
user via AskUserQuestion rather than destroying non-WIP commits.

**Anti-footgun rules:**
- NEVER blind `git reset --soft` if there are non-WIP commits. Codex flagged this
  as destructive — it would uncommit real landed work and turn the push step into
  a non-fast-forward push for anyone who already pushed.
- Only proceed to Step 15.1 after WIP commits are successfully squashed/absorbed
  or the branch has been verified to contain only WIP work.

### Step 15.1: Bisectable Commits

Create small, logical commits for `git bisect`. If all changes are already committed, skip to Step 16; never create an empty commit.

1. Analyze the diff and group changes into logical commits. Each commit should represent **one coherent change** — not one file, but one logical unit.

2. **Commit ordering** (earlier commits first):
   - **Infrastructure:** migrations, config changes, route additions
   - **Models & services:** new models, services, concerns (with their tests)
   - **Controllers & views:** controllers, views, JS/React components (with their tests)
   - **VERSION + CHANGELOG + TODOS.md:** always in the final commit

3. **Rules for splitting:**
   - A model and its test file go in the same commit
   - A service and its test file go in the same commit
   - A controller, its views, and its test go in the same commit
   - Migrations are their own commit (or grouped with the model they support)
   - Config/route changes can group with the feature they enable
   - If the total diff is small (< 50 lines across < 4 files), a single commit is fine

4. **Each commit must be independently valid** — no broken imports, no references to code that doesn't exist yet. Order commits so dependencies come first.

5. For each exact logical projection, invoke the closed stage/commit adapter.
   The adapter derives HEAD and the whole-index preimage, rejects foreign staged
   paths, disables hooks/signing/drivers, and owns the fixed operation message:

```bash
~/.claude/skills/gstack/bin/gstack-effect-scope git-stage-commit \
  --skill ship --operation ship.delivery --assert-path <exact-path> --json
```

---

## Step 16: Verification Gate

**IRON LAW: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**

The evidence ledger is the mechanical arm of this law. Check it FIRST:

```bash
~/.claude/skills/gstack/bin/gstack-evidence check --label tests --expect-cmd '<exact tests-lane command from Step 5>' --label vitest --expect-cmd '<exact vitest-lane command from Step 5>' --max-age 24 --allow-paths CHANGELOG.md,VERSION
```

Include only lane labels actually run in Step 5; `vitest` is an example, not a required framework.
Pass each `--expect-cmd` the exact command string the wrapped Step 5 lane ran —
that binds FRESH to the real suite (a green `echo ok` recorded under the label
can never satisfy the check). Whole-file exceptions are limited to VERSION and
CHANGELOG.md; profile mode validates package metadata through its declared
field projection. The check is advisory either way.

- **Every line FRESH (exit 0):** the recorded runs were green and the working-tree
  content is identical to what was tested, modulo the allow-listed release files
  (this mechanizes the "CHANGELOG edits don't count" rule — VERSION/CHANGELOG
  commits between Step 5 and here don't invalidate the run). Cite the evidence
  lines (label, exit, ts, log path) as the verification evidence and continue.
- **Any STALE/MISSING (exit non-zero):** run live, wrapped, so the fresh run is
  recorded: `~/.claude/skills/gstack/bin/gstack-evidence run --label <lane> -- '<command>'`.
  The check is an advisory guardrail — a failed CHECK never blocks; a failed RUN does.

Before pushing, re-verify if code changed at any point after Step 5:

1. **Test verification:** If ANY code changed after Step 5's test run (fixes from review findings, CHANGELOG edits don't count), re-run the test suite. The evidence check above IS this rule, mechanized — trust FRESH, re-run on STALE. Paste fresh output when you re-run. Stale output from Step 5 with changed content is NOT acceptable.

2. **Build verification:** If the project has a build step, run it. Paste output.

3. Confidence, earlier results on different code, and "trivial change" are not verification. Run the checks.

**If tests fail here:** STOP. Do not push. Fix the issue and return to Step 5.

Claiming work is complete without verification is dishonesty, not efficiency.

---

## Step 17: Push

Do not install or modify hooks, config, or prompt markers. Required redaction is
an explicit read gate owned by the workflow; hook setup is a separate task.

**Idempotency check:** Check if the branch is already pushed and up to date.

```bash
git fetch origin <branch-name> 2>/dev/null
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/<branch-name> 2>/dev/null || echo "none")
echo "LOCAL: $LOCAL  REMOTE: $REMOTE"
[ "$LOCAL" = "$REMOTE" ] && echo "ALREADY_PUSHED" || echo "PUSH_NEEDED"
```

If `ALREADY_PUSHED`, skip the push but continue to Step 18. Otherwise push with upstream tracking:

```bash
~/.claude/skills/gstack/bin/gstack-effect-scope git-push \
  --skill ship --operation ship.delivery --json
```

**You are NOT done.** The code is pushed but Step 18 (reuse the Step 11.5
documentation result) and Step 19 (create or update the PR/MR) are mandatory.
Continue to Step 18 without running another documentation mutation.

---

**PR/MR title invariant (always applies):** Every create or update uses the same
`RELEASE_TITLE_POLICY` resolved in Step 12. Compute it only through
`$GSTACK_ANCHOR_INVOCATION gstack-pr-title-rewrite` with
`--assert-target-ref`, `--assert-title-policy`, the same optional
`RELEASE_REQUEST_ARGS`, and `--version "$NEW_VERSION"` only for
`version_prefix`. Conventional/free policies must never receive a version.

**Doc-sync invariant:** Step 11.5 completed before the release transaction.
Step 18 must only reuse its result and must never mutate documentation after the
release writer froze the final tree.

> **STOP.** Before reusing the Step 11.5 documentation result (Step 18) and then creating or updating the PR/MR (Step 19), Read `~/.claude/skills/gstack/ship/sections/pr-body.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

After PR create-or-update succeeds, write the typed ShipReceipt from live
provider state. The adapter itself resolves the final manifest, validation
receipts, release decision, and remote PR head:

```bash
CANARY_HANDOFF_ASSERTIONS=(--lane "$ECPE_EXECUTION_LANE")
if [ -n "${CANARY_BLOCK_ID:-}" ] && [ -n "${CANARY_LANE:-}" ]; then
  [ "$CANARY_LANE" = "$ECPE_EXECUTION_LANE" ] || { echo "BLOCKED — canary lane differs from the initial execution plan"; exit 1; }
  CANARY_HANDOFF_ASSERTIONS=(--assert-milestone-block "$CANARY_BLOCK_ID" --lane "$ECPE_EXECUTION_LANE")
fi
SHIP_HANDOFF_JSON=$($GSTACK_ANCHOR_INVOCATION gstack-ship-handoff create --stage ship --pr "$PR_NUMBER" \
  --assert-target-ref origin/<base> "${RELEASE_REQUEST_ARGS[@]}" "${CANARY_HANDOFF_ASSERTIONS[@]}") || exit 1
SHIP_RECEIPT_ID=$(printf '%s' "$SHIP_HANDOFF_JSON" | jq -er '.receipt_run_id') || exit 1
if [ "$RELEASE_APPLICABLE" = "true" ]; then
  $GSTACK_ANCHOR_INVOCATION gstack-version-bump retire \
    "${RELEASE_ASSERTIONS[@]}" --assert-version "$NEW_VERSION" >/dev/null || exit 1
fi
```

The exact initial execution-plan lane binds release policy, title policy, the
ShipReceipt, and any promotion or canary subject. Never resolve `auto` again. Set
`CANARY_BLOCK_ID` and `CANARY_LANE` only from the initial execution-plan's
`canary_focus` object when its execution is `profile_canary`. This binds the
pre-ready ShipReceipt to the reserved focused subject; never infer either value.

## Step 20: Persist ship metrics

Log coverage and plan completion data so `/retro` can track trends.

Route the append through `gstack-review-log`. It resolves the project slug and
the canonical branch form itself, creates the directory, validates the JSON, and
enqueues the row for gbrain sync. It takes **no path argument** — never build a
`<branch>-reviews.jsonl` path by hand. A branch with a `/` in it turns a
hand-built path into a subdirectory write, and the row goes somewhere `/retro`
will never look.

```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"ship","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","coverage_pct":COVERAGE_PCT,"plan_items_total":PLAN_TOTAL,"plan_items_done":PLAN_DONE,"verification_result":"VERIFY_RESULT","version":"VERSION","branch":"'"$(git rev-parse --abbrev-ref HEAD)"'"}'
```

Substitute from earlier steps:
- **COVERAGE_PCT**: coverage percentage from Step 7 diagram (integer, or -1 if undetermined)
- **PLAN_TOTAL**: total plan items extracted in Step 8 (0 if no plan file)
- **PLAN_DONE**: count of DONE + CHANGED items from Step 8 (0 if no plan file)
- **VERIFY_RESULT**: "pass", "fail", or "skipped" from Step 8.1
- **VERSION**: from the VERSION file

The branch name is filled in by the shell — there is no `BRANCH` placeholder to
substitute.

This step is automatic — never skip it, never ask for confirmation.

---

## Step 21: Optional tuning note

Do not inspect or write plan-tune config or marker files. Mention `/plan-tune`
only when the user explicitly asks about question tuning.

---

## Section self-check (before you finish)

You ran a carved skill. For your situation, list every section the Section index
named as applying, and confirm you issued a Read for each one. If you executed any
of those steps from memory without reading its section, you skipped the source of
truth — STOP, Read it now, and redo that step. Deterministic version work goes
through `gstack-version-bump`; never hand-roll the VERSION/package.json write.

---

## Important Rules

- **Never skip tests.** If tests fail, stop.
- **Never skip the pre-landing review.** If checklist.md is unreadable, stop.
- **Never force push.** The closed `gstack-effect-scope git-push` adapter is
  the sole push writer.
- **Never ask for trivial confirmations** (e.g., "ready to push?", "create PR?"). DO stop for: version bumps (MINOR/MAJOR), pre-landing review findings (ASK items), and Codex structured review [P1] findings (large diffs only).
- **Always use the 4-digit version format** from the VERSION file.
- **Date format in CHANGELOG:** `YYYY-MM-DD`
- **Split commits for bisectability** — each commit = one logical change.
- **TODOS.md is report-only in this workflow.** Report likely-completed items conservatively; do not edit the file without a separate explicit write task.
- **Use Greptile reply templates from greptile-triage.md.** Every reply includes evidence (inline diff, code references, re-rank suggestion). Never post vague replies.
- **Never push without fresh verification evidence.** If code changed after Step 5 tests, re-run before pushing.
- **Step 7 generates coverage tests.** They must pass before committing. Never commit failing tests.
- **The goal is: user says `/ship`, next thing they see is the review + PR URL + auto-synced docs.**
