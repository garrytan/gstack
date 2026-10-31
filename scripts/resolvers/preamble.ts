/**
 * Preamble composition root.
 *
 * Each generator lives in its own file under ./preamble/*.ts. This file only
 * wires them together: preambleSections() is the composition, and
 * generatePreamble() joins it into the full inline render that tests use as
 * the pre-hoist oracle. {{PREAMBLE}} resolves through ./preamble-hoist.ts,
 * which renders tier 1 inline and splits tier 2+ into a per-skill pointer plus
 * the shared sections/preamble.md the skill Reads on load. Keep composition
 * declarative — no inline logic beyond tier gating.
 *
 * Each skill runs independently via `claude -p` (or the host's equivalent).
 * The preamble provides: update checks, session
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
// T2: T1 + voice(full) + ask + completeness + context-recovery + confusion + context-health
// T3: T2 + repo-mode + search
// T4: (same as T3 — TEST_FAILURE_TRIAGE is a separate {{}} placeholder, not preamble)
//
// Which skill gets which tier lives in each template's frontmatter
// (`preamble-tier: N`). Every template that resolves {{PREAMBLE}} must
// declare it — there is no default.
export function generatePreamble(ctx: TemplateContext): string {
  return preambleSections(ctx).join('\n\n');
}

interface PreamblePiece {
  /** Module id suffix (`preamble:<id>`); null for the model overlay, whose module id is `overlay:<model>`. */
  id: string | null;
  minTier: number;
  when?: (ctx: TemplateContext) => boolean;
  render: (ctx: TemplateContext, tier: number) => string;
}

/**
 * The preamble's pieces in render order. AskUserQuestion Format renders BEFORE
 * the model overlay so the pacing rule is the ambient default; the overlay's
 * nudges land as subordinate patches (Opus 4.7 absorbs the first pacing
 * directive it hits; reversing this regresses plan-review cadence, v1.6.4.0).
 * Plan-mode semantics stays right after bash (so _SESSION_ID / _BRANCH / _TEL
 * are live) and before every onboarding gate. The 8 one-time onboarding
 * generators live in bin/gstack-skill-start's instruction layer (plan Q2/OV6/F5).
 */
export const PREAMBLE_PIECES: readonly PreamblePiece[] = [
  { id: 'bash', minTier: 1, render: generatePreambleBash },
  { id: 'make-pdf-setup', minTier: 1, when: ctx => ctx.skillName === 'make-pdf', render: generateMakePdfSetup },
  { id: 'plan-mode-info', minTier: 1, render: generatePlanModeInfo },
  { id: 'upgrade-check', minTier: 1, render: generateUpgradeCheck },
  { id: 'brain-health', minTier: 1, render: generateBrainHealthInstruction },
  { id: 'ask-user-format', minTier: 2, render: generateAskUserFormat },
  { id: 'brain-sync', minTier: 1, render: generateBrainSyncBlock },
  { id: null, minTier: 1, render: generateModelOverlay },
  { id: 'voice', minTier: 1, render: generateVoiceDirective },
  { id: 'context-recovery', minTier: 2, render: generateContextRecovery },
  { id: 'writing-style', minTier: 2, render: generateWritingStyle },
  { id: 'completeness', minTier: 2, render: generateCompletenessSection },
  { id: 'confusion', minTier: 2, render: generateConfusionProtocol },
  { id: 'evidence', minTier: 2, render: generateEvidenceDirective },
  { id: 'context-health', minTier: 2, render: generateContextHealth },
  { id: 'question-tuning', minTier: 2, render: generateQuestionTuning },
  { id: 'repo-mode', minTier: 3, render: () => generateRepoModeSection() },
  { id: 'search-before-building', minTier: 3, render: generateSearchBeforeBuildingSection },
  { id: 'completion-status', minTier: 1, render: generateCompletionStatus },
];

export const PREAMBLE_MODULE_IDS: readonly string[] = PREAMBLE_PIECES.flatMap(p => (p.id ? [`preamble:${p.id}`] : []));

/** The preamble's generator outputs in render order, empty ones dropped. */
export function preambleSections(ctx: TemplateContext): string[] {
  const tier = ctx.preambleTier;
  if (tier === undefined) {
    throw new Error(
      `Missing preamble-tier frontmatter in ${ctx.tmplPath}: every template that ` +
      `resolves {{PREAMBLE}} must declare 'preamble-tier: N' (1-4).`
    );
  }
  if (tier < 1 || tier > 4) {
    throw new Error(`Invalid preamble-tier: ${tier} in ${ctx.tmplPath}. Must be 1-4.`);
  }
  const filter = ctx.modules;
  const pieceTier = (piece: PreamblePiece): number => {
    if (!filter || piece.id === null || filter.pinned.has(`preamble:${piece.id}`)) return tier;
    return Math.min(tier, filter.preambleTierMax ?? tier);
  };
  return PREAMBLE_PIECES
    .filter(piece => (piece.when?.(ctx) ?? true)
      && !(piece.id && filter?.excluded.has(`preamble:${piece.id}`))
      && pieceTier(piece) >= piece.minTier)
    .map(piece => piece.render(ctx, pieceTier(piece)))
    .filter(s => s && s.trim().length > 0);
}
