/**
 * End-to-end unattended runs on the simulated Capy host, driven only through
 * the CLI (plan B1a/B1b/B1c, the wave's mandatory free-tier acceptance): a
 * three-revision run validates with unique ids; phases bound from free-form
 * records with one outside voice unavailable close, answer, export and
 * validate; a run gated on <=1.91.94-style decision ids validates after the
 * load-time migration; run.json records gstack_version, a newer run refuses
 * and an older one migrates forward. One conformance run strings every
 * mechanism together.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESULT_CODES } from '../lib/result-codes';
import { ROOT, SMALL_PLAN, boundOf, recCarrying, resultOf } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan, type CapyRunner } from './helpers/autoplan-capy';

const r = capyRunner();
afterAll(() => r.cleanup());
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
let n = 0;
function start(args: string[] = []): { out: string; dir: string; plan: string } {
  const dir = path.join(r.host.base, `e2e${++n}`);
  const plan = writePlan(dir);
  const out = path.join(dir, 'run');
  const res = r.ap(['next', '--out', out, '--plan', plan, '--no-ui', ...args]);
  if (res.status !== 0) throw new Error(`first next failed: ${res.stderr}\n${res.stdout}`);
  return { out, dir, plan };
}
function expectUniqueIds(out: string) {
  for (const f of ['decisions.jsonl', 'findings.jsonl', 'tasks.jsonl']) {
    const ids = readJsonl(path.join(out, f)).map(x => x.id);
    expect(new Set(ids).size, f).toBe(ids.length);
  }
  const attempts = readJsonl(path.join(out, 'attempts.jsonl')).filter(e => e.event === 'dispatched').map(e => e.attempt);
  expect(new Set(attempts).size).toBe(attempts.length);
}
/** Every completed voice reviewed its phase's snapshot (receipt or attestation), recorded as reviewed_sha256. */
function expectReviewedHashes(out: string) {
  const run = readRunJson(out);
  for (const p of run.phase_order) for (const voice of ['native', 'outside']) {
    const v = run.phases[p][voice];
    if (v.status !== 'completed') continue;
    expect(v.reviewed_sha256, `${p} ${voice}`).toBe(run.phases[p].snapshot);
    if (v.receipt !== 'attested') expect(fs.readFileSync(path.join(out, v.output), 'utf8')).toContain(`INPUT: ${p} ${run.phases[p].snapshot}`);
  }
}
const ok = (res: { status: number | null; stderr: string; stdout: string }) => { expect(res.status, res.stderr + res.stdout).toBe(0); return res; };

