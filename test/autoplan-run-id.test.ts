/**
 * Run ids from gstack-autoplan (GST-3015, from GBRA-108): two runs started in the
 * same second whose run directories share a name ("autoplan") minted the same id,
 * autoplan-20261117010353, and so shared one checkpoint collection. Each run id now
 * carries a random part between the directory name and the 14-digit stamp, which
 * stays last so the approval importer's stamp exemption still reads it.
 */
import { afterAll, afterEach, expect, setSystemTime, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRow } from '../lib/approval-record';
import { initRun } from '../lib/autoplan-run';
import { ROOT, SMALL_PLAN } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-run-id-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
afterEach(() => setSystemTime());

test('two runs started in the same second in same-named directories get different run ids', () => {
  const plan = path.join(TMP, 'plan.md');
  fs.writeFileSync(plan, SMALL_PLAN);
  setSystemTime(new Date('2026-11-17T01:03:53.250Z'));
  const first = initRun({ plan, out: path.join(TMP, 'a', 'autoplan'), cwd: ROOT, full: true, sessionKind: 'unattended', outsideEnabled: false });
  const second = initRun({ plan, out: path.join(TMP, 'b', 'autoplan'), cwd: ROOT, full: true, sessionKind: 'unattended', outsideEnabled: false });
  expect(first.run).not.toBe(second.run);
  for (const run of [first.run, second.run]) {
    expect(run).toMatch(/^autoplan-[a-z]{6}-20261117010353$/);
    const ask = `autoplan run ${run}`;
    const row = buildRow({ ask, words: 'do it', by: 'agent:test', scope: 'this plan', source: `autoplan:${run}@gate_rev=1` }, 'main', new Date(), { id: run, at: { ask: ask.indexOf(run), source: 'autoplan:'.length } });
    expect('code' in row ? row.code : 'ok').toBe('ok');
  }
});

test('an explicit run id is kept as given', () => {
  const plan = path.join(TMP, 'plan.md');
  fs.writeFileSync(plan, SMALL_PLAN);
  expect(initRun({ plan, out: path.join(TMP, 'c', 'autoplan'), cwd: ROOT, full: true, sessionKind: 'unattended', outsideEnabled: false, runId: 'autoplan-fixed-20261117010353' }).run).toBe('autoplan-fixed-20261117010353');
});
