import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { capturePlanCountQuestion, isRejectedSlashCommand, matchesNativePlanQuestion, planCountQuestionInput, runPlanSkillCounting, stripAnsi } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import boxedFrames from './fixtures/design-ui-boxed-question.json';

// Exact public tool-result frame from the first Sep 15 Design UI attempt.
const TOOL_HELP_FRAME = "● Bash(eval \"$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)\"\n      eval \"$(~/.claude/skills/gstack/bin/gstack-paths)\"…)\n  ⎿  DESIGN_DIR: /tmp/gstack-owned-display-9o13klaz/gstack-paid-shard-awmDRC/tmp/gstack-native-review-state-mT1Xxz/\n     projects/gstack-plan-count-UAhijs/designs/user-dashboard-20260915\n     Unknown command: --help\n     … +34 lines (ctrl+o to expand)\n  ⎿  Allowed by auto mode classifier\n\n";

test('a tool help error does not reject the successfully invoked review skill', () => {
  expect(isRejectedSlashCommand(TOOL_HELP_FRAME, '/plan-design-review')).toBe(false);
  for (const other of ['--help', '/other-review', '/plan-design-review-extra']) {
    expect(isRejectedSlashCommand(`Unknown command: ${other}`, '/plan-design-review')).toBe(false);
  }
  expect(isRejectedSlashCommand('Quoted: Unknown command: /plan-design-review', '/plan-design-review')).toBe(false);
});

test('the requested native slash rejection remains an immediate failure', () => {
  // Both forms are emitted by the pinned Claude CLI's cmd_unknown branch.
  for (const suffix of ['', '. Did you mean /plan-eng-review?']) {
    expect(isRejectedSlashCommand(`Unknown command: /plan-design-review${suffix}`, '/plan-design-review')).toBe(true);
    expect(isRejectedSlashCommand(`\x1b[31mUnknown command: /plan-design-review${suffix}\x1b[0m`, '/plan-design-review')).toBe(true);
  }
});


