import { describe, expect, test } from 'bun:test';
import { findCeoModeOption, hasPostAnswerCeoPosture, hasNativePostAnswerCeoPosture, nativeCeoModeAnswer, nextCeoModeNavigation, nextCeoPostureContinuation } from './helpers/ceo-mode-option';
import { parseNumberedOptions, stripAnsi, planCountQuestionInput, nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

describe('CEO mode option matching', () => {
  test('selects option 4 from the failed Claude Code 2.1.257 menu capture', () => {
    // Labels and side-pane residue from the 2026-09-08 paid failure. The
    // option existed; literal includes("SCOPE EXPANSION") could not see it.
    // The failure log preserves parsed labels, not the original raw frame.
    const options = [
      { index: 1, label: 'SELECTIVEEXPANSION┌────────────────────────────────────────────────────────────────────────────────────┐\r    (ecommnded)                │SELECTIVEEXPANSION│' },
      { index: 2, label: 'HOLD SCOPE                  │  Hld scope: eview rigorusly fr failure modes, edg ass, observability.│' },
      { index: 3, label: 'SCOPE REDUCTION              │   Then surface: cherry-pikableadditions you ca Accept/Defer/Skip.│' },
      { index: 4, label: 'SCOPEEXPANSION│Neutralposture:presentopportunities,stateeffort,youdecide.│\r                           │  Good for: substantialfeaturewithsolidfoundation,shippedbeforescopelock.│\r└────────────────────────────────────────────────────────────────────────────────────┘' },
    ];
    expect(findCeoModeOption(options, 'SCOPE EXPANSION')).toBe(4);
    expect(findCeoModeOption(options, 'HOLD SCOPE')).toBe(2);
    expect(findCeoModeOption(options, 'SELECTIVE EXPANSION')).toBe(1);
  });

  test('recognizes the mode question when every label loses its inter-word spaces', () => {
    const frame = stripAnsi([
      '❯ 1. HOLD\x1b[1CSCOPE (recommended)',
      '  2. SELECTIVE\x1b[1CEXPANSION',
      '  3. SCOPE\x1b[1CEXPANSION',
      '  4. SCOPE\x1b[1CREDUCTION',
    ].join('\n'));
    const options = parseNumberedOptions(frame);
    expect(findCeoModeOption(options, 'SCOPE EXPANSION')).toBe(3);
    expect(findCeoModeOption(options, 'SCOPE REDUCTION')).toBe(4);
  });

  test('retains spaced, mixed-case labels and recommendation suffixes', () => {
    expect(findCeoModeOption([
      { index: 1, label: 'Scope Expansion (recommended)' },
      { index: 2, label: 'HOLD SCOPE' },
    ], 'SCOPE EXPANSION')).toBe(1);
  });

  test('still fails on the earlier three-option capture with no expansion target', () => {
    const options = [
      { index: 1, label: 'HOLD SCOPE (recommended)    ┌─────────────────────────────────────────────────────────────┐' },
      { index: 2, label: 'SELECTIVE EXPANSION        │HOLD SCOPE                                             │' },
      { index: 3, label: 'SCOPE REDUCTION             │   Codeiswritten.Makeitbulletproof.│' },
    ];
    expect(() => findCeoModeOption(options, 'SCOPE EXPANSION'))
      .toThrow('target "SCOPE EXPANSION" not in option labels');
  });

  test('does not select another mode because the side pane mentions the target', () => {
    expect(() => findCeoModeOption([
      { index: 1, label: 'HOLD SCOPE │ SCOPE EXPANSION is another option' },
      { index: 2, label: 'SELECTIVEEXPANSION┌ SCOPEEXPANSION' },
    ], 'SCOPE EXPANSION')).toThrow('target "SCOPE EXPANSION" not in option labels');
  });

  test('leaves unrelated navigation questions to the existing driver', () => {
    expect(findCeoModeOption([
      { index: 1, label: 'Review HOLD SCOPE examples' },
      { index: 2, label: 'Choose a plan │ SCOPE EXPANSION' },
    ], 'HOLD SCOPE')).toBeNull();
  });

  test('helper and regression changes select only the mode-routing paid eval', () => {
    for (const file of ['test/helpers/ceo-mode-option.ts', 'test/ceo-mode-option.test.ts', 'test/pty-option-selection.test.ts']) {
      expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['plan-ceo-mode-routing']);
    }
  });
});

