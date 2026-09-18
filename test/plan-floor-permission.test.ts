import {expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import * as floor from './helpers/plan-floor-review';
import {resolveEvalModel} from '../lib/eval-model';
import {createPendingQuestionRecorder,recordPendingQuestion,readPendingQuestion,pendingQuestionRecorderStatus} from './helpers/plan-count-pending-question';
import {createPlanCountSnapshotWriter} from './helpers/plan-count-artifacts';
import routing from './fixtures/plan-floor-routing-361c.json';
import productTypes from './fixtures/plan-floor-product-type-70b.json';
import dxCustom from './fixtures/plan-floor-dx-custom-491.json';
import * as runner from './helpers/claude-pty-runner';
import {createPlanCountFixture} from './helpers/plan-count-fixture';
import {readPlanFloorTarget} from './helpers/plan-floor-target';
import {createFilePermissionRecorder, recordFilePermission, currentFilePermissionBinding, readPendingWriteInput, isCroppedEditPermissionVisible} from './helpers/plan-count-file-permission';
import captured from './fixtures/plan-floor-permission-fb10.json';
import croppedEdit from './fixtures/plan-edit-cropped-permission-1579.json';
import {FORCING_FLOOR_CEO, FORCING_FLOOR_ENG, FORCING_FLOOR_DESIGN, FORCING_FLOOR_DEVEX} from './fixtures/forcing-finding-seeds';

const ROOT = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'), 'utf8');
const start = source.indexOf('export async function runPlanSkillFloorCheck(');
if (start < 0) throw Error('Missing actual floor runner');
const body = new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start).replace(/^export /, ''));
const QUESTIONS = {
  ceo: {header:'Evidence', question:'The pricing plan has no developer interviews. Should we validate that pricing blocks adoption before launching?',
    multiSelect:false, options:[{label:'Interview developers',description:'Test whether pricing is the adoption barrier before changing the tier.'}, {label:'Launch now',description:'Keep the unvalidated premise and collect evidence after launch.'}]},
  eng: {header:'UUID', question:'The plan repeats a custom generator in each service without a concrete reason. Should we use the built-in generator?',
    multiSelect:false, options:[{label:'Use built-in',description:'Use crypto.randomUUID() and remove unnecessary custom entropy handling.'}, {label:'Keep custom',description:'Retain the custom generator and its maintenance burden.'}]},
  design: {header:'Hierarchy', question:'The primary CTA has the same visual weight as Learn more. Should we make the main action visibly stronger?',
    multiSelect:false, options:[{label:'Emphasize primary CTA',description:'Increase primary contrast and give Learn more a secondary text style.'}, {label:'Keep equal weight',description:'Leave visitors to distinguish equally prominent actions.'}]},
  devex: {header:'First call', question:'Eight manual setup steps and an emailed API key delay the first SDK call. Should we provide a runnable sandbox?',
    multiSelect:false, options:[{label:'Provide sandbox',description:'Supply a hosted sandbox with a copy-pasteable first SDK call.'}, {label:'Keep manual setup',description:'Require all eight setup steps before the first call.'}]},
};
const SEEDS = {ceo:FORCING_FLOOR_CEO, eng:FORCING_FLOOR_ENG, design:FORCING_FLOOR_DESIGN, devex:FORCING_FLOOR_DEVEX};
const SEED_QUOTES = {ceo:"We haven't talked to any developers", eng:'custom UUIDv7 generator inline in each service',
  design:'the CTA button is the same visual weight', devex:'No quickstart command, no hosted sandbox, no copy-pasteable curl example.'};
