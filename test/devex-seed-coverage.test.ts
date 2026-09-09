import { describe, expect, test } from 'bun:test';
import { DEVEX_SEEDED_GAPS, devexSeedCoverage } from './helpers/devex-seed-coverage';
import type { PlanCountTranscript, NativePlanQuestionCall } from './helpers/plan-count-transcript';
import fixture from './fixtures/devex-seed-coverage-ad-v3.json';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';

function transcript(attempt = 0): PlanCountTranscript {
  return { status:'ready', calls:structuredClone(fixture.attempts[attempt]!.calls) as NativePlanQuestionCall[], assistantMessages:[] };
}
function extra(id: string, sessionId: string): NativePlanQuestionCall {
  const question = 'A new useful DX improvement: should we provide an offline diagnostics command?';
  return {sessionId,toolUseId:id,questions:[{header:'Extra',question,multiSelect:false,options:[{label:'Add command',description:'Add the command after the beta.'},{label:'Defer',description:'Defer the command.'}]}],answered:true,failed:false,answers:{[question]:'Defer'},unansweredQuestionIndices:[],answeredAt:'2026-09-09T20:23:00Z'};
}

describe('DX seeded-gap coverage', () => {
  for (const [i, attempt] of fixture.attempts.entries()) test(`actual attempt ${attempt.attempt} has five distinct completed seed decisions`, () => {
    const result = devexSeedCoverage(transcript(i));
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(Object.keys(result.decisions)).toEqual([...DEVEX_SEEDED_GAPS]);
    expect(new Set(Object.values(result.decisions).flat()).size).toBe(5);
    // Deterministic coverage cannot change the old early-stop outcome or
    // establish that the uncompleted original review produced its final report.
    expect(attempt.historicalOutcome).toBe('ceiling_reached');
    expect(attempt.genuineDecisions).toBe(8);
  });
  test('each additional real decision remains valid and cannot replace a missing seed', () => {
    for (let i = 0; i < 5; i++) {
      const t=transcript();t.calls.push(...Array.from({length:6},(_,n)=>extra(`extra-${n}`,t.calls[0]!.sessionId)));
      expect(devexSeedCoverage(t).complete).toBe(true);
      t.calls.splice(i,1);
      expect(devexSeedCoverage(t).complete).toBe(false);
      expect(devexSeedCoverage(t).missing).toHaveLength(1);
    }
  });
  test('a valid defer or alternate repair still covers the decision', () => {
    for (let a=0;a<2;a++) for (let i=0;i<5;i++) {
      const t=transcript(a);const c=t.calls[i]!;const q=c.questions[0]!;
      for (const option of q.options) {
        c.answers = {[q.question]:option.label};
        expect(devexSeedCoverage(t).complete).toBe(true);
      }
    }
  });
  test('five repeated questions for one seed cannot satisfy the other four', () => {
    const t=transcript();t.calls=Array.from({length:5},(_,i)=>({...structuredClone(t.calls[0]!),toolUseId:`repeat-${i}`}));
    expect(devexSeedCoverage(t).complete).toBe(false);
    expect(devexSeedCoverage(t).missing).toHaveLength(4);
  });
  test('batching all issues into one native call or one omnibus question fails', () => {
    const t=transcript();const c=structuredClone(t.calls[0]!);c.questions=t.calls.flatMap(c=>c.questions);c.answers=Object.fromEntries(t.calls.flatMap(c=>Object.entries(c.answers!)));t.calls=[c];
    expect(devexSeedCoverage(t).batched).toHaveLength(1);
    expect(devexSeedCoverage(t).complete).toBe(false);
    c.questions=[{header:'All five',question:'Should we repair all five seeded defects together?',options:[{label:'Repair all',description:'Fix every defect.'},{label:'Defer all',description:'Defer every repair.'}]}];c.answers={[c.questions[0]!.question]:'Repair all'};
    expect(devexSeedCoverage(t).missing).toHaveLength(5);
  });
  test('pending, failed, malformed completion, repeated identity and foreign sessions stay closed', () => {
    const mutations: Array<(t:PlanCountTranscript)=>void> = [
      t=>{t.status='missing'},t=>{t.calls[0]!.answered=false},t=>{t.calls[0]!.failed=true},
      t=>{t.calls[0]!.answeredAt='unknown'},t=>{t.calls[0]!.answers={}},
      t=>{t.calls[0]!.answers={[t.calls[0]!.questions[0]!.question]:'Not offered'}},
      t=>{t.calls[0]!.unansweredQuestionIndices=[0]},t=>{t.calls[0]!.questions[0]!.multiSelect=true},
      t=>{t.calls[0]!.sessionId='foreign'},t=>{t.calls.push(structuredClone(t.calls[0]!))},
      t=>{t.calls[1]!.toolUseId=t.calls[0]!.toolUseId},
    ];
    for(const mutate of mutations){const t=transcript();mutate(t);expect(devexSeedCoverage(t).complete).toBe(false)}
  });
  test('a quoted defect, retrospective confirmation or only generic navigation options is not a seed decision', () => {
    for (const prefix of ['Quoted example: ','Suppose ','Have you read: ','Confirm already resolved: ']) {
      const t=transcript();const c=t.calls[0]!;const q=c.questions[0]!;const answer=c.answers![q.question]!;
      q.question=prefix+q.question;c.answers={[q.question]:answer};expect(devexSeedCoverage(t).complete).toBe(false);
    }
    const t=transcript();const c=t.calls[0]!;const q=c.questions[0]!;q.options=[{label:'Continue',description:'Next section.'},{label:'Stop',description:'End review.'}];c.answers={[q.question]:'Continue'};
    expect(devexSeedCoverage(t).complete).toBe(false);
  });
  test('direct seed questions can ask what to do without asserting the observed wording', () => {
    const titles: Record<string,string> = {
      Quickstart:'Should we ship examples/first_eval.py or point the quickstart at the demo?',
      'CI gate':'Should the first local demo bypass the CI check?',
      Signatures:'How should we make argument order consistent between run_batch and run_eval?',
      AuthError:'Should AuthError explain the invalid API key with a code, cause and fix?',
      'v1 to v2':'Should we keep a compatibility alias from Client.evaluate to Client.run during the v2 upgrade?',
    };
    const t=transcript();
    for (const c of t.calls) { const q=c.questions[0]!, answer=c.answers![q.question]!;
      q.question=titles[q.header]!;q.header='Decision';c.answers={[q.question]:answer}; }
    expect(devexSeedCoverage(t).complete).toBe(true);
    const c=t.calls[1]!,q=c.questions[0]!,answer=c.answers![q.question]!;
    q.question='The first local demo might block on a CI check. Should we bypass it?';c.answers={[q.question]:answer};
    expect(devexSeedCoverage(t).complete).toBe(true);
  });
  test('an explicit seed action can be accepted or rejected through terse Yes/No options', () => {
    const titles: Record<string,string> = {
      Quickstart:'Should we ship examples/first_eval.py for the quickstart?',
      'CI gate':'Should we bypass the CI check for the first local demo?',
      Signatures:'Should we unify argument order between run_eval and run_batch?',
      AuthError:'Should we add a code, cause and fix to AuthError for invalid API keys?',
      'v1 to v2':'Should we keep a compatibility alias from Client.evaluate to Client.run?',
    };
    for (const answer of ['Yes','No']) {
      const t=transcript();
      for (const c of t.calls) { const q=c.questions[0]!; q.question=titles[q.header]!;
        q.options=[{label:'Yes',description:'Accept the proposed action.'},{label:'No',description:'Keep the current plan.'}];c.answers={[q.question]:answer}; }
      expect(devexSeedCoverage(t).complete).toBe(true);
      for (let i=0;i<5;i++) {
        const copy=structuredClone(t), c=copy.calls[i]!, q=c.questions[0]!;
        q.question=q.question.replace('Should we ', 'Should we document how to ');c.answers={[q.question]:answer};
        expect(devexSeedCoverage(copy).complete).toBe(false);
      }
    }
  });
  test('only the native DX count eval selects the new coverage files', () => {
    for (const file of ['test/helpers/devex-seed-coverage.ts','test/devex-seed-coverage.test.ts','test/fixtures/devex-seed-coverage-ad-v3.json']) {
      expect(Object.entries(E2E_TOUCHFILES).filter(([,files])=>files.some(pattern=>matchGlob(file,pattern))).map(([name])=>name)).toEqual(['plan-devex-finding-count']);
    }
  });
});
