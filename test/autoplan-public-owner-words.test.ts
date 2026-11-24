/**
 * GST-1243 (GEVA-225, gstack 1.93.34.0): `gstack-autoplan export --public` kept the owner's own words. decisions.jsonl
 * kept every `owner_reply`, run.json kept the gate's and the carry's copy, and a bound reviewer file
 * (ceo-native.a5.bound.md) quoted an owner reply verbatim. Garry's rule: nothing a person wrote leaves without their
 * click. The fixture bundle is the GEVA shape: a gate answered in two relayed replies, revised, re-reviewed with one
 * reviewer quoting a reply on one line and the other reflowing a reply across blockquote lines, then carried. Runs on
 * the simulated Capy host; every spawn has a timeout.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exportPublic } from '../lib/autoplan-public';
import { readState } from '../lib/autoplan-state';
import { recHash } from '../lib/gate-list';
import { ROOT, SMALL_PLAN, resultOf } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';
import { parseOwnerWords, wordKey, type OwnerLine } from '../lib/autoplan-owner-text';

setDefaultTimeout(60_000);
const r = capyRunner();
afterAll(() => r.cleanup());
const ARTIFACT = path.join(ROOT, 'bin', 'gstack-artifact');
const artifact = (args: string[]) => spawnSync('bun', [ARTIFACT, ...args], { cwd: ROOT, env: r.env, encoding: 'utf8', timeout: 60_000 });
const MARK = '[owner words redacted]';
let n = 0;

const WA = 'Garry: take the flag first, I do not want a big bang rollout on the retry path.';
const WB = 'Approved with the flag. Keep the backoff cap at thirty seconds and log every retry attempt.';
const QUOTE_A = 'The owner wrote: "take the flag first, I do not want a big bang rollout on the retry path." That settles UC1.';
const REFLOW_B = "The owner's approval, as relayed:\n\n> Approved with the flag. Keep the backoff cap at thirty\n> seconds and log every retry attempt.\n\nNothing else changed since round 1.";
const CONTROL = 'No new findings. Approved with the flag, as before. Do it: keep the backoff behind the flag; the retry path, the cap and the jitter bounds read fine.';
const AGREE = {
  native: [{ id: 'F1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'gate the change behind RETRY_BACKOFF=1' }],
  outside: [{ id: 'O1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'gate the change behind RETRY_BACKOFF=1' }],
};
const V2 = SMALL_PLAN.replace('cap 30 s', 'cap 30 s, behind RETRY_BACKOFF=1');
const gateOf = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
const boundName = (out: string, phase: string, voice: 'native' | 'outside'): string => readRunJson(out).phases[phase][voice].output;
const digest = (dir: string) => Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name !== 'run.lock')
  .map(e => { const f = path.join(e.parentPath, e.name); return [path.relative(dir, f), crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]; }));
const allText = (dir: string) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8')).join('\n');
/** Whitespace, blockquote markers and JSON escapes folded away, so a reflowed or escaped quote still reads as one run of words. */
const folded = (text: string) => text.replace(/\\[nrt"]/g, ' ').replace(/[\s>]+/g, ' ').toLowerCase();

/** One review round: the fixture reviewer writes each result, `prose` replaces its recommendation line, then both bind. */
function phaseWith(out: string, phase: string, prose: { native?: string; outside?: string } = {}): void {
  const next = r.ap(['next', '--out', out]);
  expect(next.status, next.stderr).toBe(0);
  for (const voice of ['native', 'outside'] as const) {
    const rv = r.review(path.join(out, `${phase}-${voice}-prompt.md`), { FIXTURE_FINDINGS: '[]' });
    expect(rv.status, rv.stderr).toBe(0);
    const file = resultOf(out, phase, voice);
    if (prose[voice]) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Recommendation: revise because the fixture says so.\n', `${prose[voice]}\n`));
  }
  const run = readRunJson(out);
  for (const [voice, model] of [['native', 'anthropic/claude-opus-5-5'], ['outside', 'openai/gpt-6.1-sol']] as const) {
    const s = r.ap(['submit', '--out', out, '--phase', phase, '--voice', voice, '--result', resultOf(out, phase, voice), '--model', model, '--attempt', run.phases[phase][voice].attempt, '--runner', 'host-subagent']);
    expect(s.status, s.stderr).toBe(0);
  }
}

interface Bundle { v2?: string; wa?: string; wb?: string; ceo?: { native?: string; outside?: string }; eng?: { native?: string; outside?: string } }
/** The GEVA bundle: gate 1 answered in two relayed owner replies, revised, re-reviewed (quote, reflowed quote, control), gate 2 carried. */
function ownerBundle({ v2 = V2, wa = WA, wb = WB, ceo = { native: QUOTE_A, outside: REFLOW_B }, eng = { native: CONTROL } }: Bundle = {}): { out: string; dir: string } {
  const dir = path.join(r.host.base, `owner${++n}`);
  const out = path.join(dir, 'run');
  expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui', '--no-dx']).status).toBe(0);
  phaseVia(r, out, 'ceo', AGREE);
  expect(phaseVia(r, out, 'eng', { native: [], outside: [] }).outside.stdout).toContain('status=gate_pending');
  const first = r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc1b', '--by', 'agent:gstack-minder', '--owner-reply', wa]);
  expect(first.stdout, first.stderr).toContain('GATE_PENDING: p1');
  const second = r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'p1b', '--rec-hash', recHash(gateOf(out)), '--by', 'agent:gstack-minder', '--owner-reply', wb]);
  expect(second.status, second.stderr).toBe(0);
  const plan2 = path.join(dir, 'plan-v2.md');
  fs.writeFileSync(plan2, v2);
  expect(r.ap(['revise', '--out', out, '--plan', plan2, '--incorporates', 'uc1']).status).toBe(0);
  phaseWith(out, 'ceo', ceo);
  phaseWith(out, 'eng', eng);
  expect(readRunJson(out).status).toBe('complete');
  const e = r.ap(['export', '--out', out]);
  expect(e.status, e.stderr).toBe(0);
  return { out, dir };
}

