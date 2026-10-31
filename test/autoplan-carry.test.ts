/**
 * Carry-forward (GSTA-155, lib/autoplan-carry.ts): a later gate revision that asks nothing new is answered with the
 * owner's recorded words from the revision before it, and recorded as a carry; every other case prints why not and
 * stays at the gate. A "do it" also covers new auto items that change no scope, cost or direction. A capped,
 * unreviewed delta gets one reviewer on the delta first (CARRY_CHECK, gstack-autoplan check): High or above means no
 * carry. Runs on the simulated Capy host.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDoIt } from '../lib/autoplan-carry';
import { importAutoplan } from '../lib/approval-record';
import { renderCaptainBrief } from '../lib/captain-brief';
import { recHash, renderGate } from '../lib/gate-list';
import { loadBriefInputs } from '../lib/owner-brief';
import { SMALL_PLAN } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';

setDefaultTimeout(30_000);
const r = capyRunner();
afterAll(() => r.cleanup());
let n = 0;
const NONE = { native: [], outside: [] };
const AGREE = {
  native: [{ id: 'F1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'gate the change behind RETRY_BACKOFF=1' }],
  outside: [{ id: 'O1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'gate the change behind RETRY_BACKOFF=1' }],
};
const V2 = SMALL_PLAN.replace('cap 30 s', 'cap 30 s, behind RETRY_BACKOFF=1');
const gateOf = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
const decisions = (out: string) => readJsonl(path.join(out, 'decisions.jsonl'));
const journal = (out: string) => readJsonl(path.join(out, 'attempts.jsonl'));

/** Gate 1 with one recommended plan change (uc1b), answered with the owner's words, then revised to take it. */
function answeredAndRevised(args: string[] = [], words = 'Garry: Do it', ceo: { native?: unknown[]; outside?: unknown[] } = AGREE) {
  const dir = path.join(r.host.base, `carry${++n}`);
  const plan = writePlan(dir);
  const out = path.join(dir, 'run');
  expect(r.ap(['next', '--out', out, '--plan', plan, '--no-ui', ...args]).status).toBe(0);
  phaseVia(r, out, 'ceo', ceo);
  expect(phaseVia(r, out, 'eng', NONE).outside.stdout).toContain('status=gate_pending');
  const run = readRunJson(out).run;
  const ans = r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', recHashOf(out), '--by', 'agent:gstack-minder', '--owner-reply', words]);
  expect(ans.status, ans.stderr).toBe(0);
  expect(ans.stdout).toMatch(/^APPLY: /m);
  const v2 = path.join(dir, 'plan-v2.md');
  fs.writeFileSync(v2, V2);
  const rev = r.ap(['revise', '--out', out, '--plan', v2, '--incorporates', 'uc1']);
  expect(rev.status, rev.stderr).toBe(0);
  return { dir, out, run, v2, rev };
}
const recHashOf = (out: string) => recHash(gateOf(out));

