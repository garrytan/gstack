/**
 * CEO-28 / DX-11 / ENG-10: a review that lists high-severity findings is never
 * `VERDICT: clean`. The Oct 7 /autoplan run's Codex CEO and DX outputs labeled
 * seven and eight findings "High"/"Medium" without [Pn] tags, and the installed
 * classifier printed `VERDICT: clean` / `FINDINGS: none` for both. The fixtures
 * in test/fixtures/outside-review-severity/ reproduce those shapes (the
 * findings come from the run's review record; the raw outputs were not kept),
 * plus the eng output's [P1] tags, a table, and prose negative controls.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyOutsideReview, type OutsideGate } from '../lib/outside-review-result';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { outsideVoiceCommand } from '../scripts/resolvers/outside-voice';

const ROOT = path.resolve(import.meta.dir, '..');
const LIB = path.join(ROOT, 'lib', 'outside-review-result.ts');
const FIX = path.join(ROOT, 'test', 'fixtures', 'outside-review-severity');
const fixture = (name: string) => path.join(FIX, name);
const read = (name: string) => fs.readFileSync(fixture(name), 'utf8');
const REC = 'Recommendation: fix it because the change loses data.';

describe('severity words count as findings in label position', () => {
  for (const [name, highest] of [
    ['ceo-codex-shape.txt', 'P1'],
    ['dx-codex-shape.txt', 'P1'],
    ['eng-codex-tagged.txt', 'P1'],
    ['table-shape.txt', 'P1'],
  ] as const) {
    test(`${name}: the CLI prints VERDICT: findings, FINDINGS: ${highest}, exit 3`, () => {
      const r = spawnSync(process.execPath, [LIB, '--verdict', 'review', fixture(name)], { encoding: 'utf8', timeout: 10000 });
      expect([r.status, r.stdout]).toEqual([3, `VERDICT: findings\nFINDINGS: ${highest}\n`]);
    });
  }

  test('every label form ENG-10 names is read, with critical/high blocking and medium/low advisory', () => {
    const cases: Array<[string, string | null, string]> = [
      ['Severity: High\nThe cap is ignored.', 'P1', 'findings'],
      ['Priority: critical — data loss', 'P0', 'findings'],
      ['Severity: **medium**', 'P2', 'clean'],
      ['High: the retry loop never stops.', 'P1', 'findings'],
      ['1. **High** — the cap is ignored.', 'P1', 'findings'],
      ['- [High] the cap is ignored.', 'P1', 'findings'],
      ['### Critical - secrets in logs', 'P0', 'findings'],
      ['High — the cap is ignored.', 'P1', 'findings'],
      ['The cap is ignored (**High**).', 'P1', 'findings'],
      ['| 1 | high | cap ignored |', 'P1', 'findings'],
      ['Low: rename the helper.', 'P3', 'clean'],
      ['Medium: the docs lag.\nLow: a typo.', 'P2', 'clean'],
      ['1. The guard trusts the payload without a flush check — High.', 'P1', 'findings'],
      ['2. The docs lag the new flag – Medium.', 'P2', 'clean'],
      ['- The retry loop never stops (high)', 'P1', 'findings'],
    ];
    for (const [text, highest, verdict] of cases) {
      const r = classifyOutsideReview({ text: `${text}\n${REC}`, gate: 'review' });
      expect({ text, highest: r.findings.highest as string | null, verdict: r.verdict as string }).toEqual({ text, highest, verdict });
    }
  });

  test('negative controls: severity words inside prose never count', () => {
    const r = classifyOutsideReview({ text: read('prose-negative.txt'), gate: 'review' });
    expect([r.verdict, r.findings.highest]).toEqual(['clean', null]);
    for (const text of ['A high-level plan.', 'Highly consistent.', 'This is low-risk.', 'A medium-term follow-up.',
      'There are no critical findings.', 'High availability: kept.', 'The high number of retries is fine.', 'Lower the limit.',
      'Latency stays low.', 'The cost is high-ish - acceptable.', 'Keep the trade-off low.']) {
      expect({ text, highest: classifyOutsideReview({ text: `${text}\nNo issues found.\n${REC}`, gate: 'review' }).findings.highest })
        .toEqual({ text, highest: null });
    }
  });

  test('a review with neither tags, severity labels nor a no-findings statement is unverified, never clean', () => {
    const r = classifyOutsideReview({ text: read('prose-unlabeled.txt'), gate: 'review' });
    expect([r.verdict, r.reason]).toEqual(['unverified', 'untagged_review']);
    const cli = spawnSync(process.execPath, [LIB, '--verdict', 'review', fixture('prose-unlabeled.txt')], { encoding: 'utf8', timeout: 10000 });
    expect(cli.status).toBe(4);
    expect(cli.stdout).toContain('VERDICT: unverified\n');
    expect(classifyOutsideReview({ text: `No issues found.\n${REC}`, gate: 'review' }).verdict).toBe('clean');
    expect(classifyOutsideReview({ text: `I did not find any issues.\n${REC}`, gate: 'review' }).verdict).toBe('clean');
  });

  test('the structured gate reads severity labels too', () => {
    expect(classifyOutsideReview({ text: 'High: race in cleanup.', gate: 'structured' }).verdict).toBe('findings');
    expect(classifyOutsideReview({ text: 'Medium: stale comment.', gate: 'structured' }).verdict).toBe('clean');
  });

  test('a stored panel of real Codex outputs keeps its verdicts', () => {
    const panel = path.join(ROOT, 'test', 'fixtures', 'codex-review');
    const verdict = (name: string, gate: OutsideGate) => {
      const r = classifyOutsideReview({ text: fs.readFileSync(path.join(panel, name), 'utf8'), gate });
      return [r.verdict, r.findings.highest, r.reason ?? null];
    };
    expect(verdict('clean-review.stdout.txt', 'structured')).toEqual(['unverified', null, 'untagged_review']);
    expect(verdict('p2-review.stdout.txt', 'structured')).toEqual(['clean', 'P2', null]);
    expect(verdict('clean-review.stdout.txt', 'review')).toEqual(['unavailable', null, 'missing_markers']);
    expect(verdict('p2-review.stdout.txt', 'review')).toEqual(['unavailable', 'P2', 'missing_markers']);
  });
});

describe('design proposals use the proposal gate', () => {
  test('a completed proposal needs only its Recommendation line; severity rules do not apply', () => {
    const proposal = 'Use a dense triage table with sticky filters.\nRecommendation: table because operators compare many rows.';
    expect(classifyOutsideReview({ text: proposal, gate: 'proposal' }).verdict).toBe('clean');
    expect(classifyOutsideReview({ text: 'A table.', gate: 'proposal' }).reason).toBe('missing_markers');
    expect(classifyOutsideReview({ text: proposal, gate: 'review' }).verdict).toBe('unverified');
  });

  test('design-direction invocations render the proposal gate; reviews keep the review gate', () => {
    const ctx = { skillName: 'design-consultation', tmplPath: 'design-consultation/SKILL.md.tmpl', host: 'claude' as const, paths: HOST_PATHS.claude };
    expect(outsideVoiceCommand(ctx, { timeoutMs: 300000, purpose: 'design-direction' })).toMatch(/ proposal "\$_OUTSIDE_TMP\/text"/);
    expect(outsideVoiceCommand({ ...ctx, skillName: 'plan-ceo-review' }, { timeoutMs: 300000 })).toMatch(/ review "\$_OUTSIDE_TMP\/text"/);
  });
});
