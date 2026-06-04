/**
 * GBrain resolver — brain-first lookup and save-to-brain for thinking skills.
 *
 * GBrain is a "mod" for gstack. When installed, coding skills become brain-aware:
 * they search the brain for context before starting and save results after finishing.
 *
 * These resolvers are suppressed on hosts that don't support brain features
 * (via suppressedResolvers in each host config). For those hosts,
 * {{GBRAIN_CONTEXT_LOAD}}, {{GBRAIN_SAVE_RESULTS}}, {{BRAIN_PREFLIGHT}},
 * {{BRAIN_CACHE_REFRESH}}, and {{BRAIN_WRITE_BACK}} all resolve to empty string.
 *
 * Compatible with GBrain >= v0.10.0 (search CLI, doctor --fast --json, entity enrichment).
 *
 * Brain-aware planning (T4 / v1.48 plan): adds three new resolvers powered by
 * the bin/gstack-brain-cache CLI and scripts/brain-cache-spec.ts. The new
 * resolvers fire only for the 5 planning skills registered in
 * SKILL_DIGEST_SUBSETS (office-hours, plan-ceo-review, plan-eng-review,
 * plan-design-review, plan-devex-review).
 */
import type { TemplateContext } from './types';
import {
  SKILL_DIGEST_SUBSETS,
  SKILL_CALIBRATION_WEIGHTS,
  BRAIN_CACHE_ENTITIES,
  getSkillSubset,
  getInvalidationTargets,
} from '../brain-cache-spec';

// Per-skill slug + title + tag metadata for SAVE_RESULTS. The full save
// template (heredoc body, entity-stub instructions, throttle handling,
// backlinks) lives in docs/gbrain-write-surfaces.md §Save Template and is
// read on-demand by the agent. Compressing the inline prose keeps the
// token footprint at ~150 tokens per skill (down from ~500), so users with
// gbrain installed pay a small overhead and users without it (whose hosts
// have GBRAIN_SAVE_RESULTS suppressed at gen-time) pay nothing.
interface SkillSaveMeta {
  slugPrefix: string;
  title: string;
  tag: string;
}

const skillSaveMap: Record<string, SkillSaveMeta> = {
  'office-hours':         { slugPrefix: 'office-hours',    title: 'Office Hours',    tag: 'design-doc' },
  'investigate':          { slugPrefix: 'investigations',  title: 'Investigation',   tag: 'investigation' },
  'plan-ceo-review':      { slugPrefix: 'ceo-plans',       title: 'CEO Plan',        tag: 'ceo-plan' },
  'plan-eng-review':      { slugPrefix: 'eng-reviews',     title: 'Eng Review',      tag: 'eng-review' },
  'plan-design-review':   { slugPrefix: 'design-reviews',  title: 'Design Review',   tag: 'design-review' },
  'plan-devex-review':    { slugPrefix: 'devex-reviews',   title: 'Devex Review',    tag: 'devex-review' },
  'retro':                { slugPrefix: 'retros',          title: 'Retro',           tag: 'retro' },
  'ship':                 { slugPrefix: 'releases',        title: 'Release',         tag: 'release' },
  'cso':                  { slugPrefix: 'security-audits', title: 'Security Audit',  tag: 'security-audit' },
  'design-consultation':  { slugPrefix: 'design-systems',  title: 'Design System',   tag: 'design-system' },
};

export function generateGBrainContextLoad(ctx: TemplateContext): string {
  let base = `## Brain Context Load

**Skip this entire section if \`gbrain\` is not on PATH.**

Extract 2-4 keywords from the user's request. Search the brain:
\`gbrain search "<keywords>"\`. Read the top 3 results with
\`gbrain get_page "<slug>"\`. Use that context to inform your analysis.

If \`gbrain search\` returns no results or any non-zero exit, proceed
without brain context. Full search/read protocol + examples:
see \`docs/gbrain-write-surfaces.md\` §Context Load.`;

  if (ctx.skillName === 'investigate') {
    base += `\n\nFor structured-data extraction requests ("track this", "extract from emails", "build a tracker"), route to GBrain's data-research skill instead: \`gbrain call data-research\`.`;
  }

  return base;
}

