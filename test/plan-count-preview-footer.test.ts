import {describe, test, expect} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {capturePlanCountQuestion, matchesNativePlanQuestion, nativePlanCallFingerprint, planCountQuestionInput} from './helpers/claude-pty-runner';
import {pickCeoCountQuestion} from './helpers/ceo-approach-pick';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import completed from './fixtures/ceo-preview-u-call.json';

const screen = fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-preview-u-screen.txt'), 'utf8');
// Project an unanswered call for regression execution. The actual U capture
// completed with option A; its 621ms pending state was not retained by observers.
function pending(): NativePlanQuestionCall {
  const {answers, answeredAt, unansweredQuestionIndices, ...call} = structuredClone(completed);
  return {...call, answered:false, failed:false};
}

describe('native question with preview and notes footer', () => {
  test('the captured panel binds complete native labels and selects the offered recommendation', () => {
    const call = pending();
    expect(matchesNativePlanQuestion(screen, call)).toBe(true);
    const fp = capturePlanCountQuestion(screen, new Set(), 0, true, call)!;
    expect(fp.nativeCall).toBe(call);
    expect(fp.options.map(o => o.label)).toEqual(call.questions[0]!.options.map(o => o.label));
    expect(pickCeoCountQuestion(nativePlanCallFingerprint(call, 0, true), fp)).toBe(2);
    expect(planCountQuestionInput(screen, fp, 2)).toBe('2');
    expect(completed.answers[completed.questions[0]!.question]).toBe('A) Current plan as-is');
  });

  test('late native metadata changes neither input protocol nor historical coverage', () => {
    const seen = new Set<string>();
    const fp = capturePlanCountQuestion(screen, seen, 0, true)!;
    expect(fp.nativeCall).toBeUndefined();
    expect(pickCeoCountQuestion(fp)).toBeNull();
    expect(planCountQuestionInput(screen, fp, 2)).toBe('2');
    expect(capturePlanCountQuestion(screen, seen, 1, true, pending())).toBeNull();
  });

  test('a notes footer cannot bind another question or authorize a different action', () => {
    for (const different of [
      screen.replace('☐ Approach', '☐ Other'),
      screen.replace('<gstack-qid:plan-ceo-approach-selection>', '<gstack-qid:foreign>'),
      screen.replace('navigate · n to add notes', 'navigate · n to run a command'),
      screen.replace('n to add notes · ', 'n to add notes · n to add notes · '),
      screen.replace(' · Esc to cancel', ''),
    ]) {
      const call = pending();
      expect(matchesNativePlanQuestion(different, call)).toBe(false);
      const fp = capturePlanCountQuestion(different, new Set(), 0, true, call)!;
      expect(fp.nativeCall).toBeUndefined();
      expect(pickCeoCountQuestion(nativePlanCallFingerprint(call, 0, true), fp)).toBeNull();
    }
    expect(matchesNativePlanQuestion(screen.replace(' · n to add notes', ''), pending())).toBe(true);
  });
});

test.skipIf(process.platform === 'win32')('real fake CLI chooses B from a native preview menu and sends no trailing Enter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-preview-'));
  const fake = path.join(dir, 'fake-claude');
  const worker = path.join(dir, 'worker.ts');
  const events = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'output.json');
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import fs from 'node:fs';import path from 'node:path';
const item=JSON.parse(process.env.PREVIEW_CASE);const log=e=>fs.appendFileSync(item.events,JSON.stringify(e)+'\n');
const sid='preview-'+process.pid;const nativePath=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',sid,sid+'.jsonl');fs.mkdirSync(path.dirname(nativePath),{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(nativePath,JSON.stringify({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
native('assistant',[{type:'text',text:'Fixture started.'}]);log({type:'start',pid:process.pid,cwd:process.cwd()});
let stage='startup';
process.stdin.setRawMode?.(true);process.stdin.on('data',data=>{
 const input=data.toString();log({type:'input',stage,input});
 if(stage==='startup'){
  stage='question';native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'preview',input:{questions:[item.question]}}]);
  process.stdout.write('\x1b[2J\x1b[H'+item.screen.replaceAll('\n','\r\n'));return;
 }
 if(stage!=='question'){log({type:'unexpected',input});return;}
 stage='done';
 const choice=item.question.options[Number(input[0])-1]?.label;
 native('user',[{type:'tool_result',tool_use_id:'preview',content:'Answered'}],{toolUseResult:{answers:{[item.question.question]:choice}}});
 log({type:'choice',choice,input});
 const q={header:'Finding',question:'Apply the repair?',options:[{label:'Fix'},{label:'Keep'}]};
 native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'finding',input:{questions:[q]}}]);
 native('user',[{type:'tool_result',tool_use_id:'finding',content:'Answered'}],{toolUseResult:{answers:{[q.question]:'Fix'}}});
 process.stdout.write('\x1b[2J\x1b[HDone.\r\n');
});process.on('SIGINT',()=>process.exit(0));process.stdin.resume();
`);
  fs.chmodSync(fake, 0o755);
  const runner=pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href;
  const picker=pathToFileURL(path.join(import.meta.dir,'helpers/ceo-approach-pick.ts')).href;
  fs.writeFileSync(worker, `import {runPlanSkillCounting} from ${JSON.stringify(runner)};import {pickCeoCountQuestion} from ${JSON.stringify(picker)};
const result=await runPlanSkillCounting({skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',followUpPrompt:'Review this fixture.',isLastStep0AUQ:()=>true,pickAUQ:pickCeoCountQuestion,reviewCountCeiling:1,timeoutMs:26000,env:{PREVIEW_CASE:${JSON.stringify(JSON.stringify({events, screen, question:completed.questions[0]}))}}});await Bun.write(${JSON.stringify(output)},JSON.stringify(result));`);
  const child=Bun.spawn([process.execPath,worker], {env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  try {
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code,out+err).toBe(0);
    const result=JSON.parse(fs.readFileSync(output,'utf8'));
    expect(result.outcome,JSON.stringify(result)).toBe('ceiling_reached');
    expect(result.step0Count).toBe(1);
    expect(result.reviewCount).toBe(1);
    const rows=fs.readFileSync(events,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    expect(rows.filter(row=>row.type==='input').map(row=>row.input)).toEqual(['/plan-ceo-review\r','2']);
    expect(rows.find(row=>row.type==='choice').choice).toBe(completed.questions[0]!.options[1]!.label);
    expect(rows.some(row=>row.type==='unexpected')).toBe(false);
    expect(()=>process.kill(rows[0].pid,0)).toThrow();
    expect(fs.existsSync(rows[0].cwd)).toBe(false);
  } finally {
    clearTimeout(timer);child.kill('SIGKILL');await child.exited;
    if(fs.existsSync(events)) {
      const first=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!);
      try {
        const argv = process.platform === 'linux'
          ? fs.readFileSync('/proc/' + first.pid + '/cmdline', 'utf8').split('\0')
          : Bun.spawnSync(['ps', '-p', String(first.pid), '-o', 'command='], { timeout: 1_000 }).stdout.toString().trim().split(/\s+/);
        if (argv.includes(fake)) process.kill(first.pid, 'SIGKILL');
      } catch { /* owned child already closed */ }
    }
    fs.rmSync(dir,{recursive:true,force:true});
  }
},35000);