describe('CEO mode navigation replay', () => {
  test('advances different setup questions with the same choices and ignores redraws', () => {
    const seen = new Set<string>();
    const first = '☐Routing\rEnable skill routing?\r❯1.Enable\r2.Skip';
    const next = '☐Learnings\rEnable cross-project learnings?\r❯1.Enable\r2.Skip';
    expect(nextCeoModeNavigation(first, 'HOLD SCOPE', seen).kind).toBe('question');
    expect(nextCeoModeNavigation(first, 'HOLD SCOPE', seen).kind).toBe('wait');
    expect(nextCeoModeNavigation(next, 'HOLD SCOPE', seen).kind).toBe('question');
    expect(seen.size).toBe(2);
  });

  test('navigates the captured unanswered setup tab before submitting, without counting Submit', () => {
    const seen = new Set<string>();
    const partial = [
      '← ☒ Skill routing ☐ Learnings scope ✔ Submit →',
      'Review your answers',
      '⚠You have not answered all questions',
      '❯1.Submit aswers',
      '2Cancel',
    ].join('\r\r');
    expect(nextCeoModeNavigation(partial, 'HOLD SCOPE', seen)).toEqual({ kind: 'submission', input: '\x1b[Z' });
    expect(seen.size).toBe(0);
    const question = '← ☒ Skill routing ☐ Learnings scope ✔ Submit →\rEnable cross-project learnings?\r❯1.Enable\r2.Skip';
    expect(nextCeoModeNavigation(`${partial}\r${question}`, 'HOLD SCOPE', seen).kind).toBe('question');
    const answered = partial.replace('☐ Learnings scope', '☒ Learnings scope').replace('⚠You have not answered all questions', '');
    expect(nextCeoModeNavigation(answered, 'HOLD SCOPE', seen)).toEqual({ kind: 'submission', input: '\r' });
    expect(seen.size).toBe(1);
  });

  test('handles native permission controls before question parsing and dedup', () => {
    const seen = new Set<string>();
    const permission = 'DoyouwanttooverwriteCLAUDE.md?\r❯1.Yes\r2.No\rEsctocancel·Tabtoamend';
    expect(nextCeoModeNavigation(permission, 'HOLD SCOPE', seen)).toEqual({ kind: 'permission', input: '1\r' });
    expect(seen.size).toBe(0);
    const actual = '☐ Approaches\rWhich storage strategy?\r❯1.Server\r2.Local';
    expect(nextCeoModeNavigation(`${permission}\r${actual}`, 'HOLD SCOPE', seen).kind).toBe('question');
  });

  test('file permission lifecycle is shared by navigation and posture without becoming an AUQ', () => {
    const seen = new Set<string>();
    const permission = 'Do you want to overwrite CLAUDE.md?\n❯1.Yes\n2.No\nEsc to cancel · Tab to amend';
    const transcript: PlanCountTranscript = { status: 'missing', calls: [], assistantMessages: [] };
    expect(nextCeoModeNavigation(permission, 'HOLD SCOPE', seen).kind).toBe('permission');
    expect(nextCeoModeNavigation(permission, 'HOLD SCOPE', seen).kind).toBe('wait');
    expect(nextCeoPostureContinuation(permission, transcript, 'HOLD SCOPE', 0, seen, true)).toBeNull();
    const completed = permission + '\n⎿ Added1line\n';
    expect(nextCeoPostureContinuation(completed, transcript, 'HOLD SCOPE', 0, seen, true)).toBeNull();
    expect(nextCeoModeNavigation(completed, 'HOLD SCOPE', seen).kind).toBe('wait');
    const again = completed + permission;
    expect(nextCeoPostureContinuation(again, transcript, 'HOLD SCOPE', 0, seen, true)).toBe('permission');
    expect(nextCeoModeNavigation(again, 'HOLD SCOPE', seen).kind).toBe('wait');
    expect(seen.size).toBe(0);
    const question = '☐ Approaches\nWhich storage strategy?\n❯1.Server\n2.Local';
    expect(nextCeoModeNavigation(again + '\n' + question, 'HOLD SCOPE', seen).kind).toBe('question');
    expect(seen.size).toBe(1);
    // Different sessions retain independent permission state.
    expect(nextCeoModeNavigation(permission, 'HOLD SCOPE', new Set()).kind).toBe('permission');
  });

  test('selects the intended mode from the observed menu, preserving its index', () => {
    const frame = '☐ReviewMode\rWhat review posture should I use?\r❯1.SELECTIVEEXPANSION(recommended)\r2.HOLDSCOPE\r3.SCOPEEXPANSION\r4.SCOPEREDUCTION';
    for (const [mode, index] of [['HOLD SCOPE', 2], ['SCOPE EXPANSION', 3]] as const) {
      const action = nextCeoModeNavigation(frame, mode, new Set());
      expect(action.kind).toBe('mode');
      if (action.kind === 'mode') expect(action.index).toBe(index);
    }
  });
});

