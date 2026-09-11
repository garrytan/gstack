import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { capturePlanCountQuestion, planCountQuestionInput, planCountSubmissionInput } from './helpers/claude-pty-runner';

const captured = fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-checkbox-l.screen.txt'), 'utf8');
const question = captured.slice(captured.lastIndexOf('←'));
const selected = question.replace('❯ 1. [ ]', '❯ 1. [✓]');

function focused(index: number) {
  const base = selected.replace('❯ 1.', '  1.');
  if (index === 5) return base.replace(/^ +Submit$/m, '❯    Submit');
  return base.replace(new RegExp(`^ +${index + 1}\\.`, 'm'), `❯ ${index + 1}.`);
}

describe('Native checkbox question controls', () => {
  test('the captured unchecked menu toggles one choice and does not immediately toggle it off', () => {
    expect(planCountSubmissionInput(captured)).toBeNull();
    const fp = capturePlanCountQuestion(captured, new Set(), 0, false)!;
    expect(planCountQuestionInput(captured, fp, 1)).toBe('1');
    expect(planCountSubmissionInput(selected)).toBe('\t');
  });

  test('selected checkbox rows navigate one focus step at a time; only the actual button submits', () => {
    for (let index = 0; index < 5; index++) expect(planCountSubmissionInput(focused(index))).toBe('\t');
    expect(planCountSubmissionInput(focused(5))).toBe('\r');
    expect(planCountSubmissionInput(focused(5).replace('Submit\n', 'Next\n'))).toBe('\r');
    expect(planCountSubmissionInput('```text\nold code\n```\n' + selected)).toBe('\t');
  });

  test('quoted, incomplete, superseded and unselected panels cannot advance', () => {
    for (const text of [
      question,
      selected.replace(/^ +Submit$/m, ''),
      selected.replace(/Enter to select.*$/m, ''),
      selected.replace('←', '> ←'),
      selected.split('\n').map(line => '    ' + line).join('\n'),
      '```text\n' + selected,
      'Example panel:\n' + selected,
      'Quoted source:\n' + selected,
      selected + '\n☐ New question\n❯ 1. Yes\n2. No\nEnter to select · ↑/↓ to navigate · Esc to cancel',
      selected.replace('  2. [ ]', '  8. [ ]'),
      selected.replace('❯ 1.', '  1.').replace('6. Chat', '❯ 6. Chat'),
    ]) expect(planCountSubmissionInput(text)).toBeNull();
  });

  test.skipIf(process.platform === 'win32')('real PTY submits one selected checkbox with early or deferred native metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-checkbox-'));
    const fake = path.join(dir, 'fake-claude');
    const worker = path.join(dir, 'worker.ts');
    const output = path.join(dir, 'results.json');
    const cases = [false, true].map(late => ({ late, log: path.join(dir, `${late}.jsonl`), report: path.join(dir, `${late}.md`) }));
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const item = JSON.parse(process.env.CHECKBOX_CASE);
const log = event => fs.appendFileSync(item.log, JSON.stringify(event) + '\n');
log({type:'startup',pid:process.pid});
const sessionId = 'checkbox-' + process.pid;
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', sessionId);
fs.mkdirSync(project, {recursive:true});
const native = (role, content, extra={}) => fs.appendFileSync(path.join(project, sessionId+'.jsonl'), JSON.stringify({cwd:process.cwd(),sessionId,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
native('assistant',[{type:'text',text:'Fixture started.'}]);
const q = {header:'Test specification',question:'Which verification should the plan specify? <gstack-qid:checkbox-verification>',multiSelect:true,options:[{label:'Happy path'},{label:'Email failure'},{label:'Nil input'},{label:'SQL injection'}]};
const ask = () => native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'checkbox',input:{questions:[q]}}]);
let started=false, focus=0, checked=false, stage='question', done=false;
function render() {
 let screen;
 if(stage==='question') screen='← '+(checked?'☒':'☐')+' Test specification ✔ Submit →\n│ '+q.question+'\n'+[...q.options.map(o=>o.label),'Type something'].map((label,i)=>(focus===i?'❯':' ')+' '+(i+1)+'. ['+(i===0&&checked?'✓':' ')+'] '+label).join('\n')+'\n'+(focus===5?'❯':' ')+'    Submit\n──────────────────\n  6. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
 else screen='← ☒ Test specification ✔ Submit →\nReview your answers\nHappy path\nReady to submit your answers?\n❯1.Submit answers\n2.Cancel\n';
 process.stdout.write('\x1b[2J\x1b[H'+screen.replace(/\n/g,'\r\n'));
 log({type:'screen',stage,focus,checked});
}
process.stdin.setRawMode?.(true);
process.stdin.on('data', async data => {
 const input=data.toString(); log({type:'input',input});
 if(!started){started=true;if(!item.late)ask();render();return;}
 if(done){log({type:'unexpected',input});return;}
 if(stage==='confirm'){
  if(input!=='\r'||!checked)throw Error('Unanswered confirmation');
  if(item.late)ask();
  native('user',[{type:'tool_result',tool_use_id:'checkbox',content:'Answered.'}],{toolUseResult:{answers:{[q.question]:q.options[0].label}}});
  log({type:'completed',checked});done=true;
  await Bun.sleep(10);
  fs.writeFileSync(item.report,'# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n| Review | Status | Findings |\n|---|---|---|\n| Eng | complete | resolved |\n\nVERDICT: READY\n\nNO UNRESOLVED DECISIONS\n');
  native('assistant',[{type:'text',text:'Eng review complete.'}]);
  process.stdout.write('\x1b[2J\x1b[H## Completion Summary\r\nEng review complete.\r\n');return;
 }
 for(const key of input){
  if(key==='1')checked=!checked;
  else if(key==='\t')focus=Math.min(5,focus+1);
  else if(key==='\r'){if(focus===5)stage='confirm';else if(focus===0)checked=!checked;}
  else throw Error('Unexpected checkbox input '+JSON.stringify(input));
 }
 render();
});
process.on('SIGINT',()=>process.exit(0));
process.stdin.resume();
`);
    fs.chmodSync(fake, 0o755);
    fs.writeFileSync(worker, `import {runPlanSkillCounting} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, 'helpers/claude-pty-runner.ts')).href)};