const render = (question: typeof QUESTIONS.ceo) => ['☐ '+question.header,question.question,
  ...question.options.flatMap((o,i)=>[`${i?' ':'❯'} ${i+1}. ${o.label}`,o.description]),
  'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
const FINDING = render(QUESTIONS.ceo);
type Mode = 'planning-owned' | 'planning-foreign' | 'cropped-edit' | 'cropped-edit-missing' | 'cropped-edit-changed' | 'cropped-edit-completed' | 'captured' | 'owned' | 'owned-no-question' | 'foreign' | 'wrong-session' | 'missing-native' | 'linked-target' |
  'native-question' | 'scope' | 'prose' | 'finding' | 'routing' | 'unrelated' | 'partial' | 'quoted' | 'foreign-question' |
  'stale-question' | 'answered-question' | 'failed-question' | 'mismatched-use' | 'duplicate-use' | 'judge-error' | 'mode' | 'pending-hook' | 'failed-hook' | 'packet' | 'prose-quoted' | 'prose-partial' | 'prose-foreign' | 'prose-stale' | 'product-type' | 'product-type-undeclared' |
  'unmatched-hook' | 'invalid-hook' | 'missing-hook' | 'idle-hook' | 'transition-hook' | 'unmatched-native' | 'dx-setup' | 'dx-no-finding' | 'dx-undeclared' | 'dx-cropped' | 'dx-unrelated' | 'dx-uncertain' | 'dx-changing-call';
interface SnapshotOptions { evalDir: string; failFirst?: boolean; interrupt?: boolean }

// Complete actual floor function; only clock/PTY/public-event and assessor
// boundaries are controlled. Real ownership, permission and viewport parsers run.
// Assessor responses are fixtures, never actual model-quality evidence.
async function exercise(mode: Mode, kind: keyof typeof SEEDS = 'ceo', capture?: typeof routing.captures[number], productQuestion=productTypes.captures[0]!.question, snapshotOptions?: SnapshotOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-permission-free-'));
  const config = path.join(dir, '.claude');
  let now = Date.now() - (mode.includes('hook') || mode.startsWith('cropped-edit') ? 10_000 : 1), launched: any, fixture: ReturnType<typeof createPlanCountFixture> | undefined;
  let screen = '', history = '', granted = false, closed = 0, saved: any;
  const sent: string[] = [], judgments: floor.PlanFloorReview[] = [], tools: any[] = [];
  const snapshots: any[] = [], artifactErrors: string[] = [];
  const retain = snapshotOptions ? createPlanCountSnapshotWriter({EVALS_RUN_ID:'floor-retention-free',GSTACK_EVAL_DIR:snapshotOptions.evalDir}) : undefined;
  const recorders: NonNullable<ReturnType<typeof createFilePermissionRecorder>>[] = [];
  let transcript: any = {status:'ready', calls:[], assistantMessages:[]};
  const question = structuredClone(QUESTIONS[kind]);
  if (mode.startsWith('planning-')) question.question += '\n' + ('Explain the owned seeded finding and its existing remedy.\n').repeat(50);
  class Clock extends Date { static now() { return now; } }
  const boundary = {
    ...runner, fs, path, randomUUID, isDeepStrictEqual, readPendingQuestion, pendingQuestionRecorderStatus, resolveEvalModel,
    pickPlanFloorMode: floor.pickPlanFloorMode, pickPlanFloorProductType: floor.pickPlanFloorProductType,
    Date: Clock, Bun: {sleep: async (ms: number) => { now += ms; }},
    SANCTIONED_WRITE_SUBSTRINGS: ['gstack-test-plan-', '.claude/plans/'],
    createPlanCountFixture: (seed: string, opts: any) => {
      expect(opts).toMatchObject({nativeReviewOnly:true,preconfiguredReviewActor:true});
      fixture = createPlanCountFixture(seed, opts);
      const config = fs.readFileSync(path.join(fixture.env.GSTACK_HOME,'config.yaml'),'utf8');
      expect(config).toContain('routing_declined: true'); expect(config).toContain('cross_project_learnings: false');
      expect(config).toContain('codex_reviews: disabled'); return fixture;
    },
    readPlanFloorTarget, currentFilePermissionBinding, readPendingWriteInput, isCroppedEditPermissionVisible,
    readPlanCountTranscript: (_config: string, _cwd: string, visit?: (event:any)=>void) => {tools.forEach(e=>visit?.(e));return transcript;},
    createPlanCountSnapshotWriter: () => (value: any) => {
      saved = structuredClone(value); snapshots.push({at:now,observation:saved.observation});
      if (snapshotOptions?.failFirst && snapshots.length === 1) return {artifactError:'controlled snapshot write failure'};
      return retain?.(value) ?? {};
    },
    console: {error: (message: string) => artifactErrors.push(message)},
    logPtySnapshot: () => {},
    judgePtyState: () => { throw Error('Generic waiting cannot establish a finding'); },
    judgePlanFloorReview: (input: floor.PlanFloorReview, opts: any) => {
      judgments.push(structuredClone(input));
      expect(opts.model).toBe(resolveEvalModel('warmup')); expect(opts.deadlineAt).toBeGreaterThan(now);
      floor.buildPlanFloorReviewPrompt(input);
      if(mode==='judge-error') throw Error('controlled assessment failure');
      const dxSetup = mode.startsWith('dx-') && input.candidate.transport==='native' && input.candidate.question.header===dxCustom.call.questions[0]!.header;
      const classification = dxSetup ? (mode==='dx-unrelated'?'unrelated':mode==='dx-uncertain'?'uncertain':'setup') : mode==='routing'||mode==='scope'||mode==='native-question'||mode==='product-type-undeclared' ? 'setup' :
        mode==='unrelated' ? 'unrelated' : mode==='quoted' ? 'uncertain' : 'finding';
      return floor.validatePlanFloorAssessment(input, classification==='finding' ? {
        kind:'finding',seedQuote:SEED_QUOTES[kind],questionQuote:question.question,
        optionIndex:input.candidate.transport==='native'?1:null,optionQuote:question.options[0].label,
        reason:'Controlled evidence-backed finding assessment',
      } : {kind:classification,seedQuote:'',questionQuote:'',optionIndex:null,optionQuote:'',reason:'Controlled nonfinding assessment'});
    },
    launchClaudePty: async (opts: any) => {
      launched = opts;
      expect(opts.observeSetupQuestions).toBe(true);
      let sequence=0, activeTab=0, screenReads=0;
      const sid = opts.extraArgs[1], journal = path.join(config, 'projects', 'owned', sid + '.jsonl');
      fs.mkdirSync(path.dirname(journal), {recursive:true});
      transcript.assistantMessages = [{sessionId:sid, timestamp:new Clock(now).toISOString(), text:'Reviewing the supplied plan.'}];
      const hookRecorder = mode.includes('hook') ? createPendingQuestionRecorder(opts.cwd,config) : undefined;
      if(hookRecorder)recorders.push(hookRecorder as any);
      const publish = (q = question) => {
        const call = {sessionId:mode==='foreign-question'?'foreign':sid,toolUseId:'question'+(++sequence),answered:mode==='answered-question',
          failed:mode==='failed-question',questions:[q]};
        transcript.calls=[call]; tools.splice(0);
        tools.push({sessionId:sid,toolUseId:call.toolUseId,name:'AskUserQuestion',kind:'use',
          timestamp:new Clock(mode==='stale-question'?now-100_000:now).toISOString(),
          input:{questions:mode==='mismatched-use'?[{...q,question:q.question+' different'}]:[q]}});
        if(mode==='duplicate-use')tools.push(structuredClone(tools[0]));
        screen=render(q);
      };
      const expected = opts.observeFilePermissions?.[0];
      const crop = mode.startsWith('cropped-edit');
      const editInput = crop ? {...croppedEdit.pendingEdit.input,file_path:expected} : undefined;
      if(crop)fs.writeFileSync(expected,croppedEdit.priorWrite.input.content);
      if (mode === 'linked-target') {
        const outside = path.join(dir,'outside.md'); fs.writeFileSync(outside,'outside must stay unchanged');
        fs.symlinkSync(outside,expected);
      }
      const pendingFilePermissionFiles = expected ? [(() => {
        const recorder = createFilePermissionRecorder(opts.cwd, config, expected)!;
        recorders.push(recorder);
        if (mode !== 'missing-native' && mode !== 'cropped-edit-missing') recordFilePermission(JSON.stringify({
          hook_event_name:'PreToolUse', tool_name:crop?'Edit':'Write', session_id:mode === 'wrong-session' ? 'foreign' : sid,
          tool_use_id:'write1', cwd:opts.cwd,
          transcript_path:mode === 'wrong-session' ? path.join(config,'projects','owned','foreign.jsonl') : journal,
          tool_input:editInput??{file_path:expected, content:'not retained in permission metadata'},
        }), recorder.file, opts.cwd, config, expected);
        if(mode==='cropped-edit-completed')recordFilePermission(JSON.stringify({hook_event_name:'PostToolUse',tool_name:'Edit',session_id:sid,
          tool_use_id:'write1',cwd:opts.cwd,transcript_path:journal,tool_input:editInput}),recorder.file,opts.cwd,config,expected);
        return {file:recorder.file, expected};
      })()] : [];
      const permissionPath = mode === 'foreign' ? path.join(dir, 'foreign', path.basename(expected ?? 'report.md')) : expected;
      const permission = crop ? croppedEdit.screen.replaceAll(path.basename(croppedEdit.hook.expected),path.basename(expected))
        .replace('empathy narrative',mode==='cropped-edit-changed'?'different narrative':'empathy narrative') : mode === 'captured' ? captured.rawPermission :
        `Create file\n${permissionPath}\n────────────────\n 1 # Working review\n────────────────\nDo you want to create ${path.basename(permissionPath ?? 'report.md')}?\n❯ 1. Yes\n  2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session\n  3. No\nEsc to cancel · Tab to amend`;
      return {
        hermeticConfigDir: config, pendingFilePermissionFiles, pendingQuestionFile:hookRecorder?.file,
        mark: () => 0, exited: () => false, exitCode: () => null,
        rawOutput: () => history, visibleText: () => history, visibleSince: () => history,
        currentScreen: async () => {
          screenReads++;
          if(snapshotOptions?.interrupt && screenReads === 2) throw Error('controlled screen interruption');
          if(mode==='transition-hook' && screenReads === 2) recordPendingQuestion(JSON.stringify({
            hook_event_name:'PreToolUse',tool_name:'AskUserQuestion',session_id:sid,tool_use_id:'hookQuestion',
            cwd:opts.cwd,transcript_path:journal,tool_input:{questions:[question]},
          }),hookRecorder!.file,opts.cwd,config);
          return screen;
        },
        send: (input: string) => {
          sent.push(input);
          if (input === `/plan-${kind}-review PLAN.md\r`) {
            fs.writeFileSync(journal, JSON.stringify({type:'user', isSidechain:false, cwd:opts.cwd, sessionId:sid,
              timestamp:new Clock(now).toISOString(), message:{role:'user', content:`<command-message>plan-${kind}-review</command-message>\n<command-name>/plan-${kind}-review</command-name>\n<command-args>PLAN.md</command-args>`}})+'\n');
            screen = permission;
            if(crop){
              now=Math.max(now,Date.now());
              tools.push({sessionId:sid,toolUseId:'write1',kind:'use',name:'Edit',timestamp:new Clock(now).toISOString(),input:editInput});
              fs.appendFileSync(journal,JSON.stringify({cwd:opts.cwd,sessionId:sid,isSidechain:false,timestamp:new Clock(now).toISOString(),
                message:{role:'assistant',content:[{type:'tool_use',id:'write1',name:'Edit',input:editInput}]}})+'\n');
            }
            if(['planning-owned','planning-foreign','finding','unrelated','partial','quoted','foreign-question','stale-question','answered-question','failed-question','mismatched-use','duplicate-use','judge-error','unmatched-native'].includes(mode)) {
              if(mode==='partial')question.options[0].description='';
              if(mode==='quoted')question.question='Example from a previous review: '+question.question;
              if(mode==='unrelated')question.question='For OTHER.md, '+question.question;
              publish();
              if (mode.startsWith('planning-')) {
                const directory = mode === 'planning-owned' ? path.join(config, 'plans') : path.join(dir, 'foreign', 'plans');
                const prefix = Bun.wrapAnsi('Planning: ' + path.join(directory, 'native-plan.md'), 120, {hard:true,trim:false});
                screen = prefix + '\n' + '─'.repeat(120) + '\n' + render({...question,question:question.question.slice(0,2000)+'…'});
              }
              if(mode==='unmatched-native')screen='Reviewing the generator options.';
            } else if(mode.includes('hook')) {
              transcript.assistantMessages=[{sessionId:sid,timestamp:new Clock(now).toISOString(),text:'Reviewing the exact owned seed.'}];
              if(!['idle-hook','transition-hook'].includes(mode)) recordPendingQuestion(JSON.stringify({hook_event_name:'PreToolUse',tool_name:'AskUserQuestion',session_id:sid,
                tool_use_id:'hookQuestion',cwd:opts.cwd,transcript_path:journal,tool_input:{questions:[question]}}),hookRecorder!.file,opts.cwd,config);
              if(mode==='invalid-hook')recordPendingQuestion('{}',hookRecorder!.file,opts.cwd,config);
              if(mode==='missing-hook')hookRecorder!.dispose();
              if(mode==='failed-hook')transcript.calls=[{sessionId:sid,toolUseId:'hookQuestion',questions:[question],answered:false,failed:true}];
              screen=render(question);
              if(['unmatched-hook','transition-hook'].includes(mode))screen='Reviewing the generator options.';
              now=Math.max(now,Date.now()); // The real recorder's timestamp cannot be ahead of the controlled observation clock.
            } else if(mode==='packet') {
              const modeQuestion=(header:string)=>({header,question:'Which CEO review mode should apply to '+header+'?',multiSelect:false,
                options:['SCOPE EXPANSION','SELECTIVE EXPANSION','HOLD SCOPE','SCOPE REDUCTION'].map(label=>({label,description:'Apply this review mode.'}))});
              const questions=[modeQuestion('Mode'),modeQuestion('Confirmation')];
              transcript.calls=[{sessionId:sid,toolUseId:'packet',questions,answered:false,failed:false}];
              tools.push({sessionId:sid,toolUseId:'packet',name:'AskUserQuestion',kind:'use',timestamp:new Clock(now).toISOString(),input:{questions}});
              screen='← ☐ Mode ☐ Confirmation ✔ Submit →\n'+render(questions[0]).split('\n').slice(1).join('\n').replace('↑/↓ to navigate','Tab/Arrow keys to navigate');
            } else if(mode==='mode') {
              publish({header:'Mode',question:'Which CEO review mode should we use?',multiSelect:false,
                options:['SCOPE EXPANSION','SELECTIVE EXPANSION','HOLD SCOPE','SCOPE REDUCTION'].map(label=>({label,description:'Apply this review mode.'}))});
            } else if(mode.startsWith('product-type')) {
              publish(structuredClone(productQuestion));
            } else if(mode.startsWith('dx-')) {
              publish(structuredClone(dxCustom.call.questions[0]!));
              screen=mode==='dx-cropped'?dxCustom.originalViewport:dxCustom.questionViewport;
            } else if(mode==='routing') {
              screen=capture!.viewport; transcript.calls=structuredClone(capture!.calls).map(call=>({...call,sessionId:sid}));
              for(const call of transcript.calls)tools.push({sessionId:sid,toolUseId:call.toolUseId,name:'AskUserQuestion',kind:'use',
                timestamp:new Clock(now).toISOString(),input:{questions:call.questions}});
            } else if(mode==='scope') screen='What should I review?\n❯ 1. Current branch diff\n  2. A plan or design doc';
            else if(mode.startsWith('prose')) {
              screen=question.question+'\nA) '+question.options[0].label+' — '+question.options[0].description+'\nB) '+question.options[1].label+' — '+question.options[1].description+'\nReply with A or B.';
              if(mode==='prose-quoted')screen=screen.split('\n').map(line=>'> '+line).join('\n');
              transcript.assistantMessages=[{sessionId:mode==='prose-foreign'?'foreign':sid,
                timestamp:new Clock(mode==='prose-stale'?now-100_000:now).toISOString(),text:screen}];
              if(mode==='prose-partial')screen=screen.split('\n').slice(1).join('\n');
            } else if(mode==='native-question') {
              const q = {header:'Finding',question:`Create file\n${expected}\nDo you want to create ${path.basename(expected)}?`,multiSelect:false,
                options:[{label:'Yes',description:'One review choice.'},{label:'Yes, and always allow access to /tmp',description:'A product permission proposal.'},{label:'No',description:'Keep the existing policy.'}]};
              publish(q); expect(runner.isPermissionDialogVisible(screen)).toBe(true);
            }
            history = screen;
          } else if(mode==='packet' && input==='3') {
            activeTab++;
            if(activeTab===1)screen='← ☒ Mode ☐ Confirmation ✔ Submit →\n'+render(transcript.calls[0].questions[1]).split('\n').slice(1).join('\n').replace('↑/↓ to navigate','Tab/Arrow keys to navigate');
            else if(activeTab===2)screen='← ☒ Mode ☒ Confirmation ✔ Submit →\nReview your answers\nReady to submit your answers?\n❯ 1. Submit';
            else throw Error('Duplicate setup answer');
            history+='\n'+screen;
          } else if((mode==='packet' && input==='\r') || (mode==='mode' && input==='3')) {
            const old=structuredClone(transcript.calls[0]);old.answered=true;old.answers=Object.fromEntries(old.questions.map((q:any)=>[q.question,'HOLD SCOPE']));
            publish();transcript.calls.unshift(old);history+='\n'+screen;
          } else if(mode==='product-type' && input==='1') {
            const old=structuredClone(transcript.calls[0]);old.answered=true;
            old.answers={[old.questions[0].question]:old.questions[0].options[0].label};
            publish();transcript.calls.unshift(old);history+='\n'+screen;
          } else if(mode.startsWith('dx-')) {
            if(input==='4')screen=dxCustom.focusedViewport;
            else if(input==='\x1b[200~'+dxCustom.reply+'\x1b[201~') {
              screen=dxCustom.filledViewport;
              if(mode==='dx-changing-call')transcript.calls[0].questions[0].question+=' Changed after paste.';
            } else if(input==='\r') {
              const old=structuredClone(transcript.calls[0]);old.answered=true;old.answers={[old.questions[0].question]:dxCustom.reply};
              if(mode==='dx-no-finding') {transcript.calls=[old];screen='';}
              else {publish();transcript.calls.unshift(old);}
            } else throw Error('Unexpected DX custom input: '+JSON.stringify(input));
            history+='\n'+screen;
          } else if (input === '1\r') {
            granted = true;
            if(mode==='owned'||mode==='cropped-edit')publish(); else screen='';
            history += '\n' + screen;
          } else throw Error('Unexpected actor input: ' + JSON.stringify(input));
        },
        close: async () => { closed++; for(const recorder of recorders)recorder.dispose(); },
      };
    },
  };
  const run = new Function(...Object.keys(boundary), body + '\nreturn runPlanSkillFloorCheck;')(...Object.values(boundary));
  try {
    let result: any, error: unknown;
    try {
      result = await run({skillName:`plan-${kind}-review`, slashCommand:`/plan-${kind}-review`, followUpPrompt:SEEDS[kind],
        productType:mode==='product-type'||mode.startsWith('dx-')?'sdk-documentation':undefined,
        devexSetupContext:mode.startsWith('dx-')&&mode!=='dx-undeclared'?dxCustom.reply:undefined,
        requestedPlanPath:mode === 'captured' ? undefined : `/tmp/gstack-test-plan-${kind}-floor.md`, timeoutMs:100_000});
    } catch(caught) { if(!snapshotOptions?.interrupt)throw caught; error=caught; }
    expect(closed).toBe(1); expect(fs.existsSync(fixture!.cwd)).toBe(false);
    expect(recorders.every(recorder=>!fs.existsSync(recorder.file))).toBe(true);
    return {result, error, sent, judgments, granted, launched, saved, snapshots, artifactErrors, fixture};
  } finally { for (const recorder of recorders) recorder.dispose(); fixture?.cleanup(); fs.rmSync(dir,{recursive:true,force:true}); }
}

test('captured file permission never satisfies the floor through a waiting judge', async () => {
  expect(captured.originalOutcome).toBe('auq_observed');
  expect(runner.isPermissionDialogVisible(captured.rawPermission)).toBe(true);
  const e = await exercise('captured');
  expect(e.result.outcome).toBe('timeout'); expect(e.result.auqObserved).toBe(false);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']); expect(e.judgments).toHaveLength(0);
});
test('one owned native Write grant enables the actual later question without answering it', async () => {
  const e = await exercise('owned');
  expect(e.result.outcome).toBe('auq_observed'); expect(e.granted).toBe(true);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r', '1\r']);
  expect(e.launched.observeFilePermissions).toEqual([e.fixture!.workingPlanPath]);
  expect(path.dirname(e.fixture!.workingPlanPath!)).toBe(e.fixture!.cwd);
  expect(e.saved.observation.transcript.status).toBe('ready'); expect(e.saved.viewport).toBe(FINDING);
});
for (const mode of ['planning-owned','planning-foreign'] as const) test(`actual floor binds the session plans directory: ${mode}`, async () => {
  const e = await exercise(mode, 'eng');
  expect(e.result.outcome).toBe(mode === 'planning-owned' ? 'auq_observed' : 'timeout');
  expect(e.judgments).toHaveLength(mode === 'planning-owned' ? 1 : 0);
  expect(e.sent).toEqual(['/plan-eng-review PLAN.md\r']);
});
test.each(['cropped-edit','cropped-edit-missing','cropped-edit-changed','cropped-edit-completed'] as Mode[])('%s routes through the actual floor only after exact ownership',async mode=>{
  const e=await exercise(mode,'devex');
  expect(e.sent).toEqual(mode==='cropped-edit'?['/plan-devex-review PLAN.md\r','1\r']:['/plan-devex-review PLAN.md\r']);
  expect(e.result.outcome).toBe(mode==='cropped-edit'?'auq_observed':'timeout');
  expect(e.judgments).toHaveLength(mode==='cropped-edit'?1:0);
  if(mode==='cropped-edit')expect(e.saved.observation.pendingQuestion.answered).toBe(false);
});
test.each(['owned-no-question','foreign','wrong-session','missing-native','linked-target'] as Mode[])('%s cannot supply finding credit', async mode => {
  const e = await exercise(mode); expect(e.result.outcome).toBe('timeout');
  expect(e.sent).toEqual(mode === 'owned-no-question' ? ['/plan-ceo-review PLAN.md\r','1\r'] : ['/plan-ceo-review PLAN.md\r']);
  expect(e.judgments).toHaveLength(0);
});
test('an unrelated actual native question cannot spend a file permission or supply finding credit', async () => {
  const e = await exercise('native-question'); expect(e.result.outcome).toBe('timeout');
  expect(e.judgments).toHaveLength(1);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
});
test('scope gate exclusion and legitimate prose waiting remain distinct', async () => {
  expect((await exercise('scope')).result.outcome).toBe('timeout');
  const e = await exercise('prose'); expect(e.result.outcome).toBe('auq_observed'); expect(e.judgments).toHaveLength(1);
});

for(const capture of routing.captures) test(`captured ${capture.skill} Routing is not a seeded finding`,async()=>{
  expect(capture.originalOutcome).toBe('auq_observed');
  const e=await exercise('routing',capture.skill as keyof typeof SEEDS,capture);
  expect(e.result.auqObserved).toBe(false); expect(e.result.outcome).toBe('timeout');
  expect(e.sent).toEqual([`/plan-${capture.skill}-review PLAN.md\r`]);
  expect(e.judgments).toHaveLength(capture.calls.length?1:0);
});
for(const kind of Object.keys(SEEDS) as (keyof typeof SEEDS)[]) test(`${kind} complete substantive question is assessed without answering`,async()=>{
  const e=await exercise('finding',kind);expect(e.result.outcome).toBe('auq_observed');
  expect(e.judgments).toHaveLength(1);expect(e.judgments[0].candidate).toMatchObject({transport:'native',question:QUESTIONS[kind]});
  expect(e.judgments[0].seed).toContain(SEED_QUOTES[kind]);expect(e.sent).toEqual([`/plan-${kind}-review PLAN.md\r`]);
  expect(e.saved.observation.pendingQuestion.answered).toBe(false);
  expect(e.saved.observation.pendingQuestion.answers).toBeUndefined();
});
test.each(['unrelated','quoted','foreign-question','stale-question','answered-question','failed-question','mismatched-use','duplicate-use','failed-hook'] as Mode[])('%s cannot earn finding credit',async mode=>{
  const e=await exercise(mode);expect(e.result.outcome).toBe('timeout');expect(e.result.auqObserved).toBe(false);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
});
test.each(['partial','judge-error'] as Mode[])('%s preserves explicit assessment error, snapshot and cleanup',async mode=>{
  const e=await exercise(mode);expect(e.result.outcome).toBe('assessment_error');expect(e.result.auqObserved).toBe(false);
  expect(e.saved.observation.outcome).toBe('assessment_error');expect(e.saved.observation.floorReview).toBeDefined();
});
test('declared HOLD mode is answered once and the later finding stays unanswered',async()=>{
  const e=await exercise('mode');expect(e.result.outcome).toBe('auq_observed');
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r','3']);expect(e.judgments).toHaveLength(1);
});
for (const [i,capture] of productTypes.captures.entries()) test(`captured DX product menu ${i+1} advances only its predeclared setup`,async()=>{
 const e=await exercise('product-type','devex',undefined,capture.question);
 expect(e.result.outcome).toBe('auq_observed');
 expect(e.sent).toEqual(['/plan-devex-review PLAN.md\r','1']);expect(e.judgments).toHaveLength(1);
 expect(e.judgments[0]!.seed).toContain('Product type is confirmed: SDK quickstart documentation');
 expect(e.judgments[0]!.candidate).toMatchObject({question:QUESTIONS.devex});
 expect(e.saved.observation.pendingQuestion.answered).toBe(false);
});
test('undeclared DX classification receives no answer and no finding credit',async()=>{
 const e=await exercise('product-type-undeclared','devex');
 expect(e.result.outcome).toBe('timeout');expect(e.sent).toEqual(['/plan-devex-review PLAN.md\r']);
 expect(e.judgments).toHaveLength(1);
});

test('owned pending AUQ recorder supplies the complete question before JSONL publishes the call',async()=>{
  const e=await exercise('pending-hook');expect(e.result.outcome).toBe('auq_observed');
  expect(e.saved.observation.transcript.calls).toEqual([]);
  expect(e.saved.observation.pendingQuestion.source).toBe('pre_tool_use');
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
});
for (const [mode,status] of [['unmatched-hook','pending'],['invalid-hook','invalid'],['missing-hook','missing'],['idle-hook','idle']] as const)
test(`floor retains ${status} recorder diagnostics after fixture cleanup without granting credit`,async()=>{
  const evalDir=fs.mkdtempSync(path.join(os.tmpdir(),'floor-retention-free-'));
  try {
    const e=await exercise(mode,'eng',undefined,undefined,{evalDir});
    expect(e.result.outcome).toBe('timeout');expect(e.judgments).toHaveLength(0);
    expect(e.sent).toEqual(['/plan-eng-review PLAN.md\r']);
    const record=JSON.parse(fs.readFileSync(path.join(e.result.artifactDir,'observation.json'),'utf8'));
    const diagnostics=record.questionDiagnostics;
    expect(fs.existsSync(record.capture.cwd)).toBe(false);
    expect(diagnostics.recorderStatus.status).toBe(status);
    expect(diagnostics.parentSessionId).toBe(e.launched.extraArgs[1]);
    expect(diagnostics.sampledAt).toBeGreaterThanOrEqual(record.commandStartedAt);
    expect(diagnostics.nativeCandidates).toEqual([]);
    expect(record.pendingQuestion).toBeUndefined();expect(record.auqObserved).toBe(false);
    if(status==='pending')expect(diagnostics.validatedPendingQuestion).toMatchObject({
      source:'pre_tool_use',toolUseId:'hookQuestion',questions:[QUESTIONS.eng],answered:false,failed:false,
    });
    else expect(diagnostics.validatedPendingQuestion).toBeUndefined();
    if(status==='invalid')expect(diagnostics.recorderStatus.reason).toBe('invalid_event');
    expect(fs.readFileSync(path.join(e.result.artifactDir,'terminal.screen.log'),'utf8')).toBe(e.saved.viewport);
    expect(fs.readdirSync(e.result.artifactDir).some(name=>name.endsWith('.tmp'))).toBe(false);
    const progress=e.snapshots.filter(s=>s.observation.state==='in_progress');
    expect(progress.length).toBeGreaterThan(1);expect(progress.length).toBeLessThanOrEqual(8);
    for(let i=0;i<progress.length;i++){
      expect(progress[i].observation.outcome).toBeUndefined();expect(progress[i].observation.auqObserved).toBeUndefined();
      if(i){
        const binding=(s:any)=>JSON.stringify([s.questionDiagnostics.recorderStatus,s.questionDiagnostics.nativeCandidates,
          s.questionDiagnostics.validatedPendingQuestion,s.pendingQuestion]);
        if(binding(progress[i].observation)===binding(progress[i-1].observation))
          expect(progress[i].at-progress[i-1].at).toBeGreaterThanOrEqual(15_000);
      }
    }
  } finally {fs.rmSync(evalDir,{recursive:true,force:true});}
});
test('floor retains the complete published candidate before viewport rejection',async()=>{
  const evalDir=fs.mkdtempSync(path.join(os.tmpdir(),'floor-retention-free-'));
  try {
    const e=await exercise('unmatched-native','eng',undefined,undefined,{evalDir});
    const record=JSON.parse(fs.readFileSync(path.join(e.result.artifactDir,'observation.json'),'utf8'));
    expect(e.result.outcome).toBe('timeout');expect(e.judgments).toHaveLength(0);
    expect(record.questionDiagnostics.nativeCandidates).toEqual(record.transcript.calls);
    expect(record.questionDiagnostics.nativeCandidates).toHaveLength(1);
    expect(record.questionDiagnostics.nativeCandidates[0].questions).toEqual([QUESTIONS.eng]);
    expect(record.pendingQuestion).toBeUndefined();expect(record.questionDiagnostics.validatedPendingQuestion).toBeUndefined();
    expect(fs.readFileSync(path.join(e.result.artifactDir,'terminal.screen.log'),'utf8')).toBe('Reviewing the generator options.');
  } finally {fs.rmSync(evalDir,{recursive:true,force:true});}
});
test('a recorder state change is retained before the periodic checkpoint interval',async()=>{
  const e=await exercise('transition-hook','eng');
  const progress=e.snapshots.filter(s=>s.observation.state==='in_progress');
  expect(progress[0].observation.questionDiagnostics.recorderStatus.status).toBe('idle');
  expect(progress[1].observation.questionDiagnostics.recorderStatus.status).toBe('pending');
  expect(progress[1].at-progress[0].at).toBeLessThan(15_000);
  expect(e.result.outcome).toBe('timeout');expect(e.judgments).toHaveLength(0);
});
test('interruption retains the last sampled binding and final recorder status before disposal',async()=>{
  const evalDir=fs.mkdtempSync(path.join(os.tmpdir(),'floor-retention-free-'));
  try {
    const e=await exercise('unmatched-hook','eng',undefined,undefined,{evalDir,interrupt:true});
    expect(String(e.error)).toContain('controlled screen interruption');expect(e.result).toBeUndefined();
    const runRoot=path.join(evalDir,'pty-count','floor-retention-free');
    const dirs=fs.readdirSync(runRoot);expect(dirs).toHaveLength(1);
    const record=JSON.parse(fs.readFileSync(path.join(runRoot,dirs[0],'observation.json'),'utf8'));
    expect(record.state).toBe('in_progress');expect(record.captureReason).toBe('before_cleanup');
    expect(record.outcome).toBeUndefined();expect(record.auqObserved).toBeUndefined();
    expect(record.questionDiagnostics.recorderStatus.status).toBe('pending');
    expect(record.questionDiagnostics.validatedPendingQuestion.questions).toEqual([QUESTIONS.eng]);
    expect(fs.existsSync(record.capture.cwd)).toBe(false);
  } finally {fs.rmSync(evalDir,{recursive:true,force:true});}
});
test('an earlier periodic artifact error survives a later successful final snapshot',async()=>{
  const evalDir=fs.mkdtempSync(path.join(os.tmpdir(),'floor-retention-free-'));
  try {
    const e=await exercise('unmatched-native','eng',undefined,undefined,{evalDir,failFirst:true});
    expect(e.result.outcome).toBe('timeout');expect(e.result.artifactError).toBe('controlled snapshot write failure');
    expect(e.artifactErrors).toEqual(['PTY artifact write failed: controlled snapshot write failure']);
    const record=JSON.parse(fs.readFileSync(path.join(e.result.artifactDir,'observation.json'),'utf8'));
    expect(record.artifactError).toBe(e.result.artifactError);expect(record.outcome).toBe('timeout');
  } finally {fs.rmSync(evalDir,{recursive:true,force:true});}
});
test('declared native setup tabs are answered and submitted exactly once before the finding',async()=>{
  const e=await exercise('packet');expect(e.result.outcome,JSON.stringify({sent:e.sent,viewport:e.saved.viewport,pending:e.saved.observation.pendingQuestion})).toBe('auq_observed');
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r','3','3','\r']);
  expect(e.judgments).toHaveLength(1);expect(e.saved.observation.pendingQuestion.answered).toBe(false);
});

test.each(['prose-quoted','prose-partial','prose-foreign','prose-stale'] as Mode[])('%s is not a complete current public fallback',async mode=>{
  const e=await exercise(mode);expect(e.result.outcome).toBe('timeout');expect(e.judgments).toHaveLength(0);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
});

for (const [kind, seed] of Object.entries({ceo:FORCING_FLOOR_CEO, eng:FORCING_FLOOR_ENG, design:FORCING_FLOOR_DESIGN, devex:FORCING_FLOOR_DEVEX})) {
  test(`${kind} working-plan request is seeded and committed inside its owned root`, () => {
    const requestedPlanPath = `/tmp/gstack-test-plan-${kind}-floor.md`;
    const fixture = createPlanCountFixture(seed,{requestedPlanPath});
    try {
      expect(fixture.seed).toBe(seed.replace(requestedPlanPath,fixture.workingPlanPath!));
      expect(fs.readFileSync(path.join(fixture.cwd,'PLAN.md'),'utf8')).toBe(fixture.seed);
      expect(fs.readFileSync(path.join(fixture.cwd,'CLAUDE.md'),'utf8')).toContain(fixture.seed);
      const git = Bun.spawnSync(['git','show','HEAD:PLAN.md'],{cwd:fixture.cwd});
      expect(git.exitCode).toBe(0); expect(git.stdout.toString()).toBe(fixture.seed);
      expect(fs.existsSync(fixture.workingPlanPath!)).toBe(false);
    } finally { fixture.cleanup(); }
  });
}
test.each(['relative.md','/tmp/PLAN.md','/tmp/CLAUDE.md','/tmp/a/b/../bad.md','/tmp/.git','/tmp/absent.md'])('invalid or undeclared working-plan target %s fails before launch', requestedPlanPath => {
  expect(() => createPlanCountFixture(FORCING_FLOOR_CEO,{requestedPlanPath})).toThrow();
});
test('duplicate declarations and existing fixture files cannot be rewritten into ambiguous ownership', () => {
  const requestedPlanPath = '/tmp/gstack-test-plan-ceo-floor.md';
  expect(() => createPlanCountFixture(FORCING_FLOOR_CEO+'\n'+requestedPlanPath,{requestedPlanPath})).toThrow();
  expect(() => createPlanCountFixture(FORCING_FLOOR_CEO,{requestedPlanPath,files:{'gstack-test-plan-ceo-floor.md':'different source'}})).toThrow();
});

test.each(['auq_observed','timeout','throw'])('all four actual floor registrations keep the declared actor and %s outcome', outcome => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'floor-registration-free-'));
  const worker = path.join(dir,'registrations.test.ts'), facts = path.join(dir,'calls.jsonl');
  const files = ['ceo','eng','design','devex'].map(kind => path.join(ROOT,`test/skill-e2e-plan-${kind}-finding-floor.test.ts`));
  try {
    for (const file of files) expect(fs.statSync(file).isFile()).toBe(true);
    fs.writeFileSync(worker, `
import {describe,expect,mock} from 'bun:test';
import fs from 'node:fs';
import {CAPTURE_LONG_MS} from ${JSON.stringify(path.join(ROOT,'test/helpers/eval-budgets.ts'))};
mock.module(${JSON.stringify(path.join(ROOT,'test/helpers/e2e-gate.ts'))},()=>({describeE2ETier:()=>describe}));
mock.module(${JSON.stringify(path.join(ROOT,'test/helpers/claude-pty-runner.ts'))},()=>({runPlanSkillFloorCheck:async opts=>{
  const kind=/^plan-(ceo|eng|design|devex)-review$/.exec(opts.skillName)?.[1];
  expect(kind).toBeDefined();
  expect(opts.requestedPlanPath).toBe('/tmp/gstack-test-plan-'+kind+'-floor.md');
  expect(opts.followUpPrompt.split(opts.requestedPlanPath)).toHaveLength(2);
  expect(opts.timeoutMs).toBe(CAPTURE_LONG_MS);
  expect(opts.productType).toBe(kind==='devex'?'sdk-documentation':undefined);
  expect(opts.env).toEqual({QUESTION_TUNING:'false',EXPLAIN_LEVEL:'default'});
  if(kind==='devex'){
    expect(opts.devexSetupContext).toContain('Confirmed persona: a hands-on developer making a first SDK call.');
    expect(opts.devexSetupContext).toContain(opts.followUpPrompt.split('## Onboarding flow\\n')[1].replace(/\\s+/g,' '));
    expect(opts.devexSetupContext).toContain('proposed fixes and scope changes remain undecided');
  }else expect(opts.devexSetupContext).toBeUndefined();
  fs.appendFileSync(${JSON.stringify(facts)},JSON.stringify({kind,path:opts.requestedPlanPath})+'\\n');
  if(${JSON.stringify(outcome)}==='throw')throw Error('controlled runner failure');
  return {outcome:${JSON.stringify(outcome)},auqObserved:${outcome === 'auq_observed'},elapsedMs:1,summary:'controlled outcome',evidence:'fixture'};
}}));
${files.map(file => `await import(${JSON.stringify(file)});`).join('\n')}
`);
    const result = Bun.spawnSync([process.execPath,'test',worker],{cwd:ROOT,timeout:20_000,
      env:{PATH:process.env.PATH ?? '',HOME:dir,TMPDIR:dir,TEMP:dir,TMP:dir,GIT_CONFIG_NOSYSTEM:'1',
        ...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {})}});
    const output = result.stdout.toString()+result.stderr.toString();
    expect(result.exitCode,output).toBe(outcome === 'auq_observed' ? 0 : 1);
    expect(fs.readFileSync(facts,'utf8').trim().split('\n').map(line=>JSON.parse(line).kind).sort())
      .toEqual(['ceo','design','devex','eng']);
    if(outcome !== 'auq_observed') expect(output).toContain(outcome === 'throw' ? 'controlled runner failure' : 'floor test FAILED: outcome=timeout');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
},25_000);