describe('unattended runs on the Capy host', () => {
  test('a three-revision run driven only through the CLI validates with unique ids and records gstack_version', () => {
    const s = start(['--max-rounds', '3']);
    expect(readRunJson(s.out).gstack_version).toBe(VERSION);
    for (const rev of [1, 2]) {
      phaseVia(r, s.out, 'ceo');
      expect(phaseVia(r, s.out, 'eng').outside.stdout).toContain('status=gate_pending');
      expectReviewedHashes(s.out);
      expect(ok(r.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', String(rev), '--reply', recCarrying(s.out, 'all', ['p1d'])])).stdout).toMatch(/^REOPENED: ceo,eng \(Eng last\) reason=revise$/m);
    }
    phaseVia(r, s.out, 'ceo');
    phaseVia(r, s.out, 'eng');
    expect(ok(r.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '3', '--reply', recCarrying(s.out)])).stdout).toContain('status=complete');
    ok(r.ap(['export', '--out', s.out]));
    const v = ok(r.validate(s.out));
    expect(v.stdout).toMatch(/^ARTIFACT_VALID: run=\S+ status=complete/m);
    expectUniqueIds(s.out);
    expectReviewedHashes(s.out);
    expect(readJsonl(path.join(s.out, 'decisions.jsonl')).filter(d => d.gate_rev === 3).every(d => d.id.includes('-r3-'))).toBe(true);
  });

  test('free-form records (table, list, No findings.) and one unavailable outside voice reach the gate, answer, export and validate', () => {
    const s = start();
    const run = readRunJson(s.out);
    const sha = run.phases.ceo.snapshot;
    const rec = (name: string, text: string) => { const f = path.join(s.dir, name); fs.writeFileSync(f, text); return f; };
    ok(r.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'native', '--model', 'anthropic/claude-opus-5-5', '--attest', 'Capy subagent read the prompt file', '--attempt', run.phases.ceo.native.attempt,
      '--record', rec('ceo-n.md', '# CEO review\n\n| Severity | Title | File |\n|---|---|---|\n| High | Retry cap is unbounded on restart | lib/worker.ts:10 |\n| Low | Name the env var | |\n')]));
    const closed = ok(r.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'outside', '--model', 'openai/gpt-6.1-sol', '--record', rec('ceo-o.md', `INPUT: ceo ${sha}\n\n- [High] Jitter bounds are untested\n- [Medium] Resume path skips the cap\n`)]));
    expect(closed.stdout).toMatch(/^PHASE_CLOSED: ceo .*coverage=both/m);
    const eng = ok(r.ap(['next', '--out', s.out]));
    const engSha = /^PHASE: eng snapshot=([0-9a-f]{64})/m.exec(eng.stdout)![1];
    ok(r.ap(['submit', '--out', s.out, '--phase', 'eng', '--voice', 'native', '--model', 'anthropic/claude-opus-5-5', '--record', rec('eng-n.md', `INPUT: eng ${engSha}\n\nRead the whole plan.\n\nNo findings.\n`)]));
    const gated = ok(r.ap(['submit', '--out', s.out, '--phase', 'eng', '--voice', 'outside', '--unavailable', 'no cross-family subagent on this host']));
    expect(gated.stdout).toMatch(/^PHASE_CLOSED: eng .*coverage=native_only/m);
    expect(gated.stdout).toContain('status=gate_pending');
    expect(ok(r.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '1', '--reply', recCarrying(s.out)])).stdout).toContain('status=complete');
    ok(r.ap(['export', '--out', s.out]));
    expect(ok(r.validate(s.out)).stdout).toMatch(/^ARTIFACT_VALID: run=\S+ status=complete attested=1$/m);
    expect(fs.readFileSync(path.join(s.out, 'review-record.md'), 'utf8')).toMatch(/attested/);
    expectReviewedHashes(s.out);
  });

  test('a run gated on <=1.91.94-style decision ids validates after the load-time migration', () => {
    const s = start();
    phaseVia(r, s.out, 'ceo');
    phaseVia(r, s.out, 'eng');
    ok(r.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '1', '--reply', recCarrying(s.out, 'all', ['p1d'])]));
    phaseVia(r, s.out, 'ceo');
    phaseVia(r, s.out, 'eng');
    const file = path.join(s.out, 'decisions.jsonl');
    fs.writeFileSync(file, readJsonl(file).map(d => JSON.stringify({ ...d, id: d.id.replace(/-r\d+-/, '-') })).join('\n') + '\n');
    const manifest = readRunJson(s.out);
    delete manifest.gstack_version;
    fs.writeFileSync(path.join(s.out, 'run.json'), JSON.stringify(manifest, null, 2) + '\n');
    const res = ok(r.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '2', '--reply', recCarrying(s.out)]));
    expect(res.stdout).toMatch(/^GSTACK_VERSION_CHANGED: run unknown -> /m);
    expect(res.stdout).toContain('status=complete');
    ok(r.ap(['export', '--out', s.out]));
    const v = r.validate(s.out);
    expect(v.stderr).not.toContain('ARTIFACT_DUPLICATE_ID');
    expect(v.stderr).not.toContain('ARTIFACT_DANGLING_REF');
    expect(v.status, v.stderr).toBe(0);
    const migrated = readJsonl(path.join(s.out, 'attempts.jsonl')).filter(e => e.event === 'decision_ids_migrated');
    expect(migrated).toHaveLength(1);
    expect(migrated[0].n).toBeGreaterThan(0);
    expect(readRunJson(s.out).gstack_version).toBe(VERSION);
  });

  test('a run written by a newer gstack refuses; an older one prints GSTACK_VERSION_CHANGED once and moves forward', () => {
    const s = start();
    const set = (v: string) => { const m = readRunJson(s.out); m.gstack_version = v; fs.writeFileSync(path.join(s.out, 'run.json'), JSON.stringify(m, null, 2) + '\n'); };
    set('99.0.0.0');
    const newer = r.ap(['next', '--out', s.out]);
    expect(newer.status).toBe(3);
    expect(newer.stderr).toMatch(/99\.0\.0\.0.*\(GSTACK_VERSION_CHANGED\)$/m);
    set('1.91.22.0');
    const older = ok(r.ap(['next', '--out', s.out]));
    expect(older.stdout).toMatch(new RegExp(`^GSTACK_VERSION_CHANGED: run 1\\.91\\.22\\.0 -> ${VERSION.replace(/\./g, '\\.')}`, 'm'));
    expect(ok(r.ap(['next', '--out', s.out])).stdout).not.toMatch(/GSTACK_VERSION_CHANGED/);
    expect(readJsonl(path.join(s.out, 'attempts.jsonl')).filter(e => e.event === 'gstack_version_changed')).toHaveLength(1);
  });
});

