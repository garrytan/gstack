/**
 * /autoplan in a long session (periodic tier, rule kind, one trial, haiku;
 * about $0.15 a run: two short headless turns plus one scripted resumed PTY
 * session). A real session is compacted, its journal is padded past 100 MiB
 * with owned records before the compact boundary (Claude Code does not replay
 * them to the API), and the resumed session enters /autoplan Phase 1 through
 * the guard. The outcome comes from the guard decision log (ENG-6): the PTY
 * counting reader keeps a whole-file cap and cannot read this journal.
 */
import { expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describeIfSelected, testIfSelected } from './helpers/e2e-helpers';
import { launchClaudePty, resolveClaudeBinary, selectPtyNumberedOption } from './helpers/claude-pty-runner';
import { prepareGuardSession } from './helpers/autoplan-guard-pty';
import { padBeforeCompactBoundary } from './helpers/journal-padding';

const MODEL = 'claude-haiku-4-5-20251001';
const PADDED_BYTES = 101 * 1024 * 1024;

describeIfSelected('autoplan long-session guard', ['autoplan-long-session'], () => {
  testIfSelected('autoplan-long-session', async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('autoplan-long-session requires ANTHROPIC_API_KEY; refusing to skip');
    const claude = resolveClaudeBinary();
    if (!claude) throw new Error('autoplan-long-session needs the claude CLI');
    const s = prepareGuardSession(process.env.ANTHROPIC_API_KEY);
    const env = { PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, TERM: 'dumb', ...s.env };
    const sessionId = randomUUID();
    const headless = (...args: string[]) => {
      const child = spawnSync(claude, args, { cwd: s.project, env, encoding: 'utf8', timeout: 120_000 });
      if (child.status !== 0) throw new Error(`claude ${args.join(' ')} exited ${child.status ?? child.signal}: ${child.stderr.slice(-400)}`);
    };
    try {
      headless('-p', 'Reply with the single word ok.', '--session-id', sessionId, '--model', MODEL, '--strict-mcp-config');
      headless('-p', '/compact', '--resume', sessionId, '--model', MODEL, '--strict-mcp-config');
      const projects = path.join(s.config, 'projects');
      const journal = fs.readdirSync(projects).map(dir => path.join(projects, dir, `${sessionId}.jsonl`)).find(file => fs.existsSync(file));
      if (!journal) throw new Error('the compacted session journal was not written');
      const padded = padBeforeCompactBoundary(journal, PADDED_BYTES);
      expect(fs.statSync(journal).size).toBeGreaterThan(100 * 1024 * 1024);

      const session = await launchClaudePty({ permissionMode: null, model: MODEL, cwd: s.project, env: s.env, timeoutMs: 540_000,
        observeScreen: true, extraArgs: ['--resume', sessionId] });
      const started = performance.now();
      try {
        await Bun.sleep(10_000);
        session.send(s.prompt); await Bun.sleep(400); session.send('\r');
        while (performance.now() - started < 420_000) {
          await Bun.sleep(1_000);
          const screen = await session.currentScreen();
          if (/Do you want to proceed\?/.test(screen) && /❯\s*1\.\s*Yes/.test(screen)) { await selectPtyNumberedOption(session, 1); await Bun.sleep(1_500); }
          const log = s.readLog();
          if (log.some(e => e.decision === 'deny') || log.length >= 3 || session.exited()) break;
        }
        await Bun.sleep(3_000);
      } finally { await session.close(); }
      const log = s.readLog();
      console.log(`[autoplan-long-session] ${JSON.stringify({ journalMiB: Math.round(fs.statSync(journal).size / 1048576), paddingRecords: padded.records,
        ms: Math.round(performance.now() - started), decisions: log.map(e => [e.decision, e.disposition, e.code, e.path]) })}`);
      if (!log.length) console.log(`[autoplan-long-session] journal:\n${s.journalSummary().slice(-20).join('\n')}`);
      // Phase 1 entry: a verified allow (not an unverified one) on the >100 MiB journal.
      expect(log[0]).toMatchObject({ decision: 'allow', disposition: 'allow', code: null });
      expect(['journal', 'payload']).toContain(log[0]!.path);
      expect(log.filter(e => e.decision === 'deny')).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 600_000);
});