/** CEO native binds a Critical finding, then a human defers CEO with `reason`; Eng runs clean to the gate. */
function deferredRun(reason: string, plan = SMALL_PLAN): { out: string; dir: string } {
  const dir = path.join(r.host.base, `owner${++n}`);
  const out = path.join(dir, 'run');
  expect(r.ap(['next', '--out', out, '--plan', writePlan(dir, plan), '--no-ui', '--no-dx']).status).toBe(0);
  expect(r.review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify([{ id: 'F1', severity: 'Critical', title: 'Retries can storm the webhook target' }]) }).status).toBe(0);
  const bind = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', resultOf(out, 'ceo', 'native'), '--model', 'anthropic/claude-opus-5-5', '--attempt', readRunJson(out).phases.ceo.native.attempt, '--runner', 'host-subagent']);
  expect(bind.status, bind.stderr).toBe(0);
  const close = r.ap(['close', '--out', out, '--phase', 'ceo', '--deferred', reason, '--by', 'human']);
  expect(close.status, close.stderr).toBe(0);
  expect(phaseVia(r, out, 'eng', { native: [], outside: [] }).outside.stdout).toContain('status=gate_pending');
  expect(r.ap(['export', '--out', out]).status).toBe(0);
  return { out, dir };
}

describe("export --public drops the owner's own words (GST-1243)", () => {
  test('owner_reply fields are dropped, quoted and reflowed replies are redacted, reviewer prose without owner words is byte-identical', () => {
    const { out, dir } = ownerBundle();
    const privateRows = readJsonl(path.join(out, 'decisions.jsonl'));
    expect(privateRows.filter(d => typeof d.owner_reply === 'string').length).toBe(3);
    expect(fs.readFileSync(path.join(out, 'ceo-native.a5.bound.md'), 'utf8')).toContain(QUOTE_A);
    const before = digest(out);
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    expect(digest(out)).toEqual(before);

    const publicRows = readJsonl(path.join(pub, 'decisions.jsonl'));
    expect(publicRows.map(d => d.id)).toEqual(privateRows.map(d => d.id));
    publicRows.forEach((row, i) => { const { owner_reply: _, ...rest } = privateRows[i]; expect(row).toEqual(rest); });
    const manifest = readRunJson(pub);
    expect(manifest.gate.owner_reply).toBeUndefined();
    expect(manifest.gate.reply).toBe('p1b');
    expect(manifest.carry.words).toBeUndefined();
    expect(manifest.carry.lines[0]).toContain(`words=${MARK} by=agent:gstack-minder`);

    const text = folded(allText(pub));
    for (const fragment of ['big bang rollout on the retry path', 'thirty seconds and log every retry attempt', folded(WA), folded(WB)]) expect(text).not.toContain(fragment);
    expect(fs.readFileSync(path.join(pub, 'ceo-native.a5.bound.md'), 'utf8')).toContain(`The owner wrote: "${MARK}." That settles UC1.`);
    expect(fs.readFileSync(path.join(pub, boundName(out, 'ceo', 'outside')), 'utf8')).toContain(`The owner's approval, as relayed:\n\n> ${MARK}.\n\nNothing else changed since round 1.`);

    const control = boundName(out, 'eng', 'native');
    expect(fs.readFileSync(path.join(out, control), 'utf8')).toContain(CONTROL);
    expect(fs.readFileSync(path.join(pub, control))).toEqual(fs.readFileSync(path.join(out, control)));
    for (const name of ['ceo-native.a1.bound.md', 'ceo-outside.a2.bound.md', 'eng-native.a3.bound.md', 'eng-outside.a4.bound.md']) expect(fs.readFileSync(path.join(pub, name))).toEqual(fs.readFileSync(path.join(out, name)));

    expect(e.stdout.split('\n').filter(l => l.startsWith('OWNER_WORDS:'))).toEqual([
      'OWNER_WORDS: decisions.jsonl dropped=3 redacted=0', 'OWNER_WORDS: ceo-native.a5.bound.md dropped=0 redacted=1',
      `OWNER_WORDS: ${boundName(out, 'ceo', 'outside')} dropped=0 redacted=1`, 'OWNER_WORDS: run.json dropped=2 redacted=1',
    ]);
    const full = artifact(['validate', '--public', pub, '--private', path.join(out, 'run.json')]);
    expect(full.status, full.stderr).toBe(0);
  });

  test('owner words inside plan.md code are never rewritten: export refuses, names file:line and writes nothing', () => {
    const fenced = V2.replace('## Review record', `The owner's answer, kept for the record:\n\n\`\`\`text\n${WA}\n\`\`\`\n\n## Review record`);
    const { out, dir } = ownerBundle({ v2: fenced });
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stdout + e.stderr).toBe(3);
    expect(e.stderr).toMatch(/plan\.md:\d+: owner words .*\(inside code, which export never rewrites: edit the plan\).*\(ARTIFACT_OWNER_WORDS\)$/m);
    expect(fs.existsSync(pub)).toBe(false);
    expect(fs.readdirSync(dir).filter(f => f.includes('.public-'))).toEqual([]);
  });

  test('owner words inside double-backtick inline code in plan.md are code too: export refuses', () => {
    const inline = V2.replace('## Review record', `The owner's answer: \`\` ${WA} \`\`\n\n## Review record`);
    const { out, dir } = ownerBundle({ v2: inline });
    const e = r.ap(['export', '--out', out, '--public', path.join(dir, 'public')]);
    expect(e.status, e.stdout + e.stderr).toBe(3);
    expect(e.stderr).toMatch(/plan\.md:\d+: owner words .*\(inside code, which export never rewrites: edit the plan\).*\(ARTIFACT_OWNER_WORDS\)$/m);
  });

  test('a reply that names a recorded root is redacted before the root is rewritten', () => {
    const next = path.join(r.host.base, `owner${n + 1}`, 'run');
    const wa = `Read ${next}/acquisition-merger-notes first.`;
    const { out, dir } = ownerBundle({ wa, ceo: { native: `Owner: ${wa}` }, eng: {} });
    expect(out).toBe(next);
    const pub = path.join(dir, 'public');
    expect(r.ap(['export', '--out', out, '--public', pub]).status).toBe(0);
    expect(allText(pub)).not.toContain('acquisition-merger-notes');
    expect(fs.readFileSync(path.join(pub, 'ceo-native.a5.bound.md'), 'utf8')).toContain(`Owner: ${MARK}`);
  });

  test('a reply that names a repo-relative path is redacted where the record holds the absolute worktree path', () => {
    const repo = path.join(r.host.base, `owner${n + 1}`);
    const wa = 'please also update run/notes-merger.md tests';
    const { out, dir } = ownerBundle({ wa, ceo: { native: `Decision: please also update ${path.join(repo, 'run', 'notes-merger.md')} tests` }, eng: {} });
    expect(dir).toBe(repo);
    fs.mkdirSync(path.join(repo, '.git'));
    const state = readState(out);
    state.plan_input = path.join(repo, 'plans', 'plan.md');
    const pub = path.join(dir, 'public');
    exportPublic(state, pub);
    expect(allText(pub)).not.toContain('notes-merger');
    expect(fs.readFileSync(path.join(pub, 'ceo-native.a5.bound.md'), 'utf8')).toContain(`Decision: ${MARK}`);
  });

  test('validate --public --private fails with file:line on owner words left in a public copy', () => {
    const { out, dir } = ownerBundle();
    const pub = path.join(dir, 'public');
    expect(r.ap(['export', '--out', out, '--public', pub]).status).toBe(0);
    const record = path.join(pub, 'review-record.md');
    const line = fs.readFileSync(record, 'utf8').split('\n').length;
    fs.appendFileSync(record, 'Owner, verbatim: keep the backoff cap at thirty\nseconds and log every retry attempt.\n');
    const full = artifact(['validate', '--public', pub, '--private', path.join(out, 'run.json')]);
    expect(full.status).toBe(1);
    expect(full.stderr).toMatch(new RegExp(`owner words .* at review-record\\.md:${line}\\).*\\(ARTIFACT_OWNER_WORDS\\)$`, 'm'));
  });

  test("a phase deferred by a human keeps its reason out of the public copy; an agent's deferral reason stays", () => {
    const dir = path.join(r.host.base, `owner${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui']).status).toBe(0);
    const human = r.ap(['close', '--out', out, '--phase', 'ceo', '--deferred', 'out of time', '--by', 'human']);
    expect(human.status, human.stderr).toBe(0);
    expect(r.ap(['next', '--out', out]).status).toBe(0);
    const agent = r.ap(['close', '--out', out, '--phase', 'eng', '--deferred', 'budget went to the CEO phase', '--by', 'agent:gstack-minder']);
    expect(agent.status, agent.stderr).toBe(0);
    expect(r.ap(['export', '--out', out]).status).toBe(0);
    expect(allText(out)).toContain('out of time');
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    const text = allText(pub);
    expect(text).not.toContain('out of time');
    expect(readRunJson(pub).phases.ceo.deferred.reason).toBe(MARK);
    expect(fs.readFileSync(path.join(pub, 'review-record.md'), 'utf8')).toContain(`(owner, by human): ${MARK};`);
    expect(fs.readFileSync(path.join(pub, 'ceo-consensus.md'), 'utf8')).toContain(`(${MARK}; by human)`);
    expect(readRunJson(pub).phases.eng.deferred.reason).toBe('budget went to the CEO phase');
    expect(text).toContain('budget went to the CEO phase');
  });

  test("a human's deferral reason leaves no rendering behind (gate.json why included), and validate catches one added later", () => {
    const { out, dir } = deferredRun('zebra quokka');
    expect(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')).toContain('closed deferred (zebra quokka) with this finding open');
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    expect(allText(pub)).not.toContain('zebra quokka');
    expect(fs.readFileSync(path.join(pub, 'gate.json'), 'utf8')).toContain(`ceo closed deferred (${MARK}) with this finding open`);
    const record = path.join(pub, 'review-record.md');
    const line = fs.readFileSync(record, 'utf8').split('\n').length;
    fs.appendFileSync(record, 'ceo closed deferred (zebra quokka) with this finding open\n');
    const full = artifact(['validate', '--public', pub, '--private', path.join(out, 'run.json')]);
    expect(full.status).toBe(1);
    expect(full.stderr).toMatch(new RegExp(`owner words .* at review-record\\.md:${line}\\).*\\(ARTIFACT_OWNER_WORDS\\)$`, 'm'));
    expect(full.stderr).not.toContain('zebra quokka');
  });

  test('a reply superseded at the same gate stays in the corpus: the journal keeps it, so a later quote of it is redacted', () => {
    const early = 'Hold off on jitter until we know how the single proxy host behaves under a storm of retries.';
    const dir = path.join(r.host.base, `owner${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui', '--no-dx']).status).toBe(0);
    phaseVia(r, out, 'ceo', AGREE);
    expect(phaseVia(r, out, 'eng', { native: [], outside: [] }).outside.stdout).toContain('status=gate_pending');
    expect(r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc1b p1c', '--by', 'agent:gstack-minder', '--owner-reply', early]).stdout).toContain('interrogate recorded');
    const rerun = r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc1a p1d', '--by', 'agent:gstack-minder', '--owner-reply', WB]);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8')).not.toContain('single proxy host');
    expect(fs.readFileSync(path.join(out, 'attempts.jsonl'), 'utf8')).toContain('single proxy host');
    phaseWith(out, 'ceo', { native: `The owner first said: "${early}"` });
    phaseWith(out, 'eng');
    if (readRunJson(out).status === 'gate_pending') expect(r.ap(['answer', '--out', out, '--gate-rev', String(readRunJson(out).gate_rev), '--reply', 'p1a', '--by', 'agent:gstack-minder', '--owner-reply', 'ok']).status).toBe(0);
    expect(r.ap(['export', '--out', out]).status).toBe(0);
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    expect(folded(allText(pub))).not.toContain('single proxy host');
    expect(fs.readFileSync(path.join(pub, boundName(out, 'ceo', 'native')), 'utf8')).toContain(`The owner first said: "${MARK}."`);
  });

  test("a deferral placement never rewrites plan.md code; an exact rendering inside code refuses", () => {
    const probe = SMALL_PLAN.replace('## Review record', '```js\nconsole.log("deferred: medical appointment");\n```\n\n## Review record');
    const kept = deferredRun('medical appointment', probe);
    const pub = path.join(kept.dir, 'public');
    const e = r.ap(['export', '--out', kept.out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    expect(fs.readFileSync(path.join(pub, 'plan.md'), 'utf8')).toContain('console.log("deferred: medical appointment");');
    const rendered = SMALL_PLAN.replace('## Review record', '```text\nceo closed deferred (medical appointment) with this finding open\n```\n\n## Review record');
    const refused = deferredRun('medical appointment', rendered);
    const pub2 = path.join(refused.dir, 'public');
    const x = r.ap(['export', '--out', refused.out, '--public', pub2]);
    expect(x.status, x.stdout + x.stderr).toBe(3);
    expect(x.stderr).toMatch(/plan\.md:\d+: owner words .*\(inside code, which export never rewrites: edit the plan\).*\(ARTIFACT_OWNER_WORDS\)$/m);
    expect(x.stderr).not.toContain('medical appointment');
    expect(fs.existsSync(pub2)).toBe(false);
  });

  test("a human's one-word deferral reason never rewrites an agent's longer reason that starts with it", () => {
    const dir = path.join(r.host.base, `owner${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui', '--no-dx']).status).toBe(0);
    expect(r.ap(['close', '--out', out, '--phase', 'ceo', '--deferred', 'budget', '--by', 'human']).status).toBe(0);
    expect(r.ap(['next', '--out', out]).status).toBe(0);
    expect(r.ap(['close', '--out', out, '--phase', 'eng', '--deferred', 'budget went to the CEO phase', '--by', 'agent:gstack-minder']).status).toBe(0);
    expect(r.ap(['export', '--out', out]).status).toBe(0);
    const pub = path.join(dir, 'public');
    expect(r.ap(['export', '--out', out, '--public', pub]).status).toBe(0);
    const manifest = readRunJson(pub);
    expect(manifest.phases.ceo.native.detail).toBe(`deferred: ${MARK}`);
    expect(manifest.phases.eng.native.detail).toBe('deferred: budget went to the CEO phase');
    expect(fs.readFileSync(path.join(pub, 'gate.json'), 'utf8')).toContain('eng closed accepted-with-findings at round 1 (budget went to the CEO phase): ');
    expect(fs.readFileSync(path.join(pub, 'eng-consensus.md'), 'utf8')).toContain('(budget went to the CEO phase; by agent:gstack-minder)');
  });

  test('words the owner only echoed stay where they were first written; the new words around them are redacted', () => {
    const PLAN_LINE = 'Persist the attempt count on the job row so a restarted worker resumes the schedule.';
    const withNew = `${PLAN_LINE.slice(0, -1)}, and cap the retries at five attempts in total.`;
    const { out, dir } = ownerBundle({ wa: 'Ship the backoff behind a flag first', wb: withNew, ceo: { native: `Relayed: "${withNew}"` }, eng: {} });
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    expect(fs.readFileSync(path.join(pub, 'plan.md'))).toEqual(fs.readFileSync(path.join(out, 'plan.md')));
    expect(fs.readFileSync(path.join(pub, 'plan.md'), 'utf8')).toContain(PLAN_LINE);
    const titles = (dir: string) => readJsonl(path.join(dir, 'decisions.jsonl')).map(d => d.title);
    expect(titles(pub)).toEqual(titles(out));
    expect(fs.readFileSync(path.join(pub, 'ceo-native.a5.bound.md'), 'utf8')).toContain(`Relayed: "${PLAN_LINE.slice(0, -1)}, ${MARK}."`);
    expect(folded(allText(pub))).not.toContain('five attempts in total');
  });

  test('a reply of 3 or more words is matched whole, however short', () => {
    const { out, dir } = ownerBundle({ wa: 'Jane Doe vetoed it', ceo: { native: 'Context: Jane Doe vetoed it, per the relay.' }, eng: {} });
    const pub = path.join(dir, 'public');
    expect(r.ap(['export', '--out', out, '--public', pub]).status).toBe(0);
    expect(fs.readFileSync(path.join(pub, 'ceo-native.a5.bound.md'), 'utf8')).toContain(`Context: ${MARK}, per the relay.`);
    expect(allText(pub)).not.toContain('Jane Doe');
  });

  test('markup and reference links around a short quote do not hide it from export or validate', () => {
    const { out, dir } = ownerBundle({ wa: 'Jane Doe vetoed it', ceo: { native: 'Context: Jane Doe<br>vetoed it, and [Jane Doe][1] vetoed it.\n\n[1]: https://x.test' }, eng: {} });
    const pub = path.join(dir, 'public');
    expect(r.ap(['export', '--out', out, '--public', pub]).status).toBe(0);
    const bound = fs.readFileSync(path.join(pub, 'ceo-native.a5.bound.md'), 'utf8');
    expect(bound).not.toContain('Jane');
    expect(bound).toContain(`Context: ${MARK}, and ${MARK}.`);
    expect(artifact(['validate', '--public', pub, '--private', path.join(out, 'run.json')]).status).toBe(0);
  });

  test('new words a reply adds to an echoed plan line are redacted when quoted alone', () => {
    const PLAN_LINE = 'Persist the attempt count on the job row so a restarted worker resumes the schedule.';
    const { out, dir } = ownerBundle({ wb: `${PLAN_LINE.slice(0, -1)}, and page Jane Doe on call.`, ceo: { native: 'Ops note: and page Jane Doe on call.' }, eng: {} });
    const pub = path.join(dir, 'public');
    expect(r.ap(['export', '--out', out, '--public', pub]).status).toBe(0);
    expect(fs.readFileSync(path.join(pub, 'ceo-native.a5.bound.md'), 'utf8')).toContain(`Ops note: ${MARK}.`);
    expect(fs.readFileSync(path.join(pub, 'plan.md'))).toEqual(fs.readFileSync(path.join(out, 'plan.md')));
  });
});

describe('a first-version export keeps no fragment of any owner quote (GST-3608)', () => {
  const QUOTES = [
    'blorptastic zanquiver mellowfrond grumbletide',
    'zoëlqvist brûxelkorp façadrinth naïvequor',
    '毎朝の予定をスヌーピー通知で教えてください',
    '🚀 launchpadzz 🎉 fizzwickery 🌮 tacoloopz',
  ];
  const plan = [
    '# Morning helper (synthetic first version)', '', '## Implementation plan', '',
    'Add a morning summary job in lib/morning.ts that reads the calendar and sends one notification.', '',
    "### Owner's words", '',
    `- The owner, 2026-11-20 08:00Z: "${QUOTES[0]}" → does it`,
    `- The owner, 2026-11-20 08:01Z: "${QUOTES[1]}" → choice; size: one day`,
    `- The owner, 2026-11-20 08:02Z: "${QUOTES[2]}" → choice; size: two days; leave out: needs a second permission`,
    `- The owner, 2026-11-20 08:03Z: "${QUOTES[3]}" → ruled out 2026-11-20: "${QUOTES[3]} never"`, '',
    '### Day one', '', '| action | frequency | source | feature | route | first build | check |', '|---|---|---|---|---|---|---|',
    '| reads the morning summary | daily | owner words 1 | Summary | notification | build 1 | the summary lists today |', '',
    "### What it won't do yet", '', '- No weekly digest', '', '## Review record', ''].join('\n');
  const fragments = (q: string) => [...new Set([...q.split(/\s+/), ...wordKey(q).trim().split(' ')].filter(w => [...w].length >= 3))];

  test('accented, CJK and emoji quotes leave no 3+ character fragment, raw or normalized, anywhere in the public bytes', () => {
    const dir = path.join(r.host.base, `owner${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir, plan), '--no-ui', '--no-dx', '--first-version']).status).toBe(0);
    const narrowing = [{ id: 'F1', severity: 'Medium', title: 'The summary does less than the owner asked', changes: 'scope', narrows_quote: 2 }];
    phaseVia(r, out, 'ceo', { native: narrowing, outside: [] });
    expect(phaseVia(r, out, 'eng', { native: [], outside: [] }).outside.stdout).toContain('status=gate_pending');
    expect(gateOf(out).items.filter((i: { item_class?: string }) => i.item_class === 'owner_choice').length).toBeGreaterThan(0);
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    const bytes = allText(pub);
    const leaks = QUOTES.flatMap(q => fragments(q).filter(w => bytes.includes(w)));
    expect(leaks).toEqual([]);
  });
});