const cases=${JSON.stringify(cases)};
const results=await Promise.all(cases.map(async item=>({late:item.late,observation:await runPlanSkillCounting({skillName:'plan-eng-review',slashCommand:'/plan-eng-review',followUpPrompt:'Review this fixture.',isLastStep0AUQ:()=>false,isReviewAUQ:()=>true,reviewCountCeiling:8,timeoutMs:48000,expectedPlanPath:item.report,env:{CHECKBOX_CASE:JSON.stringify(item)}})})));
await Bun.write(${JSON.stringify(output)},JSON.stringify(results));`);
    const child = Bun.spawn([process.execPath, worker], {
      env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 48000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(0);
      const results = JSON.parse(fs.readFileSync(output, 'utf8'));
      for (const item of cases) {
        const observation = results.find((row: any) => row.late === item.late).observation;
        expect(observation.outcome, JSON.stringify(observation)).toBe('completion_summary');
        expect(observation.reviewCount).toBe(1);
        expect(observation.transcript.calls).toHaveLength(1);
        expect(observation.transcript.calls[0].unansweredQuestionIndices).toEqual([]);
        expect(Object.values(observation.transcript.calls[0].answers)).toEqual(['Happy path']);
        const events = fs.readFileSync(item.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
        expect(events.filter(event => event.type === 'unexpected')).toHaveLength(0);
        expect(events.filter(event => event.type === 'input').slice(1).map(event => event.input))
          .toEqual(['1', '\t', '\t', '\t', '\t', '\t', '\r', '\r']);
        expect(fs.readFileSync(item.report, 'utf8')).toEndWith('NO UNRESOLVED DECISIONS\n');
      }
    } finally {
      clearTimeout(watchdog);
      child.kill('SIGKILL');
      await child.exited;
      for (const item of cases) {
        if (!fs.existsSync(item.log)) continue;
        const startup = fs.readFileSync(item.log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === 'startup');
        if (!startup || !Number.isInteger(startup.pid) || startup.pid <= 0) continue;
        try {
          if (process.platform === 'linux' && !fs.readFileSync(`/proc/${startup.pid}/cmdline`, 'utf8').includes(fake)) continue;
          process.kill(startup.pid, 'SIGKILL');
        } catch { /* the owned fake child already exited */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 55000);
});
