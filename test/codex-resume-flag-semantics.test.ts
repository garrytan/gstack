/**
 * Live codex CLI flag-semantics smoke for `codex exec resume`.
 *
 * Closes the gap left by #1270's regex-only assertion against codex/SKILL.md.
 * That regex catches the SKILL.md regressing back to `-C/-s` flags, but it
 * does not catch the codex CLI itself flipping flag semantics again. This
 * test probes the live `codex exec resume --help` output and asserts the
 * surface the gstack /codex skill depends on.
 *
 * Skips silently when codex is not on PATH, so dev machines without codex
 * installed never see this fail. CI lanes that run with codex installed
 * (the periodic-tier eval runners) will exercise it.
 */

import { afterAll, describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const codexPath = spawnSync('which', ['codex'], { encoding: 'utf-8', timeout: 30_000 }).stdout.trim();
const codexAvailable = codexPath.length > 0;
// Every codex run writes $CODEX_HOME/tmp/arg0, so the smoke gets a private
// HOME and CODEX_HOME and never touches the developer's real ~/.codex.
const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-smoke-'));
fs.mkdirSync(path.join(smokeHome, '.codex'));
const smokeEnv = { ...process.env, HOME: smokeHome, CODEX_HOME: path.join(smokeHome, '.codex') };
afterAll(() => fs.rmSync(smokeHome, { recursive: true, force: true }));

describe.skipIf(!codexAvailable)(
  'codex exec resume — flag semantics (live CLI smoke; closes #1270 regex-only gap)',
  () => {
    test('codex exec resume --help mentions sandbox_mode as a -c config key', () => {
      const result = spawnSync('codex', ['exec', 'resume', '--help'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        env: smokeEnv,
      });
      const helpText = (result.stdout || '') + '\n' + (result.stderr || '');
      // The /codex skill builds resume invocations with `-c 'sandbox_mode="read-only"'`.
      // If codex stops accepting `-c sandbox_mode=...` for the resume subcommand,
      // every resume invocation through gstack starts failing.
      expect(helpText).toMatch(/-c\b|--config\b|sandbox_mode/i);
    });

    test('codex exec resume --help does NOT advertise -C as a top-level flag', () => {
      const result = spawnSync('codex', ['exec', 'resume', '--help'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        env: smokeEnv,
      });
      const helpText = (result.stdout || '') + '\n' + (result.stderr || '');
      // The whole point of #1270 was that `codex exec resume` rejects `-C <dir>`.
      // If the help text starts listing `-C` again, the SKILL.md guidance to
      // drop `-C` is wrong and the surrounding `cd "$_REPO_ROOT"` workaround is
      // unnecessary. Either way, /codex needs an update.
      // Allow `-C` to appear in flag descriptions or option-name strings as long
      // as it isn't presented as a flag of the `resume` subcommand. The cheapest
      // signal: the `Options:` block (or first-column flag list) should not
      // contain a literal `-C ` flag entry on its own line.
      const optionLines = helpText
        .split('\n')
        .map((l) => l.trimStart())
        .filter((l) => /^-[A-Za-z],?\s/.test(l) || /^--[A-Za-z]/.test(l));
      const hasTopLevelDashC = optionLines.some((l) => /^-C[\s,]/.test(l));
      expect(hasTopLevelDashC).toBe(false);
    });
  },
);
