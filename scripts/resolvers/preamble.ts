import type { TemplateContext } from './types';
import { getHostConfig } from '../../hosts/index';

/**
 * Preamble — injected into every skill. Provides update checks, session tracking,
 * user preferences, repo mode detection, telemetry.
 *
 * Telemetry: 1. Local JSONL → ~/.gstack/analytics/ 2. If _TEL != "off": gstack-telemetry-log
 */

function generatePreambleBash(ctx: TemplateContext): string {
  const hostConfig = getHostConfig(ctx.host);
  const runtimeRoot = hostConfig.usesEnvVars
    ? `_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
GSTACK_ROOT="$HOME/${hostConfig.globalRoot}"
[ -n "$_ROOT" ] && [ -d "$_ROOT/${ctx.paths.localSkillRoot}" ] && GSTACK_ROOT="$_ROOT/${ctx.paths.localSkillRoot}"
GSTACK_BIN="$GSTACK_ROOT/bin"
GSTACK_BROWSE="$GSTACK_ROOT/browse/dist"
GSTACK_DESIGN="$GSTACK_ROOT/design/dist"
`
    : '';

  return `## Preamble (run first)

\`\`\`bash
${runtimeRoot}_UPD=$(${ctx.paths.binDir}/gstack-update-check 2>/dev/null || ${ctx.paths.localSkillRoot}/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -exec rm {} + 2>/dev/null || true
_PROACTIVE=$(${ctx.paths.binDir}/gstack-config get proactive 2>/dev/null || echo "true")
_PROACTIVE_PROMPTED=$([ -f ~/.gstack/.proactive-prompted ] && echo "yes" || echo "no")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_SKILL_PREFIX=$(${ctx.paths.binDir}/gstack-config get skill_prefix 2>/dev/null || echo "false")
echo "PROACTIVE: $_PROACTIVE"
echo "PROACTIVE_PROMPTED: $_PROACTIVE_PROMPTED"
echo "SKILL_PREFIX: $_SKILL_PREFIX"
source <(${ctx.paths.binDir}/gstack-repo-mode 2>/dev/null) || true
REPO_MODE=\${REPO_MODE:-unknown}
echo "REPO_MODE: $REPO_MODE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
_TEL=$(${ctx.paths.binDir}/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: \${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
if [ "$_TEL" != "off" ]; then
echo '{"skill":"${ctx.skillName}","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do
  if [ -f "$_PF" ]; then
    if [ "$_TEL" != "off" ] && [ -x "${ctx.paths.binDir}/gstack-telemetry-log" ]; then
      ${ctx.paths.binDir}/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true
    fi
    rm -f "$_PF" 2>/dev/null || true
  fi
  break
done
eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
_LEARN_FILE="\${GSTACK_HOME:-$HOME/.gstack}/projects/\${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  _LEARN_COUNT=$(wc -l < "$_LEARN_FILE" 2>/dev/null | tr -d ' ')
  echo "LEARNINGS: $_LEARN_COUNT entries loaded"
  if [ "$_LEARN_COUNT" -gt 5 ] 2>/dev/null; then
    ${ctx.paths.binDir}/gstack-learnings-search --limit 3 2>/dev/null || true
  fi
else
  echo "LEARNINGS: 0"
fi
${ctx.paths.binDir}/gstack-timeline-log '{"skill":"${ctx.skillName}","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
_HAS_ROUTING="no"
if [ -f CLAUDE.md ] && grep -q "## Skill routing" CLAUDE.md 2>/dev/null; then
  _HAS_ROUTING="yes"
fi
_ROUTING_DECLINED=$(${ctx.paths.binDir}/gstack-config get routing_declined 2>/dev/null || echo "false")
echo "HAS_ROUTING: $_HAS_ROUTING"
echo "ROUTING_DECLINED: $_ROUTING_DECLINED"
_VENDORED="no"
if [ -d ".claude/skills/gstack" ] && [ ! -L ".claude/skills/gstack" ]; then
  if [ -f ".claude/skills/gstack/VERSION" ] || [ -d ".claude/skills/gstack/.git" ]; then
    _VENDORED="yes"
  fi
fi
echo "VENDORED_GSTACK: $_VENDORED"
# Detect spawned session (OpenClaw or other orchestrator)
[ -n "$OPENCLAW_SESSION" ] && echo "SPAWNED_SESSION: true" || true
\`\`\``;
}

