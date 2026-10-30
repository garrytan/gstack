/**
 * The Captain brief (lib/captain-brief.ts, gstack-owner-brief render --captain)
 * and the shared heading parser (lib/markdown-sections.ts): the five-part shape,
 * every choice rec takes shown in words, gate ids only on the agent line, the
 * rec_hash binding, and the incomplete and answered states.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capyRelayLine, renderCaptainBrief } from '../lib/captain-brief';
import { parseReply, recHash, type GateList } from '../lib/gate-list';
import { findSection, headings } from '../lib/markdown-sections';
import { loadBriefInputs } from '../lib/owner-brief';
import { capyRunner, phaseVia, readRunJson, writePlan } from './helpers/autoplan-capy';
import { SMALL_PLAN } from './helpers/autoplan-run-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const FULL_PLAN = [
  '<!-- /autoplan restore point -->',
  '# Widget export fix',
  '',
  '## Before → after',
  '',
  'Before: `widget export` drops rows over 10k. After: every row is exported.',
  '',
  '## Why it matters',
  '',
  '- 40 users hit it weekly.',
  '',
  '## What caused this work',
  '',
  'Issue #12, quoted: "export is broken".',
  '',
  '## Big decisions',
  '',
  '1. Stream rows instead of buffering. Would flip if memory is not the cause.',
  '',
  '## Implementation plan',
  '',
  '1. Stream.',
  '',
  '## Review record',
  '',
].join('\n');

function run(plan: string, o: { answered?: boolean; urgent?: boolean } = {}): string {
  const dir = tmp('cb-run-');
  const items = [
    { id: 'd1', title: 'Split the exporter into its own module [run-1-eng-native-3]', kind: 'auto', recommended: 'a', options: [{ key: 'a', text: 'keep your direction' }, { key: 'b', text: 'accept the change', changes_plan: true }] },
    { id: 'd2', title: 'Cap memory at 256 MB', kind: 'auto', recommended: 'b', options: [{ key: 'a', text: 'no cap' }, { key: 'b', text: 'cap at 256 MB', changes_plan: true }] },
    { id: 'p1', title: 'Plan approval', kind: 'approval', recommended: 'b', options: [{ key: 'a', text: 'approve as-is' }, { key: 'b', text: 'approve with the recommended changes: d2b' }, { key: 'c', text: 'interrogate (ask questions; stays pending)' }, { key: 'd', text: `rerun every phase (to review an edited plan instead: gstack-autoplan revise --out ${dir} --plan <file>)` }, { key: 'e', text: 'reject' }] },
  ];
  const gate = { schema_version: 1, run: 'run-1', gate_rev: 2, rec_rev: 0, items } as GateList;
  fs.writeFileSync(path.join(dir, 'gate.json'), JSON.stringify(gate));
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), items.map(i => JSON.stringify({ schema_version: 1, run: 'run-1', id: `run-1-${i.id}`, label: i.id.toUpperCase(), title: i.title, options: i.options.map(x => x.key), recommended: i.recommended, kind: i.kind, gate_rev: 2,
    ...(o.answered ? { status: 'approved', chosen: i.recommended, answered_at: '2026-10-20T21:00:00Z', reply: 'rec', owner_reply: 'rec', answered_by: 'agent:GSTA-36', chosen_text: i.options.find(x => x.key === i.recommended)!.text } : { status: 'pending' }) })).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'findings.jsonl'), o.urgent ? JSON.stringify({ id: 'F9', severity: 'High', title: 'Token leaks in logs', urgent: true, suggested_owner: 'security' }) + '\n' : '');
  fs.writeFileSync(path.join(dir, 'plan-active.md'), plan);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run: 'run-1', status: 'gate_pending', active_plan: path.join(dir, 'plan-active.md') }));
  return dir;
}

function brief(dir: string) {
  const loaded = loadBriefInputs(dir);
  if ('error' in loaded) throw new Error(loaded.error.message);
  return { ...renderCaptainBrief(loaded.inputs, { outDir: dir }), gate: loaded.inputs.gate };
}

describe('heading parser', () => {
  test('skips fenced code, ends a section at the same or a higher level, folds arrows', () => {
    const text = '# T\n## Before -> After\nreal\n### detail\nkept\n~~~\n## Why it matters\n~~~\n## Next\nx';
    expect(headings(text).map(h => h.title)).toEqual(['T', 'Before -> After', 'detail', 'Next']);
    const s = findSection(text, ['Before → after']);
    expect(s?.body).toBe('real\n### detail\nkept\n~~~\n## Why it matters\n~~~');
    expect(findSection(text, ['Why it matters'])).toBeUndefined();
    expect(findSection('## C# notes\nbody', ['C# notes'])?.body).toBe('body');
  });
});

describe('renderCaptainBrief', () => {
  test('five parts in order, header first, every choice rec takes in words, ids only on the agent line', () => {
    const b = brief(run(FULL_PLAN));
    expect(b.missing).toEqual([]);
    const t = b.text;
    expect(t.split('\n')[0]).toStartWith('**Decision needed:** approve the plan "Widget export fix". Reply **rec**');
    const order = ['### Before → after', '### Why it matters', '### What caused this work', '### Big decisions', '### What we need from you', '- **do it:** rec at full scope', 'Reply: **rec**, or **do it**'].map(s => t.indexOf(s));
    expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]!))).toBe(true);
    expect(t).toContain('1. Split the exporter into its own module: keep the plan as written (a reviewer suggested changing it).');
    expect(t).toContain('2. Cap memory at 256 MB: cap at 256 MB (changes the plan).');
    const [ownerPart, agentPart] = t.split('\n---\n');
    for (const item of b.gate.items) expect(ownerPart).not.toMatch(new RegExp(`\\b${item.id}[a-e]?\\b`));
    expect(ownerPart).not.toContain('gate_rev');
    expect(ownerPart).not.toContain('gstack-autoplan revise');
    expect(agentPart).toContain(`rec_hash=${recHash(b.gate)}`);
    expect(agentPart).toContain('rec resolves to d1a d2b p1b');
  });

  test('a plan missing a section is not ready for approval and invites no reply', () => {
    const b = brief(run(FULL_PLAN.replace('## Why it matters', '## Motivation')));
    expect(b.missing).toEqual(['Why it matters']);
    expect(b.text).toStartWith('**Not ready for approval:** the plan "Widget export fix" is missing Why it matters.');
    expect(b.text).not.toContain('Reply: **rec**');
    expect(b.text).not.toContain('**do it:**');
    expect(b.text).toContain('_Not written for this plan yet._');
  });

  test('"do it", the advertised closing reply, parses as rec', () => {
    const gate = JSON.parse(fs.readFileSync(path.join(run(FULL_PLAN), 'gate.json'), 'utf8')) as GateList;
    const parsed = parseReply('do it', gate, gate.gate_rev);
    expect(parsed.valid).toBe(true);
    expect(parsed.mode).toBe('rec');
  });

  test('an answered gate says nothing is pending; urgent findings come first', () => {
    expect(brief(run(FULL_PLAN, { answered: true })).text).toStartWith('**Nothing pending.** Already decided on 2026-10-20: approved with the recommended plan changes (“rec”).');
    expect(brief(run(FULL_PLAN, { urgent: true })).text).toStartWith('## URGENT, outside this plan');
  });

  test('long sections are capped with a pointer to the plan', () => {
    const long = FULL_PLAN.replace('- 40 users hit it weekly.', Array.from({ length: 40 }, (_, i) => `- reason ${i}`).join('\n'));
    const t = brief(run(long)).text;
    expect(t).toContain('_+ more in the plan (plan-active.md)._');
    expect(t).not.toContain('- reason 39');
  });
});

describe('gstack-owner-brief render --captain', () => {
  const cli = (args: string[]) => {
    const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-owner-brief'), ...args], { encoding: 'utf8', timeout: 60_000 });
    return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  test('exit 0 when complete; exit 1 with CAPTAIN_BRIEF_INCOMPLETE unless --allow-incomplete', () => {
    expect(cli(['render', '--captain', '--out', run(FULL_PLAN)]).status).toBe(0);
    const dir = run(FULL_PLAN.replace('## Big decisions', '## Notes'));
    const r = cli(['render', '--captain', '--out', dir]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('(CAPTAIN_BRIEF_INCOMPLETE)');
    expect(r.out).toContain('**Not ready for approval:**');
    expect(cli(['render', '--captain', '--out', dir, '--allow-incomplete']).status).toBe(0);
    const j = JSON.parse(cli(['render', '--captain', '--out', run(FULL_PLAN), '--json']).out);
    expect(j.missing).toEqual([]);
    expect(j.rec_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  test('the Capy relay line appears only under GSTACK_CAPY=1', () => {
    expect(capyRelayLine('/r', { GSTACK_CAPY: '1' })).toStartWith('RELAY: gstack-owner-brief render --captain --out /r ');
    expect(capyRelayLine('/r', {})).toBeUndefined();
  });
});

describe('carried decisions at a cap gate (#3546)', () => {
  const r = capyRunner();
  afterAll(() => r.cleanup());
  const SECTIONS = '\n## ELI5\n\nRetries wait longer each time.\n\n## Before → after\n\nBefore: retries hammer. After: they back off.\n\n## Why it matters\n\nOutages.\n\n## What caused this work\n\nIncident 7.\n\n## Big decisions\n\n1. Exponential backoff.\n';
  const PLAN = SMALL_PLAN + SECTIONS;
  const WORDS: Record<string, string> = { 'keep your direction': 'keep the plan as written', 'accept the change': "make the reviewer's change" };

  function cappedRun(): string {
    const dir = path.join(r.host.base, 'carried');
    const plan = writePlan(dir, PLAN);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', plan, '--no-ui', '--max-rounds', '1']).status).toBe(0);
    const challenge = (title: string) => ({ severity: 'Medium', title, fix: `change: ${title}`, user_challenge: true, changes: 'scope' });
    phaseVia(r, out, 'ceo', { native: [challenge('Use a queue table'), challenge('Add metrics')], outside: [challenge('Drop jitter')] });
    phaseVia(r, out, 'eng', { native: [], outside: [] });
    const ds = JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')).items.filter((i: any) => i.id.startsWith('d'));
    expect(ds.map((i: any) => i.recommended)).toEqual(['a', 'a', 'a']);
    expect(r.ap(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', `${ds.map((i: any) => `${i.id}b`).join(' ')} p1b`]).status).toBe(0);
    const v2 = path.join(dir, 'plan-v2.md');
    fs.writeFileSync(v2, PLAN.replace('cap 30 s', 'cap 60 s, dead-letter after 8 attempts'));
    const rev = r.ap(['revise', '--out', out, '--plan', v2, '--incorporates', readRunJson(out).amendments.map((a: any) => a.decision).join(',')]);
    expect(rev.stdout).toMatch(/^REVISED: plan=[0-9a-f]{12} reopened=none capped=ceo,eng$/m);
    return out;
  }
  const cli = (bin: string, args: string[]) => spawnSync('bun', [path.join(ROOT, 'bin', bin), ...args], { encoding: 'utf8', timeout: 60_000 }).stdout ?? '';
  function renders(out: string) {
    const gate = JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')) as GateList;
    const gateText = cli('gstack-gate', ['render', path.join(out, 'gate.json'), '--all']);
    const briefText = cli('gstack-owner-brief', ['render', '--captain', '--out', out]);
    const gateRec = JSON.parse(/\`rec\` resolves to: (\{.*\})$/m.exec(gateText)![1]!).choices as Record<string, string>;
    const briefRec = Object.fromEntries(/rec resolves to ([a-z0-9 ]+);/.exec(briefText)![1]!.split(' ').map(t => [t.slice(0, -1), t.slice(-1)]));
    return { gate, gateText, briefText, gateRec, briefRec };
  }
  let out = '';
  beforeAll(() => { out = cappedRun(); });

  test('the Captain brief resolves rec to the carried choices, as gstack-gate render does, with the same choice labels', () => {
    const { gate, gateText, briefText, gateRec, briefRec } = renders(out);
    expect(gate.gate_rev).toBe(2);
    expect(gate.items.some(i => i.cap?.kind === 'delta')).toBe(true);
    const carried = gate.items.filter(i => i.carried);
    expect(carried.map(i => [i.recommended, i.carried!.chosen])).toEqual([['a', 'b'], ['a', 'b'], ['a', 'b']]);
    expect(briefRec).toEqual(gateRec);
    expect(Object.fromEntries(carried.map(i => [i.id, gateRec[i.id]]))).toEqual({ d1: 'b', d2: 'b', d3: 'b' });
    gate.items.filter(i => i.id !== 'p1').forEach((item, n) => {
      const text = item.options.find(o => o.key === gateRec[item.id])!.text;
      expect(gateText).toContain(`   ${item.id}${gateRec[item.id]}) ${text}`);
      expect(briefText).toContain(`  ${n + 1}. ${item.title.replace(/\s*\[[^\]]*\]\s*$/, '')}: ${WORDS[text] ?? text}`);
    });
    expect(briefText).toContain("Use a queue table: make the reviewer's change (your answer at gate_rev 1, carried forward).");
    expect(briefText).toContain('rec keeps the 3 you already answered and takes the recommended answer for the rest.');
    expect(briefText).toContain('Reply **rec** to keep the answers you already gave and take every other recommendation (recommended)');
  });

  test('an answer already given at this gate is what rec keeps, as gstack-autoplan answer --reply rec records it', () => {
    const copy = path.join(r.host.base, 'prior');
    fs.cpSync(out, copy, { recursive: true });
    const partial = r.ap(['answer', '--by', 'human', '--out', copy, '--gate-rev', '2', '--reply', 'd2a']);
    expect(partial.stdout).toMatch(/^GATE_PENDING: /m);
    const { briefText, briefRec } = renders(copy);
    expect(briefRec).toMatchObject({ d1: 'b', d2: 'a', d3: 'b' });
    expect(briefText).toContain('Add metrics: keep the plan as written (a reviewer suggested changing it) (your answer at this gate).');
    const answered = r.ap(['answer', '--by', 'human', '--out', copy, '--gate-rev', '2', '--reply', 'rec']);
    expect(answered.stdout).toMatch(/^APPROVED: gate_rev=2/m);
    const recorded = fs.readFileSync(path.join(copy, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(d => d.gate_rev === 2);
    expect(Object.fromEntries(recorded.map(d => [d.label.toLowerCase(), d.chosen]))).toEqual(briefRec);
  });

  test('negative control: without carried decisions (gate items and their decision rows) both resolve rec to the recommendations', () => {
    const copy = path.join(r.host.base, 'uncarried');
    fs.cpSync(out, copy, { recursive: true });
    const gate = JSON.parse(fs.readFileSync(path.join(copy, 'gate.json'), 'utf8')) as GateList;
    expect(Object.fromEntries(gate.items.map(i => [i.id, i.recommended]))).not.toEqual(renders(out).gateRec);
    for (const item of gate.items) delete item.carried;
    fs.writeFileSync(path.join(copy, 'gate.json'), JSON.stringify(gate));
    const rows = fs.readFileSync(path.join(copy, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    fs.writeFileSync(path.join(copy, 'decisions.jsonl'), rows.map(d => JSON.stringify(d.carried_from ? { ...d, status: 'pending', chosen: undefined, answered_at: undefined, reply: undefined, carried_from: undefined } : d)).join('\n') + '\n');
    const { briefText, gateRec, briefRec } = renders(copy);
    expect(briefRec).toEqual(gateRec);
    expect(gateRec).toEqual(Object.fromEntries(gate.items.map(i => [i.id, i.recommended])));
    expect(briefText).toContain('Use a queue table: keep the plan as written (a reviewer suggested changing it).');
    expect(briefText).not.toContain('carried forward');
    expect(briefText).toContain('rec takes the recommended answer for each.');
  });
});