export function generateGBrainSaveResults(ctx: TemplateContext): string {
  // gbrain v0.18+ uses `gbrain put <slug>` (NOT the deprecated `put_page`
  // MCP op). Compressed in v1.50.0.0: the inline heredoc + entity-stub +
  // throttle + backlink prose moved to docs/gbrain-write-surfaces.md
  // §Save Template, which the agent reads on demand when it actually
  // saves. The compact pointer keeps non-gbrain users' token overhead
  // near zero when their host's static suppression is overridden by
  // detection.
  const meta = skillSaveMap[ctx.skillName];

  if (!meta) {
    return `## Save Results to Brain

**Skip this entire section if \`gbrain\` is not on PATH.**

If the skill output is worth preserving, save it via
\`gbrain put "<slug>" --content "<frontmatter + markdown>"\`. Full template
(heredoc body, frontmatter shape, entity-stub instructions, throttle
handling): see \`docs/gbrain-write-surfaces.md\` §Save Template.`;
  }

  return `## Save Results to Brain

**Skip this entire section if \`gbrain\` is not on PATH.**

After completing this skill, save the output:

\`\`\`bash
gbrain put "${meta.slugPrefix}/<feature-slug>" --content "$(cat <<'EOF'
---
title: "${meta.title}: <feature name>"
tags: [${meta.tag}, <feature-slug>]
---
<skill output in markdown>
EOF
)"
\`\`\`

Then extract person/org entities and create stub pages for each one.
Throttle errors (exit 1 with "throttle"/"rate limit"/"busy") and any
other non-zero exit are transient — don't retry inline. Full entity-stub
template, throttle handling, and backlink protocol:
see \`docs/gbrain-write-surfaces.md\` §Save Template.`;
}

// ────────────────────────────────────────────────────────────────────
// Brain-aware planning resolvers (T4 / v1.48 plan)
// ────────────────────────────────────────────────────────────────────

/**
 * Returns true when this skill is registered for brain preflight. Skills not
 * in SKILL_DIGEST_SUBSETS get an empty BRAIN_PREFLIGHT block (no behavior).
 */
function isPreflightSkill(skillName: string): boolean {
  return Object.prototype.hasOwnProperty.call(SKILL_DIGEST_SUBSETS, skillName);
}

/**
 * Renders the per-skill BRAIN_PREFLIGHT block. The rendered output is a single
 * bash script that:
 *   1. Reads each digest file from gstack-brain-cache get (one call per digest)
 *   2. Falls back to "(brain context unavailable)" on missing
 *   3. Concatenates outputs into a single ## Brain Context block injected
 *      into the skill's prompt context
 *   4. Tells the agent: "use this context to skip already-known questions"
 *
 * The cache CLI handles cold-refresh + lock dedup + stale-but-usable
 * fallback internally. From the resolver's perspective the call is one
 * shell command per digest.
 */
export function generateBrainPreflight(ctx: TemplateContext): string {
  if (!isPreflightSkill(ctx.skillName)) return '';
  const subset = getSkillSubset(ctx.skillName);
  const binDir = ctx.paths.binDir;
  // Build the bash that loads each digest. Per-skill subset is small (2-5 entries).
  const loadLines = subset.map((entityName) => {
    const entity = BRAIN_CACHE_ENTITIES[entityName];
    if (!entity) return '';
    const projectFlag = entity.scope === 'per-project' ? '--project "$SLUG"' : '';
    return `  printf '\\n### %s\\n\\n' "${entityName}"\n  ${binDir}/gstack-brain-cache get ${entityName} ${projectFlag} 2>/dev/null || printf '_(no ${entityName} digest available yet)_\\n'`;
  }).join('\n');

  return `## Brain Context (preflight)

Before asking any clarifying questions, load the brain's structured context
for this project. The cache layer handles staleness, refresh, and stale-but-
usable fallback automatically. Skip questions whose answers are already
present in the loaded context; ground recommendations in what the brain
already knows about the user, the product, the goals, and recent decisions.

\`\`\`bash
eval "$(${binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
{
  printf '## Brain Context\\n\\n'
${loadLines}
} > /tmp/.gstack-brain-context-$$.md 2>/dev/null
[ -s /tmp/.gstack-brain-context-$$.md ] && cat /tmp/.gstack-brain-context-$$.md
rm -f /tmp/.gstack-brain-context-$$.md 2>/dev/null || true
\`\`\`

**How to use this context:**
- If \`product\` digest names the value prop, target user, or stage — don't re-ask.
- If \`goals\` digest lists active goals — frame recommendations against them.
- If \`recent-decisions\` digest names a prior scope/architecture choice — flag if this plan contradicts.
- If \`user-profile\` digest carries calibration pattern statements ("tends to over-engineer security") — surface them when relevant.
- If a digest is \`(no X digest available yet)\`, treat that section as cold; ask the user.

**Privacy:** Salience digest is filtered by allowlist (D9 default: \`projects/\`,
\`gstack/\`, \`concepts/\` only). Personal/family/therapy content never leaks here.
`;
}

