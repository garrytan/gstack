/**
 * Context-budget ratchet — CI-enforced ceilings on the two token ledgers
 * nothing else guards (plan OV8):
 *
 *   ALWAYS-ON  — full frontmatter bytes every session's skill scanner loads
 *                (catalog-budget.test.ts caps name+description only; this
 *                catches growth in the OTHER frontmatter keys).
 *   EAGER      — per-invocation SKILL.md + forced-read references, per skill
 *                (skill-size-budget floors catch shrink; parity-suite catches
 *                growth RATIOS vs an old baseline; this pins absolute token
 *                ceilings that ratchet DOWN as reduction phases land).
 *
 * Fails when a skill's eager tokens exceed its fixture ceiling, when the
 * always-on aggregate exceeds its ceiling, or when a skill exists with no
 * ceiling at all (new skills must be consciously budgeted).
 *
 * RATCHET PROTOCOL (on failure):
 *   1. If the growth is a real feature: re-run
 *        bun test/helpers/capture-context-budget.ts
 *      and commit the refreshed fixture in the SAME commit as the feature,
 *      so the growth is a visible, conscious decision in the diff.
 *   2. If the growth is accidental (resolver bloat, duplicated block,
 *      copy-paste): fix the bloat instead.
 *   3. After a token-reduction phase lands: re-run the capture so ceilings
 *      ratchet down and the win is locked against regression.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { buildBill, checkBudget } from '../lib/context-bill';
import {
  buildRatchetBill,
  captureContextBudget,
  isFixtureSkill,
  toPosixName,
  BUDGET_FIXTURE_PATH,
  ALWAYS_ON_HEADROOM,
  EAGER_HEADROOM,
  type ContextBudget,
} from './helpers/capture-context-budget';

const RATCHET_PROTOCOL =
  'Ratchet protocol: legitimate feature growth -> re-run `bun test/helpers/capture-context-budget.ts` ' +
  'and commit the refreshed fixture in the same commit; accidental bloat -> fix the bloat; ' +
  'after a reduction lands -> re-run the capture so the ceilings ratchet down.';

const budget: ContextBudget = JSON.parse(fs.readFileSync(BUDGET_FIXTURE_PATH, 'utf-8'));
const bill = buildRatchetBill();

describe('context-budget ratchet', () => {
  // checkBudget only enforces alwaysOnTotal when it is typeof number — a
  // string or missing value from a hand edit or bad merge would silently
  // turn the always-on ceiling OFF while every test stays green. Validate
  // the fixture shape so the guard cannot be disabled by a typo.
  test('fixture shape is valid (a malformed fixture must not silently disable ceilings)', () => {
    expect(typeof budget.alwaysOnTotal).toBe('number');
    expect(Number.isFinite(budget.alwaysOnTotal)).toBe(true);
    const bad = Object.entries(budget.eagerPerInvocation).filter(
      ([, v]) => typeof v !== 'number' || !Number.isFinite(v),
    );
    expect(bad, `Non-numeric ceilings: ${bad.map(([k]) => k).join(', ')}. Re-run the capture.`).toEqual([]);
  });

  // Mutation pin: the fixture-skill filter must actually shrink the
  // always-on sum vs the raw bill (deleting the totals recompute would leak
  // fixture tokens under the headroom and never fail a ceiling).
  test('filtering fixture skills shrinks the always-on ledger vs the raw bill', () => {
    const raw = buildBill(path.join(import.meta.dir, '..'));
    expect(bill.skills.some((s) => s.name.startsWith('test/'))).toBe(false);
    expect(bill.totals.skillCount).toBeLessThan(raw.totals.skillCount);
    expect(bill.totals.alwaysOnTokens).toBeLessThan(raw.totals.alwaysOnTokens);
  });
  test('always-on + eager ledgers stay under the fixture ceilings', () => {
    // actual === null means "fixture names a skill missing from the tree" —
    // the dedicated stale-fixture test below owns that case with a clearer
    // message; filtering here keeps one failure from producing two reports.
    const violations = checkBudget(bill, {
      alwaysOnTotal: budget.alwaysOnTotal,
      eagerPerInvocation: budget.eagerPerInvocation,
    }).filter((v) => v.actual !== null);
    const detail = violations
      .map((v) => `  ${v.ceiling}: ${v.actual} tok > limit ${v.limit}\n    ${v.files.join('\n    ')}`)
      .join('\n');
    expect(
      violations.length,
      `Context-budget ceilings exceeded:\n${detail}\n${RATCHET_PROTOCOL}`,
    ).toBe(0);
  });

  test('every skill in the tree has an eager ceiling (new skills are consciously budgeted)', () => {
    const missing = bill.skills
      .map((s) => s.name)
      .filter((name) => !(name in budget.eagerPerInvocation));
    expect(
      missing,
      `Skills without a context-budget ceiling: ${missing.join(', ')}.\n` +
        `Add them by re-running the capture. ${RATCHET_PROTOCOL}`,
    ).toEqual([]);
  });

  test('fixture has no ceilings for skills that no longer exist', () => {
    const live = new Set(bill.skills.map((s) => s.name));
    const stale = Object.keys(budget.eagerPerInvocation).filter((name) => !live.has(name));
    expect(
      stale,
      `Fixture carries ceilings for removed skills: ${stale.join(', ')}. Re-run the capture.`,
    ).toEqual([]);
  });

  // Windows lane: skill names arrive backslash-separated from path.relative;
  // the normalization must make the filter and the POSIX fixture keys agree.
  test('name normalization handles Windows separators', () => {
    expect(toPosixName(['test', 'fixtures', 'context-bill', 'tree-a', 'alpha'].join(path.sep))).toBe(
      'test/fixtures/context-bill/tree-a/alpha',
    );
    expect(isFixtureSkill(['test', 'fixtures', 'x'].join(path.sep))).toBe(true);
    expect(isFixtureSkill('test/fixtures/context-bill/tree-a/alpha')).toBe(true);
    expect(isFixtureSkill('openclaw/skills/gstack-openclaw-retro')).toBe(false);
    expect(bill.skills.every((s) => !s.name.includes('\\'))).toBe(true);
  });

  // Round-trip: a fresh capture must pass its own ratchet, and the headroom
  // math must be exactly ceil(actual x headroom) — the recovery protocol is
  // "re-run the capture", so a corrupt write side poisons every future fixture.
  test('captureContextBudget round-trips against its own bill', () => {
    const TREE_A = path.join(import.meta.dir, 'fixtures', 'context-bill', 'tree-a');
    const capture = captureContextBudget(TREE_A);
    const treeBill = buildRatchetBill(TREE_A);
    expect(checkBudget(treeBill, capture)).toEqual([]);
    for (const s of treeBill.skills) {
      expect(capture.eagerPerInvocation[s.name]).toBe(Math.ceil(s.eagerTokens * EAGER_HEADROOM));
    }
    expect(capture.alwaysOnTotal).toBe(Math.ceil(treeBill.totals.alwaysOnTokens * ALWAYS_ON_HEADROOM));
  });
});
