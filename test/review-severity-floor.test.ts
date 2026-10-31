/**
 * GSTA-160: /review's severity follows the blocking floor, never the checklist pass,
 * category or specialist lens. In GSTA-11's diff-only replay the core reviewer filed a
 * real /retro date-window bug INFORMATIONAL in 3 of 3 trials under the Pass 2 category
 * name, and a cache-file shell injection as a "security-invariant" note, because the
 * checklist bound severity to category and the core floor had no security clause.
 * One floor sentence (scripts/resolvers/review-floor.ts) now reaches every reviewer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { type ScopedFinding } from '../lib/review-scope';
import { BLOCKING_FLOOR } from '../scripts/resolvers/review-floor';
import { FIX_CHECK_INSTRUCTIONS } from '../scripts/resolvers/fix-check';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const read = (p: string) => flat(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('one blocking floor in every reviewer prompt', () => {
  test('the floor names security and keeps the 2026-10-26 words', () => {
    expect(BLOCKING_FLOOR).toContain('would fail a test, break production, or lose data or secrets, or open a security hole');
  });

  test.each([
    'review/SKILL.md.tmpl', 'review/SKILL.md', 'review/checklist.md', 'review/sections/review-army.md',
    'ship/sections/review-army.md', 'docs/review-policy.md', 'docs/ship-policy.md',
  ])('%s carries the floor sentence verbatim', file => {
    expect(read(file)).toContain(BLOCKING_FLOOR);
  });

  test('the ship skeleton Review policy line names the same four outcomes', () => {
    for (const file of ['ship/SKILL.md.tmpl', 'ship/SKILL.md']) expect(read(file)).toContain('only a finding that would fail a test, break production, or lose data or secrets, or open a security hole blocks a pass');
  });

  test('the fix-check prompt carries it too', () => {
    expect(flat(FIX_CHECK_INSTRUCTIONS)).toContain(BLOCKING_FLOOR);
  });
});

describe('the checklist sets check order, never severity', () => {
  const checklist = read('review/checklist.md');
  test('no pass or category is named as a severity', () => {
    for (const bound of ['Pass 1 (CRITICAL)', 'Pass 2 (INFORMATIONAL)', 'Pass 1 — CRITICAL', 'Pass 2 — INFORMATIONAL', 'Highest severity', 'Lower severity', 'CRITICAL (highest severity)', 'INFORMATIONAL (main agent)']) {
      expect(checklist).not.toContain(bound);
    }
    expect(checklist).toContain('The pass never sets severity.');
    expect(checklist).toContain('A category says what to check and in which order; it never sets severity.');
    expect(read('review/SKILL.md.tmpl')).toContain('Apply both checklist passes in order with suppressions; neither sets severity.');
    expect(read('review/SKILL.md.tmpl')).not.toContain('CRITICAL, then INFORMATIONAL');
  });

  test('shell injection is not Python-only and names shell sinks with a reaching input', () => {
    expect(checklist).not.toContain('Shell Injection (Python-specific)');
    expect(checklist).toContain('Shell scripts: `eval`, `source`/`.`, `sh -c`/`bash -c`');
    expect(checklist).toContain('Name the reaching input.');
    expect(checklist).toContain('Not a finding by itself: a quoted expansion passed as one argument');
  });

  test('state swapped before a step that can fail is a Pass 1 check (GSTA-159, gstack #201)', () => {
    const pass1 = checklist.slice(checklist.indexOf('### Pass 1 — check first'), checklist.indexOf('### Pass 2 — check second'));
    expect(pass1).toContain('State swapped before the step that can fail');
    expect(pass1).toContain('with no snapshot and rollback');
  });
});

describe('a floor-level defect the Testing specialist finds still blocks', () => {
  test('testing.md routes product defects to category correctness', () => {
    expect(read('review/specialists/testing.md')).toContain('A product-code defect you find that meets the floor uses category `correctness`');
  });

  test('gstack-review-scope classify: a CRITICAL correctness or Pass 2-category finding blocks; a testing-category gap does not', () => {
    const repo = makeFixtureRepo({ prefix: 'review-floor-' });
    repos.push(repo);
    const src = path.join(repo.work, 'browse', 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'cookie-picker-ui.ts'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    const lines = fs.readFileSync(path.join(src, 'cookie-picker-ui.ts'), 'utf8').split('\n');
    lines[9] = "const AUTH_TOKEN = '${authToken}';";
    fs.writeFileSync(path.join(src, 'cookie-picker-ui.ts'), lines.join('\n'));
    repo.git('commit', '-qam', 'inline the token');
    const at = 'browse/src/cookie-picker-ui.ts';
    const findings = [
      { fingerprint: at + ':10:correctness', path: at, line: 10, severity: 'CRITICAL', confidence: 7, category: 'correctness', specialist: 'testing', summary: 'The unauthenticated GET /cookie-picker serves HTML containing AUTH_TOKEN.' },
      { fingerprint: at + ':10:time-window-safety', path: at, line: 10, severity: 'CRITICAL', confidence: 7, category: 'time-window-safety', specialist: 'core', summary: 'A bare --since date drops most of the first day.' },
      { fingerprint: at + ':10:testing', path: at, line: 10, severity: 'CRITICAL', confidence: 7, category: 'testing', specialist: 'testing', summary: 'No test covers the token-free page.' },
    ];
    const f = path.join(repo.root, 'findings.json');
    fs.writeFileSync(f, JSON.stringify(findings));
    const r = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '1', '--findings', f, '--json']);
    expect(r.status).toBe(EXIT.ok);
    const got = JSON.parse(r.out).findings.map((x: ScopedFinding) => `${x.category}=${x.kind}/${x.blocking}`);
    expect(got).toEqual(['correctness=defect/true', 'time-window-safety=defect/true', 'testing=test-gap/false']);
    expect(r.err).toContain('blocking=2');
  });
});
