/**
 * Free contracts of the native frozen-scope fixture (test/helpers/ship-frozen-scope-actor.ts):
 * a scripted actor that follows Step 9.4 and the repeat decision passes the
 * verdict with the real gstack-review-scope / gstack-review-log binaries, and
 * the negative controls (editing the pre-existing file, leaving the diff defect
 * in place, exiting after one pass) are named failures. No model call is made.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  createShipFrozenScopeFixture, FROZEN_SCOPE_DEFER_IDENTITY, FROZEN_SCOPE_FIX_IDENTITY, shipFrozenScopeFailures, shipFrozenScopeWorkflow,
} from './helpers/ship-frozen-scope-actor';
import { reviewLoopLine, summarizeReviewLoop } from '../lib/review-scope';

type Fixture = ReturnType<typeof createShipFrozenScopeFixture>;
let workflow = '';
const roots: string[] = [];
beforeAll(async () => { workflow = await shipFrozenScopeWorkflow(); }, 120_000);
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const SAFE = 'export const canReadInvoice = (owner: string, viewer: string) => owner === viewer;\n';

function fixture(): Fixture {
  const f = createShipFrozenScopeFixture(workflow);
  roots.push(f.root);
  return f;
}
function sh(f: Fixture, command: string): string {
  const r = spawnSync('bash', ['-c', command], { cwd: f.repo, encoding: 'utf8', env: { ...process.env, ...f.env }, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`${command}\n${r.stderr}${r.stdout}`);
  return r.stdout;
}
async function hook(f: Fixture, tool: string, input: Record<string, unknown>): Promise<string | undefined> {
  const out: any = await f.preToolUse({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as any, undefined as any, {} as any);
  return out.hookSpecificOutput.permissionDecision === 'allow' ? undefined : out.hookSpecificOutput.permissionDecisionReason;
}
/** A scripted actor: declared reads, classify, fix, defer, log, commit, repeat, log, continue. */
async function act(f: Fixture, options: { fix?: boolean; passes?: 1 | 2 } = {}) {
  const { fix = true, passes = 2 } = options;
  for (const file of [f.workflowPath, f.findingsPath, f.invoice, f.payments]) expect(await hook(f, 'Read', { file_path: file })).toBeUndefined();
  expect(await hook(f, 'Bash', { command: f.commands.classify })).toBeUndefined();
  const classify = sh(f, f.commands.classify!);
  expect(classify).toContain('REVIEW_SCOPE: policy=frozen pass=1 findings=2 fix=1 defer=1 note=0 blocking=2');
  const classified = JSON.parse(fs.readFileSync(`${f.repo}/.gstack/tmp/review-classified-p1.json`, 'utf8'));
  if (fix) {
    expect(await hook(f, 'Write', { file_path: f.invoice, content: SAFE })).toBeUndefined();
    fs.writeFileSync(f.invoice, SAFE);
  }
  expect(await hook(f, 'Bash', { command: f.commands.defer })).toBeUndefined();
  expect(sh(f, f.commands.defer!)).toContain('DEFERRED: unfiled (dry run) CRITICAL payments.ts:2');
  const findings = classified.findings.map((x: any) => ({ fingerprint: x.fingerprint, severity: x.severity, action: x.scope === 'fix' ? (fix ? 'auto-fixed' : 'skipped') : 'deferred',
    ...(x.scope === 'defer' ? { issue: null } : {}), locus: x.locus, kind: x.kind, blocking: x.blocking }));
  const row = (extra: Record<string, unknown>) => ({ skill: 'review', timestamp: new Date().toISOString(), status: 'issues_found', issues_found: 0, critical: 0, informational: 0,
    quality_score: 10.0, specialists: {}, findings, commit: sh(f, 'git rev-parse --short HEAD').trim(), via: 'ship', completed: true, converged: false, cycles: 1, pass: 1,
    review_scope: 'frozen', range_base: null, ...extra });
  const log = async (record: Record<string, unknown>) => {
    expect(await hook(f, 'Write', { file_path: f.draft, content: JSON.stringify(record) })).toBeUndefined();
    fs.writeFileSync(f.draft, JSON.stringify(record));
    expect(await hook(f, 'Bash', { command: f.commands.persist })).toBeUndefined();
    sh(f, f.commands.persist!);
  };
  await log(row({}));
  if (passes === 1) {
    expect(await hook(f, 'Bash', { command: f.commands.continue })).toBeUndefined();
    sh(f, f.commands.continue!);
    return;
  }
  expect(await hook(f, 'Bash', { command: f.commands.commit })).toBeUndefined();
  sh(f, f.commands.commit!);
  expect(await hook(f, 'Bash', { command: f.commands.repeat })).toBeUndefined();
  const repeat = JSON.parse(sh(f, f.commands.repeat!));
  expect(repeat).toMatchObject({ pass: 2, findings: [], coverage: 'completed' });
  expect(await hook(f, 'Read', { file_path: `${f.repo}/.gstack/tmp/review-findings-p2.json` })).toBeUndefined();
  expect(await hook(f, 'Bash', { command: f.commands.classify })).toBeUndefined();
  expect(sh(f, f.commands.classify!)).toContain('REVIEW_SCOPE: policy=frozen pass=2 findings=0 fix=0 defer=0 note=0 blocking=0');
  await log(row({ status: 'clean', findings: [], converged: true, pass: 2, range_base: f.snapshot().head }));
  expect(await hook(f, 'Bash', { command: f.commands.continue })).toBeUndefined();
  sh(f, f.commands.continue!);
}

