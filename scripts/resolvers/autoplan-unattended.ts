/**
 * Autoplan Unattended Mode resolver (G1 + G2)
 *
 * /autoplan is built to run unattended — spawned by an orchestrator (OpenClaw),
 * batched across parallel sprints, or in a host that disables AskUserQuestion
 * (Conductor runs `--disallowedTools AskUserQuestion`). The generic preamble
 * tells spawned sessions to "auto-choose the recommended option," but autoplan
 * has TWO gates it refuses to auto-decide: premise confirmation and User
 * Challenges. Before this resolver, those gates silently collapsed to their
 * default in any unattended run — the exact high-stakes judgment the skill is
 * built to never automate (regression documented in CHANGELOG: the autoplan
 * E2E bailed at the premise gate under `--disallowedTools AskUserQuestion`).
 *
 * This block defines the unattended contract: PARK the two gates to a durable
 * pending-decisions queue, keep the user's original direction as the default,
 * HALT on security/feasibility-flagged challenges, optionally notify a webhook,
 * and resume with `/autoplan --resume`. Interactive runs are unchanged.
 *
 * Scoped to autoplan on purpose: the SPAWNED_SESSION rule lives in the shared
 * preamble, so refining it here (not there) keeps the blast radius to one skill.
 */
import type { TemplateContext } from './types';

export function generateAutoplanUnattended(_ctx: TemplateContext): string {
  return `## Unattended Mode — the two gates when no human is watching

\`/autoplan\` is built to run unattended: spawned by an orchestrator (OpenClaw sets
\`OPENCLAW_SESSION\`, surfaced as \`SPAWNED_SESSION: true\` in the preamble echo), batched
across parallel sprints, or in a host that disables interactive prompts (Conductor runs
\`--disallowedTools AskUserQuestion\`). Treat the run as unattended when ANY of these hold:
\`SPAWNED_SESSION: true\` in the preamble echo, no AskUserQuestion variant is callable, or
\`gstack-config get autoplan_unattended\` returns \`true\`.

The generic preamble tells spawned sessions to "auto-choose the recommended option." That
rule is correct for **Mechanical** and **Taste** decisions. **It does NOT apply to the two
hard gates** — premise confirmation (Phase 1) and User Challenges. Silently accepting the
default on those is exactly the high-stakes judgment the rest of this skill refuses to
automate. When unattended, PARK them instead of auto-accepting:

**1. Park, don't silently accept.** Append one row per gate to a durable queue artifact
(create the project dir first):

\`\`\`bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')
PENDING="$HOME/.gstack/projects/$SLUG/$BRANCH-autoplan-pending-$(date +%Y%m%d-%H%M%S).jsonl"
\`\`\`

Write each row with \`jq -nc\` (never hand-rolled echo), one JSON object per line:
\`{"kind":"premise|user_challenge","phase":"ceo|design|eng|dx","default":"<documented default>","context":"<full gate context: what the user said, what both models recommend, why, blind spots, cost-if-wrong>","security_flag":false,"resolved":false}\`

**2. Parking policy by kind:**
- **Premise gate** → proceed on the user's stated premises (the documented default) and tag
  the run \`PENDING_PREMISE_REVIEW\`. Do not invent or "improve" premises unattended.
- **User Challenge** → keep the user's original direction (already the default) and tag
  \`PENDING_CHALLENGE\`. Two models agreeing does not let them silently overrule an absent human.
- **Security/feasibility-flagged challenge** (both models call it a risk, not a preference)
  → **HALT.** Write the row with \`"security_flag":true\`, report
  \`BLOCKED — security/feasibility challenge requires human review\`, and stop. Never proceed
  unattended past a flagged security risk. This is the one sanctioned stop (see Important Rules).

**3. Notify (optional).** If \`gstack-config get notify_webhook\` returns a URL, POST a
one-line summary to it (parked-decision count + the resume command). No webhook configured →
no-op, zero cost.

**4. Resume.** When a human returns, \`/autoplan --resume\` reads the newest
\`*-autoplan-pending-*.jsonl\`, replays each unresolved row as a real AskUserQuestion using its
stored context, applies the answers, marks rows \`"resolved":true\`, and continues to the Final
Approval Gate.

When AskUserQuestion IS available (a normal interactive run), Unattended Mode changes nothing —
the two gates behave exactly as specified elsewhere in this skill.`;
}
