/**
 * /autoplan publication guard, live (gate tier, rule kind, one trial, haiku).
 *
 * On the pinned Claude Code, in an interactive PTY session with default
 * settings, a project skill carrying /autoplan's own hook block enters Phase 1,
 * dispatches the CEO reviewer, reads a prepared close packet, publishes the Phase 1 report in a message
 * whose only tool call is `true autoplan-published ceo`, enters Phase 2 in a
 * later message and dispatches the Phase 2 reviewer. The reviewer dispatch sends run_in_background, which the
 * 2.1.29x default fork-subagent schema strips. Claude Code 2.1.29x can write a tool call to the journal only
 * after PreToolUse returns, so this is where the guard's payload path and its
 * flush rule meet the real CLI. The outcome is read from the guard decision
 * log, never the screen.
 *
 * The reviewer runs in the background, so its completion notice starts a new
 * turn and Claude Code stops applying the skill's allowed tools. Every later
 * Read of /autoplan's own files (the close packet and the Phase 2 reviewer's
 * input in the project's .gstack/tmp/autoplan/, the installed Phase 2 section)
 * must still raise no permission card.
 */
import { expect } from 'bun:test';
import { describeIfSelected, testIfSelected } from './helpers/e2e-helpers';
import { launchClaudePty, selectPtyNumberedOption } from './helpers/claude-pty-runner';
import { prepareGuardSession } from './helpers/autoplan-guard-pty';

const MODEL = 'claude-haiku-4-5-20251001';

describeIfSelected('autoplan publication guard live PTY', ['autoplan-guard-pty'], () => {
  testIfSelected('autoplan-guard-pty', async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('autoplan-guard-pty requires ANTHROPIC_API_KEY; refusing to skip');
    const s = prepareGuardSession(process.env.ANTHROPIC_API_KEY);
    const session = await launchClaudePty({ permissionMode: null, model: MODEL, cwd: s.project, env: s.env, timeoutMs: 540_000, observeScreen: true });
    const started = performance.now();
    const prompts: string[] = [];
    let phase1Ms: number | null = null;
    try {
      await Bun.sleep(5_000);
      session.send(s.prompt); await Bun.sleep(400); session.send('\r');
      const deadline = performance.now() + 480_000;
      while (performance.now() < deadline) {
        await Bun.sleep(1_000);
        const log = s.readLog();
        if (phase1Ms === null && log.length) phase1Ms = Math.round(performance.now() - started);
        // A permission card is recorded and approved so the run can finish; any card fails the case.
        const screen = await session.currentScreen();
        if (/Do you want to proceed\?/.test(screen) && /❯\s*1\.\s*Yes/.test(screen)) {
          prompts.push(screen);
          await selectPtyNumberedOption(session, 1);
          await Bun.sleep(1_500);
        }
        if (log.some(e => e.decision === 'deny') || (log.length >= 4 && s.noticeEvidence().notices >= 2)) break;
        if (session.exited()) break;
      }
      await Bun.sleep(3_000);
      const log = s.readLog(), evidence = s.noticeEvidence();
      const summary = { prompts: prompts.length, phase1Ms, totalMs: Math.round(performance.now() - started), evidence,
        decisions: log.map(e => ({ decision: e.decision, code: e.code, path: e.path, version: e.claude_code_version })) };
      console.log(`[autoplan-guard-pty] ${JSON.stringify(summary)}`);
      if (log.length !== 4 || log.some(e => e.decision === 'deny') || prompts.length)
        console.log(`[autoplan-guard-pty] journal:\n${s.journalSummary().join('\n')}\n[autoplan-guard-pty] screen:\n${session.visibleText().slice(-2_000)}`);
      for (const prompt of prompts) console.log(`[autoplan-guard-pty] permission card approved:\n${prompt}`);
      expect(log.filter(e => e.decision === 'deny')).toEqual([]);
      // Phase 1 entry, the CEO reviewer dispatch (Cause A: run_in_background sent, stripped from the payload),
      // the Phase 2 transition and the Phase 2 reviewer dispatch: four guarded allows, each verified.
      expect(log.map(e => [e.decision, e.disposition])).toEqual(Array(4).fill(['allow', 'allow']));
      // The CEO reviewer's notice started a new turn before the close packet, the Phase 2 entry and the Phase 2 dispatch.
      expect(evidence.afterNotice.filter(c => /^Read .*close-packet\.md$/.test(c))).not.toEqual([]);
      expect(evidence.afterNotice.filter(c => /^Read .*autoplan\/sections\/design-phase\.md$/.test(c))).not.toEqual([]);
      expect(evidence.afterNotice).toContain('Agent Design review');
      expect(evidence.reviewerReads.filter(f => /\.gstack\/tmp\/autoplan\/autoplan-design-[^/]+\/native-prompt\.md$/.test(f))).not.toEqual([]);
      expect(prompts).toEqual([]);
    } finally {
      await session.close();
      s.cleanup();
    }
  }, 600_000);
});