describe('carry-forward', () => {
  test('a second gate with nothing new carries the owner\'s words: CARRIED, APPROVED, the record names its source', () => {
    const s = answeredAndRevised();
    phaseVia(r, s.out, 'ceo', NONE);
    const eng = phaseVia(r, s.out, 'eng', NONE).outside;
    expect(eng.status, eng.stderr).toBe(0);
    expect(eng.stdout).toMatch(/^CARRIED: gate_rev=2 <- gate_rev=1 words="Garry: Do it" by=agent:gstack-minder reason=no new choice; plan unchanged since the accepted changes$/m);
    expect(eng.stdout).toMatch(/^APPROVED: gate_rev=2/m);
    expect(eng.stdout).toContain('status=complete');
    const p1 = decisions(s.out).find(d => d.gate_rev === 2 && d.label === 'P1');
    expect(p1).toMatchObject({ chosen: 'a', owner_reply: 'Garry: Do it', answered_by: 'agent:gstack-autoplan', carried_gate_from: `${s.run}-p1`, carried_gate_rev: 1, carried_answered_by: 'agent:gstack-minder' });
    expect(journal(s.out).find(e => e.event === 'gate_carried')).toMatchObject({ gate_rev: 2, from_gate_rev: 1 });
    expect(journal(s.out).find(e => e.event === 'answered' && e.gate_rev === 1)).toMatchObject({ answer_class: 'plan-changes' });
    expect(fs.readFileSync(path.join(s.out, 'decisions.tsv'), 'utf8')).toContain('carried gate_rev 2 from gate_rev 1');
    expect(r.ap(['export', '--out', s.out]).status).toBe(0);
    expect(r.validate(s.out).status).toBe(0);
    const rows = importAutoplan(s.out, 'feature/x', 'Garry');
    if ('code' in rows) throw new Error(rows.message);
    const carried = rows.find(x => x.source.endsWith('gate_rev=2'))!;
    expect(carried).toMatchObject({ words: 'Garry: Do it', outcome: 'approved' });
    expect(carried.ask).toContain('gate_rev 2 carried forward from gate_rev 1');
    expect(carried.by).toBe('Garry (words from gate_rev 1, relayed by agent:gstack-minder), carried forward by gstack-autoplan');
    const loaded = loadBriefInputs(s.out);
    if ('error' in loaded) throw new Error(String(loaded.error));
    expect(renderCaptainBrief(loaded.inputs, { outDir: s.out }).text).toContain('**Nothing pending.** Carried forward from gate_rev 1: approved as reviewed under the owner\'s words “Garry: Do it”');
  });

  test('--no-carry-forward: the second gate goes to the owner', () => {
    const off = answeredAndRevised(['--no-carry-forward']);
    phaseVia(r, off.out, 'ceo', NONE);
    const o = phaseVia(r, off.out, 'eng', NONE).outside;
    expect(o.stdout).toMatch(/^CARRY: no \(carry-forward is off for this run \(--no-carry-forward\)\)$/m);
    expect(o.stdout).toMatch(/^GATE: gate_rev=2 /m);
    expect(o.stdout).toContain('status=gate_pending');
  });

  test('an edit to the plan file after the revise (an ELI5-only line) refuses the carry', () => {
    const edited = answeredAndRevised();
    fs.appendFileSync(edited.v2, '\nAn ELI5 sentence added after the revise.\n');
    phaseVia(r, edited.out, 'ceo', NONE);
    const e = phaseVia(r, edited.out, 'eng', NONE).outside;
    expect(e.stdout).toMatch(/^CARRY: no \(the plan file plan-v2\.md changed after the owner's answer or the revise that took it\)$/m);
    expect(readRunJson(edited.out).status).toBe('gate_pending');
  });

  test('a new scope challenge or an urgent finding refuses the carry', () => {
    const scope = answeredAndRevised();
    phaseVia(r, scope.out, 'ceo', NONE);
    const s2 = phaseVia(r, scope.out, 'eng', { native: [{ id: 'F9', severity: 'High', title: 'Add a dead-letter queue', user_challenge: true, changes: 'scope', fix: 'dlq' }], outside: [] }).outside;
    expect(s2.stdout).toMatch(/^CARRY: no \(new item \w+: Add a dead-letter queue/m);

    const urgent = answeredAndRevised();
    phaseVia(r, urgent.out, 'ceo', NONE);
    const u = phaseVia(r, urgent.out, 'eng', { native: [{ id: 'F8', severity: 'Medium', title: 'Tokens logged in plain text', urgent: true, suggested_owner: 'security' }], outside: [] }).outside;
    expect(u.stdout).toMatch(/^CARRY: no \(urgent finding open: Tokens logged in plain text\)$/m);
  });

  test('"do it" also covers a new packaging challenge; "rec" does not', () => {
    const PKG = { native: [{ id: 'F7', severity: 'Medium', title: 'Split the backoff into its own PR', user_challenge: true, changes: 'packaging', fix: 'own PR' }], outside: [] };
    const doIt = answeredAndRevised();
    phaseVia(r, doIt.out, 'ceo', NONE);
    const d = phaseVia(r, doIt.out, 'eng', PKG).outside;
    expect(d.stdout).toMatch(/^CARRIED: gate_rev=2 <- gate_rev=1 .*reason="do it" covers \w+; plan unchanged/m);
    expect(d.stdout).toMatch(/^CARRIED_UNDER_DO_IT: \w+ Split the backoff into its own PR .*\(the owner has not seen this item\)$/m);
    expect(decisions(doIt.out).find(x => x.gate_rev === 2 && /Split the backoff/.test(x.title))).toMatchObject({ carried_under: 'do it' });
    const loaded = loadBriefInputs(doIt.out);
    if ('error' in loaded) throw new Error(String(loaded.error));
    expect(renderCaptainBrief(loaded.inputs, { outDir: doIt.out }).text).toContain('Taken under "do it" without being shown to the owner: Split the backoff into its own PR.');
    const rec = answeredAndRevised([], 'rec');
    phaseVia(r, rec.out, 'ceo', NONE);
    expect(phaseVia(r, rec.out, 'eng', PKG).outside.stdout).toMatch(/^CARRY: no \(new item \w+: Split the backoff/m);
  });

test('an earlier answer in item tokens, or one that left an item unanswered, is not carried', () => {
    const dir = path.join(r.host.base, `carry${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui']).status).toBe(0);
    phaseVia(r, out, 'ceo', AGREE);
    phaseVia(r, out, 'eng', NONE);
    const g = gateOf(out);
    const tokens = g.items.map((i: any) => `${i.id}${i.recommended}`).join(' ');
    expect(r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', tokens, '--by', 'human']).status).toBe(0);
    const v2 = path.join(dir, 'plan-v2.md');
    fs.writeFileSync(v2, V2);
    expect(r.ap(['revise', '--out', out, '--plan', v2, '--incorporates', 'uc1']).status).toBe(0);
    phaseVia(r, out, 'ceo', NONE);
    expect(phaseVia(r, out, 'eng', NONE).outside.stdout).toMatch(/^CARRY: no \(gate_rev 1 was answered with item tokens, not rec or "do it"\)$/m);
  });

  test('an answer that left an approval item pending is not carried', () => {
    const dir = path.join(r.host.base, `carry${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui']).status).toBe(0);
    phaseVia(r, out, 'ceo', AGREE);
    phaseVia(r, out, 'eng', NONE);
    const p1 = gateOf(out).items.find((i: any) => i.id === 'p1');
    const ans = r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', `p1${p1.recommended}`, '--by', 'human']);
    expect(ans.status, ans.stderr).toBe(0);
    expect(decisions(out).some(x => x.gate_rev === 1 && x.status === 'pending')).toBe(true);
    const v2 = path.join(dir, 'plan-v2.md');
    fs.writeFileSync(v2, V2);
    expect(r.ap(['revise', '--out', out, '--plan', v2]).status).toBe(0);
    phaseVia(r, out, 'ceo', NONE);
    expect(phaseVia(r, out, 'eng', NONE).outside.stdout).toMatch(/^CARRY: no \(gate_rev 1 left \S+ unanswered\)$/m);
  });

  test('isDoIt reads the owner\'s words, not a Captain\'s', () => {
    for (const w of ['Do it', 'do it.', 'Garry: Do it', 'Garry Tan: do it!']) expect(isDoIt(w)).toBe(true);
    for (const w of ['rec', 'accept all', 'Captain: Do it', 'GStack Captain: do it', 'p3b: do it', "Captain: rec, Highs as build tasks under Garry's 'Do it'", 'Do it and also improve it']) expect(isDoIt(w)).toBe(false);
  });
});

describe('the delta check before a carry', () => {
  function capped() {
    const s = answeredAndRevised(['--max-rounds', '1']);
    expect(s.rev.stdout).toMatch(/^CAPPED: ceo used round 1 of 1/m);
    expect(s.rev.stdout).toMatch(/^CARRY_CHECK: attempt=\S+-c2 items=uc\d+,uc\d+ prompt=\S+ result=\S+ model_family=not anthropic estimate=5\.00 cap=5\.00$/m);
    expect(s.rev.stdout).toMatch(/^GATE: gate_rev=2 /m);
    const run = readRunJson(s.out);
    expect(run.status).toBe('gate_pending');
    const check = run.carry.check;
    const prompt = fs.readFileSync(check.prompt, 'utf8');
    expect(prompt).toContain('+ ');
    expect(prompt).toContain(`INPUT: carry-check ${check.delta_sha256}`);
    return { ...s, check };
  }
  const result = (file: string, sha: string, findings: unknown[]) => fs.writeFileSync(file, `INPUT: carry-check ${sha}\n\nReviewed the delta.\n\n` + '```gstack-findings\n' + findings.map(f => JSON.stringify(f)).join('\n') + '\n```\n');

  test('a clean delta check carries; the verdict is on the gate, the decisions and the trail', () => {
    const s = capped();
    result(s.check.result, s.check.delta_sha256, [{ id: 'F1', severity: 'Low', title: 'Wording' }]);
    const same = r.ap(['check', '--out', s.out, '--attempt', s.check.attempt, '--result', s.check.result, '--model', 'anthropic/claude-opus-5-5']);
    expect(same.status).toBe(3);
    expect(same.stderr).toContain('MODEL_FAMILY_CONFLICT');
    const ok = r.ap(['check', '--out', s.out, '--attempt', s.check.attempt, '--result', s.check.result, '--model', 'openai/gpt-6.1-sol']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^CARRY_CHECK: passed attempt=\S+ model=openai\/gpt-6\.1-sol findings=1 highest=Low$/m);
    expect(ok.stdout).toMatch(/^CARRIED: gate_rev=2 <- gate_rev=1 .*reason=delta check passed on uc\d+,uc\d+; plan unchanged/m);
    expect(ok.stdout).toContain('status=complete');
    expect(gateOf(s.out).carry_check).toMatchObject({ verdict: 'passed', model: 'openai/gpt-6.1-sol', max_severity: 'Low', findings: 1 });
    expect(decisions(s.out).filter(x => x.gate_rev === 2 && x.carry_check).length).toBe(2);
    expect(fs.readFileSync(path.join(s.out, 'decisions.tsv'), 'utf8')).toContain('delta check before carrying gate_rev 2');
    expect(r.ap(['export', '--out', s.out]).status).toBe(0);
    expect(r.validate(s.out).status).toBe(0);
  });

  test('a High finding, or no reviewer, leaves the gate for the owner', () => {
    const s = capped();
    result(s.check.result, s.check.delta_sha256, [{ id: 'F1', severity: 'High', title: 'The edit also drops the jitter' }]);
    const bad = r.ap(['check', '--out', s.out, '--attempt', s.check.attempt, '--result', s.check.result, '--model', 'openai/gpt-6.1-sol']);
    expect(bad.status, bad.stderr).toBe(0);
    expect(bad.stdout).toMatch(/^CARRY: no \(delta check found High: The edit also drops the jitter\)$/m);
    expect(bad.stdout).toMatch(/^GATE: gate_rev=2 /m);
    const g = gateOf(s.out);
    expect(g.carry_check).toMatchObject({ verdict: 'failed', max_severity: 'High' });
    expect(g.items.filter((i: any) => i.cap?.kind === 'delta').every((i: any) => i.flags.some((f: string) => f.includes('The edit also drops the jitter')))).toBe(true);
    const again = r.ap(['check', '--out', s.out, '--attempt', s.check.attempt, '--unavailable', 'x']);
    expect(again.status).toBe(3);
    const u = capped();
    const none = r.ap(['check', '--out', u.out, '--attempt', u.check.attempt, '--unavailable', 'no other family online']);
    expect(none.status, none.stderr).toBe(0);
    expect(none.stdout).toMatch(/^CARRY: no \(delta check unavailable: no other family online\)$/m);
    expect(JSON.parse(fs.readFileSync(path.join(u.out, 'spend.json'), 'utf8')).released.map((x: any) => x.attempt)).toContain(u.check.attempt);
  });

  // Value: protects=a delta check over --carry-check-cap or with the wrong --attempt never carries the owner's answer;
  // fails_when=the cap comparison or the attempt guard is dropped or inverted; why_new=tests above run at the default cap
  // with the right attempt only; seam=none; no_claim=real reviewer dispatch (simulated Capy host)
  test('a check over --carry-check-cap refuses the carry; a wrong --attempt is refused', () => {
    const over = answeredAndRevised(['--max-rounds', '1', '--carry-check-cap', '1']);
    expect(over.rev.stdout).toMatch(/^CARRY: no \(delta check estimate 5\.00 is over the per-gate cap 1\.00 \(--carry-check-cap\)\)$/m);
    expect(over.rev.stdout).not.toMatch(/^CARRY_CHECK:/m);
    expect(readRunJson(over.out).status).toBe('gate_pending');
    const s = capped();
    result(s.check.result, s.check.delta_sha256, []);
    const wrong = r.ap(['check', '--out', s.out, '--attempt', 'not-the-attempt', '--result', s.check.result, '--model', 'openai/gpt-6.1-sol']);
    expect(wrong.status).toBe(3);
    expect(wrong.stderr).toContain('ATTEMPT_MISMATCH');
    expect(readRunJson(s.out).status).toBe('gate_pending');
  });

  test('an owner answer at the gate voids a pending delta check and releases its reservation', () => {
    const s = capped();
    const ans = r.ap(['answer', '--out', s.out, '--gate-rev', '2', '--reply', 'p1c', '--by', 'human']);
    expect(ans.status, ans.stderr).toBe(0);
    expect(ans.stdout).toContain(`CARRY: no (delta check ${s.check.attempt} void: the owner answered gate_rev 2)`);
    result(s.check.result, s.check.delta_sha256, []);
    const late = r.ap(['check', '--out', s.out, '--attempt', s.check.attempt, '--result', s.check.result, '--model', 'openai/gpt-6.1-sol']);
    expect(late.status).toBe(3);
    expect(late.stderr).toContain('PHASE_NOT_AWAITING');
    expect(readRunJson(s.out).status).not.toBe('complete');
    expect(decisions(s.out).some(x => x.gate_rev === 2 && x.carried_gate_from)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(s.out, 'spend.json'), 'utf8')).released.map((x: any) => x.attempt)).toContain(s.check.attempt);
  });

  test('a plan edited after the check was dispatched is not carried on that check', () => {
    const s = capped();
    fs.appendFileSync(readRunJson(s.out).active_plan, '\nA line the reviewer never saw.\n');
    result(s.check.result, s.check.delta_sha256, []);
    const c = r.ap(['check', '--out', s.out, '--attempt', s.check.attempt, '--result', s.check.result, '--model', 'openai/gpt-6.1-sol']);
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout).toContain('void: the plan changed after the delta check was dispatched');
    expect(c.stdout).not.toMatch(/^CARRIED:/m);
    expect(readRunJson(s.out).status).toBe('gate_pending');
  });

  test('--same-family binds a same-family reviewer and records why', () => {
    const s = capped();
    result(s.check.result, s.check.delta_sha256, []);
    const ok = r.ap(['check', '--out', s.out, '--attempt', s.check.attempt, '--result', s.check.result, '--model', 'anthropic/claude-opus-5-5', '--same-family', 'no other family online']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(gateOf(s.out).carry_check.model).toBe('anthropic/claude-opus-5-5 (same family: no other family online)');
  });
});

describe('the review estimate', () => {
  test('the first next prints the most the review can reserve', () => {
    const dir = path.join(r.host.base, 'estimate');
    const out = path.join(dir, 'run');
    const first = r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui']);
    expect(first.stdout).toMatch(/^REVIEW_ESTIMATE: phases=ceo,eng voices=2\+2 rounds<=2 attempts<=8 per_voice=5\.00 reservations<=40\.00 \(a reservation total, not a spend ceiling/m);
    expect(r.ap(['next', '--out', out]).stdout).not.toContain('REVIEW_ESTIMATE');
  });
});

describe('gate eli5', () => {
  const SECTIONS = '\n## Before → after\n\nBefore: retries hammer. After: they back off.\n\n## Why it matters\n\nOutages.\n\n## What caused this work\n\nIncident 7.\n\n## Big decisions\n\n1. Exponential backoff.\n';
  function gated(name: string, text: string) {
    const dir = path.join(r.host.base, name);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir, text), '--no-ui']).status).toBe(0);
    phaseVia(r, out, 'ceo', NONE);
    expect(phaseVia(r, out, 'eng', NONE).outside.stdout).toContain('status=gate_pending');
    return out;
  }

  test('gate.json carries the plan\'s ELI5 and four sections, and page 1 of the render opens with them', () => {
    const out = gated('eli5', SMALL_PLAN + '\n## ELI5\n\nRetries wait longer each time.\n' + SECTIONS);
    const gate = gateOf(out);
    expect(gate.eli5).toMatchObject({ summary: 'Retries wait longer each time.', before_after: 'Before: retries hammer. After: they back off.', why: 'Outages.', cause: 'Incident 7.', decisions: '1. Exponential backoff.' });
    expect(gate.eli5.plan_file_sha256).toMatch(/^[0-9a-f]{64}$/);
    const page = renderGate(gate).split('\n');
    expect(page.slice(2, 4)).toEqual(['ELI5', 'Retries wait longer each time.']);
    expect(page.indexOf('Before → after:')).toBeGreaterThan(3);
    expect(page.indexOf('Before → after:')).toBeLessThan(page.findIndex(l => /^1\. \[/.test(l)));
    const loaded = loadBriefInputs(out);
    if ('error' in loaded) throw new Error(String(loaded.error));
    const brief = renderCaptainBrief(loaded.inputs, { outDir: out });
    expect(brief.missing).toEqual([]);
    expect(brief.text.indexOf('### ELI5')).toBeLessThan(brief.text.indexOf('### Before → after'));
  });

  test('a plan without ## ELI5: the Captain brief is not ready and names it; the plain gate render does not ask for it', () => {
    const out = gated('no-eli5', SMALL_PLAN + SECTIONS);
    const page = renderGate(gateOf(out));
    expect(page).not.toContain('CAPTAIN_BRIEF_INCOMPLETE');
    expect(page).toContain('Before → after:');
    const loaded = loadBriefInputs(out);
    if ('error' in loaded) throw new Error(String(loaded.error));
    const brief = renderCaptainBrief(loaded.inputs, { outDir: out });
    expect(brief.missing).toEqual(['ELI5']);
    expect(brief.text).toStartWith('**Not ready for approval:**');
  });

  test('a gate written before the eli5 field renders and briefs as before', () => {
    const out = gated('legacy', SMALL_PLAN + SECTIONS);
    const gate = gateOf(out);
    delete gate.eli5;
    fs.writeFileSync(path.join(out, 'gate.json'), JSON.stringify(gate, null, 2) + '\n');
    expect(renderGate(gate)).not.toContain('ELI5');
    const loaded = loadBriefInputs(out);
    if ('error' in loaded) throw new Error(String(loaded.error));
    expect(renderCaptainBrief(loaded.inputs, { outDir: out }).missing).toEqual([]);
  });
});
