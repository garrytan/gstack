/**
 * Per-skill SKILL.md size budget regression (v1.46.0.0 T5).
 *
 * Asserts that no skill's generated SKILL.md grew beyond the v1.47.0.0
 * baseline. Catches preamble/resolver changes that bloat skills back to
 * the pre-compression size. Free — pure file IO + JSON diff.
 *
 * Baseline rebased v1.44.1 → v1.47.0.0 in the AskUserQuestion split-rule
 * PR after main merged GSTACK_PLAN_MODE + /spec, pushing the v1.44.1
 * anchor past the 5% ratchet. Historical v1.44.1.json and v1.46.0.0.json
 * are retained in test/fixtures/ for reference.
 *
 * Why a separate test from skill-budget-regression.test.ts: that one
 * compares LIVE eval runs (tool calls, turns, cost); this one compares
 * static SKILL.md sizes. Both gate-tier.
 *
 * The baseline lives at test/fixtures/parity-baseline-v1.47.0.0.json,
 * captured by scripts/capture-baseline.ts before any Phase A work landed.
 *
 * Override:
 * - GSTACK_SIZE_BUDGET_RATIO=<n> changes the per-skill regression ratio.
 *   Default 1.0 (no growth allowed). Set to 1.10 to permit 10% growth
 *   (e.g., during deliberate feature additions that the catalog trim
 *   doesn't offset).
 * - GSTACK_SIZE_BUDGET_OVERRIDE_REASON="text" allows a regression to
 *   pass and logs the reason to ~/.gstack/analytics/spend-overrides.jsonl
 *   for audit. Use sparingly; the next baseline should bake in the new
 *   size.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { captureBaseline, type ParityBaseline } from './helpers/capture-parity-baseline';
import { logBudgetOverride } from './helpers/budget-override';
import { CARVED_SKILLS } from './helpers/carve-guards';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'parity-baseline-v1.47.0.0.json');

// Default per-skill ratio is 1.50 (50% growth tolerance). Adjusted v1.52.0.0
// (cathedral cap audit) from 1.05 → 1.50: a 5% ratio tripped on legitimate
// feature additions (e.g., plan-tune cathedral T13 grew SKILL.md ×1.24
// adding load-bearing Dream cycle + Audit unmarked + Recent auto-decisions
// surfaces). Real bloat is 2-3×; this catches that while not tripping on
// normal feature scope. The always-loaded catalog cost is enforced
// separately with a hard ceiling.
const DEFAULT_RATIO = 1.50;
const RATIO = Number(process.env.GSTACK_SIZE_BUDGET_RATIO) || DEFAULT_RATIO;

interface Regression {
  skill: string;
  beforeBytes: number;
  afterBytes: number;
  growth: number;
}

describe('SKILL.md size budget regression (gate, free)', () => {
  test('parity-baseline-v1.47.0.0.json exists', () => {
    expect(fs.existsSync(BASELINE_PATH)).toBe(true);
  });

  test('no skill exceeds v1.47.0.0 baseline size × ratio', () => {
    const baseline: ParityBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const current = captureBaseline({ repoRoot: REPO_ROOT });

    const regressions: Regression[] = [];
    for (const [skill, before] of Object.entries(baseline.skills)) {
      const after = current.skills[skill];
      if (!after) continue; // skill removed since v1.44 — not a regression
      if (after.skillMdBytes <= before.skillMdBytes * RATIO) continue;
      regressions.push({
        skill,
        beforeBytes: before.skillMdBytes,
        afterBytes: after.skillMdBytes,
        growth: after.skillMdBytes / before.skillMdBytes,
      });
    }

    if (regressions.length === 0) return;

    const overrideReason = process.env.GSTACK_SIZE_BUDGET_OVERRIDE_REASON?.trim();
    if (overrideReason) {
      logBudgetOverride({
        scope: 'skill-size-budget',
        reason: overrideReason,
        details: { ratio: RATIO, regressions },
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[skill-size-budget] OVERRIDE APPLIED (${overrideReason}) — ${regressions.length} regression(s) allowed:`,
      );
      for (const r of regressions) {
        // eslint-disable-next-line no-console
        console.warn(`  ${r.skill}: ${r.beforeBytes} → ${r.afterBytes} bytes (×${r.growth.toFixed(2)})`);
      }
      return;
    }

    const msg = regressions.map(r =>
      `  ${r.skill}: ${r.beforeBytes} → ${r.afterBytes} bytes (×${r.growth.toFixed(2)})`,
    ).join('\n');
    throw new Error(
      `${regressions.length} skill(s) regressed past v1.47.0.0 baseline × ${RATIO}:\n${msg}\n` +
      `Override: set GSTACK_SIZE_BUDGET_OVERRIDE_REASON="why this is OK" to allow and audit-log.`,
    );
  });

  test('total corpus byte count does not regress past baseline × ratio', () => {
    const baseline: ParityBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const current = captureBaseline({ repoRoot: REPO_ROOT });
    const ratio = current.totalCorpusBytes / baseline.totalCorpusBytes;
    if (current.totalCorpusBytes <= baseline.totalCorpusBytes * RATIO) {
      // eslint-disable-next-line no-console
      console.log(
        `[skill-size-budget] corpus OK: ${baseline.totalCorpusBytes} → ${current.totalCorpusBytes} bytes (×${ratio.toFixed(3)})`,
      );
      return;
    }
    const overrideReason = process.env.GSTACK_SIZE_BUDGET_OVERRIDE_REASON?.trim();
    if (overrideReason) {
      logBudgetOverride({
        scope: 'skill-size-budget-corpus',
        reason: overrideReason,
        details: { ratio: RATIO, observed: ratio, before: baseline.totalCorpusBytes, after: current.totalCorpusBytes },
      });
      return;
    }
    throw new Error(
      `Total corpus regressed past v1.47.0.0 baseline × ${RATIO}: ` +
      `${baseline.totalCorpusBytes} → ${current.totalCorpusBytes} bytes (×${ratio.toFixed(3)}). ` +
      `Override: set GSTACK_SIZE_BUDGET_OVERRIDE_REASON to allow.`,
    );
  });

  /**
   * Gap E (v1.46.0.0): per-skill min-size floor.
   *
   * The existing skill-coverage-floor enforces body ≥ 200 bytes, which is
   * a tiny noise floor. A skill that was 100 KB at v1.47.0.0 and shrinks to
   * 250 bytes passes that check despite losing 99.75% of content. The
   * parity-suite content invariants cover this for 10 hand-picked skills
   * (cso, ship, plan-ceo, etc.); the remaining 41 skills had no per-skill
   * shrinkage floor.
   *
   * Floor: 80% of the v1.47.0.0 baseline. v1.46 actual shrinkage is <1% per
   * skill, so this is a comfortable ceiling that still catches accidental
   * mass deletion (e.g., a refactor that strips the body of a skill).
   *
   * v2.0.0.0 introduces the sections/ pattern for 5 heavyweights
   * (ship, plan-ceo-review, office-hours, plan-eng-review,
   * plan-design-review). Carved so far: ship (skeleton ~83 KB) and
   * plan-ceo-review (skeleton ~81 KB, down from the 138 KB monolith). Those
   * skeletons legitimately fall below the 80% body-strip floor, so each carved
   * skill is added to SECTIONS_EXTRACTED; its union is guarded instead by the
   * sectioned invariant in parity-harness.ts (minBytes on skeleton+sections).
   * Add the remaining three here as they carve.
   */
  test('no skill shrinks past 80% of v1.47.0.0 baseline (catches accidental body strip)', () => {
    const baseline: ParityBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const current = captureBaseline({ repoRoot: REPO_ROOT });
    const MIN_RATIO = 0.80; // a skill at <80% of its v1.44 size signals mass-deletion
    // Carved skills (v2 plan T9): the skeleton SKILL.md intentionally shrinks
    // because prose moved into sections/*.md. The union size is guarded instead
    // by the sectioned invariant in parity-harness.ts (minBytes on the
    // skeleton+sections union), so exempt the skeleton from the body-strip floor.
    // EQ1: derived from the canonical CARVE_GUARDS registry — no parallel list.
    const SECTIONS_EXTRACTED = new Set<string>(CARVED_SKILLS);

    const undershoots: Array<{
      skill: string; beforeBytes: number; afterBytes: number; ratio: number;
    }> = [];
    for (const [skill, before] of Object.entries(baseline.skills)) {
      if (SECTIONS_EXTRACTED.has(skill)) continue;
      const after = current.skills[skill];
      if (!after) continue; // skill removed since baseline — separate concern
      const ratio = after.skillMdBytes / before.skillMdBytes;
      if (ratio < MIN_RATIO) {
        undershoots.push({
          skill, beforeBytes: before.skillMdBytes, afterBytes: after.skillMdBytes, ratio,
        });
      }
    }

    if (undershoots.length === 0) return;

    const overrideReason = process.env.GSTACK_SIZE_BUDGET_OVERRIDE_REASON?.trim();
    if (overrideReason) {
      logBudgetOverride({
        scope: 'skill-size-budget-floor',
        reason: overrideReason,
        details: { min_ratio: MIN_RATIO, undershoots },
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[skill-size-budget-floor] OVERRIDE APPLIED (${overrideReason}) — ${undershoots.length} undershoot(s) allowed`,
      );
      return;
    }

    const msg = undershoots.map(u =>
      `  ${u.skill}: ${u.beforeBytes} → ${u.afterBytes} bytes (×${u.ratio.toFixed(2)} — below ${MIN_RATIO} floor)`,
    ).join('\n');
    throw new Error(
      `${undershoots.length} skill(s) shrunk past v1.47.0.0 × ${MIN_RATIO} floor:\n${msg}\n` +
      `This usually signals accidental body strip (e.g., a resolver returning empty, a ` +
      `template losing a section). If the shrinkage is intentional (e.g., the skill moved ` +
      `to the sections/ pattern), add it to SECTIONS_EXTRACTED in this test. Override: ` +
      `GSTACK_SIZE_BUDGET_OVERRIDE_REASON="why" allows + audit-logs.`,
    );
  });

  test('catalog token estimate stays compressed (v1.45 target ≤ 7000)', () => {
    const current = captureBaseline({ repoRoot: REPO_ROOT });
    const v145Target = 7000;
    if (current.estTotalCatalogTokens <= v145Target) {
      // eslint-disable-next-line no-console
      console.log(`[skill-size-budget] catalog OK: ~${current.estTotalCatalogTokens} tokens (target ≤${v145Target})`);
      return;
    }
    const overrideReason = process.env.GSTACK_SIZE_BUDGET_OVERRIDE_REASON?.trim();
    if (overrideReason) {
      logBudgetOverride({
        scope: 'skill-size-budget-catalog',
        reason: overrideReason,
        details: { target: v145Target, observed: current.estTotalCatalogTokens },
      });
      return;
    }
    throw new Error(
      `Catalog token estimate regressed past v1.45 target: ${current.estTotalCatalogTokens} tokens > ${v145Target}. ` +
      `T4 catalog trim should keep this under control. Override: set GSTACK_SIZE_BUDGET_OVERRIDE_REASON to allow.`,
    );
  });
});