/**
 * Renders the at-skill-end background refresh hook. Fires after the skill's
 * own work completes (telemetry has already logged); kicks any digest whose
 * age exceeds half its TTL but hasn't yet expired, so the NEXT invocation
 * gets a fresh cache without paying the cold-miss tax.
 *
 * Subordinate to {{TELEMETRY}} — runs after. Doesn't block the user.
 */
export function generateBrainCacheRefresh(ctx: TemplateContext): string {
  if (!isPreflightSkill(ctx.skillName)) return '';
  const binDir = ctx.paths.binDir;
  return `## Brain Cache Background Refresh

After the skill's work completes (and telemetry has logged), kick a
background refresh of any cache digest that's getting close to its TTL.
This is non-blocking — the user doesn't wait. Next invocation benefits
from the warm cache.

\`\`\`bash
eval "$(${binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
(${binDir}/gstack-brain-cache refresh --project "$SLUG" 2>/dev/null &) || true
\`\`\`
`;
}

/**
 * Renders the calibration write-back block. ONLY emits when the skill makes
 * typed decisions worth a kind=bet take AND the brain trust policy is
 * personal. Phase 2 / E5 cross-skill calibration.
 *
 * Gated behind BRAIN_CALIBRATION_WRITEBACK feature flag in the resolver
 * output — the flag stays false until upstream gbrain ships takes_add MCP
 * op (T8). When the flag flips, the existing skill templates pick up the
 * write-back behavior without any template changes.
 */
export function generateBrainWriteBack(ctx: TemplateContext): string {
  if (!isPreflightSkill(ctx.skillName)) return '';
  const weight = SKILL_CALIBRATION_WEIGHTS[ctx.skillName];
  if (weight == null) return '';
  // List the cache digests this skill's writes should invalidate. Multiple
  // skills write to multiple entities; the invalidation map captures this.
  const invalidatesEntities = getInvalidationTargets(`/${ctx.skillName}`);
  const invalidateBash = invalidatesEntities
    .map((e) => `  ${ctx.paths.binDir}/gstack-brain-cache invalidate ${e} --project "$SLUG" 2>/dev/null || true`)
    .join('\n');

  return `## Brain Calibration Write-Back (Phase 2 / gated)

When the skill makes a typed prediction worth tracking (scope decision,
TTHW target, architectural bet, wedge commitment), it MAY write a
\`kind=bet\` take to the brain so a calibration profile builds over time.

**Gated on two things:**
1. Brain trust policy for the active endpoint is \`personal\` (check via
   \`${ctx.paths.binDir}/gstack-config get brain_trust_policy@<endpoint-hash>\`).
   Shared brains skip write-back to avoid polluting team calibration.
2. Feature flag \`BRAIN_CALIBRATION_WRITEBACK\` is set (today: false; flips
   to true when upstream gbrain v0.42+ ships \`takes_add\` MCP op).

When both gates pass, the write-back path uses \`mcp__gbrain__takes_add\`
to record a take with weight ${weight} (per SKILL_CALIBRATION_WEIGHTS).
If the MCP op is unavailable, fall back to \`mcp__gbrain__put_page\` with
a gstack:takes fence block (documented but uglier path).

Mandatory take frontmatter shape:
\`\`\`yaml
kind: bet
holder: <user identity from whoami>
claim: <one-line prediction the skill is making>
weight: ${weight}
since_date: <today's date>
expected_resolution: <date in 1-3 months depending on skill>
source_skill: ${ctx.skillName}
\`\`\`

After write, invalidate the affected digests so the next preflight reflects
the new state:

\`\`\`bash
eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
${invalidateBash || '  # (no per-skill invalidation targets configured)'}
\`\`\`
`;
}
