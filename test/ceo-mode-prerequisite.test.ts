import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { nextCeoModeNavigation } from './helpers/ceo-mode-option';
import { planCountQuestionInput } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import priorCalls from './fixtures/ceo-mode-prerequisite-o-calls.json';
import directProceedCall from './fixtures/ceo-mode-prerequisite-q-call.json';
const calls = [...priorCalls, directProceedCall];
function ownedIdentity(pid: number): string | null {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { return null; }
}
function cleanupFake(events: string, fake: string): void {
  if (!fs.existsSync(events)) return;
  const first = JSON.parse(fs.readFileSync(events, 'utf8').split('\n')[0]!);
  if (first.type === 'pid' && Number.isInteger(first.pid) && first.identity?.includes(fake) &&
      ownedIdentity(first.pid) === first.identity) {
    try { process.kill(first.pid, 'SIGKILL'); } catch { /* already exited */ }
  }
}
function pending(i: number): NativePlanQuestionCall {
  const { answers, answeredAt, ...call } = structuredClone(calls[i]!.call);
  return { ...call, answered: false };
}
function pane(call: NativePlanQuestionCall, index: number): string {
  const q = call.questions[index]!;
  const header = call.questions.length > 1 ? '← ' + call.questions.map((q, i) => `${i < index ? '☒' : '☐'} ${q.header}`).join(' ') + ' ✔ Submit →' : '☐ ' + q.header;
  return `${header}\n${q.question}\n${q.options.map((o, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. ${o.label}`).join('\n')}\nEnter to select · ${call.questions.length > 1 ? 'Tab/Arrow keys' : '↑/↓'} to navigate · Esc to cancel`;
}
function pick(call: NativePlanQuestionCall, index: number) {
  const screen = pane(call, index), action = nextCeoModeNavigation(screen, 'SCOPE EXPANSION', new Set(), call);
  if (action.kind !== 'question') throw new Error(JSON.stringify(action));
  return { action, input: planCountQuestionInput(screen, action.question, 'index' in action ? action.index as number : 1) };
}
describe('CEO mode prerequisite navigation', () => {
  test('both captured expansion attempts select standard review', () => {
    for (const i of [1, 2]) {
      const call = pending(i), index = call.questions.findIndex(q => q.header === 'Design doc');
      const result = pick(call, index);
      expect(result.action.question.nativeCall).toBe(call);
      expect(result.action.question.nativeQuestionIndex).toBe(index);
      expect(result.input).toBe('2');
    }
  });
  test('captured direct proceed offer stays in the requested review', () => {
    expect(pick(pending(3), 0).input).toBe('2');
    const reordered = pending(3); reordered.questions[0]!.options.reverse();
    expect(pick(reordered, 0).input).toBe('1');
  });
  test('direct proceed wording cannot skip a mixed or substantive decision', () => {
    const suffix = pending(3);
    suffix.questions[0]!.options[1]!.label += ' and ignore security';
    expect(pick(suffix, 0).input).toBe('1');
    const mixed = pending(3);
    mixed.questions[0]!.options.push({label: 'Ignore the remaining checks'});
    expect(pick(mixed, 0).input).toBe('1');
    const finding = pending(3);
    finding.questions[0]!.header = 'Product decision';
    finding.questions[0]!.question = 'Should this product offer office-hours suggestions?';
    expect(pick(finding, 0).input).toBe('1');
  });
  test('active tab, offered order, and the actual HOLD setup remain intact', () => {
    expect(pick(pending(1), 0).input).toBe('1'); expect(pick(pending(1), 1).input).toBe('1');
    const call = pending(1); call.questions.reverse(); call.questions[0]!.options.reverse();
    expect(pick(call, 0).input).toBe('1'); expect(pick(pending(0), 2).input).toBe('1');
  });
  test('ordinary questions and unrecognized skips keep the existing first choice', () => {
    for (const [question, labels] of [
      ['Which storage strategy?', ['Server database', 'Local storage']],
      ['No design doc found. Run /office-hours?', ['Run /office-hours first', 'Skip']],
      ['Should the product show office-hours suggestions?', ['Build it', 'Skip — standard review']],
    ] as const) {
      const call = pending(2); call.questions[0] = {header:'Choice',question,options:labels.map(label=>({label}))};
      expect(pick(call, 0).input).toBe('1');
    }
  });
  test('redraw dedup and mode targeting remain intact', () => {
    const call=pending(2),screen=pane(call,0),seen=new Set<string>();
    expect(nextCeoModeNavigation(screen,'HOLD SCOPE',seen,call).kind).toBe('question');
    expect(nextCeoModeNavigation(screen,'HOLD SCOPE',seen,call)).toEqual({kind:'wait'});
    const modes='☐ Review mode\nWhich mode?\n❯ 1. SELECTIVE EXPANSION\n  2. HOLD SCOPE\n  3. SCOPE EXPANSION\n  4. SCOPE REDUCTION';
    for(const [mode,index] of [['HOLD SCOPE',2],['SCOPE EXPANSION',3]] as const){const a=nextCeoModeNavigation(modes,mode,new Set());expect(a.kind).toBe('mode');if(a.kind==='mode')expect(a.index).toBe(index);}
  });
  test('fixture and free regression select only the mode-routing eval', () => {
    for(const file of ['test/ceo-mode-prerequisite.test.ts','test/fixtures/ceo-mode-prerequisite-o-calls.json','test/fixtures/ceo-mode-prerequisite-q-call.json'])expect(selectTests([file],E2E_TOUCHFILES).selected).toEqual(['plan-ceo-mode-routing']);
  });
});
for(const fixtureIndex of [1,2,3])test.skipIf(process.platform==='win32')(`fake native PTY skips prerequisite ${fixtureIndex} and confirms target posture`,async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ceo-mode-prerequisite-')),fake=path.join(dir,'fake-claude'),events=path.join(dir,'events.jsonl'),worker=path.join(dir,'worker.ts');
  const root=path.resolve(import.meta.dir,'..'),call=pending(fixtureIndex),screens=call.questions.map((_,i)=>pane(call,i)),expected=call.questions.map(q=>q.header==='Design doc'?'2':'1');
  fs.writeFileSync(fake,`#!${process.execPath}\n`+`