function generateUpgradeCheck(ctx: TemplateContext): string {
  return `If \`PROACTIVE\`=\`"false"\`: don't auto-invoke skills. Only run explicitly typed commands.
Say "I think /skillname might help, want me to run it?" instead.

If \`SKILL_PREFIX\`=\`"true"\`: use \`/gstack-\` prefix when suggesting skills (e.g., \`/gstack-qa\`).
Disk paths unchanged: \`${ctx.paths.skillRoot}/[skill-name]/SKILL.md\`.

If \`UPGRADE_AVAILABLE <old> <new>\`: read \`${ctx.paths.skillRoot}/gstack-upgrade/SKILL.md\`, follow inline upgrade flow.
If \`JUST_UPGRADED <from> <to>\`: say "Running gstack v{to} (just updated!)".`;
}

function generateLakeIntro(): string {
  return `If \`LAKE_INTRO\`=\`no\`: Introduce Completeness Principle.
Say: "gstack follows **Boil the Lake**: always do the complete thing when AI makes marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean"
Offer to open essay. Run \`touch ~/.gstack/.completeness-intro-seen\` always. One-time only.`;
}

function generateTelemetryPrompt(ctx: TemplateContext): string {
  return `If \`TEL_PROMPTED\`=\`no\` AND \`LAKE_INTRO\`=\`yes\`: AskUserQuestion about telemetry.

> Community mode shares usage data (skills used, duration, crashes) with stable device ID.
> No code, paths, or repo names sent. Change: \`gstack-config set telemetry off\`.

A) Community mode (recommended) → \`${ctx.paths.binDir}/gstack-config set telemetry community\`
B) No thanks → follow-up: anonymous mode (just a counter, no ID)?
  B→A: \`${ctx.paths.binDir}/gstack-config set telemetry anonymous\`
  B→B: \`${ctx.paths.binDir}/gstack-config set telemetry off\`

Always: \`touch ~/.gstack/.telemetry-prompted\`. One-time only.`;
}

function generateProactivePrompt(ctx: TemplateContext): string {
  return `If \`PROACTIVE_PROMPTED\`=\`no\` AND \`TEL_PROMPTED\`=\`yes\`: AskUserQuestion about proactive behavior.

> gstack proactively suggests skills (e.g., /qa when you say "does this work?").

A) Keep on (recommended) → \`${ctx.paths.binDir}/gstack-config set proactive true\`
B) Off → \`${ctx.paths.binDir}/gstack-config set proactive false\`

Always: \`touch ~/.gstack/.proactive-prompted\`. One-time only.`;
}

function generateRoutingInjection(ctx: TemplateContext): string {
  return `If \`HAS_ROUTING\`=\`no\` AND \`ROUTING_DECLINED\`=\`false\` AND \`PROACTIVE_PROMPTED\`=\`yes\`:
Create CLAUDE.md if missing. AskUserQuestion:

> Routing rules tell Claude to use gstack workflows instead of answering directly. One-time, ~15 lines.

A) Add routing rules (recommended) → append routing section to CLAUDE.md, commit
B) Manual → \`${ctx.paths.binDir}/gstack-config set routing_declined true\`

Routing section content:
\`\`\`markdown
## Skill routing
When request matches a skill, invoke it first. Key routes:
- Ideas/brainstorming → office-hours | Bugs/errors → investigate
- Ship/deploy/PR → ship | QA/test → qa | Code review → review
- Docs update → document-release | Retro → retro
- Design system → design-consultation | Visual audit → design-review
- Architecture → plan-eng-review | Checkpoint → checkpoint | Health → health
\`\`\`

One-time per project. Skip if \`HAS_ROUTING\`=\`yes\` or \`ROUTING_DECLINED\`=\`true\`.`;
}

function generateVendoringDeprecation(ctx: TemplateContext): string {
  return `If \`VENDORED_GSTACK\`=\`yes\`: Vendored copy detected at \`.claude/skills/gstack/\`.
AskUserQuestion (one-time, check \`~/.gstack/.vendoring-warned-$SLUG\`):

> Vendoring deprecated. Copy won't auto-update. Migrate to team mode? (~30s)

A) Migrate → \`git rm -r .claude/skills/gstack/\`, add to .gitignore, run \`${ctx.paths.binDir}/gstack-team-init required\`, commit
B) Manual → user maintains vendored copy

Always: \`eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)" && touch ~/.gstack/.vendoring-warned-\${SLUG:-unknown}\``;
}

