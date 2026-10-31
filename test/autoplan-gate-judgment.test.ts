/**
 * Gate judgment (plan B2a/B2b, items 8 and 10, with the B-core amendments and
 * next-wave B1/B2/B5): findings carry `changes`; a user challenge both voices
 * raised on a confirmed finding with the same `changes` recommends `b` only
 * with one shared proposal (the parent's override, or the same remedy from
 * both), rendering both remedies verbatim and the basis; anything weaker keeps
 * `a` with its basis. APPLY keys on the chosen option's `changes_plan`;
 * accepted changes are pending amendments (status amend_pending, nothing
 * reopens at answer) that `next` refuses past (PLAN_AMEND_PENDING) until
 * `revise --incorporates` binds them to a changed plan or `--withdraw` drops
 * them. `as-is` keeps every direction; `rec` (alias `all`) takes every
 * recommendation. Partial replies resolve against persisted decisions. On
 * reruns a challenge without `changes` is an agent decision that reopens
 * nothing, and rerun prompts carry the decided items.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROOT, SMALL_PLAN, boundOf, recCarrying, resultOf } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';

const r = capyRunner();
afterAll(() => r.cleanup());
let n = 0;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AGREE = {
  native: [{ id: 'F1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'gate the change behind RETRY_BACKOFF=1' }],
  outside: [{ id: 'O1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'add a kill switch flag for the new schedule' }],
};
const DISAGREE = {
  native: [{ id: 'F1', severity: 'Critical', title: 'Persist attempts in a separate table', file: 'lib/worker.ts', line: 10, user_challenge: true, changes: 'scope', fix: 'new table' }],
  outside: [{ id: 'O1', severity: 'Low', title: 'Persist attempts in a separate table', file: 'lib/worker.ts', line: 11, user_challenge: true, changes: 'scope', fix: 'keep the column' }],
};
const SAME = {
  native: [{ id: 'F4', severity: 'High', title: 'Cap the retry storage per tenant', user_challenge: true, changes: 'scope', fix: 'Cap stored attempts at 50 per tenant.' }],
  outside: [{ id: 'O4', severity: 'High', title: 'Cap the retry storage per tenant', user_challenge: true, changes: 'scope', fix: 'cap stored attempts at 50 per tenant' }],
};
const PACKAGING = {
  native: [{ id: 'F5', severity: 'Medium', title: 'Split the backoff into its own PR', user_challenge: true, changes: 'packaging', fix: 'land the schedule change as its own PR' }],
  outside: [{ id: 'O5', severity: 'Medium', title: 'Split the backoff into its own PR', user_challenge: true, changes: 'packaging', fix: 'Land the schedule change as its own PR.' }],
};
const MISMATCH = {
  native: [{ id: 'F1', severity: 'Medium', title: 'Drop the jitter requirement', user_challenge: true, changes: 'scope', fix: 'remove jitter' }],
  outside: [{ id: 'O1', severity: 'Medium', title: 'Drop the jitter requirement', user_challenge: true, changes: 'cost', fix: 'remove jitter' }],
};
function gated(ceo: { native?: unknown[]; outside?: unknown[] }, eng: { native?: unknown[]; outside?: unknown[] }): { out: string; dir: string; plan: string; run: string } {
  const dir = path.join(r.host.base, `gj${++n}`);
  const plan = writePlan(dir);
  const out = path.join(dir, 'run');
  expect(r.ap(['next', '--out', out, '--plan', plan, '--no-ui']).status).toBe(0);
  phaseVia(r, out, 'ceo', ceo);
  expect(phaseVia(r, out, 'eng', eng).outside.stdout).toContain('status=gate_pending');
  return { out, dir, plan, run: readRunJson(out).run };
}
const gate = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
const decisions = (out: string) => readJsonl(path.join(out, 'decisions.jsonl'));
const answer = (out: string, rev: number, reply: string, json = false) => r.ap(['answer', '--by', 'human', '--out', out, '--gate-rev', String(rev), '--reply', reply, ...(json ? ['--json'] : [])]);
const v = (dir: string, text: string) => { const f = path.join(dir, `v${++n}.md`); fs.writeFileSync(f, text); return f; };

describe('changes and user-challenge defaults', () => {
  test('`changes` reaches findings.jsonl, the schema and decisions; an unknown value is refused', () => {
    const g = gated(AGREE, {});
    expect(readJsonl(`${boundOf(g.out, 'ceo', 'native')}.findings.jsonl`)[0]).toMatchObject({ changes: 'scope', user_challenge: true });
    const schema = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-artifact'), 'schema', 'findings'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(JSON.parse(schema.stdout).properties.changes).toEqual({ enum: ['scope', 'cost', 'direction', 'packaging', 'ordering'] });
    expect(decisions(g.out).find(d => d.label === 'UC1')).toMatchObject({ changes: 'scope', recommended: 'a', recommended_basis: 'plan direction; remedies differ; no shared proposal' });
    const dir = path.join(r.host.base, 'badchanges');
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui']).status).toBe(0);
    expect(r.review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify([{ severity: 'Low', title: 'x', user_challenge: true, changes: 'naming' }]) }).status).toBe(0);
    const bad = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', resultOf(out, 'ceo', 'native'), '--model', 'anthropic/claude-opus-5-5']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/changes "naming" is not one of scope\|cost\|direction\|packaging\|ordering.*\(RESULT_FINDINGS_MISSING\)$/m);
  });

  test('one shared remedy recommends b; different remedies show both verbatim and keep a; disagreement and mismatched changes keep a with the basis', () => {
    const g = gated({ native: [...AGREE.native, ...MISMATCH.native.map(f => ({ ...f, id: 'F2' })), ...SAME.native], outside: [...AGREE.outside, ...MISMATCH.outside.map(f => ({ ...f, id: 'O2' })), ...SAME.outside] }, DISAGREE);
    const items = gate(g.out).items;
    const same = items.find((i: any) => i.title.startsWith('Cap the retry storage'));
    expect(same).toMatchObject({ kind: 'approval', recommended: 'b', recommended_basis: 'both voices; same remedy' });
    const agree = items.find((i: any) => i.title.startsWith('Ship the backoff'));
    expect(agree).toMatchObject({ kind: 'approval', recommended: 'a', recommended_basis: 'plan direction; remedies differ; no shared proposal' });
    expect(agree.options.find((o: any) => o.key === 'b')).toMatchObject({ changes_plan: true });
    expect(agree.options.find((o: any) => o.key === 'b').text).toContain('native: gate the change behind RETRY_BACKOFF=1; outside: add a kill switch flag for the new schedule');
    expect(agree.options.find((o: any) => o.key === 'a').changes_plan).toBe(false);
    expect(items.find((i: any) => i.title.startsWith('Drop the jitter'))).toMatchObject({ recommended: 'a', recommended_basis: 'plan direction; voices name different changes' });
    expect(items.find((i: any) => i.title.startsWith('Persist attempts'))).toMatchObject({ recommended: 'a', recommended_basis: 'plan direction; voices disagree' });
    const render = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-gate'), 'render', path.join(g.out, 'gate.json')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(render.stdout).toMatch(new RegExp(`\\[${same.id}\\] .*recommended: b \\(both voices; same remedy\\)`));
    expect(render.stdout).toMatch(/recommended: a \(plan direction; voices disagree\)/);
    const p1 = items.find((i: any) => i.id === 'p1');
    expect(p1.options.find((o: any) => o.key === p1.recommended).text).toContain(`${same.id}b`);
    expect(p1.options.find((o: any) => o.key === p1.recommended).text).not.toContain(`${agree.id}b`);
  });

  test('a parent reconcile override naming one shared proposal renders that proposal as option b', () => {
    const dir = path.join(r.host.base, 'shared');
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui']).status).toBe(0);
    r.review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify(AGREE.native) });
    r.review(path.join(out, 'ceo-outside-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify(AGREE.outside) });
    const run = readRunJson(out);
    expect(r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', resultOf(out, 'ceo', 'native'), '--model', 'anthropic/claude-opus-5-5']).status).toBe(0);
    const overrides = path.join(dir, 'reconcile.jsonl');
    fs.writeFileSync(overrides, JSON.stringify({ outside_id: `${run.run}-ceo-outside-1`, native_id: `${run.run}-ceo-native-1`, disposition: 'confirmed', resolution: 'same change', proposal: 'ship behind RETRY_BACKOFF=1, default off' }) + '\n');
    expect(r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--result', resultOf(out, 'ceo', 'outside'), '--model', 'openai/gpt-6.1-sol', '--reconcile', overrides]).status).toBe(0);
    phaseVia(r, out, 'eng', {});
    const uc = gate(out).items.find((i: any) => i.title.startsWith('Ship the backoff'));
    expect(uc).toMatchObject({ recommended: 'b', recommended_basis: 'both voices; shared proposal' });
    expect(uc.options.find((o: any) => o.key === 'b').text).toContain('ship behind RETRY_BACKOFF=1, default off');
  });
});

describe('accepted changes are amendments', () => {
  test('an accepted change prints APPLY and NEXT revise and leaves amend_pending without reopening; next refuses until revise --incorporates binds it; revise reports what reopened', () => {
    const g = gated(AGREE, {});
    const held = answer(g.out, 1, 'uc1b');
    expect(held.status, held.stderr).toBe(0);
    expect(held.stdout).toMatch(/^GATE_PENDING: uc2, p1 unanswered \(reply with uc2a\|uc2b p1a\|p1b\|p1c\|p1d\|p1e or rec\)$/m);
    expect(held.stdout).not.toMatch(/^APPLY:/m);
    const res = answer(g.out, 1, recCarrying(g.out, 'rec'));
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^APPLY: ${esc(g.run)}-uc1 Ship the backoff behind a flag first .* -> accept the change both reviewers recommend.*; edit the plan, then revise$`, 'm'));
    expect(res.stdout).not.toMatch(/^REOPENED:/m);
    expect(res.stdout).toMatch(new RegExp(`^NEXT: edit the plan, then gstack-autoplan revise --out ${esc(g.out)} --plan ${esc(g.plan)} --incorporates ${esc(g.run)}-uc1$`, 'm'));
    expect(res.stdout).toContain('status=amend_pending');
    const before = readRunJson(g.out);
    expect(before.status).toBe('amend_pending');
    expect(before.phases.ceo.closed_at).toBeTruthy();
    expect(before.amendments).toEqual([expect.objectContaining({ decision: `${g.run}-uc1`, status: 'pending', item: 'uc1', changes: 'scope' })]);
    expect(r.ap(['status', '--out', g.out]).stdout).toMatch(new RegExp(`^AMEND_PENDING: ${esc(g.run)}-uc1 uc1 changes=scope -> edit the plan, then revise$`, 'm'));
    expect(r.validate(g.out).status).toBe(0);
    const blocked = r.ap(['next', '--out', g.out]);
    expect(blocked.status).toBe(3);
    expect(blocked.stderr).toMatch(new RegExp(`${esc(g.run)}-uc1 \\(APPLY uc1: edit the plan, then revise\\).*\\(PLAN_AMEND_PENDING\\)$`, 'm'));
    const runFile = path.join(g.out, 'run.json');
    const saved = fs.readFileSync(runFile, 'utf8');
    fs.writeFileSync(runFile, JSON.stringify({ ...JSON.parse(saved), status: 'complete' }, null, 2) + '\n');
    const exported = r.ap(['export', '--out', g.out]);
    expect(exported.status).toBe(3);
    expect(exported.stderr).toMatch(new RegExp(`${esc(g.run)}-uc1.*\\(PLAN_AMEND_PENDING\\)$`, 'm'));
    fs.writeFileSync(runFile, saved);
    const unchanged = r.ap(['revise', '--out', g.out, '--plan', g.plan, '--incorporates', `${g.run}-uc1`]);
    expect(unchanged.status).toBe(3);
    expect(unchanged.stderr).toMatch(/did not change.*\(PLAN_AMEND_PENDING\)$/m);
    const bound = r.ap(['revise', '--out', g.out, '--plan', v(g.dir, SMALL_PLAN.replace('cap 30 s', 'cap 30 s, behind RETRY_BACKOFF=1')), '--incorporates', 'uc1']);
    expect(bound.status, bound.stderr).toBe(0);
    expect(bound.stdout).toMatch(/^REVISED: plan=[0-9a-f]{12} reopened=ceo,eng$/m);
    expect(bound.stdout).toMatch(/^AMENDMENTS: pending=none$/m);
    expect(bound.stdout).toMatch(new RegExp(`^NEXT: gstack-autoplan next --out ${esc(g.out)}$`, 'm'));
    const j = readJsonl(path.join(g.out, 'attempts.jsonl')).find(e => e.event === 'amendment_incorporated');
    expect(j).toMatchObject({ decision: `${g.run}-uc1` });
    expect(j.old_plan_sha256).not.toBe(j.new_plan_sha256);
    expect(readJsonl(path.join(g.out, 'attempts.jsonl')).find(e => e.event === 'plan_revised')).toMatchObject({ reopened: ['ceo', 'eng'] });
    expect(readRunJson(g.out).status).toBe('running');
    expect(r.ap(['next', '--out', g.out]).status).toBe(0);
  });

  test('`as-is` keeps every direction; --withdraw is a journaled owner decision that completes the run when nothing else is pending', () => {
    const g = gated(AGREE, {});
    const asIs = answer(g.out, 1, 'as-is');
    expect(asIs.status, asIs.stderr).toBe(0);
    expect(asIs.stdout).toMatch(/^APPROVED: gate_rev=1 as-is$/m);
    expect(asIs.stdout).not.toMatch(/^APPLY:/m);
    expect(decisions(g.out).find(d => d.label === 'UC1')).toMatchObject({ chosen: 'a', status: 'approved' });
    const w = gated(AGREE, {});
    expect(answer(w.out, 1, recCarrying(w.out, 'rec', ['uc1b'])).stdout).toMatch(/^APPLY:/m);
    const withdraw = r.ap(['revise', '--out', w.out, '--withdraw', `${w.run}-uc1`]);
    expect(withdraw.status, withdraw.stderr).toBe(0);
    expect(withdraw.stdout).toMatch(/^APPROVED: gate_rev=1 \(every accepted change is in the plan or settled\)$/m);
    expect(readJsonl(path.join(w.out, 'attempts.jsonl')).find(e => e.event === 'amendment_withdrawn')).toMatchObject({ decision: `${w.run}-uc1` });
    expect(readRunJson(w.out).status).toBe('complete');
    expect(r.validate(w.out).status).toBe(0);
  });
});

describe('record-only changes settle without a plan edit', () => {
  test('a packaging change: APPLY says settle, revise --settle reopens nothing and completes, export and validate pass; a scope change never settles', () => {
    const g = gated(PACKAGING, {});
    expect(gate(g.out).items.find((i: any) => i.id === 'uc1')).toMatchObject({ recommended: 'b', changes: 'packaging' });
    const res = answer(g.out, 1, recCarrying(g.out, 'rec'));
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^APPLY: ${esc(g.run)}-uc1 .*; no plan edit needed: revise --settle uc1$`, 'm'));
    expect(readRunJson(g.out).status).toBe('amend_pending');
    expect(r.ap(['next', '--out', g.out]).stderr).toMatch(/\(PLAN_AMEND_PENDING\)$/m);
    const settled = r.ap(['revise', '--out', g.out, '--settle', 'uc1']);
    expect(settled.status, settled.stderr).toBe(0);
    expect(settled.stdout).toMatch(new RegExp(`^SETTLED: ${esc(g.run)}-uc1 \\(packaging; plan [0-9a-f]{12} unchanged; nothing reopens\\)$`, 'm'));
    expect(settled.stdout).toMatch(/^APPROVED: gate_rev=1 \(every accepted change is in the plan or settled\)$/m);
    expect(settled.stdout).not.toMatch(/^REOPENED:/m);
    const run = readRunJson(g.out);
    expect(run.status).toBe('complete');
    expect(run.amendments).toEqual([expect.objectContaining({ decision: `${g.run}-uc1`, status: 'settled', changes: 'packaging' })]);
    expect(readJsonl(path.join(g.out, 'attempts.jsonl')).find(e => e.event === 'amendment_settled')).toMatchObject({ decision: `${g.run}-uc1`, changes: 'packaging' });
    expect(r.ap(['export', '--out', g.out]).status).toBe(0);
    expect(r.validate(g.out).status).toBe(0);
    const scope = gated(AGREE, {});
    expect(answer(scope.out, 1, recCarrying(scope.out, 'rec', ['uc1b'])).stdout).toMatch(/; edit the plan, then revise$/m);
    const refused = r.ap(['revise', '--out', scope.out, '--settle', 'uc1']);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toMatch(/changes scope; only packaging or ordering changes settle.*\(AMENDMENT_NOT_SETTLEABLE\)$/m);
    expect(readRunJson(scope.out).status).toBe('amend_pending');
  });
});

describe('mixed amendments: a scope change and a packaging change', () => {
  const SCOPE_SAME = { native: [{ ...SAME.native[0], title: 'Ship the backoff behind a flag first', fix: 'gate the change behind RETRY_BACKOFF=1' }], outside: [{ ...SAME.outside[0], title: 'Ship the backoff behind a flag first', fix: 'gate the change behind RETRY_BACKOFF=1' }] };
  const v2 = (dir: string) => v(dir, SMALL_PLAN.replace('cap 30 s', 'cap 30 s, behind RETRY_BACKOFF=1'));
  const mixed = () => {
    const g = gated(SCOPE_SAME, PACKAGING);
    const items = gate(g.out).items.filter((i: any) => i.id.startsWith('uc'));
    expect(items.map((i: any) => `${i.id}:${i.recommended}:${i.changes}`)).toEqual(['uc1:b:scope', 'uc2:b:packaging']);
    const res = answer(g.out, 1, 'rec');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^NEXT: gstack-autoplan revise --out ${esc(g.out)} --settle uc2; then edit the plan, then gstack-autoplan revise --out ${esc(g.out)} --plan ${esc(g.plan)} --incorporates ${esc(g.run)}-uc1$`, 'm'));
    return g;
  };
  test('incorporate first, then settle: the settle binds to the revised plan, the reopened phases rerun, and the run completes', () => {
    const g = mixed();
    const inc = r.ap(['revise', '--out', g.out, '--plan', v2(g.dir), '--incorporates', 'uc1']);
    expect(inc.status, inc.stderr).toBe(0);
    expect(inc.stdout).toMatch(/^REVISED: plan=[0-9a-f]{12} reopened=ceo,eng$/m);
    const settled = r.ap(['revise', '--out', g.out, '--settle', 'uc2']);
    expect(settled.status, settled.stderr).toBe(0);
    expect(settled.stdout).toMatch(new RegExp(`^SETTLED: ${esc(g.run)}-uc2 \\(packaging; plan [0-9a-f]{12} unchanged; nothing reopens\\)$`, 'm'));
    expect(settled.stdout).not.toMatch(/^APPROVED:/m);
    expect(settled.stdout).toMatch(new RegExp(`^NEXT: gstack-autoplan next --out ${esc(g.out)}$`, 'm'));
    expect(readRunJson(g.out).status).toBe('running');
    phaseVia(r, g.out, 'ceo');
    expect(phaseVia(r, g.out, 'eng').outside.stdout).toContain('status=gate_pending');
    expect(answer(g.out, 2, recCarrying(g.out, 'rec')).stdout).toContain('status=complete');
    expect(r.validate(g.out).status).toBe(0);
  });
  test('settle and incorporate in one revise; settling alone on an unreviewed plan edit is refused', () => {
    const g = mixed();
    fs.writeFileSync(g.plan, SMALL_PLAN.replace('cap 30 s', 'cap 30 s, behind RETRY_BACKOFF=1'));
    const early = r.ap(['revise', '--out', g.out, '--settle', 'uc2']);
    expect(early.status).toBe(3);
    expect(early.stderr).toMatch(/the plan file has edits the run has not reviewed.*\(AMENDMENT_NOT_SETTLEABLE\)$/m);
    const both = r.ap(['revise', '--out', g.out, '--plan', g.plan, '--incorporates', 'uc1', '--settle', 'uc2']);
    expect(both.status, both.stderr).toBe(0);
    expect(both.stdout).toMatch(/^AMENDMENTS: pending=none$/m);
    const run = readRunJson(g.out);
    expect(run.status).toBe('running');
    expect(run.amendments.map((a: any) => `${a.item}:${a.status}`)).toEqual(['uc1:incorporated', 'uc2:settled']);
    expect(r.ap(['next', '--out', g.out]).status).toBe(0);
  });
});

describe('partial replies resolve against persisted decisions', () => {
  test('a later `all` never overwrites an earlier override, and p1 alone with approvals unanswered keeps the gate', () => {
    const g = gated({}, {});
    const p1only = answer(g.out, 1, 'p1a', true);
    expect(JSON.parse(p1only.stdout)).toMatchObject({ status: 'gate_pending', outcome: 'gate_pending', pending: ['uc1', 'uc2'] });
    const first = answer(g.out, 1, 'uc1b', true);
    expect(JSON.parse(first.stdout)).toMatchObject({ outcome: 'gate_pending', pending: ['uc2'] });
    const second = answer(g.out, 1, 'all', true);
    expect(JSON.parse(second.stdout)).toMatchObject({ outcome: 'amend_pending', reopened: [], status: 'amend_pending' });
    expect(decisions(g.out).find(d => d.label === 'UC1')).toMatchObject({ chosen: 'b', status: 'overridden' });
  });

  test('validate rejects a complete run with a pending approval', () => {
    const g = gated({}, {});
    expect(answer(g.out, 1, recCarrying(g.out)).stdout).toContain('status=complete');
    const file = path.join(g.out, 'decisions.jsonl');
    fs.writeFileSync(file, decisions(g.out).map(d => JSON.stringify(d.label === 'UC2' ? { ...d, status: 'pending', chosen: null } : d)).join('\n') + '\n');
    r.ap(['export', '--out', g.out]);
    const res = r.validate(g.out);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/UC2.*\(ARTIFACT_GATE_UNSETTLED\)$/m);
  });
});

describe('reruns', () => {
  test('rerun prompts carry the decided items, and a rerun challenge without `changes` reopens nothing', () => {
    const g = gated({}, AGREE);
    const res = answer(g.out, 1, 'uc1a uc2b p1a');
    expect(res.stdout).not.toMatch(/^REOPENED:/m);
    expect(r.ap(['revise', '--out', g.out, '--plan', v(g.dir, SMALL_PLAN.replace('cap 30 s', 'cap 30 s, behind RETRY_BACKOFF=1')), '--incorporates', 'uc2']).stdout).toMatch(/reopened=ceo,eng/);
    phaseVia(r, g.out, 'ceo', {});
    const eng = phaseVia(r, g.out, 'eng', {
      native: [{ id: 'F9', severity: 'Low', title: 'Name the PR branch per lane', user_challenge: true }],
      outside: [{ id: 'O9', severity: 'Medium', title: 'Price the retry storage before shipping', user_challenge: true, changes: 'cost' }],
    });
    const prompt = fs.readFileSync(path.join(g.out, 'eng-native-prompt.md'), 'utf8');
    expect(prompt).toContain('DECIDED AT THE GATE');
    expect(prompt).toMatch(/uc2b .*Ship the backoff behind a flag first/);
    expect(prompt).toMatch(/uc1a /);
    expect(eng.outside.stdout).toContain('status=gate_pending');
    const items = gate(g.out).items;
    const demoted = items.find((i: any) => i.title.startsWith('Name the PR branch'));
    expect(demoted).toMatchObject({ kind: 'auto', reopens: false });
    expect(items.find((i: any) => i.title.startsWith('Price the retry storage'))).toMatchObject({ kind: 'auto' });
    expect(items.find((i: any) => i.title.startsWith('Price the retry storage')).reopens).not.toBe(false);
    const done = answer(g.out, 2, `${demoted.id}b p1a`, true);
    expect(JSON.parse(done.stdout)).toMatchObject({ outcome: 'complete', reopened: [] });
    expect(decisions(g.out).find(d => d.gate_rev === 2 && d.label === demoted.id.toUpperCase())).toMatchObject({ chosen: 'b', source: 'agent' });
  });
});

describe('open Critical and High findings reach the gate (GBRA-223 claim 3)', () => {
  const NONE = { native: [], outside: [] };
  const KILL = { native: [{ id: 'F1', severity: 'Critical', title: 'No kill switch for the resolver rollout', fix: 'add a config kill switch' }], outside: [] };
  test('each open Critical/High finding is an apply item that rec takes; a twin pair is one item; Medium stays a task', () => {
    const g = gated({
      native: [{ id: 'F1', severity: 'Critical', title: 'No kill switch for the resolver rollout', fix: 'add a config kill switch' }, { id: 'F2', severity: 'Medium', title: 'Name the flag consistently' }],
      outside: [{ id: 'O1', severity: 'High', title: 'No kill switch for the resolver rollout', fix: 'ship behind a kill switch' }],
    }, { native: [{ id: 'F3', severity: 'High', title: 'No test covers a hung resolver', file: 'test/resolver.test.ts', fix: 'add a hung-resolver test' }], outside: [] });
    const items = gate(g.out).items;
    const apply = items.filter((i: any) => i.finding);
    expect(apply.map((i: any) => i.title)).toEqual([
      expect.stringMatching(/^Critical: No kill switch for the resolver rollout \[.*-ceo-native-1 \+ .*-ceo-outside-1\]$/),
      expect.stringMatching(/^High: No test covers a hung resolver \[.*-eng-native-1\]$/),
    ]);
    for (const i of apply) expect(i).toMatchObject({ kind: 'auto', recommended: 'a', options: [{ key: 'a', changes_plan: true }, { key: 'b', changes_plan: false }] });
    expect(apply[0].options[0].text).toContain('add a config kill switch');
    expect(apply[0].options[0].text).toContain('ship behind a kill switch');
    expect(items.find((i: any) => i.id === 'p1')).toMatchObject({ recommended: 'b' });
    expect(items.some((i: any) => /Name the flag/.test(i.title))).toBe(false);
    const rec = answer(g.out, 1, 'rec');
    expect(rec.stdout.match(/^APPLY: /gm)?.length).toBe(2);
    expect(readRunJson(g.out).status).toBe('amend_pending');
  });

  test('b, as-is, or a token reply that leaves the item unanswered carries the finding into the build with no plan change', () => {
    for (const pick of [(id: string) => `${id}b p1a`, () => 'as-is', () => 'p1a']) {
      const g = gated(KILL, NONE);
      const item = gate(g.out).items.find((i: any) => i.finding);
      const done = answer(g.out, 1, pick(item.id), true);
      expect(JSON.parse(done.stdout)).toMatchObject({ outcome: 'complete', reopened: [], amendments: [] });
      expect(decisions(g.out).find(d => d.label === item.id.toUpperCase())).toMatchObject({ chosen: 'b' });
      expect(readJsonl(path.join(g.out, 'tasks.jsonl')).some(t => /No kill switch/.test(t.title))).toBe(true);
    }
  });
});