describe('every attribution, line and quote shape reads as the merge base read it, and export keeps none of it (GST-3608)', () => {
  /** The merge base's whole Owner's words rule (0d6cc1be): the first opening quote mark to the last closing one, who before it. */
  const mergeBase = (bullet: string) => {
    const m = /[“"](.+)[”"]/.exec(bullet);
    return m && m[1]!.trim() ? { who: bullet.slice(0, m.index).replace(/[\s:,-]+$/, '').trim() || 'unattributed', text: m[1]!.trim() } : undefined;
  };
  const ATTRIBUTIONS: Array<[string, string]> = [
    ['plain', 'Garry, 2026-11-23 09:00Z'],
    ['an ascii arrow', 'Garry (Slack DM -> relayed), 2026-11-23'],
    ['an arrow', 'Garry (Slack DM → relayed), 2026-11-23'],
    ['a colon', 'Garry (re: importer), 2026-11-23'],
    ['straight quote marks', 'Garry ("G"), 2026-11-23'],
    ['curly quote marks', 'Garry (“G”), 2026-11-23'],
    ['an em dash', 'Garry — via Slack, 2026-11-23'],
    ['quote marks and an arrow', 'Garry ("G" -> relayed), 2026-11-23'],
  ];
  const TEXTS: Array<[string, (u: string) => string]> = [
    ['plain', u => `blorptastic zanquiver ${u}`],
    ['nested straight quotes', u => `snarfle "grumbletide" vexwort ${u}`],
    ['nested curly quotes', u => `wibbleton “quorkle” ${u}`],
    ['an arrow between nested quotes', u => `frobnitz "plinky" -> "zorbly" ${u}`],
    ['an em dash', u => `drevnik—slorpine ${u}`],
    ['CJK', u => `毎朝の予定をスヌーピー通知で ${u}`],
    ['accented', u => `zoëlqvist brûxelkorp ${u}`],
    ['emoji', u => `🚀 launchpadzz 🎉 fizzwickery ${u}`],
  ];
  const LINES: Array<[string, (u: string) => string, (u: string) => OwnerLine | undefined]> = [
    ['no line', () => '', () => undefined],
    ['does it', () => ' → does it', () => ({ kind: 'does' })],
    ['does it after an ascii arrow', () => ' -> does it', () => ({ kind: 'does' })],
    ['a choice with a size', () => ' -> choice; size: one day', () => ({ kind: 'choice', size: 'one day' })],
    ['a choice left out', () => ' → choice; size: two days; leave out: needs a second permission', () => ({ kind: 'choice', size: 'two days', leave_out: 'needs a second permission' })],
    ['a leftover ruled-out line', u => ` → ruled out 2026-11-20: "skrimblor dorvelin ${u}"`, () => undefined],
    ['a leftover ruled-out line with nested quotes and an arrow', u => ` → ruled out 2026-11-20: "grobble "nevermore" -> ${u}"`, () => undefined],
  ];
  const tag = (prefix: string, i: number) => `${prefix}${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}vel`;
  /** Every attribution with every text, each line shape rotating through both, so every pair of shapes meets. */
  const ROWS = ATTRIBUTIONS.flatMap(([attrName, attr], a) => TEXTS.map(([textName, text], t) => {
    const i = a * TEXTS.length + t;
    const [lineName, line, parsed] = LINES[(a + t) % LINES.length]!;
    const words = text(tag('qx', i)), ruling = tag('rz', i);
    const bare = `- ${attr}: "${words}"`;
    return { name: `${attrName} / ${textName} / ${lineName}`, bullet: bare + line(ruling), bare, words, line: parsed(ruling), ruling: line(ruling).includes('ruled out') ? line(ruling).replace(/^ → ruled out [\d-]+: "|"$/g, '') : undefined };
  }));
  const section = (bullets: string[]) => ["### Owner's words", '', ...bullets, '', '## Review record', ''].join('\n');

  test.each(ROWS.map(r => [r.name, r] as const))('%s', (_, row) => {
    const base = mergeBase((row.line ? row.bare : row.bullet).replace(/^- /, ''));
    expect(base).toBeDefined();
    const w = parseOwnerWords(section([row.bullet]));
    expect(w.status, w.reason).toBe('ok');
    expect(w.quotes).toEqual([{ n: 1, who: base!.who, text: base!.text, ...(row.line ? { line: row.line } : {}) }]);
  });

  test('an arrow in the attribution keeps the quote, and a line that is none of the three is still named after it', () => {
    const slack = parseOwnerWords(section(['- Garry (Slack DM -> relayed), 2026-11-23: "ship the importer tonight"']));
    expect(slack).toEqual({ status: 'ok', quotes: [{ n: 1, who: 'Garry (Slack DM -> relayed), 2026-11-23', text: 'ship the importer tonight' }] });
    const bad = parseOwnerWords(section(['- Garry (Slack DM -> relayed), 2026-11-23: "ship the importer tonight" → maybe later']));
    expect(bad.status).toBe('malformed');
    expect(bad.reason).toBe('bullet 1 has a line that is not does it or choice');
    expect(bad.quotes.map(q => q.text)).toEqual(['ship the importer tonight']);
  });

  test('a first-version export of every row leaves no 3+ character fragment of any quote or ruling in the public bytes', () => {
    const plan = [
      '# Morning helper (synthetic first version)', '', '## Implementation plan', '',
      'Add a morning summary job in lib/morning.ts that reads the calendar and sends one notification.', '',
      "### Owner's words", '', ...ROWS.map(r => r.bullet), '',
      '### Day one', '', '| action | frequency | source | feature | route | first build | check |', '|---|---|---|---|---|---|---|',
      '| reads the morning summary | daily | owner words 1 | Summary | notification | build 1 | the summary lists today |', '',
      "### What it won't do yet", '', '- No weekly digest', '', '## Review record', ''].join('\n');
    expect(parseOwnerWords(plan).quotes).toHaveLength(ROWS.length);
    const dir = path.join(r.host.base, `owner${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir, plan), '--no-ui', '--no-dx', '--first-version']).status).toBe(0);
    phaseVia(r, out, 'ceo', { native: [{ id: 'F1', severity: 'Medium', title: 'The summary does less than the owner asked', changes: 'scope', narrows_quote: 2 }], outside: [] });
    expect(phaseVia(r, out, 'eng', { native: [], outside: [] }).outside.stdout).toContain('status=gate_pending');
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    const bytes = allText(pub);
    const fragments = (q: string) => [...new Set([...q.split(/\s+/), ...wordKey(q).trim().split(' ')].filter(w => [...w].length >= 3))];
    const leaks = ROWS.flatMap(row => [row.words, ...(row.ruling ? [row.ruling] : [])].flatMap(q => fragments(q).filter(w => bytes.includes(w)).map(w => `${row.name}: ${w}`)));
    expect(leaks).toEqual([]);
  });
});

describe("short owner quotes and leave-out reasons stay out of a first-version export (GST-3646)", () => {
  const tag = (prefix: string, i: number) => `${prefix}${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}vel`;
  const QUOTES: Array<[string, (u: string) => string, string?]> = [
    ['one word', u => u],
    ['two words', u => `quimbly ${u}`],
    ['an emoji and a word', u => `🚀 ${u}`],
    ['CJK', u => `毎朝ベル${u}`],
    ['two words padded inside the quote marks', u => `skelvy ${u}`, ' '],
    ['two words padded with a no-break space entity', u => `drimble ${u}`, '&nbsp;'],
    ['two words padded with a zero-width space', u => `frawny ${u}`, '\u200b'],
  ];
  const LINES: Array<[string, (r: string) => string, boolean]> = [
    ['does it', () => ' → does it', false],
    ['a choice with a size', () => ' → choice; size: one day', false],
    ['a one-word reason to leave it out', r => ` → choice; size: two days; leave out: ${r}`, true],
    ['a two-word reason to leave it out', r => ` → choice; leave out: blint ${r}`, true],
    ['a longer reason to leave it out', r => ` -> choice; size: one day; leave out: ${r} plinkwort drazzle fippery`, true],
    ['a reason after extra spaces', r => ` → choice; leave out :  ${r}`, true],
    ['a reason after a capitalized key', r => ` → choice; Leave Out: ${r}`, true],
    ['does it in mixed case', () => ' → Does It', false],
    ['a choice and size in mixed case', () => ' → Choice; Size: one day', false],
    ['a recommended reason in mixed case', r => ` → CHOICE; size: two days; Recommend Leave Out: ${r}`, true],
  ];
  const ROWS = QUOTES.flatMap(([qName, quote, pad = ''], a) => LINES.map(([lName, line, hasReason], b) => {
    const i = a * LINES.length + b, reason = tag('rz', i);
    const words = quote(tag('qx', i));
    return { name: `${qName} / ${lName}`, bullet: `- The owner, 2026-11-20 08:${String(i).padStart(2, '0')}Z: "${pad}${words}${pad}"${line(reason)}`, words, reason: hasReason ? line(reason).replace(/^.*leave out\s*:\s*/i, '') : undefined };
  }));
  const plan = [
    '# Morning helper (synthetic first version)', '', '## Implementation plan', '',
    'Add a morning summary job in lib/morning.ts that reads the calendar and sends one notification.', '',
    "### Owner's words", '', ...ROWS.map(row => row.bullet), '',
    '### Day one', '', '| action | frequency | source | feature | route | first build | check |', '|---|---|---|---|---|---|---|',
    '| reads the morning summary | daily | owner words 1 | Summary | notification | build 1 | the summary lists today |', '',
    "### What it won't do yet", '', '- No weekly digest', '', '## Review record', ''].join('\n');
  const fragments = (q: string) => [...new Set([...q.split(/\s+/), ...wordKey(q).trim().split(' ')].filter(w => [...w].length >= 3))];
  const exported = () => {
    const dir = path.join(r.host.base, `owner${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir, plan), '--no-ui', '--no-dx', '--first-version']).status).toBe(0);
    phaseVia(r, out, 'ceo', { native: [{ id: 'F1', severity: 'Medium', title: 'The summary does less than the owner asked', changes: 'scope', narrows_quote: 1 }], outside: [] });
    expect(phaseVia(r, out, 'eng', { native: [], outside: [] }).outside.stdout).toContain('status=gate_pending');
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    return { out, pub };
  };

  test('every short quote and every reason to leave one out reaches the gate, and none leaves a 3+ character fragment in the public bytes', () => {
    expect(parseOwnerWords(plan).quotes).toHaveLength(ROWS.length);
    const { out, pub } = exported();
    const gate = JSON.stringify(gateOf(out).items);
    expect(ROWS.filter(row => !gate.includes(row.words) && !/does it/i.test(row.bullet)).map(row => row.name)).toEqual([]);
    expect(ROWS.filter(row => row.reason && !gate.includes(row.reason)).map(row => row.name)).toEqual([]);
    const bytes = allText(pub);
    const leaks = ROWS.flatMap(row => [row.words, ...(row.reason ? [row.reason] : [])].flatMap(q => fragments(q).filter(w => bytes.includes(w)).map(w => `${row.name}: ${w}`)));
    expect(leaks).toEqual([]);
  });

  test('validate --public --private catches a short quote or a leave-out reason written back in quote marks, and passes the plain words', () => {
    const { out, pub } = exported();
    const record = path.join(pub, 'review-record.md');
    const before = fs.readFileSync(record, 'utf8');
    const validate = () => artifact(['validate', '--public', pub, '--private', path.join(out, 'run.json')]);
    expect(validate().status).toBe(0);
    const ownerWordsAt = (added: string) => { fs.writeFileSync(record, before + added); return validate().stderr.includes('ARTIFACT_OWNER_WORDS'); };
    expect(ownerWordsAt(`The owner said “${ROWS[0]!.words}”.\n`)).toBe(true);
    expect(ownerWordsAt(`The owner said " ${ROWS[1]!.words} ".\n`)).toBe(true);
    expect(ownerWordsAt(`The owner said "&nbsp;${ROWS[1]!.words}&nbsp;".\n`)).toBe(true);
    expect(ownerWordsAt(`The owner said "\u200b${ROWS[1]!.words}\u200b".\n`)).toBe(true);
    expect(ownerWordsAt(`The plan's reason: leave out: ${ROWS[2]!.reason}\n`)).toBe(true);
    expect(ownerWordsAt(`A plain mention of ${ROWS[0]!.words} and ${ROWS[2]!.reason}.\n`)).toBe(false);
    fs.writeFileSync(record, before);
    expect(validate().status).toBe(0);
  });
});
