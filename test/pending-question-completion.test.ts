import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPendingQuestionRecorder, recordPendingQuestion, readPendingQuestion,
  pendingQuestionRecorderStatus } from './helpers/plan-count-pending-question';
import { readPlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import captured from './fixtures/pending-question-completion-ad.json';

// Public question/result contents are retained; hook envelopes, paths and live
// timestamps below are synthetic. The raw historical hook stdin is unknown.
function fixture(index = 0) {
  const actual = captured.cases[index]!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-completion-' spaces-"));
  const cwd = path.join(root, 'repo'), config = path.join(root, 'config');
  const project = path.join(config, 'projects', 'owned');
  fs.mkdirSync(cwd, {recursive:true}); fs.mkdirSync(project, {recursive:true});
  const session = actual.sessionId, transcriptPath = path.join(project, `${session}.jsonl`);
  const startedAt = Date.now() - 1;
  fs.writeFileSync(transcriptPath, JSON.stringify({cwd, sessionId:session, isSidechain:false,
    timestamp:new Date().toISOString(), message:{role:'assistant', content:[{type:'text',text:'Synthetic recorder readiness.'}]}})+'\n');
  const recorder = createPendingQuestionRecorder(cwd, config);
  const event = (kind = 'PreToolUse', id = actual.toolUseId): any => ({hook_event_name:kind,
    tool_name:'AskUserQuestion', session_id:session, tool_use_id:id, cwd, transcript_path:transcriptPath,
    tool_input:structuredClone(kind === 'PreToolUse' ? {questions:actual.questions} : actual.completionInput)});
  const write = (value: unknown) => recordPendingQuestion(JSON.stringify(value),recorder.file,cwd,config);
  const read = () => readPendingQuestion(recorder.file,cwd,config,startedAt,readPlanCountTranscript(config,cwd));
  const status = () => pendingQuestionRecorderStatus(recorder.file,cwd,config);
  const dispose = () => {recorder.dispose();fs.rmSync(root,{recursive:true,force:true});};
  return {actual,root,cwd,config,project,session,transcriptPath,recorder,event,write,read,status,dispose};
}

describe('scoped pending question completion payloads', () => {
  for (let index=0;index<captured.cases.length;index++) {
    test(`code-derived completion input ${captured.cases[index]!.mode} clears pending and permits the next request`, () => {
      const f=fixture(index);
      try {
        expect(captured.provenance.rawHookEnvelopeCaptured).toBe(false);
        expect(f.actual.completionInput.questions).toEqual(f.actual.questions);
        expect(JSON.stringify(f.actual.completionInput.questions)).not.toBe(JSON.stringify(f.actual.questions));
        f.write(f.event()); expect(f.read()?.toolUseId).toBe(f.actual.toolUseId);
        f.write(f.event('PostToolUse'));
        expect(f.status()).toEqual({status:'idle'});
        expect(f.read()).toBeUndefined();
        f.write(f.event('PreToolUse','toolu_next_owned'));
        expect(f.read()).toMatchObject({toolUseId:'toolu_next_owned',answered:false,failed:false,source:'pre_tool_use'});
        expect(f.read()?.answers).toBeUndefined();
        expect(f.read()?.answeredAt).toBeUndefined();
      } finally {f.dispose();}
    });
  }

  test.each(['PostToolUse','PostToolUseFailure'])('%s accepts optional completion maps and records no answers', kind => {
    for (const fields of ['questions only','empty maps','notes and preview']) {
      const f=fixture();
      try {
        f.write(f.event());
        const completion=f.event(kind), question=f.actual.questions[0]!.question;
        if (fields==='questions only') completion.tool_input={questions:completion.tool_input.questions};
        if (fields==='empty maps') {completion.tool_input.answers={};completion.tool_input.annotations={};}
        if (fields==='notes and preview') {
          completion.tool_input.answers={[question]:'Synthetic custom answer content'};
          completion.tool_input.annotations={[question]:{preview:'Synthetic preview content',notes:'Synthetic note content'}};
        }
        f.write(completion);
        expect(f.status()).toEqual({status:'idle'});
        expect(f.read()).toBeUndefined();
        const state=JSON.parse(fs.readFileSync(f.recorder.file,'utf8'));
        expect(state.pending).toBeNull();
        expect(state.answers).toBeUndefined();expect(state.annotations).toBeUndefined();
        f.write(f.event('PreToolUse','toolu_after_completion'));
        expect(f.read()?.toolUseId).toBe('toolu_after_completion');
      } finally {f.dispose();}
    }
  });

  test.each(['answers','annotations'])('PreToolUse remains questions-only and rejects %s', field => {
    const f=fixture();
    try {
      const request=f.event();request.tool_input[field]={};f.write(request);
      expect(f.status()).toMatchObject({status:'invalid'});
      f.write(f.event());expect(f.read()).toBeUndefined();
    } finally {f.dispose();}
  });

  test.each(['answers array','answers null','answer number','unknown answer question','annotations array',
    'annotations null','annotation string','unknown annotation question','preview number','notes boolean',
    'extra annotation property','extra input property','changed question','reordered questions','changed option',
    'reordered options','changed multiSelect'])('malformed owned completion %s poisons closed', change => {
      const f=fixture();
      try {
        f.write(f.event());const completion=f.event('PostToolUse'),input=completion.tool_input;
        const question=f.actual.questions[0]!.question;
        switch(change) {
          case 'answers array':input.answers=[];break;
          case 'answers null':input.answers=null;break;
          case 'answer number':input.answers={[question]:1};break;
          case 'unknown answer question':input.answers={'Foreign question':'Yes'};break;
          case 'annotations array':input.annotations=[];break;
          case 'annotations null':input.annotations=null;break;
          case 'annotation string':input.annotations={[question]:'notes'};break;
          case 'unknown annotation question':input.annotations={'Foreign question':{notes:'Text'}};break;
          case 'preview number':input.annotations={[question]:{preview:1}};break;
          case 'notes boolean':input.annotations={[question]:{notes:true}};break;
          case 'extra annotation property':input.annotations={[question]:{notes:'Text',answer:'Yes'}};break;
          case 'extra input property':input.approved=true;break;
          case 'changed question':input.questions[0].question+=' Changed.';break;
          case 'reordered questions':input.questions.reverse();break;
          case 'changed option':input.questions[0].options[0].label+=' Changed.';break;
          case 'reordered options':input.questions[0].options.reverse();break;
          case 'changed multiSelect':input.questions[0].multiSelect=true;break;
        }
        f.write(completion);expect(f.status()).toMatchObject({status:'invalid'});
        expect(f.read()).toBeUndefined();
        f.write(f.event('PostToolUse'));f.write(f.event('PreToolUse','toolu_after_invalid'));
        expect(f.read()).toBeUndefined();
      } finally {f.dispose();}
    });

  test.each(['cwd','session','subagent'])('foreign completion %s preserves the exact owned pending state', field => {
    const f=fixture();
    try {
      f.write(f.event());const before=fs.readFileSync(f.recorder.file,'utf8');
      for(const kind of ['PostToolUse','PostToolUseFailure']) {
        const completion=f.event(kind);
        if(field==='cwd')completion.cwd=path.join(f.root,'foreign');
        if(field==='subagent')completion.agent_id='foreign-subagent';
        if(field==='session') {
          completion.session_id='foreign-session';
          completion.transcript_path=path.join(f.project,'foreign-session.jsonl');
          fs.writeFileSync(completion.transcript_path,'');
        }
        f.write(completion);expect(fs.readFileSync(f.recorder.file,'utf8')).toBe(before);
        expect(f.read()?.toolUseId).toBe(f.actual.toolUseId);
      }
    } finally {f.dispose();}
  });

  test('a same-session completion from another native transcript cannot clear the pending request', () => {
    const f=fixture();
    try {
      f.write(f.event());const completion=f.event('PostToolUse');
      const other=path.join(f.config,'projects','other');fs.mkdirSync(other);
      completion.transcript_path=path.join(other,`${f.session}.jsonl`);
      fs.writeFileSync(completion.transcript_path,'');
      f.write(completion);expect(f.status()).toMatchObject({status:'invalid'});
      f.write(f.event('PostToolUse'));f.write(f.event('PreToolUse','toolu_after_foreign_path'));
      expect(f.read()).toBeUndefined();
    } finally {f.dispose();}
  });

  test('a late other-ID completion records a tombstone without clearing or replacing the current question', () => {
    const f=fixture();
    try {
      f.write(f.event());const before=f.read();
      f.write(f.event('PostToolUse','toolu_prior_question'));
      expect(f.read()).toEqual(before);
      f.write(f.event('PreToolUse','toolu_prior_question'));expect(f.read()).toEqual(before);
      f.write(f.event('PostToolUse'));expect(f.status()).toEqual({status:'idle'});
      f.write(f.event('PreToolUse','toolu_prior_question'));expect(f.read()).toBeUndefined();
      f.write(f.event('PreToolUse','toolu_after_both'));expect(f.read()?.toolUseId).toBe('toolu_after_both');
      f.write(f.event('PostToolUse'));expect(f.read()?.toolUseId).toBe('toolu_after_both');
    } finally {f.dispose();}
  });

  test('completion before PreToolUse cannot be reopened by a replay', () => {
    const f=fixture();
    try {
      f.write(f.event('PostToolUse'));expect(f.status()).toEqual({status:'idle'});
      f.write(f.event());expect(f.read()).toBeUndefined();
      f.write(f.event('PreToolUse','toolu_newer'));expect(f.read()?.toolUseId).toBe('toolu_newer');
    } finally {f.dispose();}
  });

  test('the actual generated completion hook is silent and grants no answer or tool decision', () => {
    const f=fixture();
    try {
      f.write(f.event());
      const command=f.recorder.hooks.PostToolUse[0]!.hooks[0]!.command;
      const result=spawnSync('bash',['-c',command],{cwd:f.cwd,input:JSON.stringify(f.event('PostToolUse')),
        encoding:'utf8',timeout:6000});
      expect(result.error).toBeUndefined();expect(result.status).toBe(0);
      expect(result.stdout).toBe('');expect(result.stderr).toBe('');
      expect(f.status()).toEqual({status:'idle'});expect(f.read()).toBeUndefined();
    } finally {f.dispose();}
  });

  test('the completion regression and fixture select exactly the two opted-in paid workflows', () => {
    for(const file of ['test/pending-question-completion.test.ts','test/fixtures/pending-question-completion-ad.json']) {
      expect(selectTests([file],E2E_TOUCHFILES,[]).selected.sort()).toEqual(['autoplan-chain-pty','plan-ceo-mode-routing']);
    }
  });
});