// The actor replays the bash workflow through bash -c and the shebang bins, so it is POSIX-only like the paid case it mirrors.
const posixTest = test.skipIf(process.platform === 'win32');
posixTest('a scripted actor that fixes the diff, defers the pre-existing defect and converges on pass 2 passes the verdict', async () => {
  const f = fixture();
  await act(f);
  const verdict = await shipFrozenScopeFailures(f, { exitReason: 'success' });
  expect(verdict.failures).toEqual([]);
  expect(verdict.evidence.loop).toEqual({ passes: 2, blocking_found: 2, deferred: 1, noted: 0, fixed: 1, rounds: 2, scope: 'frozen' });
  const rows = verdict.evidence.rows as Array<Record<string, any>>;
  expect(rows.map(r => r.pass)).toEqual([1, 2]);
  expect(rows[0]!.findings.map((x: any) => [x.fingerprint, x.action])).toEqual([[FROZEN_SCOPE_FIX_IDENTITY, 'auto-fixed'], [FROZEN_SCOPE_DEFER_IDENTITY, 'deferred']]);
  expect(rows[1]!.range_base).toBe(verdict.evidence.head);
  expect(verdict.evidence.payments).toBe(verdict.evidence.originalPayments);
  const summary = summarizeReviewLoop(rows, verdict.evidence.start.started_at);
  expect(summary).toEqual(verdict.evidence.loop);
  expect(reviewLoopLine(summary)).toBe('REVIEW_LOOP: passes=2 blocking_found=2 deferred=1 noted=0 fixed=1 scope=frozen');
}, 120_000);

posixTest('the fixture interface refuses the undeclared interactions before any decision', async () => {
  const f = fixture();
  expect(await hook(f, 'Edit', { file_path: f.payments, old_string: 'card', new_string: '?' })).toBe('Edit outside invoice.ts');
  expect(await hook(f, 'Write', { file_path: f.payments, content: '' })).toBe('Write outside invoice.ts and the review record');
  expect(await hook(f, 'Bash', { command: `${f.commands.classify} && echo done` })).toBe('Bash outside the fixture interface');
  expect(await hook(f, 'Bash', { command: 'git status' })).toBe('Bash outside the fixture interface');
  expect(await hook(f, 'Read', { file_path: `${f.root}/fixture.json` })).toBe('Read outside the declared files');
  expect(await hook(f, 'AskUserQuestion', { questions: [] })).toBe('Undeclared tool');
  expect(() => sh(f, f.commands.repeat!)).toThrow(/committed/);
  expect(() => sh(f, f.commands.continue!)).toThrow(/logged/);
  expect(f.snapshot().executions.filter(e => !e.allowed)).toHaveLength(6);
}, 120_000);

posixTest('leaving the diff defect in place or exiting after one pass are named failures', async () => {
  const f = fixture();
  await act(f, { fix: false, passes: 1 });
  const verdict = await shipFrozenScopeFailures(f, { exitReason: 'success' });
  expect(verdict.failures).toContain('invoice.ts still accepts a viewer other than the owner');
  expect(verdict.failures).toContain('expected exactly one repeat pass');
  expect(verdict.failures).toContain('pass 1 did not record the in-diff defect as fixed');
  expect(verdict.failures.some(line => line.startsWith('REVIEW_LOOP summary'))).toBe(true);
  expect(await hook(f, 'Bash', { command: f.commands.classify })).toBe('Loop decision already taken');
}, 120_000);