// Complete real floor loop with captured native frames. Assessments are controlled
// transport fixtures; only a later substantive question receives finding credit.
test('DX declared context answers setup through native custom input, then awaits a real finding',async()=>{
  const e=await exercise('dx-setup','devex');
  expect(e.result.outcome).toBe('auq_observed');expect(e.judgments).toHaveLength(2);
  expect(e.sent).toEqual(['/plan-devex-review PLAN.md\r','4','\x1b[200~'+dxCustom.reply+'\x1b[201~','\r']);
  expect(e.launched.rows).toBe(80);
  expect(e.fixture!.seed).toContain(dxCustom.reply);
  expect(e.saved.observation.setupContextReplies[0].stage).toBe('done');
  expect(e.saved.observation.transcript.calls.find((c:any)=>c.answered).answers).toEqual({[dxCustom.call.questions[0]!.question]:dxCustom.reply});
});
test.each(['dx-no-finding','dx-undeclared','dx-cropped','dx-unrelated','dx-uncertain','dx-changing-call'] as Mode[])('%s cannot obtain finding credit or approve an offered claim',async mode=>{
  const e=await exercise(mode,'devex');expect(e.result.outcome).toBe('timeout');expect(e.result.auqObserved).toBe(false);
  const typed=mode==='dx-no-finding'||mode==='dx-changing-call';
  expect(e.sent).toEqual(typed?['/plan-devex-review PLAN.md\r','4','\x1b[200~'+dxCustom.reply+'\x1b[201~',...(mode==='dx-no-finding'?['\r']:[])]:['/plan-devex-review PLAN.md\r']);
  expect(e.judgments).toHaveLength(mode==='dx-cropped'||mode==='dx-undeclared'?0:1);
});


