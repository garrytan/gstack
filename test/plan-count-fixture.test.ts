/** Free behavioral coverage for the isolated, preloaded plan-count workspace. */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlanCountFixture } from './helpers/plan-count-fixture';
import { getHermeticDirs } from './helpers/hermetic-env';

const ROOT = path.resolve(import.meta.dir, '..');
const PROMPT = '# Seeded settings plan\n\nReview each issue separately.\n' +
  'Literal text: "quotes" \'single quotes\' `touch never` $(touch never)\n';

function gitRoot(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  return fs.realpathSync(result.stdout.trim());
}

describe('plan-count fixtures', () => {
  test('preloads the literal plan and initial context in a separate git repository', () => {
    const fixture = createPlanCountFixture(PROMPT);
    try {
      expect(fs.realpathSync(fixture.cwd)).not.toBe(fs.realpathSync(ROOT));
      expect(gitRoot(fixture.cwd)).toBe(fs.realpathSync(fixture.cwd));
      expect(fs.readFileSync(path.join(fixture.cwd, 'PLAN.md'), 'utf8')).toBe(PROMPT);
      const context = fs.readFileSync(path.join(fixture.cwd, 'CLAUDE.md'), 'utf8');
      expect(context).toContain('PLAN.md');
      expect(context).toContain(PROMPT);
      expect(fs.existsSync(path.join(fixture.cwd, 'DESIGN.md'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.cwd, 'TODOS.md'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.cwd, 'never'))).toBe(false);
      expect(fixture.env).toEqual({}); // Mode-routing callers keep normal config.
    } finally {
      fixture.cleanup();
    }
    expect(fs.existsSync(fixture.cwd)).toBe(false);
  });

  test('native count config owns independent state and preserves shared onboarding seeds', () => {
    const shared = getHermeticDirs().gstackHome;
    const before = fs.readFileSync(path.join(shared, 'config.yaml'), 'utf8');
    const markers = fs.readdirSync(shared).filter(name => name.startsWith('.'));
    const first = createPlanCountFixture('first native plan', { nativeReviewOnly: true });
    const second = createPlanCountFixture('second native plan', { nativeReviewOnly: true });
    try {
      expect(first.env.GSTACK_HOME).not.toBe(shared);
      expect(first.env.GSTACK_HOME).not.toBe(second.env.GSTACK_HOME);
      expect(first.env.GSTACK_STATE_ROOT).toBe(first.env.GSTACK_HOME);
      expect(fs.readFileSync(path.join(first.env.GSTACK_HOME, 'config.yaml'), 'utf8'))
        .toBe(before.replace(/^codex_reviews:.*(?:\r?\n|$)/gm, '') + '\ncodex_reviews: disabled\n');
      for (const marker of markers) {
        expect(fs.readFileSync(path.join(first.env.GSTACK_HOME, marker), 'utf8'))
          .toBe(fs.readFileSync(path.join(shared, marker), 'utf8'));
      }
      first.cleanup();
      first.cleanup();
      expect(fs.existsSync(first.env.GSTACK_HOME)).toBe(false);
      expect(fs.existsSync(second.env.GSTACK_HOME)).toBe(true);
      expect(fs.readFileSync(path.join(shared, 'config.yaml'), 'utf8')).toBe(before);
    } finally {
      first.cleanup();
      second.cleanup();
    }
    expect(fs.existsSync(second.env.GSTACK_HOME)).toBe(false);
  });

  test('concurrent fixtures have independent content and cleanup owns only its directory', () => {
    const first = createPlanCountFixture('first plan');
    const second = createPlanCountFixture('second plan');
    try {
      expect(first.cwd).not.toBe(second.cwd);
      first.cleanup();
      first.cleanup();
      expect(fs.existsSync(first.cwd)).toBe(false);
      expect(fs.readFileSync(path.join(second.cwd, 'PLAN.md'), 'utf8')).toBe('second plan');
      expect(gitRoot(second.cwd)).toBe(fs.realpathSync(second.cwd));
    } finally {
      first.cleanup();
      second.cleanup();
    }
    expect(fs.existsSync(second.cwd)).toBe(false);
  });

  test('additional design context exists in the initial clean fixture commit', () => {
    const design = '# Approved design system\nUse the existing components.\n' + PROMPT;
    const fixture = createPlanCountFixture(PROMPT, { files: { 'DESIGN.md': design, 'docs/accepted behavior.md': 'Save is atomic.\n' } });
    try {
      const committed = spawnSync('git', ['show', 'HEAD:DESIGN.md'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 10_000 });
      expect(committed.status, committed.stderr).toBe(0);
      expect(committed.stdout).toBe(design);
      expect(fs.readFileSync(path.join(fixture.cwd, 'docs/accepted behavior.md'), 'utf8')).toBe('Save is atomic.\n');
      expect(spawnSync('git', ['status', '--porcelain'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 10_000 }).stdout).toBe('');
    } finally {
      fixture.cleanup();
    }
    expect(fs.existsSync(fixture.cwd)).toBe(false);
  });

  test('additional context cannot escape the fixture or replace its instructions and Git metadata', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-outside-'));
    const sentinel = path.join(outside, 'untouched.md');
    fs.writeFileSync(sentinel, 'user-owned');
    try {
      for (const name of [sentinel, '../escape.md', 'nested/../escape.md', '..\\escape.md',
        'C:\\escape.md', '/escape.md', '.git/config', 'nested/.git/config', 'PLAN.md', 'CLAUDE.md']) {
        expect(() => createPlanCountFixture(PROMPT, { files: { [name]: 'overwrite' } }))
          .toThrow('Invalid plan-count fixture file:');
      }
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('user-owned');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('cleans the fixture when the PTY executable cannot launch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-launch-failure-'));
    const fixtureTmp = path.join(dir, 'fixtures');
    const workerPath = path.join(dir, 'worker.ts');
    const brokenCli = path.join(dir, 'not-executable');
    fs.mkdirSync(fixtureTmp);
    fs.writeFileSync(brokenCli, 'This file deliberately has no executable permission.', { mode: 0o644 });
    const runnerUrl = pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href;
    fs.writeFileSync(workerPath, `
import { runPlanSkillCounting } from ${JSON.stringify(runnerUrl)};
try {
  await runPlanSkillCounting({
    skillName: 'plan-design-review', slashCommand: '/plan-design-review',
    followUpPrompt: 'Review this launch-failure fixture.',
    isLastStep0AUQ: () => false, reviewCountCeiling: 8,
  });
  process.exitCode = 1;
} catch (error) {
  process.stdout.write('launch failed as expected');
}
`);
    try {
      const result = spawnSync(process.execPath, [workerPath], {
        cwd: ROOT,
        env: { ...process.env, BROWSE_TERMINAL_BINARY: brokenCli, EVALS_HERMETIC: '1', TMPDIR: fixtureTmp },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('launch failed as expected');
      expect(fs.readdirSync(fixtureTmp)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);

  // Bun's real PTY spawn and executable shebangs are POSIX-only. The direct
  // fixture tests above still exercise repository setup/cleanup on Windows.
  test.skipIf(process.platform === 'win32')(
    'real PTY children see preloaded isolated plans, shipped skills, and only the bare slash command',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-subprocess-'));
      const fakePath = path.join(dir, 'fake-claude');
      const workerPath = path.join(dir, 'worker.ts');
      const resultPath = path.join(dir, 'result.json');
      const hostState = path.join(dir, 'host-state');
      const hostConfig = 'codex_reviews: enabled\nexplain_level: expert\n';
      fs.mkdirSync(hostState);
      fs.writeFileSync(path.join(hostState, 'config.yaml'), hostConfig);
      const cases = [
        { name: 'design', skillName: 'plan-design-review', prompt: PROMPT, mode: 'complete', files: { 'DESIGN.md': '# Approved design\nKeep the existing layout.\n' } },
        { name: 'design-direct', skillName: 'plan-design-review', prompt: PROMPT, mode: 'direct-finding' },
        { name: 'design-batched', skillName: 'plan-design-review', prompt: PROMPT, mode: 'batched-finding' },
        { name: 'failed-native', skillName: 'plan-design-review', prompt: PROMPT, mode: 'failed-call' },
        { name: 'native-permission-policy', skillName: 'plan-eng-review', prompt: PROMPT, mode: 'native-permission-policy', report: path.join(dir, 'native-policy-report.md') },
        { name: 'permission-lifecycle', skillName: 'plan-design-review', prompt: PROMPT, mode: 'permission-lifecycle' },
        { name: 'permission', skillName: 'plan-design-review', prompt: PROMPT, mode: 'permission' },
        { name: 'missing-transcript', skillName: 'plan-design-review', prompt: PROMPT, mode: 'missing-transcript' },
        { name: 'ceo', skillName: 'plan-ceo-review', prompt: '# Independent CEO plan\nUnique product context.', mode: 'complete' },
        { name: 'exited', skillName: 'plan-eng-review', prompt: '# Early-exit plan\nStill clean up.', mode: 'exit' },
        { name: 'skip-first', skillName: 'plan-devex-review', prompt: '# Native DX plan', mode: 'prerequisite', skipIndex: 1 },
        { name: 'skip-second', skillName: 'plan-devex-review', prompt: '# Native DX plan', mode: 'prerequisite', skipIndex: 2 },
        { name: 'skip-review-now', skillName: 'plan-ceo-review', prompt: '# Native CEO plan', mode: 'prerequisite', skipIndex: 2, skipLabel: 'Skip — review now (Recommended)' },
        { name: 'caller-policy', skillName: 'plan-devex-review', prompt: '# Native DX plan', mode: 'prerequisite', skipIndex: 2, custom: true },
        { name: 'late-mode', skillName: 'plan-devex-review', prompt: '# Native DX plan', mode: 'late-mode' },
        { name: 'batched-mode', skillName: 'plan-devex-review', prompt: '# Native DX plan', mode: 'batched-mode' },
        { name: 'damaged-submit', skillName: 'plan-devex-review', prompt: '# Native DX plan', mode: 'damaged-submit' },
        { name: 'damaged-menu', skillName: 'plan-ceo-review', prompt: '# Native CEO plan', mode: 'damaged-menu' },
      ].map((item) => ({ ...item, record: path.join(dir, `${item.name}.jsonl`) }));

      // The fake snapshots its environment BEFORE installing the first stdin
      // handler. It never dispatches a model or invokes the real Claude CLI.
      fs.writeFileSync(fakePath, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const record = (event) => fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(event) + '\n');
// Older fake menus used CR as a line separator. Emit actual terminal newlines;
// real cursor/erase behavior is exercised separately in pty-screen-session.test.ts.
const render = text => process.stdout.write(text.replace(/\r(?!\n)/g, '\r\n'));
const sessionId = 'fixture-' + process.pid;
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', sessionId);
fs.mkdirSync(project, { recursive: true });
const native = (role, content, extra = {}) => {
  if (process.env.FIXTURE_MODE === 'missing-transcript') return;
  fs.appendFileSync(path.join(project, sessionId + '.jsonl'), JSON.stringify({
    cwd: process.cwd(), sessionId, isSidechain: false, message: { role, content },
    ...(process.env.FIXTURE_MODE === 'native-permission-policy' ? { timestamp: new Date().toISOString() } : {}), ...extra,
  }) + '\n');
};
native('assistant', [{ type: 'text', text: 'Fixture CLI started.' }]);
let callId = 0;
let nativeQuestions = [];
const ask = (questions) => {
  nativeQuestions = questions;
  native('assistant', [{ type: 'tool_use', id: 'question-' + (++callId), name: 'AskUserQuestion', input: { questions } }]);
};
const answer = () => native('user', [{ type: 'tool_result', tool_use_id: 'question-' + callId, content: 'Your questions have been answered.' }],
  { toolUseResult: { answers: Object.fromEntries(nativeQuestions.map(q => [q.question, q.options[0].label])) } });
const questionMetadata = (header, question, labels) => ({ header, question, options: labels.map(label => ({ label })) });
const modeQuestion = questionMetadata('Review mode', 'How deep should this DX review go? <gstack-qid:plan-devex-review-mode>', ['DX EXPANSION', 'DX POLISH', 'DX TRIAGE']);
const submitQuestions = [
  questionMetadata('Routing setup', 'Should gstack add skill routing rules? <gstack-qid:routing-injection>', ['Add routing rules', 'Skip']),
  questionMetadata('Cross-project', 'Enable cross-project learnings?', ['Enable cross-project', 'Keep project-scoped']),
];
const submitPanel = (answered) => '\r← ☒ Routing setup ' + (answered ? '☒' : '☐') + ' Cross-project ✔ Submit →\r' +
  'Review your answers\r' + (answered ? '' : '⚠You have not answere all questions\r') +
  '│ ●D1 — Should gstack add skill routing rules?\r→Add routing rules\r' +
  'Ready to submit your answers?\r❯1.Sbmi answers\r2Cancel\r';
const skillDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', process.env.FIXTURE_SKILL);
const planPath = path.join(process.cwd(), 'PLAN.md');
const contextPath = path.join(process.cwd(), 'CLAUDE.md');
const config = (key) => {
  const result = spawnSync('bash', [process.env.FIXTURE_CONFIG_BIN, 'get', key], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error('Fixture config failed: ' + result.stderr);
  return result.stdout;
};
record({
  type: 'startup', pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2),
  stateRoot: process.env.GSTACK_STATE_ROOT, gstackHome: process.env.GSTACK_HOME,
  codexReviews: config('codex_reviews'), explainLevel: config('explain_level'),
  onboarding: fs.readdirSync(process.env.GSTACK_HOME).filter(name => name.startsWith('.')),
  gitRoot: spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim(),
  plan: fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : null,
  context: fs.existsSync(contextPath) ? fs.readFileSync(contextPath, 'utf8') : null,
  inheritedDesign: fs.existsSync('DESIGN.md'), inheritedTodos: fs.existsSync('TODOS.md'),
  design: fs.existsSync('DESIGN.md') ? fs.readFileSync('DESIGN.md', 'utf8') : null,
  skill: fs.existsSync(path.join(skillDir, 'SKILL.md')) ? fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8') : null,
  sections: fs.existsSync(path.join(skillDir, 'sections', 'review-sections.md'))
    ? fs.readFileSync(path.join(skillDir, 'sections', 'review-sections.md'), 'utf8') : null,
});
fs.writeFileSync(path.join(process.env.GSTACK_HOME, 'child-owned'), 'isolated');
if (process.env.FIXTURE_MODE === 'exit') render('\x1b[?25lSTARTUP_DIAGNOSTIC fixture CLI booted\x1b[?25h\n');
process.stdin.setRawMode?.(true);
let firstInput = true;
let completion;
let question = 0;
let selected = '';
let permissionStage = 'first';
const filePermission = () => '\nDo you want to make this edit to gstack-test-plan-design.md?\n' +
  '❯1.Yes\n2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession;Yes,and\n' +
  'alwaysallowaccessto/tmp/fixtureforthissession\n3.No\nEsctocancel·Tabtoamend\n';
process.stdin.on('data', (data) => {
  const rawInput = data.toString('utf8');
  record({ type: 'input', data: rawInput });
  // These complete native panels accept a numeric shortcut immediately.
  // Keep the fixture's existing answer handler sentinel internal; assertions
  // below still check the exact bytes the real driver sent.
  const instantNative = ['native-permission-policy', 'damaged-menu'].includes(process.env.FIXTURE_MODE)
    || (process.env.FIXTURE_MODE === 'permission-lifecycle' && permissionStage === 'question')
    || (process.env.FIXTURE_MODE === 'prerequisite' && (question === 2 || process.env.FIXTURE_CUSTOM !== 'true'));
  const input = instantNative && /^[1-9]$/.test(rawInput) ? rawInput + '\r' : rawInput;
  if (!firstInput) {
    if (process.env.FIXTURE_MODE === 'native-permission-policy') {
      if (permissionStage === 'done') { record({ type: 'unexpected-policy-input', input }); return; }
      selected += input.replace(/\r/g, '');
      if (input.includes('\r')) {
        permissionStage = 'done';
        const label = nativeQuestions[0].options[Number(selected) - 1]?.label;
        record({ type: 'native-policy-answer', selected, label });
        native('user', [{ type: 'tool_result', tool_use_id: 'question-' + callId, content: 'Answered.' }],
          { toolUseResult: { answers: { [nativeQuestions[0].question]: label } } });
        // The answered menu survives a provisional heading and partial report.
        // Neither may turn its permission wording into a fresh default1.
        const summary = 'Completion Summary:\n- Architecture Review: file policy issue resolved\n';
        render('\n● ' + summary);
        native('assistant', [{ type: 'text', text: summary }], { timestamp: new Date(Date.now() + 1).toISOString() });
        setTimeout(() => {
          fs.writeFileSync(process.env.FIXTURE_EXPECTED_REPORT, '## GSTACK REVIEW REPORT\n');
          record({ type: 'partial-policy-report' });
        }, 3000);
        completion = setTimeout(() => {
          fs.writeFileSync(process.env.FIXTURE_EXPECTED_REPORT, '# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n' +
            '| Review | Status | Findings |\n|---|---|---|\n| Eng Review | clean | policy resolved |\n\n' +
            'VERDICT: ENG CLEARED\n\nNO UNRESOLVED DECISIONS\n');
          record({ type: 'complete-policy-report' });
          render('\nGSTACK REVIEW REPORT\n');
        }, 6500);
      }
      return;
    }
    if (process.env.FIXTURE_MODE === 'damaged-menu') {
      if (question === 0) record({ type: 'input-during-prose', input });
      else if (input.includes('\r')) {
        record({ type: 'damaged-menu-answer', input });
        answer();
        render('\nGSTACK REVIEW REPORT\n');
      }
      return;
    }
    if (process.env.FIXTURE_MODE === 'damaged-submit') {
      if (question === 0 && input === '\x1b[Z') {
        question = 1;
        record({ type: 'returned-to-unanswered' });
        render('\r← ☒ Routing setup ☐ Cross-project ✔ Submit →\r' +
          '│ Enable cross-project learnings?\r❯1.Enable cross-project\r2.Keep project-scoped\r');
      } else if (question === 1) {
        selected += input.replace(/\r/g, '');
        if (input.includes('\r')) {
          question = 2;
          record({ type: 'answered-remaining-tab', selected });
          render(submitPanel(true));
        }
      } else if (question === 2 && input === '\r') {
        // Native JSONL can arrive only after the whole packet is submitted.
        ask(submitQuestions);
        native('user', [{ type: 'tool_result', tool_use_id: 'question-' + callId, content: 'Your questions have been answered.' }],
          { toolUseResult: { answers: {
            [submitQuestions[0].question]: submitQuestions[0].options[0].label,
            [submitQuestions[1].question]: submitQuestions[1].options[Number(selected) - 1]?.label,
          } } });
        record({ type: 'submitted-both-answers' });
        render('\nGSTACK REVIEW REPORT\n');
      } else record({ type: 'unexpected-submit-input', question, input });
      return;
    }
    if (['late-mode', 'batched-mode'].includes(process.env.FIXTURE_MODE)) {
      selected += input.replace(/\r/g, '');
      if (input.includes('\r')) {
        // The real CLI can defer its native call record until after the UI
        // answer. A known multi-question call must still block the override.
        if (process.env.FIXTURE_MODE === 'late-mode') ask([modeQuestion]);
        const label = modeQuestion.options[Number(selected) - 1]?.label;
        record({ type: 'mode-answer', selected, label });
        native('user', [{ type: 'tool_result', tool_use_id: 'question-' + callId, content: 'Your questions have been answered.' }],
          { toolUseResult: { answers: { [modeQuestion.question]: label } } });
        render('\nGSTACK REVIEW REPORT\n');
      }
      return;
    }
    if (['direct-finding', 'failed-call'].includes(process.env.FIXTURE_MODE) && input.includes('\r')) {
      answer();
      render('\nGSTACK REVIEW REPORT\n');
      return;
    }
    if (process.env.FIXTURE_MODE === 'batched-finding' && input.includes('\r')) {
      if (question === 1) {
        question = 2;
        render('\r☐Loading\rD2 — Define the loading state <gstack-qid:plan-design-review-loading>\r❯1.Add spinner\r2.Keep blank\r');
      } else {
        answer();
        render('\nGSTACK REVIEW REPORT\n');
      }
      return;
    }
    if (process.env.FIXTURE_MODE === 'permission-lifecycle' && input.includes('\r')) {
      if (permissionStage === 'first') {
        record({ type: 'permission-grant', number: 1, input });
        permissionStage = 'pending';
        render(filePermission()); // Same pending menu, appended redraw.
        completion = setTimeout(() => {
          permissionStage = 'completed';
          render('\n⎿ Wrote320linesto../fixture/gstack-test-plan-design.md\n' + '·'.repeat(1600));
          completion = setTimeout(() => {
            permissionStage = 'second';
            render(filePermission()); // New request, identical file/text.
          }, 4500);
        }, 4500);
      } else if (permissionStage === 'second') {
        record({ type: 'permission-grant', number: 2, input });
        permissionStage = 'question';
        render('\n⎿ Added2lines\n');
        ask([questionMetadata('File policy', 'Do you want to create gstack-test-plan-design.md?', ['Yes', 'No'])]);
        render('\n☐ File policy\nDo you want to create gstack-test-plan-design.md?\n❯1.Yes\n2.No\n' +
          'Enter to select · ↑/↓ to navigate · Esc to cancel\n');
      } else if (permissionStage === 'question') {
        record({ type: 'file-policy-answer', input });
        native('user', [{ type: 'tool_result', tool_use_id: 'question-' + callId, content: 'Your question has been answered.' }],
          { toolUseResult: { answers: { [nativeQuestions[0].question]: input.startsWith('2') ? 'No' : 'Yes' } } });
        permissionStage = 'done';
        render('\nGSTACK REVIEW REPORT\n');
      } else record({ type: 'unexpected-permission-input', stage: permissionStage, input });
      return;
    }
    if (process.env.FIXTURE_MODE === 'permission' && input.includes('\r')) {
      render('\nGSTACK REVIEW REPORT\n');
      return;
    }
    if (process.env.FIXTURE_MODE !== 'prerequisite') return;
    if (question === 1 && input.includes('\r')) {
      answer();
      record({ type: 'generic-answer', input });
      question = 2;
      selected = '';
      const labels = ['Run /office-hours now', process.env.FIXTURE_SKIP_LABEL || 'Skip — proceed with standard review'];
      if (process.env.FIXTURE_SKIP_INDEX === '1') labels.reverse();
      ask([questionMetadata('Prerequisite', 'No design doc found. Run /office-hours first?', labels)]);
      render('\r☐ Prerequisite\rNo design doc found. Run /office-hours first?\r❯1.' + labels[0] + '\r2.' + labels[1] + '\r');
      return;
    }
    selected += input.replace(/\r/g, '');
    if (input.includes('\r')) {
      answer();
      record({ type: 'prerequisite-answer', selected });
      render(selected === process.env.FIXTURE_SKIP_INDEX ? '\nGSTACK REVIEW REPORT\n' : '\nWRONG_PREREQUISITE_CHOICE\n');
    }
    return;
  }
  firstInput = false;
  if (process.env.FIXTURE_MODE === 'exit') process.exit(7);
  if (process.env.FIXTURE_MODE === 'damaged-menu') {
    render('☐Stripe event types\nWhich event should the handler accept?\n❯1.Specify one canonical event\n2.Accept all events\n' +
      '·'.repeat(4200) + '\nMinimum required test cases:\n1.Happy path\n2.Email failure\n3.DB timeout\n4.Unknown event\n5.Unknown user\n❯1\n');
    completion = setTimeout(() => {
      question = 1;
      ask([questionMetadata('Test scope', 'Should the plan include an integration test? <gstack-qid:plan-ceo-test-scope>',
        ['Unit tests only for now (recommended)', 'Unit tests + one integration test', 'Integration test only'])]);
      render('\n☐Test scope\nShould the plan include an integration test? <gstack-qid:plan-ceo-test-scope>\n' +
        '❯1.Unittestsonlyfornow(recommended)\n2Uni tsts + one integration test\n3.Integrationtestonly\n' +
        'Enter to select · ↑/↓ to navigate · Esc to cancel\n');
    }, 4100);
    return;
  }
  if (process.env.FIXTURE_MODE === 'damaged-submit') {
    render(submitPanel(false));
    return;
  }
  if (['late-mode', 'batched-mode'].includes(process.env.FIXTURE_MODE)) {
    if (process.env.FIXTURE_MODE === 'batched-mode') ask([modeQuestion,
      questionMetadata('Separate decision', 'Which fixture target should be used?', ['First target', 'Second target'])]);
    render('\r☐ Review mode\r' + modeQuestion.question + '\r❯1.DX EXPANSION\r2.DX POLISH\r3.DX TRIAGE\r');
    return;
  }
  if (['direct-finding', 'batched-finding', 'failed-call'].includes(process.env.FIXTURE_MODE)) {
    question = 1;
    if (process.env.FIXTURE_MODE === 'failed-call') {
      ask([questionMetadata('Missing answer', 'Should the save retry be idempotent?', ['Yes', 'No'])]);
      native('user', [{ type: 'tool_result', tool_use_id: 'question-' + callId, is_error: true, content: 'Question rejected' }]);
    }
    const questions = [questionMetadata('Button style', 'D1 — How should the four header buttons differ? <gstack-qid:plan-design-review-button-hierarchy>', ['Filled primary', 'Ghost buttons'])];
    if (process.env.FIXTURE_MODE === 'batched-finding') questions.push(questionMetadata('Loading', 'D2 — Define the loading state <gstack-qid:plan-design-review-loading>', ['Add spinner', 'Keep blank']));
    ask(questions);
    render('\r☐Buttonstyle\r│D1—Howshouldthe4headerbuttonsbedifferentiated?<gstack-qid:plan-design-review-butn-hierarchy>\r❯1.Filledprimary\r2.Ghostbuttons\r');
    return;
  }
  if (process.env.FIXTURE_MODE === 'prerequisite') {
    question = 1;
    const suffix = process.env.FIXTURE_CUSTOM === 'true' ? ' Context '.repeat(50) + 'routing-proof-after-240' : '';
    ask([questionMetadata('Setup', 'Which fixture setup should be used?' + suffix, ['First setup', 'Second setup'])]);
    render('\r☐ Setup\rWhich fixture setup should be used?\r❯1.First setup\r2.Second setup\r');
    return;
  }
  if (process.env.FIXTURE_MODE === 'native-permission-policy') {
    const prompt = 'D1 — Should we create a file that documents always allow access to the project? <gstack-qid:plan-eng-review-file-policy>';
    ask([questionMetadata('File policy', prompt, ['Create it', 'Keep current policy'])]);
    render('\n☐ File policy\n' + prompt + '\n❯1.Create it\n2.Keep current policy\nEnter to select · ↑/↓ to navigte · Esc to cancel\n');
    return;
  }
  if (process.env.FIXTURE_MODE === 'permission-lifecycle') {
    render(filePermission());
    return;
  }
  if (process.env.FIXTURE_MODE === 'permission') {
    render('\rDo you want to create PLAN.md?\r❯1.Yes\r2.Yes, and switch to accept edits\r3.No\r');
    return;
  }
  // Longer than the old 3 s delayed fixture send: record that regression
  // even if the helper would otherwise return on our completion marker.
  completion = setTimeout(() => render('\nGSTACK REVIEW REPORT\n'), 4100);
});
process.on('SIGINT', () => {
  clearTimeout(completion);
  record({ type: 'closed', at: Date.now() });
  process.exit(0);
});
process.stdin.resume();
`);
      fs.chmodSync(fakePath, 0o755);
      const runnerUrl = pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href;
      const hermeticUrl = pathToFileURL(path.join(ROOT, 'test/helpers/hermetic-env.ts')).href;
      const devexUrl = pathToFileURL(path.join(ROOT, 'test/helpers/devex-count-fixture.ts')).href;
      fs.writeFileSync(workerPath, `
import { runPlanSkillCounting, designFirstReviewAUQ } from ${JSON.stringify(runnerUrl)};
import { getHermeticDirs } from ${JSON.stringify(hermeticUrl)};
import { devexReviewModePick } from ${JSON.stringify(devexUrl)};
import * as fs from 'node:fs';
import * as path from 'node:path';
const shared = getHermeticDirs().gstackHome;
fs.appendFileSync(path.join(shared, 'config.yaml'), 'codex_reviews: enabled\\nexplain_level: beginner\\n');
const sharedBefore = fs.readFileSync(path.join(shared, 'config.yaml'), 'utf8');
const onboarding = fs.readdirSync(shared).filter(name => name.startsWith('.'));
const cases = ${JSON.stringify(cases)};
const results = await Promise.all(cases.map(async (item) => ({
  name: item.name,
  observation: await runPlanSkillCounting({
    skillName: item.skillName,
    slashCommand: '/' + item.skillName,
    followUpPrompt: item.prompt,
    fixtureFiles: item.files,
    expectedPlanPath: item.report,
    isLastStep0AUQ: () => false,
    isFirstReviewAUQ: ['direct-finding', 'batched-finding', 'failed-call'].includes(item.mode) ? designFirstReviewAUQ : undefined,
    isReviewAUQ: item.custom ? fp => fp.promptSnippet.includes('routing-proof-after-240') : undefined,
    pickAUQ: item.mode === 'native-permission-policy' ? () => 2
      : ['late-mode', 'batched-mode'].includes(item.mode) ? devexReviewModePick
      : item.custom ? fp => fp.promptSnippet.includes('routing-proof-after-240') ? 1 : null : undefined,
    reviewCountCeiling: 8,
    timeoutMs: item.mode === 'permission-lifecycle' ? 22000 : 15000,
    firstAUQPick: () => ['late-mode', 'batched-mode'].includes(item.mode) ? 1 : 2,
    env: {
      FIXTURE_RECORD: item.record, FIXTURE_SKILL: item.skillName, FIXTURE_MODE: item.mode,
      FIXTURE_EXPECTED_REPORT: item.report ?? '',
      FIXTURE_CUSTOM: String(item.custom ?? false),
      FIXTURE_SKIP_INDEX: String(item.skipIndex ?? ''), FIXTURE_CONFIG_BIN: ${JSON.stringify(path.join(ROOT, 'bin/gstack-config'))},
      FIXTURE_SKIP_LABEL: item.skipLabel ?? '',
      GSTACK_HOME: ${JSON.stringify(hostState)}, GSTACK_STATE_ROOT: ${JSON.stringify(hostState)},
    },
  }),
})));
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ results, onboarding, sharedBefore,
  sharedAfter: fs.readFileSync(path.join(shared, 'config.yaml'), 'utf8'),
  sharedHasChildFile: fs.existsSync(path.join(shared, 'child-owned')),
}));
`);

      const startedAt = Date.now();
      const child = Bun.spawn([process.execPath, workerPath], {
        cwd: ROOT,
        env: { ...process.env, BROWSE_TERMINAL_BINARY: fakePath, EVALS_HERMETIC: '1', GSTACK_HOME: hostState, GSTACK_STATE_ROOT: hostState,
          EVALS_RUN_ID: 'fixture-integration', GSTACK_EVAL_DIR: path.join(dir, 'eval-artifacts') },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const killer = setTimeout(() => child.kill('SIGKILL'), 35_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, stdout + stderr).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(35_000);
        const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const results = report.results;
        expect(report.sharedAfter).toBe(report.sharedBefore);
        expect(report.sharedHasChildFile).toBe(false);
        expect(fs.readFileSync(path.join(hostState, 'config.yaml'), 'utf8')).toBe(hostConfig);
        expect(fs.readdirSync(hostState)).toEqual(['config.yaml']);
        const cwds = new Set<string>();
        const stateRoots = new Set<string>();
        for (const item of cases) {
          const events = fs.readFileSync(item.record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
          const startup = events[0];
          expect(startup.type).toBe('startup');
          expect(startup.cwd).not.toBe(ROOT);
          expect(startup.gitRoot).toBe(startup.cwd);
          expect(startup.stateRoot).toBe(startup.gstackHome);
          expect(startup.stateRoot).not.toBe(hostState);
          expect(startup.codexReviews).toBe('disabled');
          expect(startup.explainLevel).toBe('beginner');
          expect(startup.onboarding).toEqual(report.onboarding);
          expect(startup.plan).toBe(item.prompt);
          expect(startup.context).toContain('PLAN.md');
          expect(startup.context).toContain(item.prompt);
          expect(startup.argv[startup.argv.indexOf('--permission-mode') + 1]).toBe('plan');
          expect(startup.inheritedDesign).toBe(Boolean(item.files?.['DESIGN.md']));
          expect(startup.design).toBe(item.files?.['DESIGN.md'] ?? null);
          expect(startup.inheritedTodos).toBe(false);
          expect(startup.skill).toContain(`name: ${item.skillName}`);
          expect(startup.sections).toBe(fs.readFileSync(path.join(ROOT, item.skillName, 'sections/review-sections.md'), 'utf8'));
          expect(events.filter((event) => event.type === 'input').map((event) => event.data).join(''))
            .toBe(`/${item.skillName}\r` + (item.mode === 'prerequisite' ? `${item.custom ? '1\r' : '2'}${item.skipIndex}`
              : item.mode === 'permission-lifecycle' ? '1\r1\r2'
              : item.mode === 'damaged-submit' ? '\x1b[Z2\r\r'
              : item.mode === 'batched-finding' ? '2\r1\r' : item.mode === 'batched-mode' ? '1\r'
              : ['damaged-menu', 'native-permission-policy'].includes(item.mode) ? '2'
              : ['direct-finding', 'failed-call', 'permission', 'late-mode'].includes(item.mode) ? '2\r' : ''));
          expect(fs.existsSync(startup.cwd)).toBe(false);
          expect(fs.existsSync(startup.stateRoot)).toBe(false);
          expect(() => process.kill(startup.pid, 0)).toThrow();
          const result = results.find((result) => result.name === item.name);
          expect(result.observation.outcome, `${item.name}: ${JSON.stringify(result.observation)}`).toBe(item.mode === 'exit' ? 'exited'
            : ['missing-transcript', 'failed-call'].includes(item.mode) ? 'transcript_unavailable' : 'completion_summary');
          const artifacts = result.observation.artifactDir;
          expect(result.observation.artifactError).toBeUndefined();
          expect(fs.existsSync(artifacts)).toBe(true); // Survives the temporary fixture's cleanup.
          const captured = JSON.parse(fs.readFileSync(path.join(artifacts, 'observation.json'), 'utf8'));
          expect(captured.outcome).toBe(result.observation.outcome);
          expect(captured.capture.cwd).toBe(startup.cwd);
          expect(fs.readFileSync(path.join(artifacts, 'terminal.raw.log'), 'utf8')).toContain(item.mode === 'exit' ? 'STARTUP_DIAGNOSTIC' : 'GSTACK REVIEW REPORT');
          expect(fs.readFileSync(path.join(artifacts, 'terminal.visible.log'), 'utf8')).toContain(item.mode === 'exit' ? 'STARTUP_DIAGNOSTIC' : 'GSTACK REVIEW REPORT');
          if (['direct-finding', 'batched-finding', 'failed-call'].includes(item.mode)) {
            expect(result.observation.reviewCount).toBe(1);
            expect(result.observation.step0Count).toBe(0);
            expect(result.observation.fingerprints).toHaveLength(1);
            expect(result.observation.fingerprints[0].nativeCall.questions).toHaveLength(item.mode === 'batched-finding' ? 2 : 1);
          }
          if (item.mode === 'damaged-menu') {
            expect(events.filter(event => event.type === 'input-during-prose')).toEqual([]);
            expect(events.filter(event => event.type === 'damaged-menu-answer').map(event => event.input)).toEqual(['2\r']);
            expect(result.observation.fingerprints).toHaveLength(1);
            expect(result.observation.fingerprints[0].nativeCall.questions[0].header).toBe('Test scope');
          }
          if (item.mode === 'failed-call') {
            expect(result.observation.transcript.calls[0].failure).toContain('is_error');
            expect(result.observation.transcript.calls[0].answered).toBe(false);
          }
          if (item.mode === 'native-permission-policy') {
            expect(events.filter(event => event.type === 'unexpected-policy-input')).toEqual([]);
            expect(events.filter(event => event.type.endsWith('-policy-report')).map(event => event.type))
              .toEqual(['partial-policy-report', 'complete-policy-report']);
            expect(fs.readFileSync(item.report!, 'utf8')).toContain('NO UNRESOLVED DECISIONS');
            expect(events.filter(event => event.type === 'native-policy-answer').map(event => event.selected)).toEqual(['2']);
            expect(result.observation.transcript.calls).toHaveLength(1);
            expect(Object.values(result.observation.transcript.calls[0].answers)).toEqual(['Keep current policy']);
          }
          if (item.mode === 'permission-lifecycle') {
            expect(events.filter(event => event.type === 'unexpected-permission-input')).toEqual([]);
            expect(events.filter(event => event.type === 'permission-grant').map(event => event.input)).toEqual(['1\r', '1\r']);
            expect(events.filter(event => event.type === 'file-policy-answer').map(event => event.input)).toEqual(['2\r']);
            expect(result.observation.step0Count).toBe(1);
            expect(result.observation.reviewCount).toBe(0);
            expect(result.observation.transcript.calls).toHaveLength(1);
            expect(result.observation.transcript.calls[0].answers['Do you want to create gstack-test-plan-design.md?']).toBe('No');
          }
          if (['permission', 'missing-transcript'].includes(item.mode)) {
            expect(result.observation.reviewCount).toBe(0);
            expect(result.observation.step0Count).toBe(0);
          }
          if (item.mode === 'exit') {
            expect(result.observation.evidence).toContain('exitCode=7');
            expect(result.observation.evidence).toContain('STARTUP_DIAGNOSTIC fixture CLI booted');
            expect(result.observation.evidence).not.toContain('\x1b');
          }
          if (item.mode === 'complete') expect(events.at(-1).type).toBe('closed');
          if (item.mode === 'prerequisite') {
            expect(events.find(event => event.type === 'prerequisite-answer').selected).toBe(String(item.skipIndex));
            expect(result.observation.step0Count).toBe(item.custom ? 1 : 2);
            expect(result.observation.reviewCount).toBe(item.custom ? 1 : 0);
          }
          if (['late-mode', 'batched-mode'].includes(item.mode)) {
            const expectedLabel = item.mode === 'late-mode' ? 'DX POLISH' : 'DX EXPANSION';
            expect(events.find(event => event.type === 'mode-answer').label).toBe(expectedLabel);
            expect(result.observation.step0Count).toBe(1);
            expect(result.observation.reviewCount).toBe(0);
            expect(result.observation.transcript.calls).toHaveLength(1);
            const call = result.observation.transcript.calls[0];
            expect(call.answers[call.questions[0].question]).toBe(expectedLabel);
            expect(call.questions).toHaveLength(item.mode === 'late-mode' ? 1 : 2);
            expect(call.unansweredQuestionIndices).toEqual(item.mode === 'late-mode' ? [] : [1]);
          }
          if (item.mode === 'damaged-submit') {
            expect(events.filter(event => ['returned-to-unanswered', 'answered-remaining-tab', 'submitted-both-answers', 'unexpected-submit-input'].includes(event.type)))
              .toEqual([{ type: 'returned-to-unanswered' }, { type: 'answered-remaining-tab', selected: '2' }, { type: 'submitted-both-answers' }]);
            expect(result.observation.step0Count).toBe(1);
            expect(result.observation.reviewCount).toBe(0);
            expect(result.observation.transcript.calls).toHaveLength(1);
            expect(result.observation.transcript.calls[0].unansweredQuestionIndices).toEqual([]);
            expect(result.observation.transcript.calls[0].questions).toHaveLength(2);
          }
          cwds.add(startup.cwd);
          stateRoots.add(startup.stateRoot);
        }
        expect(cwds.size).toBe(cases.length);
        expect(stateRoots.size).toBe(cases.length);
      } finally {
        clearTimeout(killer);
        child.kill('SIGKILL');
        // A failed worker assertion must not leave its PTY fakes running.
        for (const item of cases) {
          if (!fs.existsSync(item.record)) continue;
          const startup = JSON.parse(fs.readFileSync(item.record, 'utf8').split('\n')[0]);
          try { process.kill(startup.pid, 'SIGKILL'); } catch { /* already reaped */ }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
