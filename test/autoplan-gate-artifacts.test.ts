/**
 * Next wave, Lane B artifacts (GBRA-40 items 7, 11, 14, 15, 18):
 *  B3  an empty gstack-findings fence (LF, CRLF, whitespace-only) is zero findings, not a missing fence;
 *      an opener without a closer and invalid rows are still refused.
 *  B7  canonical rows carry repo-relative paths; snapshot citations become the plan file and its source line.
 *  B8  `status` lists every open attempt with its result file.
 *  B9  `gstack-gate render --all` prints every item; paged output tells the relay to send every page.
 *  B6  a plan naming a minimum effect with no number gets a flagged PLAN_REALITY line under the plan approval item.
 *  B11 an outside voice submitted without --runner is labeled host-subagent in the consensus header.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeFindingFile } from '../lib/autoplan-plan-text';
import { parseRecordFindings, parseReviewResult } from '../lib/autoplan-reconcile';
import { renderGate, type GateList } from '../lib/gate-list';
import { attemptsOf, autoplan, readRun, review, ROOT, runPhase, SMALL_PLAN, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-gate-artifacts-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SHA = 'a'.repeat(64);
const GATE = path.join(ROOT, 'bin', 'gstack-gate');

describe('B3: empty findings fence', () => {
  const head = `INPUT: ceo ${SHA}\n\n## review\n\n`;
  test('LF, CRLF and whitespace-only empty fences parse as zero findings in both grammars', () => {
    for (const text of [`${head}\`\`\`gstack-findings\n\`\`\`\n`, `${head}\`\`\`gstack-findings\n\`\`\`\n`.replace(/\n/g, '\r\n'), `${head}\`\`\`gstack-findings\n   \n\`\`\`\n`]) {
      const r = parseReviewResult(text, { phase: 'ceo', sha256: SHA });
      expect(r.fenceFound).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.findings).toEqual([]);
      expect(parseRecordFindings(text)).toEqual({ findings: [], source: 'fence', errors: [] });
    }
  });
  test('an opener without a closer is no fence; an invalid row is refused; two fences still parse', () => {
    expect(parseReviewResult(`${head}\`\`\`gstack-findings\n{"severity":"High","title":"x"}\n`, { phase: 'ceo', sha256: SHA }).errors).toContain('no ```gstack-findings fence');
    expect(parseReviewResult(`${head}\`\`\`gstack-findings\n{"severity":"Bogus","title":"x"}\n\`\`\`\n`, { phase: 'ceo', sha256: SHA }).errors[0]).toMatch(/severity "Bogus"/);
    const two = parseReviewResult(`${head}\`\`\`gstack-findings\n{"severity":"High","title":"a"}\n\`\`\`\n\n\`\`\`gstack-findings\n\`\`\`\n\n\`\`\`gstack-findings\n{"severity":"Low","title":"b"}\n\`\`\`\n`, { phase: 'ceo', sha256: SHA });
    expect(two.errors).toEqual([]);
    expect(two.findings.map(f => f.title)).toEqual(['a', 'b']);
  });
});

describe('B7: repo-relative paths and plan lines', () => {
  test('absolute repo paths become relative; snapshot and active-plan citations map to the plan source line or drop the line', () => {
    const repo = path.join(TMP, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const source = path.join(TMP, 'plan-source.md');
    fs.writeFileSync(source, '# Title\n\n## Implementation plan\n\nline A\nline B\nline C\n\n## Review record\n');
    const snapDir = path.join(TMP, 'autoplan-ceo-Xy12');
    fs.mkdirSync(snapDir, { recursive: true });
    const snapshot = path.join(snapDir, 'ceo-implementation.md');
    fs.writeFileSync(snapshot, '\nline A\nline B\nline C\n\n');
    const active = path.join(TMP, 'plan-active.md');
    fs.writeFileSync(active, `<!-- /autoplan restore point: "${TMP}/restore.md" -->\n${fs.readFileSync(source, 'utf8')}`);
    const stray = path.join(TMP, 'other-snapshot.md');
    fs.writeFileSync(stray, 'unrelated\n');
    const ctx = { cwd: path.join(repo, 'src'), planFiles: [snapshot, active, stray], planSource: source, planName: 'plan.md' };
    expect(normalizeFindingFile({ file: path.join(repo, 'src', 'worker.ts'), line: 9 }, ctx)).toEqual({ file: 'src/worker.ts', line: 9 });
    expect(normalizeFindingFile({ file: snapshot, line: 3 }, ctx)).toEqual({ file: 'plan.md', line: 6 });
    expect(normalizeFindingFile({ file: 'ceo-implementation.md', line: 2 }, ctx)).toEqual({ file: 'plan.md', line: 5 });
    expect(normalizeFindingFile({ file: active, line: 6 }, ctx)).toEqual({ file: 'plan.md', line: 5 });
    expect(normalizeFindingFile({ file: stray, line: 1 }, ctx)).toEqual({ file: 'plan.md' });
    expect(normalizeFindingFile({ file: '/elsewhere/x.ts', line: 1 }, ctx)).toEqual({ file: '/elsewhere/x.ts', line: 1 });
    expect(normalizeFindingFile({ file: 'lib/x.ts', line: 4 }, ctx)).toEqual({ file: 'lib/x.ts', line: 4 });
  });

  test('end to end: a reviewer citing the snapshot and an absolute repo path binds repo-relative rows; the bound copy stays verbatim', () => {
    const out = startSmallRun(path.join(TMP, 'paths'));
    expect(autoplan(['next', '--out', out]).status).toBe(0);
    const snap = readRun(out).phases.ceo.snapshot_path as string;
    const findings = JSON.stringify([{ severity: 'High', title: 'cap unexplained', file: snap, line: 2 }, { severity: 'Low', title: 'abs path', file: path.join(ROOT, 'lib', 'gate-list.ts'), line: 3 }]);
    review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: findings });
    const ids = attemptsOf(out, 'ceo');
    const result = readRun(out).phases.ceo.native.attempts[0].result as string;
    const bind = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', result, '--model', 'anthropic/claude-opus-5-5', '--attempt', ids.native]);
    expect(bind.status, bind.stderr).toBe(0);
    const output = readRun(out).phases.ceo.native.output as string;
    const rows = fs.readFileSync(path.join(out, `${output}.findings.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows.map((r: any) => [r.file, r.line])).toEqual([['plan.md', 5], ['lib/gate-list.ts', 3]]);
    expect(fs.readFileSync(path.join(out, output), 'utf8')).toContain(snap);
  });
});

describe('B8/B11: pending attempts in status; outside voice labeled host-subagent', () => {
  test('status prints PENDING per open attempt; an outside submit without --runner reads model (host-subagent)', () => {
    const out = startSmallRun(path.join(TMP, 'pending'));
    expect(autoplan(['next', '--out', out]).status).toBe(0);
    const ids = attemptsOf(out, 'ceo');
    const run = readRun(out);
    const status = autoplan(['status', '--out', out]);
    expect(status.stdout).toContain(`PENDING: ${ids.native} phase=ceo voice=native result=${run.phases.ceo.native.attempts[0].result}`);
    expect(status.stdout).toContain(`PENDING: ${ids.outside} phase=ceo voice=outside result=${run.phases.ceo.outside.attempts[0].result}`);
    for (const voice of ['native', 'outside']) review(path.join(out, `ceo-${voice}-prompt.md`));
    expect(autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', run.phases.ceo.native.attempts[0].result, '--model', 'anthropic/claude-opus-5-5']).status).toBe(0);
    expect(autoplan(['status', '--out', out]).stdout).not.toContain(`PENDING: ${ids.native}`);
    expect(autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--result', run.phases.ceo.outside.attempts[0].result, '--model', 'openai/gpt-6.1-sol']).status).toBe(0);
    expect(readRun(out).phases.ceo.outside.provider).toBe('host-subagent');
    expect(fs.readFileSync(path.join(out, 'ceo-consensus.md'), 'utf8')).toContain('openai/gpt-6.1-sol(host-subagent)');
    expect(autoplan(['status', '--out', out]).stdout).not.toContain('PENDING:');
  });
});

describe('B9: every gate page reaches the owner', () => {
  const item = (i: number) => ({ id: `d${i}`, title: `finding ${i}`, kind: 'auto' as const, recommended: 'a', options: [{ key: 'a', text: 'keep' }, { key: 'b', text: 'change' }] });
  const list: GateList = { schema_version: 1, run: 'r', gate_rev: 1, items: [...Array.from({ length: 14 }, (_, i) => item(i + 1)), { id: 'p1', title: 'Plan approval', kind: 'approval', recommended: 'a', options: [{ key: 'a', text: 'approve' }, { key: 'b', text: 'other' }] }] };
  test('14 findings span three pages; --all prints every id once and paged output says to relay every page', () => {
    expect(renderGate(list)).toContain('or every page with `--all`. Relay every page.');
    const file = path.join(TMP, 'big-gate.json');
    fs.writeFileSync(file, JSON.stringify(list));
    const r = spawnSync('bun', [GATE, 'render', file, '--all'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('page=1/1');
    for (const i of list.items) expect(r.stdout.match(new RegExp(`\\[${i.id}\\]`, 'g'))?.length).toBe(1);
    const pages = [1, 2, 3].map(p => renderGate(list, p)).join('\n');
    for (const i of list.items) expect(pages).toContain(`[${i.id}]`);
    expect(spawnSync('bun', [GATE, 'render', file, '--all', '--page', '2'], { encoding: 'utf8', timeout: 30_000 }).status).toBe(2);
  });
});

describe('B6: PLAN_REALITY flag beside the approval item', () => {
  test('the plan names a minimum effect with no number: gate.json p1 carries the flag and the render prints it; nothing blocks', () => {
    const dir = path.join(TMP, 'vague');
    fs.mkdirSync(dir, { recursive: true });
    const plan = path.join(dir, 'plan.md');
    fs.writeFileSync(plan, SMALL_PLAN.replace('Tests cover the cap', 'Ship once the minimum effect shows in the retry metrics. Tests cover the cap'));
    const out = path.join(dir, 'run');
    expect(autoplan(['next', '--out', out, '--plan', plan, '--no-ui']).status).toBe(0);
    for (const phase of ['ceo', 'eng']) { const r = runPhase(out, phase); expect(r.outside.status, r.outside.stderr).toBe(0); }
    const gate = JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')) as GateList;
    const p1 = gate.items.find(i => i.id === 'p1')!;
    expect(p1.flags).toEqual([expect.stringMatching(/^PLAN_REALITY "minimum effect" has no number, arm list or rule body \(plan\.md:6: .*minimum effect.*\) \(report only\)$/)]);
    expect([1, 2].map(p => renderGate(gate, p)).join('\n')).toMatch(/\n   flagged: PLAN_REALITY "minimum effect"/);
    expect(readRun(out).status).toBe('gate_pending');
  });
});
