import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoplanSetupDecision } from './helpers/autoplan-setup-question';
import { readPendingQuestion } from './helpers/plan-count-pending-question';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES } from './helpers/touchfiles';
import fixture from './fixtures/autoplan-routing-label-ap.json';

function call(): NativePlanQuestionCall {
  const pending = fixture.pendingState.pending;
  return { sessionId: pending.sessionId, toolUseId: pending.toolUseId,
    questions: structuredClone(pending.questions), answered: false, failed: false };
}
function panel(c: NativePlanQuestionCall): string {
  const q = c.questions[0]!;
  return `☐ ${q.header}\n${q.question}\n` + q.options.map((o, i) =>
    `${i === 0 ? '❯' : ' '} ${i + 1}. ${o.label}\n     ${o.description ?? ''}`).join('\n') +
    '\n  3. Type something.\n  4. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel';
}
const decision = (c: NativePlanQuestionCall) => autoplanSetupDecision(panel(c), new Set(), c);

describe('AP routing action labels retain exact native display identity', () => {
  test('exact owned A)/B) labels select Add on a complete counterfactual panel, once', () => {
    const c = call(), before = JSON.stringify(c), seen = new Set<string>();
    expect(c.questions[0]!.options.map(o => o.label)).toEqual([
      'A) Add routing rules to CLAUDE.md (recommended)',
      "B) No thanks, I'll invoke skills manually",
    ]);
    const result = autoplanSetupDecision(panel(c), seen, c);
    expect(result).toMatchObject({kind:'input',input:'1'});
    expect(seen.size).toBe(0);
    expect(JSON.stringify(c)).toBe(before);
    if (result.kind !== 'input') throw Error('Expected the allowed Add action');
    result.signatures.forEach(signature => seen.add(signature));
    expect(autoplanSetupDecision(panel(c), seen, c).kind).toBe('waiting');
  });

  test('the exact observed damaged display still waits; action normalization does not repair it', () => {
    expect(autoplanSetupDecision(fixture.observedScreen, new Set(), call()).kind).toBe('waiting');
  });

  test('reordered actions select the native numeric position, with corresponding letters', () => {
    const c = call(), q = c.questions[0]!;
    q.options.reverse();
    q.options = q.options.map((o, i) => ({...o, label:String.fromCharCode(65 + i) + ') ' + o.label.slice(3)}));
    expect(decision(c)).toMatchObject({kind:'input',input:'2'});
    const lower = call(); lower.questions[0]!.options.forEach(o => { o.label = o.label[0]!.toLowerCase() + o.label.slice(1); });
    expect(decision(lower)).toMatchObject({kind:'input',input:'1'});
    const plain = call(); plain.questions[0]!.options.forEach(o => { o.label = o.label.slice(3); });
    expect(decision(plain)).toMatchObject({kind:'input',input:'1'});
  });

  test('one marker cannot hide another marker, noncorresponding ordinal or unrelated action', () => {
    for (const prefix of ['B) ', 'AA) ', 'A)) ', 'A) B) ', 'A) A) ', 'A.', '1) ', 'Option A) ', 'A)Source excerpt: ', 'A) If approved, ', 'A) Do not ']) {
      const c = call(); c.questions[0]!.options[0]!.label = prefix + c.questions[0]!.options[0]!.label.slice(3);
      expect(decision(c).kind, prefix).not.toBe('input');
    }
    for (const label of ['A) Add product routes', 'A) Add routing rules to README.md', 'A) Add routing rules to CLAUDE.md and deploy', 'A) Add routing rules to CLAUDE.md (recommended) then delete the plan']) {
      const c = call(); c.questions[0]!.options[0]!.label = label;
      expect(decision(c).kind, label).not.toBe('input');
    }
    const unsupported = call(); unsupported.questions[0]!.options[1]!.label = 'B) Ask me after this review';
    expect(decision(unsupported).kind).toBe('unsupported_setup');
  });

  test('normalization never changes full label, question, status or menu binding', () => {
    const original = call(), display = panel(original);
    for (const mutate of [
      (c:NativePlanQuestionCall) => { c.questions[0]!.options.reverse(); },
      (c:NativePlanQuestionCall) => { c.questions[0]!.options[0]!.label = c.questions[0]!.options[0]!.label.slice(3); },
      (c:NativePlanQuestionCall) => { c.questions[0]!.question = 'A different routing question?'; },
      (c:NativePlanQuestionCall) => { c.questions[0]!.header = 'Foreign routing'; },
      (c:NativePlanQuestionCall) => { c.answered = true; },
      (c:NativePlanQuestionCall) => { c.failed = true; },
      (c:NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
    ]) {
      const c = call(); mutate(c);
      expect(autoplanSetupDecision(display,new Set(),c).kind).not.toBe('input');
    }
    for (const screen of [display.replace('  2. B)', '  2. A)'), display.replace('  2. B)', '  2. '),
      display.replace('Esc to cancel','Esc to'), 'Source example panel:\n' + display,
      '```text\n' + display + '\n```']) {
      expect(autoplanSetupDecision(screen,new Set(),original).kind).not.toBe('input');
    }
  });

  test('existing owned pending reader rejects foreign, stale and completed requests before action selection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'routing-label-reader-'));
    try {
      const cwd=path.join(dir,'repo'),config=path.join(dir,'config'),state=structuredClone(fixture.pendingState);
      state.cwd=cwd; state.configDir=config;
      state.pending.transcriptPath=path.join(config,'projects','owned',`${state.sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(state.pending.transcriptPath),{recursive:true});
      fs.writeFileSync(state.pending.transcriptPath,'');
      const file=path.join(dir,'state.json'); fs.writeFileSync(file,JSON.stringify(state));
      const transcript=structuredClone(fixture.nativeTranscript) as PlanCountTranscript;
      const read=(c=cwd,cf=config,t=fixture.commandLowerBound,n=transcript) => readPendingQuestion(file,c,cf,t,n);
      const owned=read(); expect(owned).toBeDefined();
      expect(autoplanSetupDecision(panel(owned!),new Set(),owned)).toMatchObject({kind:'input',input:'1'});
      expect(read(cwd+'-foreign')).toBeUndefined();
      expect(read(cwd,config+'-foreign')).toBeUndefined();
      expect(read(cwd,config,Date.parse(state.pending.timestamp)+1)).toBeUndefined();
      const foreign=structuredClone(transcript);foreign.assistantMessages[0]!.sessionId='foreign';
      expect(read(cwd,config,fixture.commandLowerBound,foreign)).toBeUndefined();
      const completed=structuredClone(transcript);completed.calls.push({...call(),answered:true});
      expect(read(cwd,config,fixture.commandLowerBound,completed)).toBeUndefined();
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });

  test('the new regression and exact public fixture are mapped without sparse owner entries', () => {
    const owner=E2E_TOUCHFILES['autoplan-chain-pty'];
    expect(owner).toContain('test/autoplan-routing-label-ap.test.ts');
    expect(owner).toContain('test/fixtures/autoplan-routing-label-ap.json');
    for(let i=0;i<owner.length;i++){expect(Object.hasOwn(owner,i)).toBe(true);expect(typeof owner[i]).toBe('string');}
  });
});
