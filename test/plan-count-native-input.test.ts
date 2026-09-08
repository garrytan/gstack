import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  capturePlanCountQuestion,
  planCountQuestionInput,
} from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import {
  nextCeoModeNavigation,
  nextCeoPostureContinuation,
  hasNativePostAnswerCeoPosture,
} from './helpers/ceo-mode-option';
import { autoplanRoutingSetupInput } from './helpers/autoplan-setup-question';

const designOutsideQuestions = [
  {
    "question": "D3 (Step 0D) — I've rated this plan 5/10 on design completeness. The three biggest gaps are: (1) the 5 identified implementation gaps describe the problem but not the solution, (2) no explicit state coverage table, (3) no user journey emotional arc. I'll skip mockups and review all 7 dimensions as you requested. Any specific areas to prioritize, or cover all 7 equally? <gstack-qid:plan-design-focus>",
    "header": "Focus areas",
    "multiSelect": false,
    "options": [
      {
        "label": "Cover all 7 equally (Recommended)",
        "description": "Standard review: all 7 design dimensions get full treatment. Takes longer but produces a complete plan."
      },
      {
        "label": "Focus on the 5 identified gaps first",
        "description": "Prioritize Pass 5 (Design System Alignment) to close the gap descriptions into actionable specs, then cover remaining passes more quickly."
      },
      {
        "label": "Prioritize accessibility and states",
        "description": "Focus on Pass 2 (Interaction States) and Pass 6 (Responsive/A11y), since the form has sensitive UX requirements (ARIA, contrast, keyboard)."
      }
    ]
  },
  {
    "question": "D4 — Want outside design voices before the detailed review? Codex evaluates against OpenAI's design hard rules + litmus checks; a Claude subagent does an independent completeness review. (Requires Codex CLI to be installed.) <gstack-qid:outside-voices-design>",
    "header": "Outside voices",
    "multiSelect": false,
    "options": [
      {
        "label": "Yes, run outside design voices",
        "description": "Launches Codex design critique + Claude subagent completeness review in parallel before the 7 passes. Adds 1–2 minutes."
      },
      {
        "label": "No, proceed without (Recommended)",
        "description": "Skip outside voices and go straight to the 7 review passes. Faster; sufficient for most plans."
      }
    ]
  }
];

const questions = [
  {
    header: 'Routing rules',
    question: 'Add skill routing rules? <gstack-qid:routing-injection>',
    options: [{ label: 'Enable' }, { label: 'Skip' }],
  },
  {
    header: 'Cross-project',
    question: 'Enable cross-project learnings?',
    options: [{ label: 'Enable' }, { label: 'Skip' }],
  },
];
function menu(index: number) {
  return (
    '← ☐ Routing rules ☐ Cross-project ✔ Submit →\n│ ' +
    questions[index]!.question +
    '\n❯1.Enable\n2.Skip\n3.Type something.\n4.Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n'
  );
}
const pending = (): NativePlanQuestionCall => ({
  sessionId: 'native',
  toolUseId: 'packet',
  answered: false,
  questions,
});

