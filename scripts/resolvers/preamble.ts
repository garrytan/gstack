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

// One-time onboarding prompts
import { generateLakeIntro } from './preamble/generate-lake-intro';
import { generateTelemetryPrompt } from './preamble/generate-telemetry-prompt';
import { generateProactivePrompt } from './preamble/generate-proactive-prompt';
import { generateRoutingInjection } from './preamble/generate-routing-injection';
import { generateVendoringDeprecation } from './preamble/generate-vendoring-deprecation';
import { generateSpawnedSessionCheck } from './preamble/generate-spawned-session-check';
import { generateWritingStyleMigration } from './preamble/generate-writing-style-migration';

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
import { generateContinuousCheckpoint } from './preamble/generate-continuous-checkpoint';
import { generateContextHealth } from './preamble/generate-context-health';

// Tier 3+ repo mode + search
import { generateRepoModeSection } from './preamble/generate-repo-mode-section';
import { generateSearchBeforeBuildingSection } from './preamble/generate-search-before-building';

// Standalone export used directly by the resolver registry
export { generateTestFailureTriage } from './preamble/generate-test-failure-triage';

// Preamble Composition (tier → sections)
// ─────────────────────────────────────────────
// T1: core + upgrade + lake + telemetry + voice(trimmed) + completion
// T2: T1 + voice(full) + ask + completeness + context-recovery + confusion + checkpoint + context-health
// T3: T2 + repo-mode + search
// T4: (same as T3 — TEST_FAILURE_TRIAGE is a separate {{}} placeholder, not preamble)
//
// Skills by tier:
//   T1: browse, setup-cookies, benchmark
//   T2: investigate, cso, retro, doc-release, setup-deploy, canary, context-save, context-restore, health
//   T3: autoplan, codex, design-consult, office-hours, ceo/design/eng-review
//   T4: ship, review, qa, qa-only, design-review, land-deploy
export function generatePreamble(ctx: TemplateContext): string {
  const tier = ctx.preambleTier ?? 4;
  if (tier < 1 || tier > 4) {
    throw new Error(`Invalid preamble-tier: ${tier} in ${ctx.tmplPath}. Must be 1-4.`);
  }
  const sections = [
    generatePreambleBash(ctx),
    // Plan-mode-skill semantics at position 1: after bash (so _SESSION_ID /
    // _BRANCH / _TEL env vars are live) and before all onboarding gates so
    // models read the authoritative "AskUserQuestion satisfies plan mode's
    // end-of-turn" rule before any other instruction. Renders for all skills
    // (not interactive-gated); the text applies universally.
    generatePlanModeInfo(ctx),
    generateUpgradeCheck(ctx),
    generateWritingStyleMigration(ctx),
    generateLakeIntro(),
    generateTelemetryPrompt(ctx),
    generateProactivePrompt(ctx),
    generateRoutingInjection(ctx),
    generateVendoringDeprecation(ctx),
    generateSpawnedSessionCheck(),
    generateBrainHealthInstruction(ctx),
    // AskUserQuestion Format renders BEFORE the model overlay so the pacing rule
    // is the ambient default; the overlay's behavioral nudges land as subordinate
    // patches. Opus 4.7 reads top-to-bottom and absorbs the first pacing directive
    // it hits; reversing this order regresses plan-review cadence (v1.6.4.0 bug).
    ...(tier >= 2 ? [generateAskUserFormat(ctx)] : []),
    generateBrainSyncBlock(ctx),
    generateModelOverlay(ctx),
    generateVoiceDirective(tier),
    ...(tier >= 2 ? [
      generateContextRecovery(ctx),
      generateWritingStyle(ctx),
      generateCompletenessSection(),
      generateConfusionProtocol(),
      generateContinuousCheckpoint(),
      generateContextHealth(),
      generateQuestionTuning(ctx),
    ] : []),
    ...(tier >= 3 ? [generateRepoModeSection(), generateSearchBeforeBuildingSection(ctx)] : []),
    generateCompletionStatus(ctx),
  ];
  return sections.filter(s => s && s.trim().length > 0).join('\n\n');
}
