import { describe, expect, test } from 'bun:test';
import { findCeoModeOption, hasPostAnswerCeoPosture, hasNativePostAnswerCeoPosture, nativeCeoModeAnswer, nextCeoModeNavigation, nextCeoPostureContinuation } from './helpers/ceo-mode-option';
import { parseNumberedOptions, stripAnsi } from './helpers/claude-pty-runner';
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
