/**
 * Preamble composition root.
 *
 * Each generator lives in its own file under ./preamble/*.ts. This file only
 * wires them together via generatePreamble(). Keep composition declarative —
 * no inline logic beyond tier gating.
 *
 * Each skill runs independently via `claude -p` (or the host's equivalent).
 * There is no shared loader. The preamble provides: update checks, session
 * tracking, user preferences, repo mode detection, model overlays, and
 * telemetry.
 *
 * Telemetry data flow:
 *   1. Always: local JSONL append to ~/.gstack/analytics/ (inline, inspectable)
 *   2. If _TEL != "off" AND binary exists: gstack-telemetry-log for remote reporting
 */


import type { TemplateContext } from './types';
import { generateModelOverlay } from './model-overlay';
import { generateQuestionTuning } from './question-tuning';

// Core bootstrap
import { generatePreambleBash } from './preamble/generate-preamble-bash';
import { generateUpgradeCheck } from './preamble/generate-upgrade-check';
import {
  generateCompletionStatus,
  generatePlanModeInfo,
} from './preamble/generate-completion-status';

// Host-specific instructions
import { generateBrainHealthInstruction } from './preamble/generate-brain-health-instruction';

// GBrain cross-machine sync (runs at skill start; end-side handled in completion-status)
import { generateBrainSyncBlock } from './preamble/generate-brain-sync-block';

// Behavioral / voice
import { generateVoiceDirective } from './preamble/generate-voice-directive';

// Tier 2+ context and interaction framework
import { generateContextRecovery } from './preamble/generate-context-recovery';
import { generateAskUserFormat } from './preamble/generate-ask-user-format';
import { generateWritingStyle } from './preamble/generate-writing-style';
import { generateCompletenessSection } from './preamble/generate-completeness-section';
import { generateConfusionProtocol } from './preamble/generate-confusion-protocol';
import { generateEvidenceDirective } from './preamble/generate-evidence-directive';
import { generateContinuousCheckpoint } from './preamble/generate-continuous-checkpoint';
import { generateContextHealth } from './preamble/generate-context-health';

// Tier 3+ repo mode + search
import { generateRepoModeSection } from './preamble/generate-repo-mode-section';
import { generateSearchBeforeBuildingSection } from './preamble/generate-search-before-building';
import { generateMakePdfSetup } from './make-pdf';

// Standalone export used directly by the resolver registry
export { generateTestFailureTriage } from './preamble/generate-test-failure-triage';

