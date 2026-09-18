import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bindAutoDecisionState } from './helpers/auto-decision-state';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import capture from './fixtures/auto-decide-state-cab3.json';

const clone = () => structuredClone(capture) as any;
const qid = 'plan-ceo-review-mode';
function state(f: any) {
  const use = f.tools.find((e: any) => e.input?.command?.includes('gstack-question-log'));
  // Synthetic file witness, built from the actual literal request. The original
  // run did not retain this file, and is still a failed paid attempt.
  const record = JSON.parse(/gstack-question-log '(\{[^\n]*\})'/.exec(use.input.command)![1]!);
  record.source = 'agent';
  record.ts = f.tools.find((e: any) => e.kind === 'result' && e.toolUseId === use.toolUseId).timestamp;
  return { questionId: qid, preference: 'never-ask' as const, records: [record] };
}
const decide = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);
const mode = (f: any) => f.transcript.assistantMessages.find((m: any) => m.text.startsWith('**Mode:'));

test('original captured retry cannot prove a masked log succeeded', () => {
  expect(decide(clone())).toBeNull();
});
test('actual retry declaration plus a completed owned append proves the chosen mode', () => {
  const f = clone(); f.options.stateEvidence = state(f);
  const result = decide(f);
  expect(result?.option).toBe('HOLD SCOPE');
  expect(result?.stateRecord).toEqual(f.options.stateEvidence.records[0]);
  expect(result?.questionLogToolUseId).toBeUndefined();
});

for (const [name, mutate] of Object.entries({
  'foreign record session': (f: any) => { f.options.stateEvidence.records[0].session_id = 'foreign'; },
  'wrong question': (f: any) => { f.options.stateEvidence.questionId = 'wrong'; },
  'wrong skill': (f: any) => { f.options.stateEvidence.records[0].skill = 'plan-eng-review'; },
  'nonautomatic record': (f: any) => { f.options.stateEvidence.records[0].auto_decided = false; },
  'string flag': (f: any) => { f.options.stateEvidence.records[0].auto_decided = 'true'; },
  'wrong source': (f: any) => { f.options.stateEvidence.records[0].source = 'hook'; },
  'different preference': (f: any) => { f.options.stateEvidence.preference = 'always-ask'; },
  'missing append': (f: any) => { f.options.stateEvidence.records = []; },
  'duplicate append': (f: any) => { f.options.stateEvidence.records.push({ ...f.options.stateEvidence.records[0] }); },
  'contradictory recommendation': (f: any) => { f.options.stateEvidence.records[0].recommended = 'SCOPE EXPANSION'; },
  'empty summary': (f: any) => { f.options.stateEvidence.records[0].question_summary = ''; },
  'old record': (f: any) => { f.options.stateEvidence.records[0].ts = new Date(f.options.commandStartedAt - 1).toISOString(); },
  'future record': (f: any) => { f.options.stateEvidence.records[0].ts = new Date(f.options.now + 1).toISOString(); },
  'record after declaration': (f: any) => { f.options.stateEvidence.records[0].ts = new Date(Date.parse(mode(f).timestamp) + 1).toISOString(); },
  'invalid timestamp': (f: any) => { f.options.stateEvidence.records[0].ts = 'invalid'; },
  'actual native question': (f: any) => { f.transcript.calls.push({ sessionId: f.options.sessionId }); },
  'actual prose question': (f: any) => { f.options.proseQuestionObserved = true; },
  'failed preamble': (f: any) => { f.tools.find((e: any) => e.kind === 'result' && e.content?.includes('SKILL_START_PROTO')).isError = true; },
  'quoted declaration': (f: any) => { mode(f).text = '> Mode: HOLD SCOPE (saved preference).'; },
  'conditional declaration': (f: any) => { mode(f).text = 'Mode: HOLD SCOPE (if approved).'; },
  'later withdrawal': (f: any) => { mode(f).text += '\n\nCorrection: I withdraw this decision.'; },
  'later different mode': (f: any) => { mode(f).text += '\n\nMode: SCOPE EXPANSION (saved preference).'; },
})) test(`owned log witness rejects ${name}`, () => {
  const f = clone(); f.options.stateEvidence = state(f); mutate(f); expect(decide(f)).toBeNull();
});

function withState(check: (x: { root: string; project: string; pref: string; log: string; bind: () => ReturnType<typeof bindAutoDecisionState> }) => void) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-state-')));
  const project = path.join(root, 'projects', 'fixture'); fs.mkdirSync(project, { recursive: true });
  const pref = path.join(project, 'question-preferences.json'), log = path.join(project, 'question-log.jsonl');
  fs.writeFileSync(pref, JSON.stringify({ [qid]: 'never-ask' }));
  const bind = () => bindAutoDecisionState({ stateRoot: root, projectSlug: 'fixture' }, { GSTACK_STATE_ROOT: root }, 'plan-ceo-review');
  try { check({ root, project, pref, log, bind }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('state witness binds before launch and observes only completed owned file contents', () => withState(({ log, bind }) => {
  const read = bind(); expect(read()).toBeUndefined();
  const record = state(clone()).records[0]; fs.writeFileSync(log, JSON.stringify(record) + '\n');
  expect(read()?.records).toEqual([record]);
}));
for (const scenario of ['existing-log', 'preference-change', 'malformed-log', 'log-symlink', 'preference-symlink', 'wrong-root', 'path-escape'])
  test(`state binding rejects ${scenario}`, () => withState(({ root, pref, log, bind }) => {
    if (scenario === 'wrong-root' || scenario === 'path-escape') {
      expect(() => bindAutoDecisionState({ stateRoot: root, projectSlug: scenario === 'path-escape' ? '../fixture' : 'fixture' },
        { GSTACK_STATE_ROOT: scenario === 'wrong-root' ? root + '-other' : root }, 'plan-ceo-review')).toThrow(); return;
    }
    if (scenario === 'existing-log') { fs.writeFileSync(log, '{}\n'); expect(bind).toThrow('fresh attempt'); return; }
    const read = bind();
    if (scenario === 'preference-change') fs.writeFileSync(pref, JSON.stringify({ [qid]: 'always-ask' }));
    if (scenario === 'malformed-log') fs.writeFileSync(log, '{');
    if (scenario === 'log-symlink') fs.symlinkSync(pref, log);
    if (scenario === 'preference-symlink') { fs.renameSync(pref, pref + '.real'); fs.symlinkSync(pref + '.real', pref); }
    expect(read()).toBeUndefined();
  }));
