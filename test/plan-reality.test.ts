/**
 * Plan D1: reality rows in plan reviews. Pins the row ids, the `REALITY:` line
 * grammar, the checker's missing/unreceipted/n/a branches, the bin's exit codes
 * and `PLAN_REALITY:` line, the unattended `incomplete` verdict, and that the
 * rendered plan-review skills and autoplan phase files carry the contract.
 * Each tier 1 row has a positive fixture from this wave's own review record
 * (test/fixtures/multi-agent-wave/reality-rows.json, receipts verified against
 * the record) and a decoy that must not count. Prose is not pinned.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { REALITY_ROWS, REALITY_SCOPES, TIER1_ROW_IDS, checkRealityRows, parseRealityLines, parseScopes, renderIncidentTable, renderRows, requiredRows } from '../lib/plan-reality';
import { RESULT_CODES } from '../lib/result-codes';
import { generatePlanRealityRows } from '../scripts/resolvers/plan-reality';
import type { TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-plan-reality');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'multi-agent-wave', 'reality-rows.json'), 'utf8')) as {
  rows: Record<string, { positive: string; source: { file: string; lines: [number, number]; contains: string }; decoy: string; decoy_kind: string; metric?: Record<string, string> }>;
};
const positives = Object.values(FIXTURE.rows).map(r => r.positive).join('\n');

function run(args: string[], input?: string, env: Record<string, string> = {}) {
  const r = spawnSync('bun', [BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, input, env: { ...process.env, GSTACK_SESSION_KIND: '', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('reality row table', () => {
  test('seven tier 1 rows, every row has a check and an incident, ids are unique and scopes known', () => {
    expect(TIER1_ROW_IDS).toEqual(['premise-table', 'already-done', 'surface-check', 'binding-decisions', 'numbers', 'deferred-asks', 'pr-count']);
    expect(REALITY_ROWS.filter(r => r.tier === 2).length).toBe(11);
    expect(new Set(REALITY_ROWS.map(r => r.id)).size).toBe(REALITY_ROWS.length);
    for (const r of REALITY_ROWS) {
      expect(r.check.length).toBeGreaterThan(20);
      expect(r.incident.length).toBeGreaterThan(20);
      expect(REALITY_SCOPES).toContain(r.scope);
      expect(r.tier === 1 ? 'always' : 'scoped').toBe(r.scope === 'always' ? 'always' : 'scoped');
    }
  });
  test('required rows: tier 1 always, tier 2 only for a detected scope', () => {
    expect(requiredRows([]).map(r => r.id)).toEqual([...TIER1_ROW_IDS]);
    expect(requiredRows(['db']).map(r => r.id)).toContain('transaction-semantics');
    expect(requiredRows(['db']).map(r => r.id)).not.toContain('recall');
    expect(parseScopes('db, search,bogus')).toEqual({ scopes: ['db', 'search'], unknown: ['bogus'] });
  });
});

describe('REALITY: line grammar', () => {
  test('parses id, status, receipt (path:line, path:line-line, sha) and key=value metrics; tolerates list and table prefixes', () => {
    const lines = parseRealityLines([
      'REALITY: premise-table finding 27 checked unverified=3 docs/x/ceo-native.md:11-37',
      '- REALITY: already-done pass 0 hits 91bbd9e',
      '| REALITY: surface-check finding bun upgrade bin/gstack-capy-install:52 |',
      'REALITY: numbers pass 7 PRs 48 min',
      'REALITY: transaction-semantics n/a scope db absent',
      'reality: not-a-row pass lower-case prefix is not the grammar',
    ].join('\n'));
    expect(lines.map(l => [l.id, l.status, l.receipt])).toEqual([
      ['premise-table', 'finding', 'docs/x/ceo-native.md:11-37'],
      ['already-done', 'pass', '91bbd9e'],
      ['surface-check', 'finding', 'bin/gstack-capy-install:52'],
      ['numbers', 'pass', null],
      ['transaction-semantics', 'n/a', null],
    ]);
    expect(lines[0]!.metrics.unverified).toBe('3');
  });
});

describe('checkRealityRows', () => {
  test('every tier 1 positive fixture from the review record passes and the premise metric is scored', () => {
    const r = checkRealityRows(positives, { phase: 'ceo', sessionKind: 'unattended' });
    expect(r.missing).toEqual([]);
    expect(r.unreceipted).toEqual([]);
    expect(r.verdict).toBe('complete');
    expect(r.metrics).toEqual({ unverified: '3' });
    expect(r.line).toBe('PLAN_REALITY: phase=ceo rows=7/7 missing=none unverified=3 verdict=complete');
  });
  test('each positive receipt points into the review record at the stated lines', () => {
    for (const [id, row] of Object.entries(FIXTURE.rows)) {
      const text = fs.readFileSync(path.join(ROOT, row.source.file), 'utf8').split('\n');
      const [from, to] = row.source.lines;
      const excerpt = text.slice(from - 1, to).join('\n');
      expect(excerpt, `${id}: ${row.source.file}:${from}-${to}`).toContain(row.source.contains);
      const parsed = parseRealityLines(row.positive)[0]!;
      expect(parsed.id).toBe(id);
      expect(parsed.receipt, `${id} carries a receipt`).not.toBeNull();
      expect(row.positive).toContain(`${row.source.file}:${from}`);
    }
  });
  test('each decoy fails for its own row while the other six positives stand (negative control per row)', () => {
    for (const [id, row] of Object.entries(FIXTURE.rows)) {
      const others = Object.entries(FIXTURE.rows).filter(([k]) => k !== id).map(([, r]) => r.positive);
      const r = checkRealityRows([...others, row.decoy].join('\n'), { phase: 'eng' });
      expect([...r.missing, ...r.unreceipted], `${id} decoy (${row.decoy_kind}) must not count`).toEqual([id]);
      expect(r.verdict).toBe('repair');
    }
  });
  test('a review that only talks about the rows in prose has every row missing', () => {
    const prose = 'The premises were checked and already-done work was considered. Surface check done. Numbers estimated.';
    const r = checkRealityRows(prose, { phase: 'ceo', sessionKind: 'unattended' });
    expect(r.missing).toEqual([...TIER1_ROW_IDS]);
    expect(r.verdict).toBe('incomplete');
    expect(r.line).toContain('rows=0/7');
  });
  test('verdict word: unattended → incomplete, anything else → repair; complete needs no session kind', () => {
    const partial = positives.split('\n').slice(0, 6).join('\n');
    expect(checkRealityRows(partial, { phase: 'eng', sessionKind: 'unattended' }).verdict).toBe('incomplete');
    expect(checkRealityRows(partial, { phase: 'eng', sessionKind: 'interactive' }).verdict).toBe('repair');
    expect(checkRealityRows(partial, { phase: 'eng' }).verdict).toBe('repair');
    expect(checkRealityRows(partial, { phase: 'eng' }).missing).toEqual(['pr-count']);
  });
  test('tier 2 rows: required only under their scope; n/a is accepted off-scope and a tier 1 n/a is missing', () => {
    const withNa = `${positives}\nREALITY: transaction-semantics n/a no db change`;
    expect(checkRealityRows(withNa, { phase: 'eng' }).missing).toEqual([]);
    expect(checkRealityRows(withNa, { phase: 'eng', scopes: ['db'] }).missing).toEqual(['transaction-semantics']);
    const dbRow = `${positives}\nREALITY: transaction-semantics pass idle, pooled and reserved traced lib/pool.ts:40-88`;
    expect(checkRealityRows(dbRow, { phase: 'eng', scopes: ['db'] }).line).toContain('rows=8/8');
    expect(checkRealityRows(positives.replace(/^REALITY: numbers finding/m, 'REALITY: numbers n/a'), { phase: 'eng' }).missing).toEqual(['numbers']);
  });
  test('a later real line outranks an earlier n/a for the same row; unknown row ids are reported, not counted', () => {
    const r = checkRealityRows(`REALITY: already-done n/a\n${positives}\nREALITY: premises pass lookalike plan.md:1`, { phase: 'ceo' });
    expect(r.missing).toEqual([]);
    expect(r.unknownRows).toEqual(['premises']);
  });
});

describe('gstack-plan-reality bin', () => {
  test('--help prints the exit table and the line shape; no command is usage', () => {
    const help = run(['--help']);
    expect(help.code).toBe(EXIT.ok);
    expect(help.out).toContain('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag');
    expect(help.out).toContain('REALITY: <row> pass|finding|n/a <summary> <file:line>');
    expect(run([]).code).toBe(EXIT.usage);
    expect(run(['rows']).code).toBe(EXIT.usage);
    expect(run(['rows', '--phase', 'eng', '--scope', 'bogus']).code).toBe(EXIT.usage);
    expect(run(['frob', '--phase', 'eng']).code).toBe(EXIT.usage);
  });
  test('rows prints the applicable rows; --scope adds tier 2; --json is JSON only', () => {
    const plain = run(['rows', '--phase', 'eng']);
    expect(plain.code).toBe(EXIT.ok);
    for (const id of TIER1_ROW_IDS) expect(plain.out).toContain(`- ${id} (tier 1)`);
    expect(plain.out).not.toContain('recall');
    expect(run(['rows', '--phase', 'eng', '--scope', 'search']).out).toContain('- recall (tier 2, scope search)');
    expect(run(['rows', '--phase', 'eng', '--deep']).out).toContain('Incident:');
    const json = JSON.parse(run(['rows', '--phase', 'ceo', '--json']).out);
    expect(json.rows.map((r: { id: string }) => r.id)).toEqual([...TIER1_ROW_IDS]);
  });
  test('check: complete exits 0; a miss exits 1 with REALITY_ROW_MISSING; unattended prints verdict=incomplete; stdin and --json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plan-reality-'));
    const file = path.join(tmp, 'review.md');
    fs.writeFileSync(file, `prose\n${positives}\n`);
    const ok = run(['check', '--phase', 'ceo', file]);
    expect(ok.code).toBe(EXIT.ok);
    expect(ok.out.trim()).toBe('PLAN_REALITY: phase=ceo rows=7/7 missing=none unverified=3 verdict=complete');

    const partial = positives.split('\n').slice(1).join('\n');
    const miss = run(['check', '--phase', 'eng', '-'], partial, { GSTACK_SESSION_KIND: 'unattended' });
    expect(miss.code).toBe(EXIT.fail);
    expect(miss.out).toContain('missing=premise-table verdict=incomplete');
    expect(miss.err).toContain('(REALITY_ROW_MISSING)');
    expect(miss.err).toContain('fix:');

    const flag = run(['check', '--phase', 'eng', '-', '--session-kind', 'unattended'], partial);
    expect(flag.out).toContain('verdict=incomplete');
    const interactive = run(['check', '--phase', 'eng', '-'], partial);
    expect(interactive.out).toContain('verdict=repair');

    const unreceipted = run(['check', '--phase', 'ceo', '-', '--json'], `${partial}\n${FIXTURE.rows['premise-table']!.decoy}`);
    expect(unreceipted.code).toBe(EXIT.fail);
    const parsed = JSON.parse(unreceipted.out);
    expect(parsed.unreceipted).toEqual(['premise-table']);
    expect(unreceipted.err).toContain('(REALITY_RECEIPT_MISSING)');
    expect(run(['check', '--phase', 'ceo', path.join(tmp, 'absent.md')]).code).toBe(EXIT.fail);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('rendered templates carry the contract', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const ctx = (skillName: string) => ({ skillName, host: 'claude', paths: {} } as unknown as TemplateContext);
  test('resolver variants name the bin, the tier 1 rows, the line shape and the unattended rule', () => {
    const eng = generatePlanRealityRows(ctx('plan-eng-review'));
    expect(eng).toContain('gstack-plan-reality rows --phase eng');
    expect(eng).toContain('gstack-plan-reality check --phase eng');
    for (const id of TIER1_ROW_IDS) expect(eng).toContain(id);
    expect(eng).toContain('REALITY: <row> pass|finding|n/a <summary> <file:line>');
    expect(generatePlanRealityRows(ctx('plan-ceo-review'))).toContain('--phase ceo');
    expect(generatePlanRealityRows(ctx('plan-devex-review'))).toContain('--phase dx');
    const deep = generatePlanRealityRows(ctx('plan-eng-review'), ['deep']);
    for (const r of REALITY_ROWS) expect(deep).toContain(`| \`${r.id}\` | ${r.tier} | ${r.scope} |`);
    expect(deep).toBe(deep.replace(/\n{3,}/g, '\n\n'));
    expect(generatePlanRealityRows(ctx('autoplan'), ['autoplan', 'eng'])).toContain('check --phase eng');
    expect(generatePlanRealityRows(ctx('autoplan'), ['pregate'])).toContain('`incomplete`');
    expect(generatePlanRealityRows(ctx('plan-eng-review'), ['summary'])).toContain('PLAN_REALITY');
    expect(renderIncidentTable(REALITY_ROWS).split('\n').length).toBe(REALITY_ROWS.length + 2);
    expect(renderRows(requiredRows([]), { deep: false }).split('\n').length).toBe(TIER1_ROW_IDS.length);
  });
  test('plan-eng-review: Scope Challenge block, deep incident table and Completion summary line', () => {
    const sections = read('plan-eng-review/sections/review-sections.md');
    expect(sections).toContain('gstack-plan-reality rows --phase eng');
    expect(sections).toContain('### Reality rows (why each exists)');
    expect(sections).toContain('| `pr-count` | 1 | always |');
    expect(sections).toContain('- Reality rows: ___/___ applicable rows emitted (`PLAN_REALITY` line), ___ unverified premises');
    expect(read('plan-eng-review/sections/checklist.md')).toContain('| Reality rows (`REALITY:` lines, `PLAN_REALITY` check) | Scope Challenge → Reality rows | always |');
  });
  test('plan-ceo-review: 0A/0B block in the skeleton, Completion Summary row and checklist row', () => {
    const skeleton = read('plan-ceo-review/SKILL.md');
    const at = skeleton.indexOf('gstack-plan-reality rows --phase ceo');
    expect(at).toBeGreaterThan(skeleton.indexOf('### 0B. Existing Code Leverage'));
    expect(at).toBeLessThan(skeleton.indexOf('### 0C. Dream State Mapping'));
    expect(read('plan-ceo-review/sections/review-sections.md')).toContain('| Reality rows         | ___/___ rows (PLAN_REALITY), ___ unverified |');
    expect(read('plan-ceo-review/sections/checklist.md')).toContain('| Reality rows (`REALITY:` lines, `PLAN_REALITY` check) | 0A/0B → Reality rows | always |');
  });
  test('autoplan: CEO and Eng phase files run the check; the Pre-Gate names incomplete for unattended misses', () => {
    expect(read('autoplan/sections/ceo-phase.md')).toContain('gstack-plan-reality check --phase ceo');
    expect(read('autoplan/sections/eng-phase.md')).toContain('gstack-plan-reality check --phase eng');
    const skeleton = read('autoplan/SKILL.md');
    const pregate = skeleton.slice(skeleton.indexOf('## Pre-Gate Verification'), skeleton.indexOf('## Phase 4: Final Approval Gate'));
    expect(pregate).toContain('`REALITY:` lines');
    expect(pregate).toContain('verdict=complete');
    expect(pregate).toContain('`incomplete`');
  });
  test('the two result codes have troubleshooting anchors', () => {
    const doc = read('docs/troubleshooting.md');
    for (const code of ['REALITY_ROW_MISSING', 'REALITY_RECEIPT_MISSING'] as const) {
      expect(doc).toContain(`<a id="${RESULT_CODES[code].anchor}"></a>`);
    }
  });
});