test.each([false,true])('current Write input survives the actual floor snapshot and fixture cleanup (interruption=%s)',async interrupt=>{
 const evalDir=fs.mkdtempSync(path.join(os.tmpdir(),'floor-write-retention-'));
 try {
  const e=await exercise('owned-no-question','eng',undefined,undefined,{evalDir,interrupt});
  const snapshots=fs.readdirSync(path.join(evalDir,'pty-count','floor-retention-free'));
  expect(snapshots).toHaveLength(1);
  const artifact=path.join(evalDir,'pty-count','floor-retention-free',snapshots[0]!,'observation.json');
  const saved=JSON.parse(fs.readFileSync(artifact,'utf8'));
  expect(fs.existsSync(saved.capture.cwd)).toBe(false);
  expect(saved.pendingWriteInputs).toHaveLength(1);
  expect(saved.pendingWriteInputs[0]).toMatchObject({source:'PreToolUse',toolName:'Write',
    sessionId:e.launched.extraArgs[1],input:{file_path:e.launched.observeFilePermissions[0],content:'not retained in permission metadata'}});
  expect(saved.pendingWriteInputs[0].pendingId).toBe(`${e.launched.extraArgs[1]}:write1`);
  if(interrupt) expect(saved.captureReason).toBe('before_cleanup');
  else expect(saved.outcome).toBe('timeout');
 }finally{fs.rmSync(evalDir,{recursive:true,force:true});}
});
