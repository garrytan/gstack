import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPtyScreen } from './helpers/pty-screen';
import { capturePlanCountQuestion, createPlanCountPermissionGuard, isPermissionDialogVisible, matchesNativePlanQuestion, nativePlanCallFingerprint, stripAnsi } from './helpers/claude-pty-runner';
import { autoplanRoutingSetupInput } from './helpers/autoplan-setup-question';
import { createPlanCountSnapshotWriter } from './helpers/plan-count-artifacts';
import { pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

function seed(frame: { initial: string[]; cursor: { x: number; y: number } }): string {
  return '\x1b[?1049h\x1b[2J' + frame.initial.map((line, i) => `\x1b[${i + 1};1H${line}\x1b[K`).join('') +
    `\x1b[${frame.cursor.y + 1};${frame.cursor.x + 1}H`;
}
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/pty-screen', name + '.json'), 'utf8'));

describe('owned PTY viewport', () => {
  test('preserves cursor positioning, carriage return, erase, and alternate-screen restoration', async () => {
    const screen = await createPtyScreen(20, 4);
    try {
      screen.write('normal');
      screen.write('\x1b[?1049h\x1b[2J\x1b[Habcdef\rX\x1b[4G!\x1b[K');
      expect((await screen.read()).split('\n')[0]).toBe('Xbc!');
      screen.write('\x1b[2;1Hsecond\x1b[2J\x1b[Hready');
      expect(await screen.read()).toBe('ready\n\n\n');
      screen.write('\x1b[?1049l');
      expect((await screen.read()).split('\n')[0]).toBe('normal');
    } finally { await screen.dispose(); }
  });

  test('uses the requested dimensions and excludes scrollback', async () => {
    const screen = await createPtyScreen(12, 3);
    try {
      screen.write('old permission\r\n1\r\n2\r\n3\r\n4');
      const current = await screen.read();
      expect(current.split('\n')).toHaveLength(3);
      expect(current).not.toContain('old permission');
      expect(current).toBe('2\n3\n4');
    } finally { await screen.dispose(); }
  });

  test('sessions isolate state and dispose flushes pending writes once without changing navigator', async () => {
    const navigatorBefore = globalThis.navigator;
    const a = await createPtyScreen(30, 4);
    const b = await createPtyScreen(30, 4);
    a.write('first'); b.write('second');
    const closing = a.dispose();
    await closing;
    expect(await a.read()).toBe('first\n\n\n');
    expect(await b.read()).toBe('second\n\n\n');
    expect(a.dispose()).toBe(closing);
    expect(() => a.write('late')).toThrow('disposed');
    await b.dispose();
    expect(globalThis.navigator).toBe(navigatorBefore);
  });

  test('retains a long genuine question when its options are visible and its header has scrolled away', async () => {
    const screen = await createPtyScreen(120, 40);
    try {
      screen.write('☐ API consistency\r\n' + 'Existing context for this independent issue.\r\n'.repeat(45) +
        'Which argument order should run_eval/run_batch use?\r\n❯1.Use the same argument order\r\n2.Keep the inconsistent order\r\n' +
        'Enter to select · ↑/↓ to navigate · Esc to cancel');
      const current = await screen.read();
      expect(current).not.toContain('☐ API consistency');
      const question = capturePlanCountQuestion(current, new Set(), 0, false);
      expect(question).not.toBeNull();
      expect(question?.options[0].label).toBe('Use the same argument order');
      expect(question?.options).toHaveLength(2);
    } finally { await screen.dispose(); }
  });

  test('clipped native handoff preserves its bound manual choice in either option order', async () => {
    for (const contextLines of [36, 41]) for (const reverse of [false, true]) {
      const options = [{ label: 'Run /plan-eng-review next' }, { label: "Done — I'll handle reviews manually" }];
      if (reverse) options.reverse();
      const call: NativePlanQuestionCall = { sessionId: 'long-handoff', toolUseId: 'pending', answered: false,
        questions: [{ header: 'Next review',
          question: 'CEO review is complete. Which next review should run? <gstack-qid:plan-ceo-next-steps>\n' +
            Array.from({ length: contextLines }, (_, i) => `Review context line ${i + 1}: the existing requirements remain approved.`).join('\n'),
          options }] };
      const q = call.questions[0]!;
      const screen = await createPtyScreen(120, 40);
      try {
        screen.write(`☐ ${q.header}\r\n${q.question.replace(/\n/g, '\r\n')}\r\n` +
          `❯ 1. ${options[0]!.label}\r\n  2. ${options[1]!.label}\r\nEnter to select · ↑/↓ to navigate · Esc to cancel`);
        const current = await screen.read();
        expect(current).not.toContain('☐ Next review');
        expect(current.includes('<gstack-qid:')).toBe(contextLines === 36);
        expect(matchesNativePlanQuestion(current, call)).toBe(true);
        const seen = new Set<string>();
        const capture = capturePlanCountQuestion(current, seen, 0, false, call);
        expect(capture?.nativeCall).toBe(call);
        expect(pickCeoCompletionHandoff(nativePlanCallFingerprint(call, 0, false), capture!)).toBe(reverse ? 1 : 2);
        expect(capturePlanCountQuestion(current, seen, 1, false, call)).toBeNull();
        for (const unrelated of [
          // Same choices are not identity, even with an intact native footer.
          current.slice(current.indexOf('❯ 1.')),
          current.replace('Review context line', 'Unrelated context line'),
          'A different question with shared context?\n' + current,
          current.replace('2. ' + options[1]!.label, '2. Approve a new implementation task'),
          current.replace('↑/↓ to navigate', '↑/↓ to navigte'),
          current + '\nDo you want to create another.md?\n❯ 1. Yes\n2. No\nEsc to cancel · Tab to amend',
        ]) {
          expect(matchesNativePlanQuestion(unrelated, call)).toBe(false);
          const other = capturePlanCountQuestion(unrelated, new Set(), 0, false, call);
          expect(other?.nativeCall).toBeUndefined();
          if (other) expect(pickCeoCompletionHandoff(nativePlanCallFingerprint(call, 0, false), other)).toBeNull();
        }
        expect(capturePlanCountQuestion(current, new Set(), 0, false, { ...call, failed: true })?.nativeCall).toBeUndefined();
      } finally { await screen.dispose(); }
    }
  });

  for (const chunkSize of [37, 4096]) {
    test(`captured routing redraw recovers the intact manual option (${chunkSize}-character chunks)`, async () => {
      const frame = fixture('autoplan');
      const screen = await createPtyScreen(frame.cols, frame.rows);
      try {
        screen.write(seed(frame));
        for (let i = 0; i < frame.update.length; i += chunkSize) screen.write(frame.update.slice(i, i + chunkSize));
        const current = await screen.read();
        expect(current.split('\n').map(line => line.trimEnd())).toEqual(frame.expected.map((line: string) => line.trimEnd()));
        expect(current).toContain("2. No thanks, I'll invoke skills manually");
        expect(stripAnsi(frame.update)).toContain("2. N thanks, I'll invokeskillsmanually");
        expect(autoplanRoutingSetupInput(current, new Set())).toBe('1');
      } finally { await screen.dispose(); }
    });
  }

  test('historical file results release a new current permission but cannot activate stale scrollback', () => {
    const menu = 'Do you want to create plan.md?\n❯1.Yes\n2.No\nEsc to cancel · Tab to amend';
    const completed = menu + '\n⎿ Wrote 44 lines';
    const guard = createPlanCountPermissionGuard();
    expect(guard(menu, menu)).toBe('grant');
    expect(guard(menu, menu)).toBe('handled');
    expect(guard('⎿ Wrote 44 lines\n❯ ', completed)).toBeNull();
    // The actual new menu has no old Write in its viewport. The separate
    // history establishes a new completed-file epoch for this same target.
    expect(guard(menu, completed + '\n' + menu)).toBe('grant');
    expect(guard(menu, completed + '\n' + menu)).toBe('handled');
    expect(guard('❯ ', completed + '\n' + menu)).toBeNull();
    expect(guard(menu + '\n⎿ Wrote 1 line', completed + '\n' + menu + '\n⎿ Wrote 1 line')).toBe('handled');
  });

  test('captured successful Write removes the old permission; raw and viewport evidence stay separate', async () => {
    const frame = fixture('design');
    const screen = await createPtyScreen(frame.cols, frame.rows);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-evidence-'));
    try {
      const raw = seed(frame) + frame.update;
      screen.write(raw);
      const active = await screen.read();
      expect(active.split('\n').map(line => line.trimEnd())).toEqual(frame.expected.map((line: string) => line.trimEnd()));
      expect(active).toContain('Do you want to create gstack-test-plan-design.md?');
      expect(isPermissionDialogVisible(active)).toBe(true);
      screen.write(frame.completed);
      const current = await screen.read();
      expect(current).toContain('Wrote 44 lines');
      expect(current).not.toContain('Do you want');
      expect(isPermissionDialogVisible(current)).toBe(false);
      expect(capturePlanCountQuestion(current, new Set(), 0, false)).toBeNull();
      const preservedRaw = raw + frame.completed;
      expect(stripAnsi(preservedRaw)).toContain('Do you wat');
      const native = { calls: [{ toolUseId: 'native-question', answered: true }] };
      const save = createPlanCountSnapshotWriter({ EVALS_RUN_ID: 'screen-proof', GSTACK_EVAL_DIR: dir });
      const saved = save({ skillName: 'plan-design-review', cwd: dir, claudeConfigDir: null,
        raw: preservedRaw, visible: stripAnsi(preservedRaw), viewport: current, observation: { native } });
      expect(saved.artifactError).toBeUndefined();
      expect(fs.readFileSync(path.join(saved.artifactDir!, 'terminal.raw.log'), 'utf8')).toBe(preservedRaw);
      expect(fs.readFileSync(path.join(saved.artifactDir!, 'terminal.screen.log'), 'utf8')).toBe(current);
      expect(JSON.parse(fs.readFileSync(path.join(saved.artifactDir!, 'observation.json'), 'utf8')).native).toEqual(native);
    } finally { await screen.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