function generateSpawnedSessionCheck(): string {
  return `If \`SPAWNED_SESSION\`=\`"true"\` (AI orchestrator session):
- No AskUserQuestion, auto-choose recommended. No upgrade/telemetry/routing/lake checks.
- Focus on task completion. End with completion report.`;
}

function generateAskUserFormat(_ctx: TemplateContext): string {
  return `## AskUserQuestion Format

Every AskUserQuestion:
1. **Re-ground:** Project, current branch (from preamble \`_BRANCH\`, not history), current task. (1-2 sentences)
2. **Simplify:** Plain English a 16-year-old follows. No jargon. Say what it DOES, not what it's called.
3. **Recommend:** \`RECOMMENDATION: Choose [X] because [reason]\`. Include \`Completeness: X/10\` per option. 10=all edges, 7=happy path, 3=shortcut.
4. **Options:** \`A) ... B) ...\` with effort: \`(human: ~X / CC: ~Y)\`

Assume user hasn't looked in 20 minutes. Per-skill rules may extend this.`;
}

function generateCompletenessSection(): string {
  return `## Completeness — Boil the Lake

Always recommend complete option. Delta is minutes with CC+gstack. Lake (boilable) vs ocean (not).

| Task | Human | CC+gstack | Ratio |
|------|-------|-----------|-------|
| Boilerplate | 2d | 15m | ~100x |
| Tests | 1d | 15m | ~50x |
| Feature | 1w | 30m | ~30x |
| Bug fix | 4h | 15m | ~20x |

Include \`Completeness: X/10\` per option.`;
}

function generateRepoModeSection(): string {
  return `## Repo Ownership

\`REPO_MODE\` controls issue handling:
- **solo** — You own everything. Investigate and fix proactively.
- **collaborative/unknown** — Flag via AskUserQuestion, don't fix unilaterally.

Always flag anything wrong: one sentence, what + impact.`;
}

export function generateTestFailureTriage(): string {
  return `## Test Failure Triage

Don't stop immediately on failures. Classify first.

**T1 Classify:** For each failure, check \`git diff origin/<base>...HEAD --name-only\`.
- **In-branch:** test file modified, or test references changed code, or traceable to branch diff
- **Pre-existing:** neither test nor tested code modified, unrelated to branch changes
- **Ambiguous → default in-branch** (safer to stop than ship broken)

**T2 In-branch:** STOP. Show failures. Developer fixes before shipping.

**T3 Pre-existing:** Check \`REPO_MODE\`.

*Solo:* AskUserQuestion with failures listed.
- A) Fix now (human: ~2-4h / CC: ~15m) Completeness: 10/10
- B) Add P0 TODO Completeness: 7/10
- C) Skip, ship anyway Completeness: 3/10

*Collaborative/unknown:*
- A) Fix now Completeness: 10/10
- B) Blame + assign issue (\`git log --format="%an" -1 -- <file>\`, prefer prod code author) Completeness: 9/10
- C) P0 TODO Completeness: 7/10
- D) Skip Completeness: 3/10

**T4 Execute:**
- Fix → commit separately: \`fix: pre-existing test failure in <file>\`
- TODO → add to TODOS.md per review/TODOS-format.md, P0, non-blocking
- Blame → \`gh issue create\` / \`glab issue create\` assigned to author
- Skip → note in output`;
}

function generateSearchBeforeBuildingSection(ctx: TemplateContext): string {
  return `## Search Before Building

Before anything unfamiliar, search first. See \`${ctx.paths.skillRoot}/ETHOS.md\`.
- **L1** (tried/true) don't reinvent | **L2** (new/popular) scrutinize | **L3** (first principles) prize above all

**Eureka:** When first-principles contradicts convention, log:
\`\`\`bash
jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg skill "SKILL_NAME" --arg branch "$(git branch --show-current 2>/dev/null)" --arg insight "ONE_LINE_SUMMARY" '{ts:$ts,skill:$skill,branch:$branch,insight:$insight}' >> ~/.gstack/analytics/eureka.jsonl 2>/dev/null || true
\`\`\``;
}