describe('complete boxed native questions', () => {
  const pending = (capture: typeof boxedFrames[number]): NativePlanQuestionCall => structuredClone(capture.call);
  const pane = (screen: string) => screen.slice(screen.indexOf(' ☐ Board'));

  test.each(boxedFrames)('binds the exact retained attempt $attempt question without answer credit', capture => {
    const call = pending(capture);
    expect(call.questions[0]!.question.length).toBeGreaterThan(240);
    expect(matchesNativePlanQuestion(capture.screen, call)).toBe(true);
    const active = capturePlanCountQuestion(capture.screen, new Set(), 0, false, call)!;
    expect(active.nativeCall).toBe(call);
    expect(active.nativeQuestionIndex).toBe(0);
    expect(active.options).toEqual(call.questions[0]!.options.map((option, i) => ({ index: i + 1, label: option.label })));
    expect(planCountQuestionInput(capture.screen, active, 1)).toBe('1');
    expect(call.answered).toBe(false);
    expect(call.answers).toBeUndefined();
  });

  test('preserves the supported question presentation class across wrapping and terminal decoration', () => {
    for (const capture of boxedFrames) {
      const call = pending(capture);
      const wrapped = call.questions[0]!.question.match(/.{1,60}(?:\s|$)|\S+/g)!.map(line => `│ ${line.trim()}`).join('\n');
      for (const screen of [
        pane(capture.screen),
        capture.screen.replace(/^│ /gm, ''),
        capture.screen.replace(/^│ /gm, '┃ '),
        capture.screen.replaceAll('\n', '\r\n'),
        // The session decodes ANSI before the visible-frame matcher runs.
        stripAnsi(`\x1b[32m${capture.screen}\x1b[0m`),
        capture.screen.replace(/\n\n│[\s\S]*?\n\n❯/, `\n\n${wrapped}\n\n❯`),
      ]) expect(matchesNativePlanQuestion(screen, call), screen).toBe(true);
    }
  });

  test('requires the entire native question and current header, including text after character 240', () => {
    for (const capture of boxedFrames) {
      const call = pending(capture);
      const after240 = "I'll generate new variants.";
      expect(call.questions[0]!.question.indexOf(after240)).toBeGreaterThan(240);
      for (const screen of [
        capture.screen.replace('☐ Board', '☐ Different board'),
        capture.screen.replace(/\/boards\/[^/]+\//, '/boards/foreign/'),
        capture.screen.replace(after240, "I'll discard those variants."),
        capture.screen.replace(/^│ submitted[^\n]*\n/m, ''),
      ]) {
        expect(screen).not.toBe(capture.screen);
        expect(matchesNativePlanQuestion(screen, call), screen).toBe(false);
        expect(capturePlanCountQuestion(screen, new Set(), 0, false, call)?.nativeCall).toBeUndefined();
      }
    }
  });

  test('retains literal leading and interior rails as part of the full question identity', () => {
    for (const capture of boxedFrames) {
      const call = pending(capture);
      const first = capture.screen.match(/^│ (.*)$/m)![1]!;
      const extraLeading = capture.screen.replace(`│ ${first}`, `│ │${first}`);
      const extraInterior = capture.screen.replace('comparison board with', 'comparison │board with');
      expect(matchesNativePlanQuestion(extraLeading, call)).toBe(false);
      expect(matchesNativePlanQuestion(extraInterior, call)).toBe(false);
      const literal = pending(capture);
      literal.questions[0]!.question = `│${literal.questions[0]!.question}`;
      expect(matchesNativePlanQuestion(extraLeading, literal)).toBe(true);
      expect(matchesNativePlanQuestion(capture.screen, literal)).toBe(false);
      const interior = pending(capture);
      interior.questions[0]!.question = interior.questions[0]!.question.replace('comparison board with', 'comparison │board with');
      expect(matchesNativePlanQuestion(extraInterior, interior)).toBe(true);
      expect(matchesNativePlanQuestion(capture.screen, interior)).toBe(false);
    }
  });

  test('requires current pane structure and rejects quoted, fenced or superseded copies', () => {
    for (const capture of boxedFrames) {
      const call = pending(capture);
      for (const screen of [
        capture.screen.split('\n').map(line => `> ${line}`).join('\n'),
        'Quoted earlier menu:\n' + pane(capture.screen),
        'Unrelated descriptive prose:\n' + pane(capture.screen),
        '```text\n' + capture.screen,
        '~~~text\n' + capture.screen,
        '````text\n```\n' + capture.screen,
        '~~~text\n```\n' + capture.screen,
        capture.screen + '\nA later question?',
        capture.screen + '\n☐ Other\nA different question?\n❯ 1. Submitted\n  2. Wait\nEnter to select · ↑/↓ to navigate · Esc to cancel',
      ]) {
        expect(matchesNativePlanQuestion(screen, call), screen).toBe(false);
        expect(capturePlanCountQuestion(screen, new Set(), 0, false, call)?.nativeCall).toBeUndefined();
      }
      // Closed historical source does not hide a later real native pane.
      for (const prefix of ['```text\nold source\n```\n', '~~~text\nold source\n~~~~\n']) {
        expect(matchesNativePlanQuestion(prefix + capture.screen, call)).toBe(true);
      }
    }
  });

  test('requires all offered choices, supported controls and the final native footer on the new path', () => {
    for (const capture of boxedFrames) {
      const call = pending(capture);
      for (const screen of [
        capture.screen.replace('3. Type preferences', '3. Type pref'),
        capture.screen.replace(/^  3\. Type preferences\n[^\n]*\n/m, ''),
        capture.screen.replace('4. Type something.', '4. Perform another action'),
        capture.screen.replace('5. Chat about this', '5. Accept everything'),
        capture.screen.replace('↑/↓ to navigate', '↑/↓ to navigte'),
        capture.screen.replace('Enter to select · ↑/↓ to navigate · Esc to cancel', ''),
      ]) {
        expect(screen).not.toBe(capture.screen);
        expect(matchesNativePlanQuestion(screen, call), screen).toBe(false);
        expect(capturePlanCountQuestion(screen, new Set(), 0, false, call)?.nativeCall).toBeUndefined();
      }
    }
  });

  test('keeps pending ownership, answered state and native/rendered deduplication unchanged', () => {
    for (const capture of boxedFrames) {
      for (const call of [undefined, { ...pending(capture), answered: true }, { ...pending(capture), failed: true }]) {
        expect(capturePlanCountQuestion(capture.screen, new Set(), 0, false, call)?.nativeCall).toBeUndefined();
      }
      const seen = new Set<string>(), call = pending(capture);
      expect(capturePlanCountQuestion(capture.screen, seen, 0, false, call)?.nativeCall).toBe(call);
      expect(capturePlanCountQuestion(capture.screen, seen, 1, false, call)).toBeNull();
      expect(capturePlanCountQuestion(capture.screen, seen, 2, false)).toBeNull();
      const delayed = new Set<string>();
      expect(capturePlanCountQuestion(capture.screen, delayed, 0, false)?.nativeCall).toBeUndefined();
      expect(capturePlanCountQuestion(capture.screen, delayed, 1, false, call)).toBeNull();
    }
  });
});

test.skipIf(process.platform === 'win32').each(['answer', 'throw', 'unbound'] as const)(
  'real counting loop binds a pending board before publication and preserves %s evidence', async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-ui-count-recovery-'));
    const fake = path.join(root, 'fake-claude'), worker = path.join(root, 'worker.ts');
    const events = path.join(root, 'events.jsonl'), resultFile = path.join(root, 'result.json');
    const evalDir = path.join(root, 'eval');
    const helper = (name: string) => pathToFileURL(path.join(import.meta.dir, 'helpers', name)).href;
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs'; import * as path from 'node:path';
const cwd=process.cwd(), session='owned-board-session', id='owned-board-call';
const {resolveStateFilePath}=await import(process.env.PROBE_STATE_MODULE);
const designCwd=path.join(process.env.GSTACK_STATE_ROOT,'projects','owned','designs','board');
fs.mkdirSync(designCwd,{recursive:true});process.chdir(designCwd);
const resolvedState=resolveStateFilePath();process.chdir(cwd);

const journal=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','owned',session+'.jsonl');
fs.mkdirSync(path.dirname(journal),{recursive:true});
const record=value=>fs.appendFileSync(process.env.PROBE_EVENTS,JSON.stringify(value)+'\n');
record({kind:'state-binding',cwd,designCwd,resolvedState,envState:process.env.DESIGN_DAEMON_STATE_FILE});

const persist=(role,content,extra={})=>fs.appendFileSync(journal,JSON.stringify({cwd,sessionId:session,
  isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
const question={header:'Comparison board',question:'Review http://127.0.0.1:48123/boards/owned-fixture/ and continue?',
  multiSelect:false,options:[{label:'Submitted',description:'Feedback was submitted.'},
    {label:'Type preferences',description:'Use a manual preference.'}]};
const at=process.argv.indexOf('--settings'), settings=JSON.parse(process.argv[at+1]);
async function hook(kind) {
  const entries=settings.hooks[kind]?.filter(e=>e.matcher==='^AskUserQuestion$')??[];
  if(entries.length!==1||entries[0].hooks.length!==1||entries[0].hooks[0].timeout!==5)throw Error('missing scoped observer');
  const payload={hook_event_name:kind,tool_name:'AskUserQuestion',session_id:session,tool_use_id:id,
    cwd,transcript_path:journal,tool_input:{questions:[question]}};
  const child=Bun.spawn(['bash','-c',entries[0].hooks[0].command],{
    stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  record({kind:'hook',event:kind,code,out,err});if(code||out||err)throw Error('observer changed native response');
}
let started=false, ready=false, answered=false;
process.stdin.setRawMode?.(true);process.stdin.resume();
process.stdin.on('data',async data=>{
  const input=data.toString();record({kind:'input',input});
  if(!started){
    if(input!=='/plan-design-review\r')throw Error('wrong initial command');started=true;
    persist('assistant',[{type:'text',text:'Preparing the owned board.'}]);
    process.stdout.write('\x1b[2J\x1b[H'+process.env.PROBE_HELP_FRAME.replace(/\n/g,'\r\n'));
    setTimeout(async()=>{
      await hook('PreToolUse');ready=true;
      const screen='☐ Comparison board\n'+question.question+'\n❯ 1. Submitted\n  2. Type preferences\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
      process.stdout.write('\x1b[2J\x1b[H'+screen.replace(/\n/g,'\r\n'));
    },3000);return;
  }
  if(!ready||answered||input!=='1')throw Error('unowned or duplicate board input');
  answered=true;await hook('PostToolUse');
  persist('assistant',[{type:'tool_use',id,name:'AskUserQuestion',input:{questions:[question]}}]);
  persist('user',[{type:'tool_result',tool_use_id:id,content:'Answered.'}],{toolUseResult:{answers:{[question.question]:'Submitted'}}});
  process.stdout.write('\x1b[2J\x1b[HBOARD_ACKNOWLEDGED\r\n');
});
process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
`, { mode: 0o755 });
    fs.writeFileSync(worker, `
import * as fs from 'node:fs';
import {runPlanSkillCounting,resolveClaudeBinary} from ${JSON.stringify(helper('claude-pty-runner.ts'))};
if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('fake CLI binding failed');
let picks=0, originalError;
try {
  const observation=await runPlanSkillCounting({skillName:'plan-design-review',slashCommand:'/plan-design-review',
    followUpPrompt:'# Owned board ordering control',observeSetupQuestions:true,
    bindDesignBoardState:${mode !== 'unbound'},
    env:${JSON.stringify({ PROBE_EVENTS: events, PROBE_HELP_FRAME: TOOL_HELP_FRAME, PROBE_STATE_MODULE: pathToFileURL(path.resolve(import.meta.dir, '../design/src/daemon-state.ts')).href, DESIGN_DAEMON_STATE_FILE: path.join(root, 'foreign', 'design.json') })},
    isLastStep0AUQ:()=>false,isReviewAUQ:fp=>fp.nativeCall?.answered===true,
    reviewCountCeiling:1,timeoutMs:28000,pickAUQ:(_routing,active)=>{
      if(!active.nativeCall||active.nativeCall.answered||active.nativeCall.toolUseId!=='owned-board-call')throw Error('board missing owned pending identity');
      picks++;if(${JSON.stringify(mode)}==='throw')throw Error('controlled board actor failure');return 1;
    }});
  fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({picks,observation}));
}catch(error){originalError=error.message;fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({picks,error:originalError}));}
`);
    const child = Bun.spawn([process.execPath, worker], {
      env: { ...process.env, EVALS_HERMETIC: '1', EVALS_RUN_ID: `board-ordering-${mode}`,
        GSTACK_EVAL_DIR: evalDir, BROWSE_TERMINAL_BINARY: fake, PROBE_EVENTS: events, PROBE_HELP_FRAME: TOOL_HELP_FRAME },
      stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 32_000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(0);
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      expect(result.picks, JSON.stringify(result)).toBe(1);
      const rows = fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.kind === 'input').map(row => row.input)).toEqual(
        mode !== 'throw' ? ['/plan-design-review\r', '1'] : ['/plan-design-review\r']);
      const binding = rows.find(row => row.kind === 'state-binding');
      expect(binding.designCwd.startsWith(binding.cwd + path.sep)).toBe(false);
      const expectedState = mode === 'unbound' ? path.join(root, 'foreign', 'design.json')
        : path.join(binding.cwd, '.gstack', 'design.json');
      expect(binding.envState).toBe(expectedState);
      expect(binding.resolvedState).toBe(expectedState);
      const run = path.join(evalDir, 'pty-count', `board-ordering-${mode}`);
      const snapshots = fs.readdirSync(run);
      expect(snapshots).toHaveLength(1);
      const artifact = path.join(run, snapshots[0]!);
      const saved = JSON.parse(fs.readFileSync(path.join(artifact, 'observation.json'), 'utf8'));
      expect(fs.existsSync(saved.capture.cwd)).toBe(false);
      if (mode !== 'throw') {
        expect(result.observation.outcome).toBe('ceiling_reached');
        expect(result.observation.reviewCount).toBe(1);
        expect(result.observation.transcript.calls).toHaveLength(1);
        expect(result.observation.transcript.calls[0].answered).toBe(true);
        expect(saved.outcome).toBe('ceiling_reached');
      } else {
        expect(result.error).toBe('controlled board actor failure');
        expect(saved.state).toBe('threw');
        expect(saved.error).toBe(result.error);
        expect(saved.reviewCount).toBe(0);
        expect(saved.transcript.calls).toEqual([]);
        expect(saved.pendingQuestion).toMatchObject({ toolUseId: 'owned-board-call', answered: false, source: 'pre_tool_use' });
        expect(fs.readFileSync(path.join(artifact, 'terminal.screen.log'), 'utf8')).toContain('/boards/owned-fixture/');
        expect(fs.readFileSync(path.join(artifact, 'terminal.raw.log'), 'utf8')).toContain('Submitted');
        expect(err).toContain(`Full PTY artifacts: ${artifact}`);
      }
    } finally {
      clearTimeout(timer); child.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 35_000,
);


test('Design state binding rejects unrelated callers or a missing actor before fixture creation', async () => {
  for (const control of [
    {skillName: 'plan-eng-review', pickAUQ: () => 1},
    {skillName: 'plan-design-review'},
  ]) {
    // The independently invalid budget also prevents any process launch if
    // the ownership guard regresses; this free control cannot invoke a model.
    await expect(runPlanSkillCounting({
      ...control, slashCommand: '/plan-design-review', followUpPrompt: 'Ownership control',
      bindDesignBoardState: true, timeoutMs: 1000,
      isLastStep0AUQ: () => false, reviewCountCeiling: 1,
    })).rejects.toThrow('Design board state binding requires the Design caller and its declared picker');
  }
});
