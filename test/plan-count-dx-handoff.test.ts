import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasNativePlanTerminal } from './helpers/claude-pty-runner';
import { withPendingExit } from './helpers/plan-count-pending-exit';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/devex-handoff-n-call.json';
import vCaptured from './fixtures/devex-handoff-v-call.json';

describe('V closed DX task handoff', () => {
  function run(edit?: (calls: NativePlanQuestionCall[]) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-v-handoff-'));
    try {
      const report = path.join(dir, 'report.md'); fs.writeFileSync(report, vCaptured.reportContent);
      const written=vCaptured.provenance.reportMtimeMs/1000;fs.utimesSync(report,written,written);
      const calls=structuredClone(vCaptured.calls) as NativePlanQuestionCall[];edit?.(calls);
      return hasNativePlanTerminal({status:'ready',calls,assistantMessages:[],planReadyRequests:vCaptured.planReadyRequests},
        report,Date.parse('2026-09-09T08:42:53Z'),'plan_ready');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
  test('exact task navigation permits the complete report written after all issue decisions', () => {
    expect(run()).toBe(true);
    expect(run(calls=>{calls.at(-1)!.questions[0]!.options.reverse();})).toBe(true);
    expect(run(calls=>{calls.at(-2)!.answeredAt=new Date(vCaptured.provenance.reportMtimeMs+1).toISOString();})).toBe(false);
  });
  test('new obligations, incomplete decisions and non-navigation routes preserve freshness', () => {
    const mutations: Array<(c: NativePlanQuestionCall) => void> = [
      c=>{c.questions[0]!.question=c.questions[0]!.question.replace('found and resolved','found but not resolved');},
      c=>{c.questions[0]!.question=c.questions[0]!.question.replace('All decisions were made','All decisions will be made');},
      c=>{c.questions[0]!.question=c.questions[0]!.question.replace('five P1 issues','six P1 issues');},
      c=>{c.questions[0]!.question+=' Repair the missing authorization test.';},
      c=>{c.questions[0]!.question+=' Should we add another task?';},
      c=>{c.questions[0]!.options[3]!.description+=' Remove the owner check.';},
      c=>{c.questions[0]!.options[1]!.description='The tasks need another approval before implementation.';},
      c=>{c.questions[0]!.options[0]!.label='Run a new feature implementation';},
      c=>{c.questions[0]!.question=c.questions[0]!.question.replace('needs an Eng Review before shipping','may skip Eng Review');},
      c=>{c.questions[0]!.question='```\n'+c.questions[0]!.question+'\n```';},
      c=>{c.questions[0]!.header='Issue decision';},
      c=>{c.questions[0]!.multiSelect=true;},
    ];
    for(const edit of mutations)expect(run(calls=>{
      const c=calls.at(-1)!;edit(c);c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};
    })).toBe(false);
  });
  test('native answer identity and completed status are required', () => {
    expect(run(calls=>{calls.at(-1)!.failed=true;})).toBe(false);
    expect(run(calls=>{calls.at(-1)!.answered=false;})).toBe(false);
    expect(run(calls=>{delete calls.at(-1)!.unansweredQuestionIndices;})).toBe(false);
    expect(run(calls=>{const c=calls.at(-1)!;c.answers={[c.questions[0]!.question]:'Repair another issue'};})).toBe(false);
    expect(run(calls=>{calls.at(-1)!.questions.push(structuredClone(calls[1]!.questions[0]!));})).toBe(false);
  });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-completed-handoff-'));
  const report = path.join(dir, 'plan.md');
  const pending = path.join(dir, 'pending.json');
  fs.writeFileSync(report, captured.reportContent);
  fs.writeFileSync(pending, JSON.stringify(captured.pendingExit));
  const written = captured.provenance.reportMtimeMs / 1000;
  fs.utimesSync(report, written, written);
  const calls = structuredClone(captured.calls) as NativePlanQuestionCall[];
  const started = Date.parse('2026-09-09T01:06:22Z');
  const raw = { status: 'ready' as const, calls, assistantMessages: [] };
  const observed = withPendingExit(raw, pending, captured.provenance.capture.cwd,
    captured.provenance.capture.claudeConfigDir, started, captured.screen);
  return { dir, report, pending, written, started, calls, raw, observed,
    ready: () => hasNativePlanTerminal(observed, report, started, 'plan_ready'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('completed DX handoff with a result recap after its navigation question', () => {
  test('the exact native handoff is the only later answer excluded from report freshness', () => {
    const f = fixture();
    try {
      expect(f.calls).toHaveLength(7);
      expect(Date.parse(f.calls.at(-2)!.answeredAt!)).toBeLessThan(f.written * 1000);
      expect(Date.parse(f.calls.at(-1)!.answeredAt!)).toBeGreaterThan(f.written * 1000);
      expect(f.observed.planReadyRequests?.[0]?.source).toBe('pre_tool_use');
      expect(f.ready()).toBe(true);
      expect(hasNativePlanTerminal(f.raw, f.report, f.started, 'plan_ready')).toBe(false);
    } finally { f.cleanup(); }
  });

  test('finished headings and navigation labels cannot hide a new issue, TODO or unresolved obligation', () => {
    const mutations: Array<(call: NativePlanQuestionCall) => void> = [
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('is complete.', 'is complete only after fixing authentication.'); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('5 issues found and resolved', '5 issues found but not resolved'); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('5 issues found and resolved', '5 issues found and resolved (not all resolved)'); },
      call => { call.questions[0]!.question += ' This is complete only if we fix the missing auth test.'; },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('What’s next?', 'Should I add a missing test?'); },
      call => { call.questions[0]!.question += ' Should I package another example?'; },
      call => { call.questions[0]!.question += ' We should fix the missing auth test.'; },
      call => { call.questions[0]!.question += ' One issue remains unresolved.'; },
      call => { call.questions[0]!.question += ' <gstack-qid:devex-auth-fix>'; },
      call => { call.questions[0]!.question += ' <gstack-qid'; },
      call => { call.questions[0]!.header = 'TODO'; },
      call => { call.questions[0]!.options[1]!.label = 'Implement another missing example now'; },
      call => { call.questions[0]!.options[2]!.description = 'Proceed to fix the missing auth test.'; },
      call => { call.questions[0]!.options[2]!.description = 'Do you want me to fix the missing auth test?'; },
      call => { call.questions[0]!.options[0]!.description = 'An optional review before shipping.'; },
      call => { call.questions[0]!.options[2]!.description = 'The authentication issue remains unresolved.'; },
      call => { call.questions[0]!.multiSelect = true; },
      call => { call.questions.push(structuredClone(captured.calls[1]!.questions[0]!)); },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      try {
        const call = f.calls.at(-1)!;
        mutate(call);
        call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
        expect(f.ready()).toBe(false);
      } finally { f.cleanup(); }
    }
  });

  test('all real answers still need a fresh complete report and current successful native identity', () => {
    const f = fixture();
    try {
      const substantive = f.calls.at(-2)!;
      const stale = Date.parse(substantive.answeredAt!) / 1000 - 1;
      fs.utimesSync(f.report, stale, stale);
      expect(f.ready()).toBe(false);
      fs.utimesSync(f.report, f.written, f.written);
      f.observed.planReadyRequests![0]!.failed = true;
      expect(f.ready()).toBe(false);
      f.observed.planReadyRequests![0]!.failed = false;
      const last = f.calls.at(-1)!;
      last.unansweredQuestionIndices = [0];
      expect(f.ready()).toBe(false);
      last.unansweredQuestionIndices = [];
      last.answers = { [last.questions[0]!.question]: 'Add a new feature' };
      expect(f.ready()).toBe(false);
      last.answers = structuredClone(captured.calls.at(-1)!.answers);
      last.failed = true;
      expect(f.ready()).toBe(false);
      last.failed = false;
      f.observed.planReadyRequests![0]!.sessionId = 'foreign-session';
      expect(f.ready()).toBe(false);
      f.observed.planReadyRequests![0]!.sessionId = last.sessionId;
      fs.writeFileSync(f.report, '# Incomplete report\n');
      expect(f.ready()).toBe(false);
    } finally { f.cleanup(); }
  });
});

// Actual Z native calls, owned Exit hook, report bytes and original file mtime.
import zCaptured from './fixtures/devex-handoff-z-call.json';
describe('Z completed DX navigation over specified tasks', () => {
  function run(edit?: (calls: NativePlanQuestionCall[], hook: any) => void, reportTime = zCaptured.provenance.reportMtimeMs, noHook = false) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dx-z-handoff-'));
    try {
      const report=path.join(dir,'report.md'), pending=path.join(dir,'pending.json');
      fs.writeFileSync(report,zCaptured.reportContent);fs.utimesSync(report,reportTime/1000,reportTime/1000);
      const calls=structuredClone(zCaptured.calls) as NativePlanQuestionCall[],hook=structuredClone(zCaptured.pendingExit);edit?.(calls,hook);
      fs.writeFileSync(pending,JSON.stringify(hook));
      const started=Date.parse(zCaptured.provenance.startedAt),raw={status:'ready' as const,calls,assistantMessages:[]};
      const observed=noHook?raw:withPendingExit(raw,pending,zCaptured.provenance.capture.cwd,zCaptured.provenance.capture.claudeConfigDir,started,zCaptured.screen);
      return hasNativePlanTerminal(observed,report,started,'plan_ready');
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  const change=(c:NativePlanQuestionCall,from:string,to:string)=>{const q=c.questions[0]!;const answer=c.answers![q.question]!;q.question=q.question.replace(from,to);c.answers={[q.question]:answer};};
  test('exact native navigation preserves the original report after all issue answers',()=>{
    expect(zCaptured.calls).toHaveLength(9);
    expect(Date.parse(zCaptured.calls.at(-2)!.answeredAt)).toBeLessThan(zCaptured.provenance.reportMtimeMs);
    expect(Date.parse(zCaptured.calls.at(-1)!.answeredAt)).toBeGreaterThan(zCaptured.provenance.reportMtimeMs);
    expect(zCaptured.calls.at(-1)!.answers[zCaptured.calls.at(-1)!.questions[0]!.question]).toBe('Run /plan-eng-review next (Recommended)');
    expect(run()).toBe(true);expect(run(calls=>calls.at(-1)!.questions[0]!.options.reverse())).toBe(true);
    for(const index of [1,2])expect(run(calls=>{const c=calls.at(-1)!,q=c.questions[0]!;c.answers={[q.question]:q.options[index]!.label};})).toBe(true);
  });
  test('whole closed body and all descriptions cannot add unresolved product work',()=>{
    for(const [from,to] of [
      ['DX review complete.','DX review complete only after fixing errors.'],['7 tasks specified','7 tasks proposed'],['7 tasks specified','8 tasks specified'],
      ["What's next?",'Should we add another migration guide?'],['Next steps','Issue decision'],['warrant an eng review','require another product decision'],
      ['<gstack-qid:plan-devex-review-next-steps>','<gstack-qid:plan-devex-review-new-issue>'],
    ])expect(run(calls=>{const c=calls.at(-1)!;if(from==='Next steps')c.questions[0]!.header=to!;else change(c,from!,to!);})).toBe(false);
    for(const text of [' One task remains unresolved.',' Add a missing test.',' <gstack-qid:extra>'])expect(run(calls=>change(calls.at(-1)!,'<gstack-qid:plan-devex-review-next-steps>','<gstack-qid:plan-devex-review-next-steps>'+text))).toBe(false);
    for(const index of [0,1,2])expect(run(calls=>{calls.at(-1)!.questions[0]!.options[index]!.description+=' Also change authentication.';})).toBe(false);
    for(const prefix of ['> ','```text\n','For example: '])expect(run(calls=>{const c=calls.at(-1)!;change(c,c.questions[0]!.question,prefix+c.questions[0]!.question);})).toBe(false);
    expect(run(calls=>{calls.at(-1)!.questions[0]!.options[1]!.description='Start implementing a newly added feature.';})).toBe(false);
  });
  test('native completion, exact offered answer and current owned Exit remain mandatory',()=>{
    for(const edit of [
      (c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{delete (c as any).answered;},
      (c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{delete c.failed;},
      (c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{delete c.unansweredQuestionIndices;},
      (c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'Not offered'};},
      (c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},
      (c:NativePlanQuestionCall)=>{c.questions[0]!.options.push(structuredClone(c.questions[0]!.options[0]!));},
    ])expect(run(calls=>edit(calls.at(-1)!))).toBe(false);
    expect(run(undefined,undefined,true)).toBe(false);
    expect(run((_calls,h)=>{h.sessionId='foreign';})).toBe(false);
    expect(run((_calls,h)=>{h.cwd='/foreign';})).toBe(false);
    expect(run((_calls,h)=>{h.timestamp='2026-09-09T11:00:00Z';})).toBe(false);
    expect(run(calls=>{calls.splice(0,calls.length-1);})).toBe(false);
  });
  test('report freshness remains bound to every substantive answer and task numbers are not fixture ids',()=>{
    expect(run(calls=>{calls.at(-2)!.answeredAt=new Date(zCaptured.provenance.reportMtimeMs+1).toISOString();})).toBe(false);
    expect(run(undefined,Date.parse(zCaptured.calls.at(-2)!.answeredAt)-1)).toBe(false);
    expect(run(calls=>{const c=calls.at(-1)!;for(const [from,to] of [['D9','D19'],['7 tasks','8 tasks'],['2 P2','3 P2']])change(c,from!,to!);c.questions[0]!.options[1]!.description=c.questions[0]!.options[1]!.description!.replace('T1–T7','T1–T8');})).toBe(true);
  });
});