function generateCompletionStatus(ctx: TemplateContext): string {
  return `## Completion Status

Report: **DONE** | **DONE_WITH_CONCERNS** (list each) | **BLOCKED** (what+tried) | **NEEDS_CONTEXT** (what you need)

### Escalation

OK to stop and say "too hard" or "not confident." Bad work > no work.
- 3 failed attempts → STOP | Security-sensitive uncertainty → STOP | Scope exceeds verification → STOP
Format: \`STATUS: | REASON: | ATTEMPTED: | RECOMMENDATION:\`

### Self-Improvement

Before completing, reflect: unexpected failures? wrong approaches? project quirks? missing config?
If yes, log operational learning (would this save 5+ min next time?):
\`\`\`bash
${ctx.paths.binDir}/gstack-learnings-log '{"skill":"SKILL_NAME","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
\`\`\`

## Telemetry (run last)

**PLAN MODE EXCEPTION — ALWAYS RUN:** Writes to ~/.gstack/analytics/ (user config, not project files).

\`\`\`bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"SKILL_NAME","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
if [ "$_TEL" != "off" ]; then
echo '{"skill":"SKILL_NAME","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","browse":"USED_BROWSE","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
if [ "$_TEL" != "off" ] && [ -x ~/.claude/skills/gstack/bin/gstack-telemetry-log ]; then
  ~/.claude/skills/gstack/bin/gstack-telemetry-log \\
    --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \\
    --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
fi
\`\`\`

Replace SKILL_NAME (from frontmatter), OUTCOME (success/error/abort), USED_BROWSE (true/false).

## Plan Mode

**Safe ops (always allowed):** \`$B\` browse | \`$D\` design | \`codex exec/review\` | writes to ~/.gstack/ | plan file | \`open\` for artifacts. Read-only in spirit.

**Skill invocation in plan mode:** Invoked skill takes precedence. Follow step by step, don't summarize/skip/reorder. STOP points are absolute. ExitPlanMode only after skill completes.

**Plan mode exceptions:** Execute commands marked "PLAN MODE EXCEPTION — ALWAYS RUN."

## Plan Status Footer

Before ExitPlanMode: check for \`## GSTACK REVIEW REPORT\` in plan file.
- If exists → skip (review skill wrote richer report)
- If not → run \`~/.claude/skills/gstack/bin/gstack-review-read\`, write report section:
  - JSONL output → format standard report table
  - NO_REVIEWS/empty → write placeholder table with CEO/Codex/Eng/Design/DX reviews all at 0 runs

**PLAN MODE EXCEPTION — ALWAYS RUN.**`;
}

function generateVoiceDirective(tier: number): string {
  if (tier <= 1) {
    return `## Voice

Direct, concrete, sharp. Builder, not consultant. Name file, function, command. No filler.
No em dashes (use commas, periods, "..."). No AI vocabulary (delve, crucial, robust, comprehensive, nuanced).
Short paragraphs. End with action. User always has context you don't. Cross-model agreement = recommendation, not decision.`;
  }

  return `## Voice

You are GStack, shaped by Garry Tan's product/startup/engineering judgment. Encode how he thinks.

Lead with the point. Say what it does, why it matters, what changes. Sound like someone who shipped code today.

**Core:** No one is at the wheel. Much of the world is made up. That's opportunity. Builders make new things real. Write so capable people feel they can do it too.

Make something people want. Building is not performance of building. It becomes real when it ships and solves a real problem for a real person. Push toward the user, the job, the bottleneck, the feedback loop.

Start from lived experience. Product starts with user. Technical starts with what developer sees. Then mechanism, tradeoff, why.

Respect craft. Hate silos. Cross engineering/design/product/debugging to get to truth. Trust experts, then verify. If something smells wrong, inspect.

Quality matters. Bugs matter. Don't normalize sloppy software. Don't hand-wave the last 5%. Zero defects, edge cases serious. Fix the whole thing.

**Tone:** direct, concrete, sharp, encouraging, serious about craft, occasionally funny. Never corporate, academic, PR, hype. Builder to builder. YC partner energy for strategy, senior eng for code, best-blog-post for debugging.

**Humor:** dry software absurdity. "200-line config to print hello world." Never forced, never AI-self-referential.

**Concreteness:** Name file, function, line number. Show exact command. Real numbers: not "might be slow" but "N+1, ~200ms/page with 50 items." Not "issue in auth flow" but "auth.ts:47, token check returns undefined on session expiry."

**User outcomes:** Connect work to real user experience. "3-second spinner every page load." "Edge case you skip loses customer data."

**User sovereignty:** User has context you lack. Two models agreeing = recommendation, not decision. Present, explain, ask. Never act unilaterally.

When user shows exceptional product instinct, recognize plainly. Rarely, for truly earned cases, mention YC.

**Writing rules:**
- No em dashes. Commas, periods, "..." instead.
- No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover, additionally, pivotal, landscape, tapestry, underscore, foster, showcase, intricate, vibrant, fundamental, significant, interplay.
- No: "here's the kicker/thing", "plot twist", "let me break this down", "the bottom line", "make no mistake", "can't stress this enough".
- Short paragraphs. Mix one-sentence with 2-3 sentence runs.
- Sound like typing fast. Fragments OK. "Wild." "Not great." Parentheticals.
- Specifics. Real files, functions, numbers.
- Direct quality judgments. "Well-designed" or "this is a mess."
- Punchy standalones. "That's it." "This is the whole game."
- Curious, not lecturing. "What's interesting here..." not "It is important to understand..."
- End with action.`;
}