describe('CEO posture evidence after mode selection', () => {
  const posture = /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i;
  const menu = [
    '☐ Review mode',
    '❯1.SELECTIVEEXPANSION(recommended)',
    '2.HOLD SCOPE │ Code is written. Make it bulletproof.',
    '3.SCOPE EXPANSION',
    '4.SCOPE REDUCTION',
    'Enter to select · ↑/↓ to navigate',
  ].join('\r');

  test('menu redraw and native selected-option echo cannot satisfy the posture gate', () => {
    expect(posture.test(menu)).toBe(true); // The old unscoped check passed here.
    expect(hasPostAnswerCeoPosture(menu, posture)).toBe(false);
    const answer = "⏺ User answered Claude's questions:\r⎿ · Review mode? → HOLD SCOPE";
    expect(hasPostAnswerCeoPosture(`${menu}\r${answer}`, posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('❯ HOLD SCOPE\r● HOLD SCOPE', posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('● Selected option: HOLD SCOPE', posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('● HOLD SCOPE\r✶ Honking… (5s · ↓ 300 tokens)', posture)).toBe(false);
  });

  test('assistant output must itself contain the existing posture evidence', () => {
    expect(hasPostAnswerCeoPosture(`${menu}\r● I will inspect the plan now.`, posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('⏺ Read(plan-ceo-review/SKILL.md)\r  Review with maximum rigor.', posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('● high · /effort\rHOLD SCOPE', posture)).toBe(false);
    expect(hasPostAnswerCeoPosture(`● I will inspect the plan now.\r${menu}`, posture)).toBe(false);
  });

  test('accepts new assistant posture after the answered-question echo, including wrapped prose', () => {
    const answer = "⏺UseransweredClaude'squestions:\r⎿Reviewmode?→HOLDSCOPE";
    expect(hasPostAnswerCeoPosture(`${answer}\r● HOLD SCOPE. I will review the existing scope for failure modes.`, posture)).toBe(true);
    expect(hasPostAnswerCeoPosture(`${answer}\r⏺\rI will apply maximum rigor\rto the agreed scope.`, posture)).toBe(true);
    const expansion = /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i;
    expect(hasPostAnswerCeoPosture(`${answer}\r● I will explore expansion opportunities that improve the saved-view workflow.`, expansion)).toBe(true);
  });
});

describe('native CEO mode posture evidence', () => {
  const selectedAt = Date.parse('2026-09-08T15:43:28.000Z');
  const posture = /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i;
  function transcript(text: string, answer = 'HOLD SCOPE'): PlanCountTranscript {
    // Actual question/options/answer shape from targeted-a's false-negative
    // HOLD SCOPE run. The native answer selected option3 correctly.
    const question = 'Which review mode should I use for this plan? <gstack-qid:plan-ceo-review-mode-selection>';
    return { status: 'ready', calls: [{
      sessionId: 'mode-session', toolUseId: 'mode-call', answered: true,
      answeredAt: '2026-09-08T15:43:30.405Z', answers: { [question]: answer },
      questions: [{ header: 'Review mode', question, options: [
        { label: 'SELECTIVE EXPANSION (Recommended)' }, { label: 'SCOPE EXPANSION' },
        { label: 'HOLD SCOPE' }, { label: 'SCOPE REDUCTION' },
      ] }],
    }], assistantMessages: [{ sessionId: 'mode-session', timestamp: '2026-09-08T15:44:01.150Z', text }] };
  }

  test('recognizes the retained native answer followed by actual HOLD SCOPE analysis', () => {
    const captured = 'HOLD SCOPE mode confirmed. Running Step 0D analysis, then reading the review sections file.\n\n**0D — HOLD SCOPE Analysis**\n\n**Complexity check:**\nThe plan introduces: 1 DB migration, 1 SavedView model, 1 CRUD API module (~4 endpoints), 1 view picker UI component, and integration into the existing filter UI.';
    expect(hasNativePostAnswerCeoPosture(transcript(captured), 'HOLD SCOPE', posture, selectedAt)).toBe(true);
  });

  test('wrong, missing, failed, or earlier mode answers cannot establish target routing', () => {
    const text = 'I will apply maximum rigor to the existing plan.';
    expect(hasNativePostAnswerCeoPosture(transcript(text, 'SCOPE EXPANSION'), 'HOLD SCOPE', posture, selectedAt)).toBe(false);
    for (const change of [{ answered: false }, { failed: true }, { answers: {} }, { answeredAt: undefined }]) {
      const t = transcript(text); Object.assign(t.calls[0]!, change);
      expect(hasNativePostAnswerCeoPosture(t, 'HOLD SCOPE', posture, selectedAt)).toBe(false);
    }
    expect(hasNativePostAnswerCeoPosture(transcript(text), 'HOLD SCOPE', posture, selectedAt + 10000)).toBe(false);
  });

  test('prior or foreign assistant prose, a menu, source quotation, and bare confirmation remain insufficient', () => {
    for (const text of [
      '', 'HOLD SCOPE', '**HOLD SCOPE mode confirmed.**',
      'Which mode?\n1. SELECTIVE EXPANSION\n2. HOLD SCOPE\n3. SCOPE EXPANSION',
      '```markdown\nReview with maximum rigor.\n```',
      '> Review with maximum rigor.',
      'Read(SKILL.md)\nReview with maximum rigor.',
    ]) expect(hasNativePostAnswerCeoPosture(transcript(text), 'HOLD SCOPE', posture, selectedAt)).toBe(false);
    for (const change of [{ timestamp: '2026-09-08T15:43:29.000Z' }, { sessionId: 'other-session' }]) {
      const t = transcript('I will apply maximum rigor.'); Object.assign(t.assistantMessages[0]!, change);
      expect(hasNativePostAnswerCeoPosture(t, 'HOLD SCOPE', posture, selectedAt)).toBe(false);
    }
    expect(hasNativePostAnswerCeoPosture({ status: 'missing', calls: [], assistantMessages: [] }, 'HOLD SCOPE', posture, selectedAt)).toBe(false);
  });

  test('continuation requires the confirmed target and permits at most one fresh downstream question', () => {
    const t = transcript('');
    const fresh = '☐ Architecture\nD4 — Guard the member-scoped lookup?\n❯1.Add the guard\n2.Defer';
    const mode = '☐ Review mode\nWhich review mode?\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION';
    const seen = new Set<string>();
    expect(nextCeoPostureContinuation(mode, t, 'HOLD SCOPE', selectedAt, seen, false)).toBeNull();
    expect(nextCeoPostureContinuation(fresh, transcript('', 'SCOPE EXPANSION'), 'HOLD SCOPE', selectedAt, seen, false)).toBeNull();
    expect(nextCeoPostureContinuation(fresh, t, 'HOLD SCOPE', selectedAt, seen, false)).toBe('question');
    expect(nextCeoPostureContinuation(fresh, t, 'HOLD SCOPE', selectedAt, seen, false)).toBeNull();
    expect(nextCeoPostureContinuation(fresh.replace('member-scoped', 'project-scoped'), t, 'HOLD SCOPE', selectedAt, seen, true)).toBeNull();
    expect(nativeCeoModeAnswer(t, 'HOLD SCOPE', selectedAt)?.toolUseId).toBe('mode-call');
    const permission = 'DoyouwanttooverwriteCLAUDE.md?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';
    expect(nextCeoPostureContinuation(permission, t, 'HOLD SCOPE', selectedAt, seen, false)).toBe('permission');
    expect(nextCeoPostureContinuation(permission, t, 'HOLD SCOPE', selectedAt, seen, false)).toBeNull();
  });

  test.skipIf(process.platform === 'win32')('one downstream answer releases delayed native prose without passing on the streamed menu', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-posture-flush-'));
    const fake = path.join(dir, 'fake-claude');
    const worker = path.join(dir, 'worker.ts');
    const recordFile = path.join(dir, 'events.jsonl');
    const resultFile = path.join(dir, 'result.json');
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const record = event => fs.appendFileSync(process.env.POSTURE_RECORD, JSON.stringify(event) + '\n');
record({type:'startup', pid:process.pid});
const sessionId = 'fake-mode-session';
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
fs.mkdirSync(dir, {recursive:true});
const write = (role, content, extra = {}) => fs.appendFileSync(path.join(dir, sessionId + '.jsonl'), JSON.stringify({
  sessionId, cwd:process.cwd(), isSidechain:false, timestamp:new Date().toISOString(), message:{role,content}, ...extra,
}) + '\n');
const question = 'Which mode?';
write('assistant', [{type:'tool_use', id:'mode', name:'AskUserQuestion', input:{questions:[{header:'Mode', question,
  options:[{label:'HOLD SCOPE'},{label:'SCOPE EXPANSION'}]}]}}]);
write('user', [{type:'tool_result', tool_use_id:'mode', content:'Answered.'}], {toolUseResult:{answers:{[question]:'SCOPE EXPANSION'}}});
process.stdin.setRawMode?.(true);
let answered = false;
process.stdin.on('data', data => {
  record({type:'input', data:data.toString()});
  if (data.toString().includes('\r') && !answered) {
    answered = true;
    write('assistant', [{type:'text', text:'I will explore expansion opportunities that improve saved project views.'}]);
    process.stdout.write('\nPOSTURE_FLUSHED\n');
  }
});
process.stdout.write('POSTURE_READY\n● I will explore expansion opportunities.\n☐ Expansion 1\nD4 — Add shared project views?\n❯1.Add to scope\n2.Defer\n');
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
`);
    fs.chmodSync(fake, 0o755);
    const moduleUrl = (name: string) => pathToFileURL(path.resolve(import.meta.dir, 'helpers', name)).href;
    fs.writeFileSync(worker, `
import { launchClaudePty, selectPtyNumberedOption } from ${JSON.stringify(moduleUrl('claude-pty-runner.ts'))};
import { readPlanCountTranscript } from ${JSON.stringify(moduleUrl('plan-count-transcript.ts'))};
import { hasNativePostAnswerCeoPosture, nextCeoPostureContinuation } from ${JSON.stringify(moduleUrl('ceo-mode-option.ts'))};
const started = Date.now();
const session = await launchClaudePty({cwd:${JSON.stringify(dir)}, timeoutMs:5000, env:{POSTURE_RECORD:${JSON.stringify(recordFile)}}});
try {
  await session.waitFor('POSTURE_READY', {timeoutMs:2000, pollMs:20});
  const read = () => readPlanCountTranscript(session.hermeticConfigDir, ${JSON.stringify(dir)});
  const posture = /\\b(expansion|10x|delight|dream|cathedral|opt[\\s-]?in)\\b/i;
  const before = hasNativePostAnswerCeoPosture(read(), 'SCOPE EXPANSION', posture, started);
  const action = nextCeoPostureContinuation(session.visibleText(), read(), 'SCOPE EXPANSION', started, new Set(), false);
  if (action === 'question') await selectPtyNumberedOption(session, 1);
  await session.waitFor('POSTURE_FLUSHED', {timeoutMs:2000, pollMs:20});
  const after = hasNativePostAnswerCeoPosture(read(), 'SCOPE EXPANSION', posture, started);
  await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({before, action, after}));
} finally { await session.close(); }
`);
    const child = Bun.spawn([process.execPath, worker], {
      env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toEqual({before:false, action:'question', after:true});
      const events = fs.readFileSync(recordFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(e => e.type === 'input').map(e => e.data).join('')).toBe('1\r');
      expect(() => process.kill(events[0].pid, 0)).toThrow();
    } finally {
      clearTimeout(timer); child.kill('SIGKILL');
      if (fs.existsSync(recordFile)) {
        const first = JSON.parse(fs.readFileSync(recordFile, 'utf8').split('\n')[0]!);
        try { process.kill(first.pid, 'SIGKILL'); } catch { /* already reaped */ }
      }
      fs.rmSync(dir, {recursive:true, force:true});
    }
  }, 10_000);
});


const sidebarModeScreen = fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-mode-preview-aa-screen.txt'), 'utf8');
// The AA first SCOPE pane was retained in the terminal failure, but its native
// mode call never flushed. This pending call is synthetic identity coverage.
function sidebarPendingMode() {
  return {sessionId:'sidebar-fixture', toolUseId:'sidebar-mode', answered:false, failed:false,
    questions:[{header:'Review mode', question:'Which review mode should I use for this plan?', multiSelect:false,
      options:[
        {label:'SELECTIVE EXPANSION — baseline + cherry-pick (Recommended)'},
        {label:'HOLD SCOPE — maximum rigor, no expansions'},
        {label:'SCOPE EXPANSION — dream big'},
        {label:'SCOPE REDUCTION — strip to essentials'},
      ]}]};
}

describe('AA mode sidebar preview protocol', () => {
  test('submits the independently retained CEO count pane when Notes sits on a wrapped option line', () => {
    const screen=fs.readFileSync(path.join(import.meta.dir,'fixtures/ceo-count-mode-preview-aa-screen.txt'),'utf8');
    const action=nextCeoModeNavigation(screen,'HOLD SCOPE',new Set());
    expect(action.kind).toBe('mode');
    if(action.kind!=='mode')throw new Error('Expected mode');
    expect(action.index).toBe(1);
    expect(planCountQuestionInput(screen,action.question,1)).toBe('1\r');
    const native=nativePlanCallFingerprint(sidebarPendingMode(),0,true);
    for(const altered of [screen.replace('    bigger','  bigger'),screen.replace('  4. SCOPE EXPANSION — dream','  Unrelated unnumbered message'),screen.replace('    bigger','    bigger│')]) {
      expect(planCountQuestionInput(altered,native,1)).toBe('1');
    }
  });


  test('submits all four offered modes from the exact pane, with or without pending metadata', () => {
    for (const [mode,index] of [['SELECTIVE EXPANSION',1],['HOLD SCOPE',2],['SCOPE EXPANSION',3],['SCOPE REDUCTION',4]] as const) {
      for (const pending of [undefined,sidebarPendingMode()]) {
        const action=nextCeoModeNavigation(sidebarModeScreen,mode,new Set(),pending);
        expect(action.kind).toBe('mode');
        if(action.kind!=='mode')throw new Error('Expected mode');
        expect(action.index).toBe(index);
        expect(action.question.nativeCall).toBe(pending);
        expect(planCountQuestionInput(sidebarModeScreen,action.question,index)).toBe(`${index}\r`);
      }
    }
  });

  test('requires a complete aligned preview and exact notes protocol', () => {
    const fp=nativePlanCallFingerprint(sidebarPendingMode(),0,true);
    for(const frame of [
      sidebarModeScreen.replace('Notes: press n to add notes','Notes: press n to run a command'),
      sidebarModeScreen.replace('      Notes:','     Notes:'),
      sidebarModeScreen.replace(/┌─+┐/,'no preview box'),
      sidebarModeScreen.replace(/└─+┘/,'no preview bottom'),
      sidebarModeScreen.replace('└──','└─'),
      sidebarModeScreen+'\n☐ Next question\nWhat now?\n❯ 1. Continue\n  2. Stop\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
      sidebarModeScreen.replace(' · n to add notes',''),
      sidebarModeScreen.replace(' · Esc to cancel',''),
      sidebarModeScreen.replace('☐ Review mode','quoted Review mode'),
      sidebarModeScreen.replace('n to add notes · ','n to add notes · n to add notes · '),
      sidebarModeScreen+'\nUnrelated active prompt',
      sidebarModeScreen.split('\n').map(line=>'> '+line).join('\n'),
    ])expect(planCountQuestionInput(frame,fp,3)).toBe('3');
    const checkbox=sidebarPendingMode();checkbox.questions[0]!.multiSelect=true;
    expect(planCountQuestionInput(sidebarModeScreen,nativePlanCallFingerprint(checkbox,0,true),3)).toBe('3');
  });

  test('keeps the actual retry missing-target failure and independent answer/posture gates', () => {
    const omitted=[
      {index:1,label:'HOLD SCOPE — make the client-side plan bulletproof (Recommended)'},
      {index:2,label:'SELECTIVE EXPANSION — hold core scope but surface cherry-pick options'},
      {index:3,label:'SCOPE REDUCTION — cut to absolute minimum'},
      {index:4,label:'Type something.'},{index:5,label:'Chat about this'},
    ];
    expect(()=>findCeoModeOption(omitted,'SCOPE EXPANSION')).toThrow('target "SCOPE EXPANSION" not in option labels');
    const t:PlanCountTranscript={status:'ready',calls:[sidebarPendingMode()],assistantMessages:[
      {sessionId:'sidebar-fixture',timestamp:new Date().toISOString(),text:'I will explore expansion opportunities.'},
    ]};
    expect(hasNativePostAnswerCeoPosture(t,'SCOPE EXPANSION',/expansion/i,0)).toBe(false);
    const foreign=sidebarPendingMode();foreign.questions[0]!.header='Other';
    const action=nextCeoModeNavigation(sidebarModeScreen,'SCOPE EXPANSION',new Set(),foreign);
    expect(action.kind).toBe('mode');
    if(action.kind==='mode')expect(action.question.nativeCall).toBeUndefined();
  });
});

test.skipIf(process.platform==='win32')('AA sidebar fake CLI requires submission before native mode posture',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mode-sidebar-'));
  const fake=path.join(dir,'fake-claude');const worker=path.join(dir,'worker.ts');const output=path.join(dir,'result.json');
  const cases=[
    {mode:'SELECTIVE EXPANSION',index:1},{mode:'HOLD SCOPE',index:2},
    {mode:'SCOPE EXPANSION',index:3},{mode:'SCOPE REDUCTION',index:4},
    {mode:'SCOPE EXPANSION',index:3,digitOnly:true},
  ].map((item,i)=>({...item,cwd:path.join(dir,String(i)),record:path.join(dir,`${i}.jsonl`)}));
  for(const item of cases)fs.mkdirSync(item.cwd);
  fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import fs from 'node:fs';import path from 'node:path';
const item=JSON.parse(process.env.SIDEBAR_REPLAY);const record=row=>fs.appendFileSync(item.record,JSON.stringify(row)+'\n');
const sid='sidebar-'+process.pid;const file=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',sid,sid+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(file,JSON.stringify({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
record({type:'start',pid:process.pid});native('assistant',[{type:'text',text:'Review preview: expansion, rigor, and reduction.'}]);
let focused=1;let done=false;process.stdin.setRawMode?.(true);
process.stdin.on('data',data=>{
 const input=data.toString();record({type:'input',input});
 if(done){record({type:'unexpected',input});return;}
 const digit=/[1-4]/.exec(input)?.[0];
 if(digit)setTimeout(()=>{focused=Number(digit);record({type:'focus',focused});},25);
 if(!input.includes('\r'))return;done=true;
 const answer=item.question.options[focused-1].label;
 native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'mode',input:{questions:[item.question]}}]);
 native('user',[{type:'tool_result',tool_use_id:'mode',content:'Answered'}],{toolUseResult:{answers:{[item.question.question]:answer}}});
 record({type:'answer',answer});
 setTimeout(()=>{native('assistant',[{type:'text',text:'I will apply '+answer+' to assess this plan thoroughly.'}]);process.stdout.write('\r\nANSWER_READY\r\n');},25);
});
process.stdout.write('\x1b[2J\x1b[H'+item.screen.replaceAll('\n','\r\n'));process.on('SIGINT',()=>process.exit(0));process.stdin.resume();
`);fs.chmodSync(fake,0o755);
  const moduleUrl=(name:string)=>pathToFileURL(path.join(import.meta.dir,'helpers',name)).href;
  fs.writeFileSync(worker,`
import {launchClaudePty,selectPtyNumberedOption,planCountQuestionInput} from ${JSON.stringify(moduleUrl('claude-pty-runner.ts'))};
import {nextCeoModeNavigation,hasNativePostAnswerCeoPosture} from ${JSON.stringify(moduleUrl('ceo-mode-option.ts'))};
import {readPlanCountTranscript} from ${JSON.stringify(moduleUrl('plan-count-transcript.ts'))};
const cases=${JSON.stringify(cases)};const screen=${JSON.stringify(sidebarModeScreen)};const question=${JSON.stringify(sidebarPendingMode().questions[0])};
const results=await Promise.all(cases.map(async item=>{
 const session=await launchClaudePty({cwd:item.cwd,observeScreen:true,timeoutMs:5000,env:{SIDEBAR_REPLAY:JSON.stringify({...item,screen,question})}});
 try{
  await session.waitFor('Which review mode',{timeoutMs:2000,pollMs:20});
  const visible=await session.currentScreen();const action=nextCeoModeNavigation(visible,item.mode,new Set());
  if(action.kind!=='mode')throw new Error('Mode not captured');
  const started=Date.now();const before=readPlanCountTranscript(session.hermeticConfigDir,item.cwd);
  const beforeMatched=hasNativePostAnswerCeoPosture(before,item.mode,new RegExp(item.mode,'i'),started);
  const input=item.digitOnly?String(action.index):planCountQuestionInput(visible,action.question,action.index);
  if(input.includes('\\r'))await selectPtyNumberedOption(session,action.index);else session.send(input);
  if(!item.digitOnly)await session.waitFor('ANSWER_READY',{timeoutMs:1500,pollMs:20});else await Bun.sleep(150);
  const transcript=readPlanCountTranscript(session.hermeticConfigDir,item.cwd);
  return {mode:item.mode,digitOnly:!!item.digitOnly,index:action.index,input,beforeMatched,matched:hasNativePostAnswerCeoPosture(transcript,item.mode,new RegExp(item.mode,'i'),started)};
 }finally{await session.close();}
}));await Bun.write(${JSON.stringify(output)},JSON.stringify(results));
`);
  const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  try{
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code,out+err).toBe(0);
    const results=JSON.parse(fs.readFileSync(output,'utf8'));
    for(const [i,item] of cases.entries()){
      expect(results[i]).toEqual({mode:item.mode,digitOnly:!!item.digitOnly,index:item.index,input:String(item.index)+(item.digitOnly?'':'\r'),beforeMatched:false,matched:!item.digitOnly});
      const rows=fs.readFileSync(item.record,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      expect(rows.filter(row=>row.type==='input').map(row=>row.input)).toEqual(item.digitOnly?[String(item.index)]:[String(item.index),'\r']);
      expect(rows.filter(row=>row.type==='answer').length).toBe(item.digitOnly?0:1);
      expect(rows.some(row=>row.type==='unexpected')).toBe(false);
      expect(()=>process.kill(rows[0].pid,0)).toThrow();
    }
  }finally{
    clearTimeout(timer);child.kill('SIGKILL');await child.exited;
    for(const item of cases){
      if(!fs.existsSync(item.record))continue;const first=JSON.parse(fs.readFileSync(item.record,'utf8').split('\n')[0]!);
      try{
        const argv=process.platform==='linux'?fs.readFileSync('/proc/'+first.pid+'/cmdline','utf8').split('\0'):Bun.spawnSync(['ps','-p',String(first.pid),'-o','command='],{timeout:1000}).stdout.toString().trim().split(/\s+/);
        if(argv.includes(fake))process.kill(first.pid,'SIGKILL');
      }catch{/* owned child already closed */}
    }
    fs.rmSync(dir,{recursive:true,force:true});
  }
},12000);
