import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { capturePlanCountQuestion, matchesNativePlanQuestion, nativePlanCallFingerprint, planCountQuestionInput } from './helpers/claude-pty-runner';
import { pickCeoCountQuestion } from './helpers/ceo-approach-pick';
import { createPtyScreen } from './helpers/pty-screen';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import completed from './fixtures/ceo-approach-z-call.json';

const screen = fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-approach-z-screen.txt'), 'utf8');
function pending(): NativePlanQuestionCall {
  // No pending-only version survived the live capture. This is an explicit
  // projection for replay, not evidence of metadata availability at input time.
  const { answers, answeredAt, unansweredQuestionIndices, ...call } = structuredClone(completed);
  return { ...call, answered: false, failed: false };
}

describe('native question truncated before its routing id', () => {
  test('the actual complete 120x40 pane binds its exact native prefix and offered labels', async () => {
    const viewport = await createPtyScreen(120, 40);
    try {
      viewport.write(screen.replaceAll('\n', '\r\n'));
      const visible = await viewport.read();
      expect(visible.trimEnd()).toBe(screen.trimEnd());
      expect(visible).not.toContain('<gstack-qid:');
      const call = pending();
      expect(matchesNativePlanQuestion(visible, call)).toBe(true);
      const active = capturePlanCountQuestion(visible, new Set(), 0, true, call)!;
      expect(active.nativeCall).toBe(call);
      expect(pickCeoCountQuestion(nativePlanCallFingerprint(call, 0, true), active)).toBe(2);
      expect(planCountQuestionInput(visible, active, 2)).toBe('2');
      expect(completed.answers[completed.questions[0]!.question]).toBe('A — Minimal Fix');
    } finally { await viewport.dispose(); }
  });

  test('changed or incomplete panels cannot borrow pending metadata', () => {
    for (const visible of [
      screen.replace('☐ Approach', '☐ Other'),
      screen.replace('SQL injection bug', 'different defect'),
      screen.replace('Dela…', 'Different…'),
      screen.replace('Dela…', 'Dela'),
      screen.replace('B — Proper Integration (recommended)', 'B — Different Integration (recommended)'),
      screen.replace('3. C — Reject and Redesign', '3. Changed choice'),
      screen.replace('4. Type something.', '4. Extra operation'),
      screen.replace('↑/↓ to navigate', '↑/↓ to navigte'),
      screen.replace(' · Esc to cancel', ''),
      screen + '\nA later question?',
      'Quoted earlier menu:\n' + screen,
      screen.slice(screen.indexOf('❯ 1.')),
      screen.replace(/\n\n│[\s\S]*?\n\n❯/, '\n\n│ Which approach…\n\n❯'),
      screen.replace('☐ Approach', '← ☐ Approach ☐ Other ✔ Submit →'),
    ]) {
      expect(visible).not.toBe(screen);
      const call = pending();
      expect(matchesNativePlanQuestion(visible, call), visible).toBe(false);
      expect(capturePlanCountQuestion(visible, new Set(), 0, true, call)?.nativeCall).toBeUndefined();
    }
    const packet = pending(); packet.questions.push(structuredClone(packet.questions[0]!));
    expect(matchesNativePlanQuestion(screen, packet)).toBe(false);
  });

  test('answer state, failed calls and late metadata retain existing guards and deduplication', () => {
    for (const call of [completed, { ...pending(), failed: true }]) {
      expect(capturePlanCountQuestion(screen, new Set(), 0, true, call)?.nativeCall).toBeUndefined();
    }
    const seen = new Set<string>();
    const unbound = capturePlanCountQuestion(screen, seen, 0, true)!;
    expect(unbound.nativeCall).toBeUndefined();
    expect(pickCeoCountQuestion(nativePlanCallFingerprint(pending(), 0, true), unbound)).toBeNull();
    expect(capturePlanCountQuestion(screen, seen, 1, true, pending())).toBeNull();
    const nativeSeen = new Set<string>();
    expect(capturePlanCountQuestion(screen, nativeSeen, 0, true, pending())?.nativeCall).toBeDefined();
    expect(capturePlanCountQuestion(screen, nativeSeen, 1, true, pending())).toBeNull();
    expect(capturePlanCountQuestion(screen, nativeSeen, 2, true)).toBeNull();
  });
});

