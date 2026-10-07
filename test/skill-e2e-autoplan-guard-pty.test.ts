/**
 * /autoplan publication guard, live (gate tier, rule kind, one trial, haiku).
 *
 * On the pinned Claude Code, in an interactive PTY session with default
 * settings, a project skill carrying /autoplan's own hook block enters Phase 1,
 * dispatches the CEO reviewer, reads a prepared close packet, publishes the Phase 1 report in a message
 * whose only tool call is `true autoplan-published ceo`, and enters Phase 2 in a
 * later message. The reviewer dispatch sends run_in_background, which the
 * 2.1.29x default fork-subagent schema strips. Claude Code 2.1.29x can write a tool call to the journal only
 * after PreToolUse returns, so this is where the guard's payload path and its
 * flush rule meet the real CLI. The outcome is read from the guard decision
 * log, never the screen; the no-op must run without a permission prompt.
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
        // A permission card is recorded and approved; the no-op must never raise one (DX-13).
        const screen = await session.currentScreen();
        if (/Do you want to proceed\?/.test(screen) && /❯\s*1\.\s*Yes/.test(screen)) {
          prompts.push(screen);
          await selectPtyNumberedOption(session, 1);
          await Bun.sleep(1_500);
        }
        if (log.some(e => e.decision === 'deny') || log.length >= 3) break;
        if (session.exited()) break;
      }
      await Bun.sleep(3_000);
      const log = s.readLog();
      const summary = { prompts: prompts.length, phase1Ms, totalMs: Math.round(performance.now() - started),
        decisions: log.map(e => ({ decision: e.decision, code: e.code, path: e.path, version: e.claude_code_version })) };
      console.log(`[autoplan-guard-pty] ${JSON.stringify(summary)}`);
      if (log.length !== 3 || log.some(e => e.decision === 'deny'))
        console.log(`[autoplan-guard-pty] journal:\n${s.journalSummary().join('\n')}\n[autoplan-guard-pty] screen:\n${session.visibleText().slice(-2_000)}`);
      for (const prompt of prompts) console.log(`[autoplan-guard-pty] permission card approved:\n${prompt}`);
      expect(prompts.filter(p => p.replace(/\s+/g, '').includes('autoplan-published'))).toEqual([]);
      expect(log.filter(e => e.decision === 'deny')).toEqual([]);
      // Phase 1 entry, the CEO reviewer dispatch (Cause A: run_in_background sent, stripped from the payload)
      // and the Phase 2 transition: three guarded allows, each verified (not an unverified allow).
      expect(log.map(e => [e.decision, e.disposition])).toEqual([['allow', 'allow'], ['allow', 'allow'], ['allow', 'allow']]);
    } finally {
      await session.close();
      s.cleanup();
    }
  }, 600_000);
});