describe('native AUQ accepts one action per displayed question', () => {
  test('mode permission history releases a fresh identical viewport grant', () => {
    const seen = new Set<string>();
    const permission = 'Do you want to create PLAN.md?\n❯1.Yes\n2.Yes, and switch to accept edits\n3.No\nEsc to cancel · Tab to amend\n';
    expect(nextCeoModeNavigation(permission, 'HOLD SCOPE', seen, undefined, '')).toEqual({
      kind: 'permission', input: '1\r',
    });
    expect(nextCeoModeNavigation(permission, 'HOLD SCOPE', seen, undefined, '').kind).toBe('wait');
    const completed = '⎿ Wrote1line\n';
    expect(nextCeoModeNavigation(permission, 'HOLD SCOPE', seen, undefined, completed)).toEqual({
      kind: 'permission', input: '1\r',
    });
    expect(nextCeoModeNavigation(permission, 'HOLD SCOPE', seen, undefined, completed).kind).toBe('wait');
  });
  test('each native tab has separate UI identity, while retaining one call identity', () => {
    const seen = new Set<string>();
    const first = capturePlanCountQuestion(menu(0), seen, 0, true, pending())!;
    const second = capturePlanCountQuestion(menu(1), seen, 1, true, pending())!;
    expect(first.nativeQuestionIndex).toBe(0);
    expect(second.nativeQuestionIndex).toBe(1);
    expect(first.signature).not.toBe(second.signature);
    expect(first.nativeCall!.toolUseId).toBe(second.nativeCall!.toolUseId);
    expect(planCountQuestionInput(menu(0), first, 2)).toBe('2');
    expect(planCountQuestionInput(menu(1), second, 1)).toBe('1');
    expect(
      capturePlanCountQuestion(menu(0), seen, 2, true, pending()),
    ).toBeNull();
    expect(
      capturePlanCountQuestion(menu(1), seen, 3, true, pending()),
    ).toBeNull();
  });
  test('a delayed native record binds an already answered UI tab without another input', () => {
    const seen = new Set<string>();
    const ui = capturePlanCountQuestion(menu(0), seen, 0, true)!;
    expect(ui.nativeCall).toBeUndefined();
    expect(planCountQuestionInput(menu(0), ui, 1)).toBe('1');
    expect(
      capturePlanCountQuestion(menu(0), seen, 1, true, pending()),
    ).toBeNull();
    expect(
      capturePlanCountQuestion(menu(1), seen, 2, true, pending())!
        .nativeQuestionIndex,
    ).toBe(1);
  });
  test('shared headers or options cannot borrow an unrelated native question', () => {
    const foreign = menu(0).replace(
      questions[0]!.question,
      'Which release should we inspect?',
    );
    const fp = capturePlanCountQuestion(
      foreign,
      new Set(),
      0,
      true,
      pending(),
    )!;
    expect(fp.nativeCall).toBeUndefined();
    const prose = 'Which release?\n❯1.First\n2.Second\n';
    const plain = capturePlanCountQuestion(prose, new Set(), 0, true)!;
    expect(planCountQuestionInput(prose, plain, 2)).toBe('2\r');
  });
  test('known multi-select keeps its existing protocol', () => {
    const fp = capturePlanCountQuestion(
      menu(0),
      new Set(),
      0,
      true,
      pending(),
    )!;
    fp.nativeCall = {
      ...fp.nativeCall!,
      questions: fp.nativeCall!.questions.map((q) => ({
        ...q,
        multiSelect: true,
      })),
    };
    expect(planCountQuestionInput(menu(0), fp, 1)).toBe('1\r');
  });
  test('a native checkbox packet with delayed metadata keeps its existing input protocol', () => {
    for (const mark of [' ', '✓']) {
      const screen = menu(0)
        .replace('1.Enable', `1.[${mark}] Enable`)
        .replace('2.Skip', '2.[ ] Skip');
      const fp = capturePlanCountQuestion(screen, new Set(), 0, true)!;
      expect(fp.nativeCall).toBeUndefined();
      expect(planCountQuestionInput(screen, fp, 1)).toBe('1\r');
    }
  });
  test('CEO mode and its next native question accept one digit; permission stays separate', () => {
    const mode = {
      header: 'Review mode',
      question: 'Which review posture? <gstack-qid:plan-ceo-mode>',
      options: [{ label: 'HOLD SCOPE' }, { label: 'SCOPE EXPANSION' }],
    };
    const call = { ...pending(), questions: [mode] };
    const screen =
      '☐ Review mode\n' +
      mode.question +
      '\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
    const seen = new Set<string>();
    const action = nextCeoModeNavigation(screen, 'SCOPE EXPANSION', seen, call);
    expect(action.kind).toBe('mode');
    if (action.kind !== 'mode') throw Error('Expected native mode');
    expect(planCountQuestionInput(screen, action.question, action.index)).toBe(
      '2',
    );
    expect(
      nextCeoModeNavigation(screen, 'SCOPE EXPANSION', seen, call).kind,
    ).toBe('wait');
    const selected = {
      ...call,
      answered: true,
      answeredAt: '2026-09-08T20:00:01Z',
      answers: { [mode.question]: 'SCOPE EXPANSION' },
    };
    const next = {
      ...pending(),
      toolUseId: 'next',
      questions: [
        {
          header: 'Expansion',
          question: 'Which idea would create 10x delight?',
          options: [{ label: 'First idea' }, { label: 'Second idea' }],
        },
      ],
    };
    const transcript = {
      status: 'ready' as const,
      calls: [selected, next],
      assistantMessages: [],
    };
    const nextScreen =
      '☐ Expansion\n' +
      next.questions[0]!.question +
      '\n❯1.First idea\n2.Second idea\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
    expect(
      hasNativePostAnswerCeoPosture(
        transcript,
        'SCOPE EXPANSION',
        /delight/,
        Date.parse('2026-09-08T20:00:00Z'),
      ),
    ).toBe(false);
    expect(
      nextCeoPostureContinuation(
        nextScreen,
        transcript,
        'SCOPE EXPANSION',
        Date.parse('2026-09-08T20:00:00Z'),
        new Set(),
        false,
      ),
    ).toBe('question');
    const fp = capturePlanCountQuestion(nextScreen, new Set(), 0, false, next)!;
    expect(planCountQuestionInput(nextScreen, fp, 1)).toBe('1');
    const permission =
      'Do you want to create PLAN.md?\n❯1.Yes\n2.Yes, and switch to accept edits\n3.No\nEsc to cancel · Tab to amend\n';
    const grant = nextCeoModeNavigation(
      permission,
      'SCOPE EXPANSION',
      new Set(),
      next,
    );
    expect(grant).toEqual({ kind: 'permission', input: '1\r' });
  });
  test('autoplan routing uses the native shortcut with early or delayed metadata, while prose is unchanged', () => {
    const q = {
      header: 'Routing rules',
      question:
        "gstack works best when your project's CLAUDE.md includes skill routing rules. Add them? <gstack-qid:routing-injection>",
      options: [
        { label: 'Add routing rules (Recommended)' },
        { label: 'Skip — manual invocation' },
      ],
    };
    const native = { ...pending(), questions: [q] };
    const screen =
      '☐ Routing rules\n' +
      q.question +
      '\n❯1.Add routing rules (Recommended)\n2.Skip — manual invocation\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
    expect(autoplanRoutingSetupInput(screen, new Set(), native)).toBe('1');
    expect(autoplanRoutingSetupInput(screen, new Set())).toBe('1');
    expect(
      autoplanRoutingSetupInput(
        screen.replace(
          'Enter to select · ↑/↓ to navigate · Esc to cancel\n',
          '',
        ),
        new Set(),
      ),
    ).toBe('1\r');
    expect(
      autoplanRoutingSetupInput(
        screen.replace(
          q.question,
          'Should the app change its product routing?',
        ),
        new Set(),
        native,
      ),
    ).toBeNull();
  });

  test.skipIf(process.platform === 'win32')(
    'real PTY completes two and four tabs once without skipping, overshooting or queuing Enter',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-auq-input-'));
      const fake = path.join(dir, 'fake-claude');
      const worker = path.join(dir, 'worker.ts');
      const results = path.join(dir, 'results.json');
      const cases = [
        { name: 'two-tabs', count: 2, late: false, permission: true },
        {
          name: 'four-tabs',
          count: 4,
          late: false,
          permission: false,
          long: true,
        },
        { name: 'late-packet', count: 2, late: true, permission: false },
        { name: 'design-outside-tab', count: 2, late: false, permission: false, designQuestions: designOutsideQuestions },
        { name: 'design-outside-late', count: 2, late: true, permission: false, designQuestions: designOutsideQuestions },
      ].map((item) => ({
        ...item,
        record: path.join(dir, item.name + '.jsonl'),
      }));
      fs.writeFileSync(
        fake,
        `#!${process.execPath}\n` +
          String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const item = JSON.parse(process.env.NATIVE_INPUT_CASE);
const record = (event) =>
  fs.appendFileSync(item.record, JSON.stringify(event) + '\n');
const sessionId = 'native-input-' + process.pid;
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', sessionId);
fs.mkdirSync(project, { recursive: true });
const native = (role, content, extra = {}) =>
  fs.appendFileSync(
    path.join(project, sessionId + '.jsonl'),
    JSON.stringify({
      cwd: process.cwd(),
      sessionId,
      isSidechain: false,
      message: { role, content },
      ...extra,
    }) + '\n',
  );
native('assistant', [{ type: 'text', text: 'Fixture started.' }]);
record({ type: 'startup', pid: process.pid, cwd: process.cwd() });
const questions = item.designQuestions ?? Array.from({ length: item.count }, (_, i) => ({
  header: 'Decision ' + i,
  question:
    (item.long && i === 0
      ? 'Additional concrete context for this decision. '.repeat(140)
      : '') +
    'Which implementation fixes gap ' +
    i +
    '? <gstack-qid:input-gap-' +
    i +
    '>',
  options: [{ label: 'First remedy' }, { label: 'Second remedy' }],
}));
const ask = () =>
  native('assistant', [
    {
      type: 'tool_use',
      id: 'packet',
      name: 'AskUserQuestion',
      input: { questions },
    },
  ]);
let started = false,
  permission = item.permission,
  index = 0,
  answers = {},
  done = false;
const render = () => {
  let screen = '';
  if (permission)
    screen =
      'Do you want to create PLAN.md?\n❯1.Yes\n2.Yes, and switch to accept edits\n3.No\nEsc to cancel · Tab to amend\n';
  else if (index < questions.length)
    screen =
      '← ' +
      questions
        .map((q) => (answers[q.question] ? '☒' : '☐') + ' ' + q.header)
        .join(' ') +
      ' ✔ Submit →\n│ ' +
      questions[index].question +
      '\n' + questions[index].options.map((option, i) => (i === 0 ? '❯' : '') + (i + 1) + '.' + option.label).join('\n') +
      '\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n';
  else if (index === questions.length)
    screen =
      '← ' +
      questions
        .map((q) => (answers[q.question] ? '☒' : '☐') + ' ' + q.header)
        .join(' ') +
      ' ✔ Submit →\nReview your answers\n' +
      (Object.keys(answers).length < questions.length
        ? '⚠ You have not answered all questions\n'
        : '') +
      'Ready to submit your answers?\n❯1.Submit answers\n2.Cancel\n';
  record({
    type: 'screen',
    index,
    answers: Object.keys(answers),
    blank: !screen,
  });
  process.stdout.write('\x1b[2J\x1b[H' + screen.replace(/\n/g, '\r\n'));
};
process.stdin.setRawMode?.(true);
process.stdin.on('data', (data) => {
  const input = data.toString();
  record({ type: 'input', input });
  if (!started) {
    started = true;
    if (!item.late) ask();
    render();
    return;
  }
  if (done) {
    record({ type: 'unexpected-after-completion', input });
    return;
  }
  if (permission) {
    if (input !== '1\r') throw Error('permission protocol changed');
    permission = false;
    render();
    return;
  }
  const rendered = index;
  if (input === '\x1b[Z') {
    index = Math.max(0, index - 1);
    render();
    return;
  }
  if (rendered === questions.length) {
    if (input !== '\r') throw Error('submit protocol changed');
    if (item.late) ask();
    native(
      'user',
      [{ type: 'tool_result', tool_use_id: 'packet', content: 'Answered.' }],
      { toolUseResult: { answers } },
    );
    record({ type: 'submitted', answers });
    if (item.designQuestions && Object.values(answers)[1] === item.designQuestions[1].options[0].label) record({ type: 'outside-dispatched' });
    done = true;
    process.stdout.write('\x1b[2J\x1b[HGSTACK REVIEW REPORT\r\n');
    return;
  }
  // CLI2.1.257's numeric shortcut and select:accept both call onChange,
  // whose set-answer reducer increments the current question index. Events
  // in one chunk retain the rendered question closure until the next paint.
  for (const key of input) {
    if (rendered >= questions.length) break;
    if (/[1-2]/.test(key) || key === '\r') {
      answers[questions[rendered].question] =
        questions[rendered].options[key === '2' ? 1 : 0].label;
      index++;
    }
  }
  render();
});
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
`,
      );
      fs.chmodSync(fake, 0o755);
      fs.writeFileSync(
        worker,
        `import {runPlanSkillCounting} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, 'helpers/claude-pty-runner.ts')).href)};