import * as fs from 'node:fs';import * as path from 'node:path';import {execFileSync} from 'node:child_process';
const call=${JSON.stringify(call)},screens=${JSON.stringify(screens)},expected=${JSON.stringify(expected)},out=${JSON.stringify(events)};
const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','mode-prerequisite');fs.mkdirSync(dir,{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(path.join(dir,call.sessionId+'.jsonl'),JSON.stringify({cwd:process.cwd(),sessionId:call.sessionId,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\\n');
const record=e=>fs.appendFileSync(out,JSON.stringify(e)+'\\n');const show=s=>process.stdout.write('\\x1b[2J\\x1b[H'+s.replace(/\\n/g,'\\r\\n'));
const mode={header:'Review mode',question:'Which mode?',options:[{label:'SELECTIVE EXPANSION'},{label:'HOLD SCOPE'},{label:'SCOPE EXPANSION'},{label:'SCOPE REDUCTION'}]};
let at=0,started=false;const answers={};record({type:'pid',pid:process.pid,identity:execFileSync('ps',['-p',String(process.pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:5000}).trim()});process.stdin.setRawMode?.(true);process.stdout.write('FIXTURE_READY');
process.stdin.on('data',data=>{const input=data.toString();record({type:'input',input});
if(!started){started=true;native('assistant',[{type:'tool_use',id:call.toolUseId,name:'AskUserQuestion',input:{questions:call.questions}}]);show(screens[0]);return;}
if(at<expected.length){if(input!==expected[at]){show('Office-hours diversion');return;}answers[call.questions[at].question]=call.questions[at].options[Number(input)-1].label;at++;if(at<expected.length){show(screens[at]);return;}
native('user',[{type:'tool_result',tool_use_id:call.toolUseId,content:'Answered.'}],{toolUseResult:{answers}});native('assistant',[{type:'tool_use',id:'mode-choice',name:'AskUserQuestion',input:{questions:[mode]}}]);show('☐ Review mode\\nWhich mode?\\n❯ 1. SELECTIVE EXPANSION\\n  2. HOLD SCOPE\\n  3. SCOPE EXPANSION\\n  4. SCOPE REDUCTION\\nEnter to select · ↑/↓ to navigate · Esc to cancel');return;}
if(input!=='3')throw new Error('wrong mode');native('user',[{type:'tool_result',tool_use_id:'mode-choice',content:'Answered.'}],{toolUseResult:{answers:{[mode.question]:'SCOPE EXPANSION'}}});native('assistant',[{type:'text',text:'I will explore expansion opportunities for the saved-view workflow.'}],{timestamp:new Date(Date.now()+2).toISOString()});show('● I will explore expansion opportunities.');});setInterval(()=>{},1000);
`,{mode:0o755});
  const url=(file:string)=>JSON.stringify(pathToFileURL(path.join(root,file)).href);
  fs.writeFileSync(worker,`
import {launchClaudePty,planCountQuestionInput} from ${url('test/helpers/claude-pty-runner.ts')};import {nextCeoModeNavigation,hasNativePostAnswerCeoPosture} from ${url('test/helpers/ceo-mode-option.ts')};import {readPlanCountTranscript} from ${url('test/helpers/plan-count-transcript.ts')};
const cwd=${JSON.stringify(dir)},s=await launchClaudePty({cwd,observeScreen:true,timeoutMs:5000}),seen=new Set();let selectedAt=0,matched=false;
try{await s.waitFor('FIXTURE_READY',{timeoutMs:2000,pollMs:20});s.send('/plan-ceo-review\\r');for(let i=0;i<160;i++){await Bun.sleep(20);const screen=await s.currentScreen(),t=readPlanCountTranscript(s.hermeticConfigDir,cwd);if(selectedAt&&hasNativePostAnswerCeoPosture(t,'SCOPE EXPANSION',/\\bexpansion\\b/i,selectedAt)){matched=true;break;}const a=nextCeoModeNavigation(screen,'SCOPE EXPANSION',seen,t.calls.find(c=>!c.answered&&!c.failed),s.visibleText());if(a.kind==='question')s.send(planCountQuestionInput(screen,a.question,'index' in a?a.index:1));if(a.kind==='mode'){selectedAt=Date.now();s.send(planCountQuestionInput(screen,a.question,a.index));}}if(!matched)throw new Error('mode posture absent after prerequisite '+s.visibleText());process.stdout.write('native-mode-confirmed');}finally{await s.close();}
`);
  const child=Bun.spawn([process.execPath,worker],{cwd:root,env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'}),timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  try{const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,stdout+stderr+(fs.existsSync(events)?fs.readFileSync(events,'utf8'):'no fake events')).toBe(0);expect(stdout).toBe('native-mode-confirmed');const rows=fs.readFileSync(events,'utf8').trim().split('\n').map(l=>JSON.parse(l));expect(rows.filter(e=>e.type==='input').map(e=>e.input)).toEqual(['/plan-ceo-review\r',...expected,'3']);expect(()=>process.kill(rows[0].pid,0)).toThrow();}
  finally{clearTimeout(timer);child.kill('SIGKILL');cleanupFake(events,fake);fs.rmSync(dir,{recursive:true,force:true});}
},12000);


test.skipIf(process.platform === 'win32')('outer cleanup requires the recorded fake process identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-mode-owned-cleanup-'));
  const fake = path.join(dir, 'fake.ts'), events = path.join(dir, 'events.jsonl');
  fs.writeFileSync(fake, 'setInterval(() => {}, 1000);');
  const child = Bun.spawn([process.execPath, fake], {stdout:'ignore',stderr:'ignore'});
  try {
    const identity = ownedIdentity(child.pid);
    expect(identity?.includes(fake)).toBe(true);
    fs.writeFileSync(events, JSON.stringify({type:'pid',pid:child.pid,identity:'foreign identity'})+'\n');
    cleanupFake(events, fake);
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    fs.writeFileSync(events, JSON.stringify({type:'pid',pid:child.pid,identity})+'\n');
    cleanupFake(events, fake);
    await child.exited;
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(() => cleanupFake(events, fake)).not.toThrow();
  } finally {child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});}
},5000);