test.skipIf(process.platform === 'win32')('real fake CLI receives the offered recommendation instead of default A', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-truncated-'));
  const fake = path.join(dir, 'fake-claude');
  const worker = path.join(dir, 'worker.ts');
  const events = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'output.json');
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import fs from 'node:fs';import path from 'node:path';
const item=JSON.parse(process.env.TRUNCATED_CASE);const log=e=>fs.appendFileSync(item.events,JSON.stringify(e)+'\n');
const sid='truncated-'+process.pid;const nativePath=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',sid,sid+'.jsonl');fs.mkdirSync(path.dirname(nativePath),{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(nativePath,JSON.stringify({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
native('assistant',[{type:'text',text:'Fixture started.'}]);log({type:'start',pid:process.pid,cwd:process.cwd()});
let stage='startup';process.stdin.setRawMode?.(true);process.stdin.on('data',data=>{
 const input=data.toString();log({type:'input',stage,input});
 if(stage==='startup'){
  stage='question';native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'truncated',input:{questions:[item.question]}}]);
  process.stdout.write('\x1b[2J\x1b[H'+item.screen.replaceAll('\n','\r\n'));return;
 }
 if(stage!=='question'){log({type:'unexpected',input});return;}
 const digit=/^[1-9]$/.exec(input)?.[0];if(!digit){log({type:'unexpected',input});return;}
 stage='done';const choice=item.question.options[Number(digit)-1]?.label;
 native('user',[{type:'tool_result',tool_use_id:'truncated',content:'Answered'}],{toolUseResult:{answers:{[item.question.question]:choice}}});
 log({type:'choice',choice,input});
 const q={header:'Finding',question:'Apply the repair?',options:[{label:'Fix'},{label:'Keep'}]};
 native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'finding',input:{questions:[q]}}]);
 native('user',[{type:'tool_result',tool_use_id:'finding',content:'Answered'}],{toolUseResult:{answers:{[q.question]:'Fix'}}});
 process.stdout.write('\x1b[2J\x1b[HDone.\r\n');
});process.on('SIGINT',()=>process.exit(0));process.stdin.resume();
`);
  fs.chmodSync(fake, 0o755);
  const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
  const picker = pathToFileURL(path.join(import.meta.dir, 'helpers/ceo-approach-pick.ts')).href;
  fs.writeFileSync(worker, `import {runPlanSkillCounting} from ${JSON.stringify(runner)};import {pickCeoCountQuestion} from ${JSON.stringify(picker)};
const result=await runPlanSkillCounting({skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',followUpPrompt:'Review this fixture.',isLastStep0AUQ:()=>true,pickAUQ:pickCeoCountQuestion,defaultPick:1,reviewCountCeiling:1,timeoutMs:26000,env:{TRUNCATED_CASE:${JSON.stringify(JSON.stringify({ events, screen, question: completed.questions[0] }))}}});await Bun.write(${JSON.stringify(output)},JSON.stringify(result));`);
  const child = Bun.spawn([process.execPath, worker], { env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(result.outcome, JSON.stringify(result)).toBe('ceiling_reached');
    expect(result.step0Count).toBe(1);
    expect(result.reviewCount).toBe(1);
    const rows = fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.type === 'input').map(row => row.input)).toEqual(['/plan-ceo-review\r', '2']);
    expect(rows.find(row => row.type === 'choice').choice).toBe(completed.questions[0]!.options[1]!.label);
    expect(rows.some(row => row.type === 'unexpected')).toBe(false);
    expect(() => process.kill(rows[0].pid, 0)).toThrow();
    expect(fs.existsSync(rows[0].cwd)).toBe(false);
  } finally {
    clearTimeout(timer); child.kill('SIGKILL'); await child.exited;
    if (fs.existsSync(events)) {
      const first = JSON.parse(fs.readFileSync(events, 'utf8').split('\n')[0]!);
      try {
        const argv = process.platform === 'linux'
          ? fs.readFileSync('/proc/' + first.pid + '/cmdline', 'utf8').split('\0')
          : Bun.spawnSync(['ps', '-p', String(first.pid), '-o', 'command='], { timeout: 1000 }).stdout.toString().trim().split(/\s+/);
        if (argv.includes(fake)) process.kill(first.pid, 'SIGKILL');
      } catch { /* owned child already closed */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 35000);