// Preamble Composition (tier → sections)
// ─────────────────────────────────────────────
// T1: core + upgrade + lake + telemetry + voice(trimmed) + completion
// T2: T1 + voice(full) + ask + completeness + context-recovery + confusion + checkpoint + context-health
// T3: T2 + repo-mode + search
// T4: (same as T3 — TEST_FAILURE_TRIAGE is a separate {{}} placeholder, not preamble)
//
// Which skill gets which tier lives in each template's frontmatter
// (`preamble-tier: N`). Every template that resolves {{PREAMBLE}} must
// declare it — there is no default.
export function generatePreamble(ctx: TemplateContext): string {
  const tier = ctx.preambleTier;
  const governed = ['review', 'ship', 'land-and-deploy', 'setup-deploy'].includes(ctx.skillName);
  if (tier === undefined) {
    throw new Error(
      `Missing preamble-tier frontmatter in ${ctx.tmplPath}: every template that ` +
      `resolves {{PREAMBLE}} must declare 'preamble-tier: N' (1-4).`
    );
  }
  if (tier < 1 || tier > 4) {
    throw new Error(`Invalid preamble-tier: ${tier} in ${ctx.tmplPath}. Must be 1-4.`);
  }
  if (ctx.host === 'codex' && governed) {
    return [
      generatePreambleBash(ctx),
      `## ECPE eager safety kernel

- **ECPE-SCOPE-RESOLUTION** — resolve the governed base/diff scope before acting; an unresolved or invalid scope is unknown, never empty.
- **ECPE-EXPLICIT-EFFECT-SEPARATION** — reads and reports do not imply tracked writes, Git/provider mutation, paid-model use, merge, or deploy authority. Resolve each explicit effect at its closed adapter immediately before use.
- **ECPE-TRUSTED-SUBJECT-IDENTITY** — use only the subject identity returned by the installed authority path. Do not substitute a caller path, ambient checkout, prompt claim, or remembered hash.
- **ECPE-HARD-STOP** — missing, stale, mismatched, consumed, or unverifiable authority evidence stops that effect and spawns zero effect children.
- **ECPE-FINAL-EVIDENCE-HONESTY** — claim only fresh observed results. Missing section delivery/end/flush, direct file reads, and host-reported open assertions leave section coverage unknown. Report eager bytes plus adapter-delivered section bytes; never count carved-but-unmeasured text as savings.

Stage procedure is on demand. A small answer, docs-only edit, or focused code
task loads no recovery, checkpoint, search, completeness, learning, test-triage,
release, or deploy module by default. Follow only a verified section batch
emitted by the installed anchor for the current compiled skill/stage.`,
      `## Completion and one-shot observation flush

Report DONE, DONE_WITH_CONCERNS, BLOCKED, or NEEDS_CONTEXT with the fresh
evidence that supports it. At workflow end, run the existing single flush:

\`\`\`bash
${ctx.paths.binDir}/gstack-skill-end --skill "${ctx.skillName}" --outcome OUTCOME \\
  --session-id "SESSION_ID" --tel-start "TEL_START" --used-browse USED_BROWSE \\
  --error-message "ERROR_MESSAGE" --failed-step "FAILED_STEP" 2>/dev/null || true
\`\`\`

Use SESSION_ID/TEL_START from the direct preamble output. If the flush is
missing or fails, say coverage is unknown; do not synthesize a successful end.`,
    ].join('\n\n');
  }
  const sections = [
    generatePreambleBash(ctx),
    ...(ctx.skillName === 'make-pdf' ? [generateMakePdfSetup(ctx)] : []),
    // Plan-mode-skill semantics stays near the top: after bash (so _SESSION_ID /
    // _BRANCH / _TEL env vars are live) and before all onboarding gates so
    // models read the authoritative "AskUserQuestion satisfies plan mode's
    // end-of-turn" rule before any other instruction. Renders for all skills
    // (not interactive-gated); the text applies universally.
    generatePlanModeInfo(ctx),
    generateUpgradeCheck(ctx),
    // Phase 2: the 8 one-time onboarding generators (lake-intro, telemetry-
    // prompt, proactive-prompt, first-run-guidance, routing-injection,
    // vendoring-deprecation, spawned-session-check, writing-style-migration)
    // moved into bin/gstack-skill-start's instruction-emission layer — their
    // text appears at runtime only when its gate fires (plan Q2/OV6/F5).
    generateBrainHealthInstruction(ctx),
    // AskUserQuestion Format renders BEFORE the model overlay so the pacing rule
    // is the ambient default; the overlay's behavioral nudges land as subordinate
    // patches. Opus 4.7 reads top-to-bottom and absorbs the first pacing directive
    // it hits; reversing this order regresses plan-review cadence (v1.6.4.0 bug).
    ...(tier >= 2 ? [generateAskUserFormat(ctx)] : []),
    ...(governed ? [] : [generateBrainSyncBlock(ctx)]),
    generateModelOverlay(ctx),
    generateVoiceDirective(tier),
    ...(tier >= 2 ? [
      ...(governed ? [] : [generateContextRecovery(ctx)]),
      generateWritingStyle(ctx),
      generateCompletenessSection(ctx),
      generateConfusionProtocol(ctx),
      generateEvidenceDirective(ctx),
      generateContinuousCheckpoint(ctx),
      generateContextHealth(ctx),
      ...(governed ? [] : [generateQuestionTuning(ctx)]),
    ] : []),
    ...(tier >= 3 ? [generateRepoModeSection(), generateSearchBeforeBuildingSection(ctx)] : []),
    generateCompletionStatus(ctx),
  ];
  return sections.filter(s => s && s.trim().length > 0).join('\n\n');
}