import {pickDesignCountOutsideVoices} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, 'helpers/design-count-outside.ts')).href)};
const cases=${JSON.stringify(cases)};
const results = await Promise.all(cases.map(async item => ({
  name: item.name,
  observation: await runPlanSkillCounting({
    skillName: 'plan-eng-review',
    slashCommand: '/plan-eng-review',
    followUpPrompt: 'Review only this fixture.',
    isLastStep0AUQ: () => false,
    isReviewAUQ: () => true,
    firstAUQPick: item.designQuestions ? undefined : () => 2,
    pickAUQ: item.designQuestions ? pickDesignCountOutsideVoices : undefined,
    reviewCountCeiling: 8,
    timeoutMs: 22000,
    env: { NATIVE_INPUT_CASE: JSON.stringify(item) },
  }),
})));
await Bun.write(${JSON.stringify(results)},JSON.stringify(results));`,
      );
      const child = Bun.spawn([process.execPath, worker], {
        env: {
          ...process.env,
          BROWSE_TERMINAL_BINARY: fake,
          EVALS_HERMETIC: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 35000);
      try {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, out + err).toBe(0);
        const report = JSON.parse(fs.readFileSync(results, 'utf8'));
        for (const item of cases) {
          const row = report.find((r) => r.name === item.name);
          expect(row.observation.outcome, JSON.stringify(row.observation)).toBe(
            'completion_summary',
          );
          expect(row.observation.reviewCount).toBe(1);
          expect(row.observation.transcript.calls).toHaveLength(1);
          expect(
            row.observation.transcript.calls[0].unansweredQuestionIndices,
          ).toEqual([]);
          const events = fs
            .readFileSync(item.record, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(
            events.filter((e) => e.type === 'input').map((e) => e.input),
          ).toEqual([
            '/plan-eng-review\r',
            ...(item.permission ? ['1\r'] : []),
            ...(item.designQuestions ? ['1', '2'] : ['2', ...Array(item.count - 1).fill('1')]),
            '\r',
          ]);
          expect(events.filter((e) => e.type === 'screen' && e.blank)).toEqual(
            [],
          );
          expect(
            events.filter((e) => e.type === 'unexpected-after-completion'),
          ).toEqual([]);
          const submitted = events.filter((e) => e.type === 'submitted');
          expect(submitted).toHaveLength(1);
          expect(Object.values(submitted[0].answers)).toEqual(item.designQuestions
            ? [item.designQuestions[0].options[0].label, item.designQuestions[1].options[1].label]
            : ['Second remedy', ...Array(item.count - 1).fill('First remedy')]);
          expect(events.filter(e => e.type === 'outside-dispatched')).toEqual([]);
          expect(() => process.kill(events[0].pid, 0)).toThrow();
          expect(fs.existsSync(events[0].cwd)).toBe(false);
        }
      } finally {
        clearTimeout(timer);
        child.kill('SIGKILL');
        for (const item of cases) {
          if (!fs.existsSync(item.record)) continue;
          const pid = JSON.parse(
            fs.readFileSync(item.record, 'utf8').split('\n')[0]!,
          ).pid;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    40000,
  );
});
