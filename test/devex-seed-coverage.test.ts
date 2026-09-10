import { describe, expect, test } from 'bun:test';
import { DEVEX_SEEDED_GAPS, devexSeedCoverage } from './helpers/devex-seed-coverage';
import type { PlanCountTranscript, NativePlanQuestionCall } from './helpers/plan-count-transcript';
import fixture from './fixtures/devex-seed-coverage-ad-v3.json';
import declarativeFixture from './fixtures/dx-declarative-choices-am.json';
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

function declarativeTranscript(): PlanCountTranscript {
  return { status: 'ready', calls: structuredClone(declarativeFixture.calls) as NativePlanQuestionCall[], assistantMessages: [] };
}
function changeDeclaration(t: PlanCountTranscript, index: number, change: (text: string) => string) {
  const call = t.calls[index]!, question = call.questions[0]!, answer = call.answers![question.question]!;
  question.question = change(question.question);
  call.answers = { [question.question]: answer };
}

describe('DX current declarative choices', () => {
  test('captured declarative titles retain five distinct completed decisions', () => {
    const t = declarativeTranscript(), result = devexSeedCoverage(t);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(Object.values(result.decisions).flat().sort()).toEqual(t.calls.map(c => `${c.sessionId}:${c.toolUseId}`).sort());
    expect(declarativeFixture.provenance.paidOutcomesReclassified).toBe(false);
    expect(declarativeFixture.provenance.historicalOutcome).toBe('plan_ready; seeded-gap assertion failed');
  });
  test('renumbering, inline subject code, singular codes and final punctuation keep the same current decisions', () => {
    const changes = [
      (text: string) => text.replace(/^D\d+ — /, 'D27: '),
      (text: string) => text.replace(/^(.*)\n/, '$1.\n'),
      (text: string) => text.replace(/^(.*)\n/, '$1?\n'),
      (text: string) => text.replace('run_eval and run_batch take', '`run_eval` and `run_batch` take'),
    ];
    for (const change of changes) {
      const t = declarativeTranscript(); t.calls.forEach((_, i) => changeDeclaration(t, i, change));
      expect(devexSeedCoverage(t).complete).toBe(true);
    }
    const t = declarativeTranscript();
    t.calls[3]!.questions[0]!.options[0]!.description = t.calls[3]!.questions[0]!.options[0]!.description!.replace('Codes for', 'Code for');
    expect(devexSeedCoverage(t).complete).toBe(true);
  });
  test('each legitimate alternate or deferral remains a decision', () => {
    for (let index = 0; index < 5; index++) {
      const t = declarativeTranscript(), c = t.calls[index]!, q = c.questions[0]!;
      for (const option of q.options) { c.answers = { [q.question]: option.label }; expect(devexSeedCoverage(t).complete).toBe(true); }
    }
  });
  test('current titles cannot be borrowed from examples, hypotheses, literal quotes or reported history', () => {
    for (const prefix of ['Historical example: ', 'Quoted source: ', 'If approved, ', 'Suppose ', 'The old report states: ', '> ', '"', '`']) {
      for (let i = 0; i < 5; i++) {
        const t = declarativeTranscript();
        changeDeclaration(t, i, text => text.replace(/^(D\d+ — )(.*)\n/, (_, id, title) => `${id}${prefix}${title}${prefix === '"' || prefix === '`' ? prefix : ''}\n`));
        expect(devexSeedCoverage(t).complete).toBe(false);
      }
    }
  });
  test('source or conditional ownership before the explanation is not a current finding', () => {
    for (const prefix of ['Source excerpt:\n', 'If approved:\n', 'Historical example only:\n', 'The following is a quoted source excerpt.\n', 'The following is a hypothetical example.\n', '```\n']) {
      for (let i = 0; i < 5; i++) {
        const t = declarativeTranscript(); changeDeclaration(t, i, text => text.replace('\nELI10:', `\n${prefix}ELI10:`));
        expect(devexSeedCoverage(t).complete).toBe(false);
      }
    }
    for (const prefix of ['Source excerpt: ', 'If approved: ', 'Historical example: ', 'The following is a hypothetical example. ']) {
      const t = declarativeTranscript(); changeDeclaration(t, 0, text => text.replace('ELI10: ', `ELI10: ${prefix}`));
      expect(devexSeedCoverage(t).complete).toBe(false);
    }
    const metadata = declarativeTranscript(); changeDeclaration(metadata, 0, text => text.replace('Project/branch/task: ', 'Project/branch/task: copied source example; the following is not a current finding; '));
    expect(devexSeedCoverage(metadata).complete).toBe(false);
    for (let i = 0; i < 5; i++) {
      const t = declarativeTranscript(); changeDeclaration(t, i, text => text.replace('Project/branch/task: ', 'Project/branch/task: If approved, '));
      expect(devexSeedCoverage(t).complete).toBe(false);
    }
  });
  test('same-finding current withdrawals override titles and proposed remedies', () => {
    for (const tail of ['Correction: this finding is withdrawn.', 'Correction: this finding is "withdrawn".', 'This issue is already resolved.', 'The defect is historical, not current.', 'There is no current defect.', 'Correction: this explanation is a source example, not a current finding.']) {
      for (let i = 0; i < 5; i++) {
        const t = declarativeTranscript(); changeDeclaration(t, i, text => `${text}\n${tail}`);
        expect(devexSeedCoverage(t).complete).toBe(false);
      }
    }
  });
  test('attributed quoted history and conditional future outcomes do not withdraw a current decision', () => {
    for (const tail of ['> This finding is withdrawn.', 'Old note: "The issue is already resolved."', '```\nSource excerpt:\nThis finding is withdrawn.\n```', 'If the fix is accepted, this defect is resolved in the proposed API.']) {
      for (let i = 0; i < 5; i++) {
        const t = declarativeTranscript(); changeDeclaration(t, i, text => `${text}\n${tail}`);
        expect(devexSeedCoverage(t).complete).toBe(true);
      }
    }
  });
  test('affirmatively healthy titles, missing subjects and nominal headers do not assert a defect', () => {
    const titles = [
      'Quickstart points at the shipped README example and the file is available',
      'First local evaluation runs immediately without any remote CI check',
      'run_eval and run_batch take the same arguments in the same positional order',
      'Invalid API key raises AuthError with a clear cause, code and fix',
      'v2 removes Client.evaluate() with a compatibility alias and migration warning',
    ];
    for (let i = 0; i < 5; i++) {
      for (const title of [titles[i]!, 'Current issue', 'The draft describes the relevant interface']) {
        const t = declarativeTranscript(); changeDeclaration(t, i, text => text.replace(/^.*\n/, `D1 — ${title}\n`));
        expect(devexSeedCoverage(t).complete).toBe(false);
      }
    }
    const otherFunctions = declarativeTranscript(); changeDeclaration(otherFunctions, 2, text => text.replace(/^.*\n/, 'D3 — run_score and run_many take arguments in reversed positional order\n'));
    expect(devexSeedCoverage(otherFunctions).complete).toBe(false);
  });
  test('offered current remedies are required; navigation, source or withdrawn actions cannot supply them', () => {
    for (let i = 0; i < 5; i++) {
      for (const change of [
        (s: string) => `Quoted source: ${s}`,
        (s: string) => `If approved: ${s}`,
        (s: string) => `${s} Correction: this option is withdrawn.`,
      ]) {
        const t = declarativeTranscript(), c = t.calls[i]!, q = c.questions[0]!;
        q.options = q.options.map(o => ({ label: change(o.label), description: change(o.description ?? '') }));
        c.answers = { [q.question]: q.options[0]!.label };
        expect(devexSeedCoverage(t).complete).toBe(false);
      }
      const t = declarativeTranscript(), c = t.calls[i]!, q = c.questions[0]!;
      q.options = [{ label: 'Continue', description: 'Next section.' }, { label: 'Stop', description: 'End the review.' }];
      c.answers = { [q.question]: 'Continue' };
      expect(devexSeedCoverage(t).complete).toBe(false);
    }
  });
  test('the new title form preserves completion, exact answer, native identity and batching requirements', () => {
    const mutations: Array<(t: PlanCountTranscript) => void> = [
      t => { t.calls[0]!.answered = false; }, t => { t.calls[0]!.failed = true; },
      t => { t.calls[0]!.unansweredQuestionIndices = [0]; }, t => { t.calls[0]!.answeredAt = 'invalid'; },
      t => { t.calls[0]!.answers = { 'A foreign question': t.calls[0]!.questions[0]!.options[0]!.label }; },
      t => { t.calls[0]!.answers = { [t.calls[0]!.questions[0]!.question]: 'Not offered' }; },
      t => { t.calls[0]!.sessionId = 'foreign'; }, t => { t.calls[0]!.toolUseId = t.calls[1]!.toolUseId; },
      t => { t.calls[0]!.questions[0]!.multiSelect = true; },
      t => { t.calls[0]!.questions.push(structuredClone(t.calls[1]!.questions[0]!)); },
    ];
    for (const mutate of mutations) { const t = declarativeTranscript(); mutate(t); expect(devexSeedCoverage(t).complete).toBe(false); }
  });
  test('only asserted option prose supplies actions, while inline API identifiers remain usable', () => {
    for (const wrap of [(s: string) => `> ${s}`, (s: string) => `~~~\n${s}\n~~~`, (s: string) => `"${s}"`]) {
      const t = declarativeTranscript();
      t.calls[3]!.questions[0]!.options[0]!.description = wrap(t.calls[3]!.questions[0]!.options[0]!.description!);
      expect(devexSeedCoverage(t).complete).toBe(false);
    }
    const t = declarativeTranscript(), c = t.calls[4]!, q = c.questions[0]!;
    q.options[0]!.label = 'A: Keep `Client.evaluate` as an `alias` with `DeprecationWarning`';
    q.options[0]!.description = 'Preserve compatibility for existing callers.';
    q.options[1]!.description = 'Leave the API unchanged.'; q.options[1]!.label = 'B: Keep the plan';
    c.answers = { [q.question]: q.options[0]!.label };
    expect(devexSeedCoverage(t).complete).toBe(true);
  });
  test('the captured fixture selects only DX and its complete dependency array stays dense', () => {
    const file = 'test/fixtures/dx-declarative-choices-am.json';
    expect(Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.some(pattern => matchGlob(file, pattern))).map(([name]) => name)).toEqual(['plan-devex-finding-count']);
    const deps = E2E_TOUCHFILES['plan-devex-finding-count']!;
    for (let i = 0; i < deps.length; i++) { expect(Object.hasOwn(deps, i)).toBe(true); expect(typeof deps[i]).toBe('string'); }
  });
});