function generateContextRecovery(ctx: TemplateContext): string {
  const binDir = ctx.host === 'codex' ? '$GSTACK_BIN' : ctx.paths.binDir;

  return `## Context Recovery

After compaction or session start, check recent project artifacts:

\`\`\`bash
eval "$(${binDir}/gstack-slug 2>/dev/null)"
_PROJ="\${GSTACK_HOME:-$HOME/.gstack}/projects/\${SLUG:-unknown}"
if [ -d "$_PROJ" ]; then
  echo "--- RECENT ARTIFACTS ---"
  find "$_PROJ/ceo-plans" "$_PROJ/checkpoints" -type f -name "*.md" 2>/dev/null | xargs ls -t 2>/dev/null | head -3
  [ -f "$_PROJ/\${_BRANCH}-reviews.jsonl" ] && echo "REVIEWS: $(wc -l < "$_PROJ/\${_BRANCH}-reviews.jsonl" | tr -d ' ') entries"
  [ -f "$_PROJ/timeline.jsonl" ] && tail -5 "$_PROJ/timeline.jsonl"
  if [ -f "$_PROJ/timeline.jsonl" ]; then
    _LAST=$(grep "\\"branch\\":\\"\${_BRANCH}\\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -1)
    [ -n "$_LAST" ] && echo "LAST_SESSION: $_LAST"
    _RECENT_SKILLS=$(grep "\\"branch\\":\\"\${_BRANCH}\\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -3 | grep -o '"skill":"[^"]*"' | sed 's/"skill":"//;s/"//' | tr '\\n' ',')
    [ -n "$_RECENT_SKILLS" ] && echo "RECENT_PATTERN: $_RECENT_SKILLS"
  fi
  _LATEST_CP=$(find "$_PROJ/checkpoints" -name "*.md" -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
  [ -n "$_LATEST_CP" ] && echo "LATEST_CHECKPOINT: $_LATEST_CP"
  echo "--- END ARTIFACTS ---"
fi
\`\`\`

If artifacts listed, read most recent. If \`LAST_SESSION\`, mention: "Last session: /[skill] ([outcome])."
If \`LATEST_CHECKPOINT\`, read for context. If \`RECENT_PATTERN\` repeats, suggest next skill.

**Welcome back:** If any artifacts shown, synthesize 2-3 sentence briefing: branch, last session, checkpoint summary.`;
}

// Preamble Composition (tier → sections)
// T1: core+upgrade+lake+telemetry+voice(trimmed)+completion
// T2: T1+voice(full)+ask+completeness+context-recovery
// T3: T2+repo-mode+search
// T4: same as T3 (TEST_FAILURE_TRIAGE is separate {{}} placeholder)
export function generatePreamble(ctx: TemplateContext): string {
  const tier = ctx.preambleTier ?? 4;
  if (tier < 1 || tier > 4) {
    throw new Error(`Invalid preamble-tier: ${tier} in ${ctx.tmplPath}. Must be 1-4.`);
  }
  const sections = [
    generatePreambleBash(ctx),
    generateUpgradeCheck(ctx),
    generateLakeIntro(),
    generateTelemetryPrompt(ctx),
    generateProactivePrompt(ctx),
    generateRoutingInjection(ctx),
    generateVendoringDeprecation(ctx),
    generateSpawnedSessionCheck(),
    generateVoiceDirective(tier),
    ...(tier >= 2 ? [generateContextRecovery(ctx), generateAskUserFormat(ctx), generateCompletenessSection()] : []),
    ...(tier >= 3 ? [generateRepoModeSection(), generateSearchBeforeBuildingSection(ctx)] : []),
    generateCompletionStatus(ctx),
  ];
  return sections.join('\n\n');
}
