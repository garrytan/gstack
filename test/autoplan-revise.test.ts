/**
 * `gstack-autoplan revise --out <dir> --plan <v2>` (plan B1c, item 9): the run
 * reviews a revised plan in the same run directory. Drift is the
 * Implementation-plan hash: every opened phase whose reviewed hash differs is
 * reopened (open attempts superseded), newly in-scope phases are added, the
 * archives keep `.r<rev>` names with `.v<k>` only on collision, revise at
 * gate_pending is its own journal event and the next gate is gate_rev + 1.
 * `next` and `answer` print the drift hints; a plan missing one of the two
 * sections refuses with PLAN_SECTIONS_INVALID and `next --scaffold` reviews a
 * scaffolded copy. Runs on the simulated Capy host.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESULT_CODES } from '../lib/result-codes';
import { SMALL_PLAN } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';

const r = capyRunner();
afterAll(() => r.cleanup());
let n = 0;
const V2 = SMALL_PLAN.replace('cap 30 s', 'cap 60 s, dead-letter after 8 attempts');
const RECORD_ONLY = SMALL_PLAN + '\nReviewed once; notes only.\n';
const DX_V2 = SMALL_PLAN.replace('Tests cover', 'Add a CLI flag --max-retries and an error message for a bad value. Tests cover');
function start(args: string[] = [], text = SMALL_PLAN): { out: string; dir: string; plan: string } {
  const dir = path.join(r.host.base, `rev${++n}`);
  const plan = writePlan(dir, text);
  const out = path.join(dir, 'run');
  const first = r.ap(['next', '--out', out, '--plan', plan, '--no-ui', ...args]);
  if (first.status !== 0) throw new Error(`first next failed: ${first.stderr}\n${first.stdout}`);
  return { out, dir, plan };
}
const v2File = (dir: string, text = V2) => { const f = path.join(dir, `plan-v2-${++n}.md`); fs.writeFileSync(f, text); return f; };
function gated(args: string[] = []): { out: string; dir: string; plan: string } {
  const s = start(args);
  phaseVia(r, s.out, 'ceo', { native: [], outside: [] });
  expect(phaseVia(r, s.out, 'eng', { native: [], outside: [] }).outside.stdout).toContain('status=gate_pending');
  return s;
}

describe('revise', () => {
  test('revise after ceo closes reopens ceo, and dx and eng then review the v2 snapshot', () => {
    const s = start(['--developer-tool']);
    phaseVia(r, s.out, 'ceo', { native: [], outside: [] });
    const v1 = readRunJson(s.out).phases.ceo.snapshot;
    const rev = r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir)]);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/^REVISED: plan=[0-9a-f]{12} reopened=ceo$/m);
    expect(rev.stdout).toContain('GSTACK_RESULT: skill=autoplan status=running');
    for (const phase of ['ceo', 'dx', 'eng']) {
      const p = phaseVia(r, s.out, phase, { native: [], outside: [] });
      expect(p.next.stdout).toMatch(new RegExp(`^PHASE: ${phase} snapshot=`, 'm'));
      expect(fs.readFileSync(path.join(s.out, `${phase}-native-prompt.md`), 'utf8')).toContain('dead-letter after 8 attempts');
      expect(fs.readFileSync(path.join(s.out, `${phase}-outside-prompt.md`), 'utf8')).toContain('dead-letter after 8 attempts');
    }
    const run = readRunJson(s.out);
    expect(run.status).toBe('gate_pending');
    expect(new Set(['ceo', 'dx', 'eng'].map(p => run.phases[p].snapshot)).size).toBe(1);
    expect(run.phases.ceo.snapshot).not.toBe(v1);
    expect(readJsonl(path.join(s.out, 'attempts.jsonl')).filter(e => e.event === 'plan_revised')).toHaveLength(1);
    expect(fs.existsSync(path.join(s.out, 'ceo-native-prompt.r0.md'))).toBe(true);
    const sealed = run.history.find((h: any) => h.phase === 'ceo').previous.native.output;
    expect(sealed).toMatch(/^ceo-native\.a\d+\.bound\.md$/);
    expect(fs.existsSync(path.join(s.out, sealed))).toBe(true);
    expect(run.artifacts[sealed]).toBeTruthy();
  });

  test('a Review-record-only edit keeps every phase; an open phase whose hash changed has its attempts superseded', () => {
    const s = start();
    phaseVia(r, s.out, 'ceo', { native: [], outside: [] });
    const same = r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir, RECORD_ONLY)]);
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toMatch(/reopened=none/);
    expect(readRunJson(s.out).phases.ceo.closed_at).toBeTruthy();
    const eng = r.ap(['next', '--out', s.out]);
    expect(eng.stdout).toMatch(/^PHASE: eng /m);
    const open = readRunJson(s.out).phases.eng;
    const changed = r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir)]);
    expect(changed.stdout).toMatch(/reopened=ceo,eng/);
    const superseded = readJsonl(path.join(s.out, 'attempts.jsonl')).filter(e => e.event === 'superseded').map(e => e.attempt);
    expect(superseded.sort()).toEqual([open.native.attempt, open.outside.attempt].sort());
  });

  test('revise at gate_pending is its own journal event, reruns on v2, and the next gate is gate_rev 2', () => {
    const s = gated();
    const rev = r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir), '--json']);
    expect(rev.status, rev.stderr).toBe(0);
    expect(JSON.parse(rev.stdout)).toMatchObject({ status: 'running', reopened: ['ceo', 'eng'] });
    const j = readJsonl(path.join(s.out, 'attempts.jsonl'));
    expect(j.find(e => e.event === 'plan_revised')).toMatchObject({ at_gate_rev: 1 });
    expect(j.filter(e => e.event === 'answered')).toEqual([]);
    expect(fs.existsSync(path.join(s.out, 'gate.r1.json'))).toBe(true);
    phaseVia(r, s.out, 'ceo', { native: [], outside: [] });
    phaseVia(r, s.out, 'eng', { native: [], outside: [] });
    expect(fs.readFileSync(path.join(s.out, 'eng-native-prompt.md'), 'utf8')).toContain('dead-letter after 8 attempts');
    expect(readRunJson(s.out)).toMatchObject({ status: 'gate_pending', gate_rev: 2 });
  });

  test('a second revise never overwrites the first archive', () => {
    const s = gated(['--max-rounds', '3']);
    expect(r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir)]).status).toBe(0);
    const first = fs.readFileSync(path.join(s.out, 'ceo-native-prompt.r1.md'));
    phaseVia(r, s.out, 'ceo', { native: [], outside: [] });
    expect(r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir, V2.replace('jitter 10%', 'jitter 20%'))]).status).toBe(0);
    expect(fs.readFileSync(path.join(s.out, 'ceo-native-prompt.r1.md')).equals(first)).toBe(true);
    expect(fs.existsSync(path.join(s.out, 'ceo-native-prompt.r1.v2.md'))).toBe(true);
  });

  test('revise adds a newly in-scope phase and never removes one', () => {
    const s = start();
    expect(readRunJson(s.out).phase_order).toEqual(['ceo', 'eng']);
    const rev = r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir, DX_V2)]);
    expect(rev.status, rev.stderr).toBe(0);
    const run = readRunJson(s.out);
    expect(run.phase_order).toEqual(['ceo', 'dx', 'eng']);
    expect(run.required_phases).toEqual(['ceo', 'dx', 'eng']);
    expect(run.phases.dx.skipped).toBeUndefined();
    expect(r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir)]).status).toBe(0);
    expect(readRunJson(s.out).phase_order).toEqual(['ceo', 'dx', 'eng']);
  });

  test('an attested bind is refused when the plan was revised after its attempt was dispatched', () => {
    const s = start();
    const attempt = readRunJson(s.out).phases.ceo.native.attempt;
    expect(r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir, RECORD_ONLY)]).stdout).toMatch(/reopened=none/);
    const rec = path.join(s.dir, 'hand.md');
    fs.writeFileSync(rec, 'Hand review.\n\nNo findings.\n');
    const res = r.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'native', '--record', rec, '--model', 'anthropic/claude-opus-5-5', '--attest', 'ran it', '--attempt', attempt]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/revised after .*dispatched.*\(RESULT_RECEIPT_MISSING\)$/m);
  });
  test('naming a decision that is not a pending amendment refuses with AMENDMENT_UNKNOWN and never asks for the edit just made', () => {
    const s = start();
    const before = fs.readFileSync(path.join(s.out, 'run.json'), 'utf8');
    for (const args of [['--plan', v2File(s.dir), '--incorporates', 'd1b'], ['--withdraw', 'd1b']]) {
      const res = r.ap(['revise', '--out', s.out, ...args]);
      expect(res.status).toBe(3);
      expect(res.stderr).toMatch(/d1b is not a pending amendment \(pending: none\).*\(AMENDMENT_UNKNOWN\)$/m);
      expect(res.stderr).toContain(`; fix: ${RESULT_CODES.AMENDMENT_UNKNOWN.fix} (AMENDMENT_UNKNOWN)`);
      expect(res.stderr).not.toContain('PLAN_AMEND_PENDING');
      expect(res.stderr).not.toContain('edit the plan');
    }
    expect(fs.readFileSync(path.join(s.out, 'run.json'), 'utf8')).toBe(before);
  });
});

describe('drift hints', () => {
  test('next prints PLAN_CHANGED when the source plan changed since the snapshot', () => {
    const s = start();
    fs.writeFileSync(s.plan, V2);
    const res = r.ap(['next', '--out', s.out]);
    expect(res.stdout).toMatch(new RegExp(`^PLAN_CHANGED: ${s.plan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} differs from the reviewed plan; run gstack-autoplan revise --out \\S+ --plan \\S+$`, 'm'));
  });
  test('answer prints PLAN_SOURCE_CHANGED when a reply reopens phases after the source plan changed', () => {
    const s = gated();
    fs.writeFileSync(s.plan, V2);
    const res = r.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '1', '--reply', 'all except p1d']);
    expect(res.stdout).toMatch(/^REOPENED: ceo,eng \(Eng last\)/m);
    expect(res.stdout).toMatch(/^PLAN_SOURCE_CHANGED: .* differs from the reviewed plan; run gstack-autoplan revise --out \S+ --plan \S+$/m);
  });
});

describe('plan sections', () => {
  test('only an Implementation plan: next refuses with PLAN_SECTIONS_INVALID and stdout; --scaffold reviews a copy', () => {
    const dir = path.join(r.host.base, 'scaffold');
    const text = '# P\n\n## Implementation plan\n\nDo the thing in lib/x.ts with a 30 s timeout.\n';
    const plan = writePlan(dir, text);
    const refused = r.ap(['next', '--out', path.join(dir, 'a'), '--plan', plan, '--no-ui']);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toMatch(/no "## Review record".*--scaffold.*\(PLAN_SECTIONS_INVALID\)$/m);
    expect(refused.stdout).toContain('GSTACK_RESULT: skill=autoplan status=refused');
    const ok = r.ap(['next', '--out', path.join(dir, 'b'), '--plan', plan, '--no-ui', '--scaffold']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^SCAFFOLDED: added "## Review record"/m);
    expect(ok.stdout).toMatch(/^PHASE: ceo /m);
    expect(fs.readFileSync(plan, 'utf8')).toBe(text);
    expect(fs.readFileSync(path.join(dir, 'b', 'plan-source.md'), 'utf8')).toContain('## Review record');
  });
  test('duplicate or reversed headings refuse with the code even with --scaffold; an empty section says so', () => {
    const dir = path.join(r.host.base, 'ambiguous');
    for (const [name, text] of [['dup', '# P\n\n## Implementation plan\n\nA.\n\n## Implementation plan\n\nB.\n\n## Review record\n'], ['rev', '# P\n\n## Review record\n\nx\n\n## Implementation plan\n\nA.\n']] as const) {
      const plan = writePlan(path.join(dir, name), text);
      const res = r.ap(['next', '--out', path.join(dir, name, 'run'), '--plan', plan, '--no-ui', '--scaffold']);
      expect(res.status).toBe(3);
      expect(res.stderr).toMatch(/\(PLAN_SECTIONS_INVALID\)$/m);
    }
    const plan = writePlan(path.join(dir, 'empty'), '# P\n\n## Implementation plan\n\n## Review record\n');
    const res = r.ap(['next', '--out', path.join(dir, 'empty', 'run'), '--plan', plan, '--no-ui']);
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/Implementation plan is empty.*\(PLAN_SECTIONS_INVALID\)$/m);
  });
  const BARE = '# Retry backoff\n\nAdd exponential backoff to lib/worker.ts: base 500 ms, cap 30 s.\n';
  test('a run whose first plan had no headings revises a plan that gained one heading, scaffolding the other', () => {
    for (const [name, v2, added] of [
      ['record', BARE.replace('30 s', '60 s') + '\n## Review record\n\nIncorporated the cap change.\n', '## Implementation plan'],
      ['impl', '# Retry backoff\n\n## Implementation plan\n\nAdd exponential backoff, cap 60 s.\n', '## Review record'],
    ] as const) {
      const dir = path.join(r.host.base, `bare-${name}`);
      const plan = writePlan(dir, BARE);
      const out = path.join(dir, 'run');
      expect(r.ap(['next', '--out', out, '--plan', plan, '--no-ui']).status).toBe(0);
      fs.writeFileSync(plan, v2);
      const rev = r.ap(['revise', '--out', out, '--plan', plan]);
      expect(rev.status, rev.stderr).toBe(0);
      expect(rev.stdout).toMatch(new RegExp(`^SCAFFOLDED: added "${added}" \\(the run's first plan had no section headings; .*plan-source\\.v1\\.md`, 'm'));
      expect(rev.stdout).toMatch(/^REVISED: plan=[0-9a-f]{12} reopened=ceo$/m);
      expect(fs.readFileSync(plan, 'utf8')).toBe(v2);
      const active = fs.readFileSync(path.join(out, 'plan-active.md'), 'utf8');
      expect(active).toContain('cap 60 s');
      expect(active.slice(0, active.indexOf('## Review record'))).not.toContain('Incorporated');
    }
  });
  test('a run that started with both headings still refuses a revision missing one, and says why', () => {
    const s = start();
    fs.writeFileSync(s.plan, V2.replace('## Review record\n', ''));
    const res = r.ap(['revise', '--out', s.out, '--plan', s.plan]);
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/no "## Review record"; this run's first plan had both headings, so its revisions keep both.*\(PLAN_SECTIONS_INVALID\)$/m);
  });
});

describe('plan path', () => {
  test('revise from another plan file says the run now follows it; the same file prints nothing', () => {
    const s = start();
    fs.writeFileSync(s.plan, V2);
    const same = r.ap(['revise', '--out', s.out, '--plan', s.plan]);
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).not.toContain('PLAN_INPUT:');
    const v2 = v2File(s.dir, V2.replace('jitter 10%', 'jitter 20%'));
    const moved = r.ap(['revise', '--out', s.out, '--plan', v2]);
    expect(moved.status, moved.stderr).toBe(0);
    expect(moved.stdout).toContain(`PLAN_INPUT: ${s.plan} -> ${v2} (drift checks and later revises read ${v2}; pass --plan ${s.plan} to go back)`);
    expect(readRunJson(s.out).plan_input).toBe(v2);
    expect(readJsonl(path.join(s.out, 'attempts.jsonl')).filter(e => e.event === 'plan_revised').map(e => e.plan_input_from ?? null)).toEqual([null, s.plan]);
  });
});