describe('conformance: one run through every mechanism', () => {
  test('canonical and attested binds, an unavailable voice, partial then full replies, PLAN_AMEND_PENDING, revise --incorporates, an interruption, three gate revisions', () => {
    const c: CapyRunner = r;
    const s = start(['--max-rounds', '3']);
    const run = readRunJson(s.out).run;
    // ceo: native canonical (fixture), outside attested record
    ok(c.review(path.join(s.out, 'ceo-native-prompt.md')));
    ok(c.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'native', '--result', resultOf(s.out, 'ceo', 'native'), '--model', 'anthropic/claude-opus-5-5']));
    const hand = path.join(s.dir, 'ceo-outside-hand.md');
    fs.writeFileSync(hand, '| Severity | Title |\n|---|---|\n| Medium | Retry storage cost is unpriced |\n');
    ok(c.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'outside', '--record', hand, '--model', 'openai/gpt-6.1-sol', '--attest', 'Capy subagent', '--attempt', readRunJson(s.out).phases.ceo.outside.attempt]));
    // eng: native challenge with changes, outside unavailable
    ok(c.ap(['next', '--out', s.out]));
    ok(c.review(path.join(s.out, 'eng-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify([{ id: 'F1', severity: 'High', title: 'Gate the backoff behind a flag', user_challenge: true, changes: 'scope', fix: 'RETRY_BACKOFF=1' }]) }));
    ok(c.ap(['submit', '--out', s.out, '--phase', 'eng', '--voice', 'native', '--result', resultOf(s.out, 'eng', 'native'), '--model', 'anthropic/claude-opus-5-5']));
    expect(ok(c.ap(['submit', '--out', s.out, '--phase', 'eng', '--voice', 'outside', '--unavailable', 'no outside runner'])).stdout).toContain('status=gate_pending');
    const accept = JSON.parse(fs.readFileSync(path.join(s.out, 'gate.json'), 'utf8')).items.find((i: any) => i.title.startsWith('Gate the backoff')).id;
    // partial, then full
    expect(ok(c.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '1', '--reply', `${accept}b`])).stdout).toMatch(/^GATE_PENDING: p1/m);
    const full = ok(c.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '1', '--reply', recCarrying(s.out)]));
    expect(full.stdout).toMatch(new RegExp(`^APPLY: ${run}-${accept} `, 'm'));
    const pendingNext = c.ap(['next', '--out', s.out]).stderr;
    expect(pendingNext).toMatch(/\(PLAN_AMEND_PENDING\)$/m);
    expect(pendingNext).toContain(`; fix: ${RESULT_CODES.PLAN_AMEND_PENDING.fix} (PLAN_AMEND_PENDING)`);
    const v2 = path.join(s.dir, 'plan-v2.md');
    fs.writeFileSync(v2, SMALL_PLAN.replace('Tests cover', 'Ship behind RETRY_BACKOFF=1, default off. Tests cover'));
    expect(ok(c.ap(['revise', '--out', s.out, '--plan', v2, '--incorporates', `${run}-${accept}`])).stdout).toMatch(/^AMENDMENTS: pending=none$/m);
    // interruption: attempts dispatched, the driver dies holding the lock; resume reclaims and the parent redispatches
    ok(c.ap(['next', '--out', s.out]));
    fs.writeFileSync(path.join(s.out, 'run.lock'), JSON.stringify({ pid: 999_999_999, host: require('node:os').hostname(), at: new Date().toISOString() }));
    const resumed = ok(c.ap(['resume', '--out', s.out]));
    expect(resumed.stdout).toMatch(/execution_unknown=2/);
    const unknown = [...resumed.stdout.matchAll(/^EXECUTION_UNKNOWN: (\S+)$/gm)].map(m => m[1]!);
    ok(c.ap(['next', '--out', s.out, ...unknown.flatMap(a => ['--redispatch', a])]));
    for (const voice of ['native', 'outside']) ok(c.review(path.join(s.out, `ceo-${voice}-prompt.md`)));
    for (const voice of ['native', 'outside']) ok(c.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', voice, '--result', resultOf(s.out, 'ceo', voice as 'native' | 'outside'), '--model', voice === 'native' ? 'anthropic/claude-opus-5-5' : 'openai/gpt-6.1-sol']));
    phaseVia(c, s.out, 'eng');
    expect(readRunJson(s.out).gate_rev).toBe(2);
    ok(c.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '2', '--reply', recCarrying(s.out, 'all', ['p1d'])]));
    phaseVia(c, s.out, 'ceo');
    phaseVia(c, s.out, 'eng');
    expect(ok(c.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '3', '--reply', recCarrying(s.out)])).stdout).toContain('status=complete');
    ok(c.ap(['export', '--out', s.out]));
    expect(ok(c.validate(s.out)).stdout).toMatch(/^ARTIFACT_VALID: run=\S+ status=complete/m);
    const final = readRunJson(s.out);
    expect(final.counts.decisions_pending).toBe(0);
    expect((final.amendments ?? []).filter((a: any) => a.status === 'pending')).toEqual([]);
    expect(final.gate_rev).toBe(3);
    expectUniqueIds(s.out);
    expectReviewedHashes(s.out);
    expect(fs.readFileSync(boundOf(s.out, 'ceo', 'native'), 'utf8')).toContain(final.phases.eng.snapshot);
  });
});
