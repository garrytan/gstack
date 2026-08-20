/**
 * #2461 daemon crash log + F6 log hygiene needles.
 *
 * The detached daemon's stdout/stderr now land in <stateDir>/browse-daemon.log
 * (both spawn paths) instead of 'ignore'. That makes crashes diagnosable —
 * and makes it load-bearing that NOTHING secret or page-derived reaches the
 * daemon's console streams:
 *
 *   - No console.* call anywhere in src/ may pass a token VALUE (AUTH_TOKEN,
 *     state.token, attachToken, INTERNAL_TOKEN, setup keys). Names like
 *     tokenInfo.clientId are fine — the needle targets expressions whose
 *     value IS a token.
 *   - The page-content carrier modules (tab-session, buffers,
 *     content-security, activity) stay console-free, so raw page-derived
 *     strings can't be echoed into the log unsanitized.
 *
 * Source-level, same style as windows-spawn-hide.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.join(import.meta.dir, '../src');
const SRC = (f: string) => fs.readFileSync(path.join(SRC_DIR, f), 'utf-8');

describe('#2461 daemon log wiring', () => {
  test('both daemon spawn paths capture stdout/stderr to browse-daemon.log', () => {
    const cli = SRC('cli.ts');
    // Unix path: fd from openDaemonLogSink wired into stdio.
    expect(cli).toContain("stdio: ['ignore', daemonLogFd, daemonLogFd]");
    expect(cli).toMatch(/openDaemonLogSink/);
    // Windows path: the fd must be opened INSIDE the node -e launcher (an fd
    // opened in cli.ts wouldn't cross the spawn boundary).
    expect(cli).toContain("stdio:['ignore',logFd,logFd]");
    expect(cli).toContain('browse-daemon.log');
    // The old fully-discarded wiring must not come back on either daemon path.
    expect(cli).not.toContain("stdio:['ignore','ignore','ignore']");
  });

  test('log sink is append-mode (accumulates across respawns)', () => {
    const cli = SRC('cli.ts');
    // Both spawn paths open through the single daemonLogPath() source (M4),
    // which itself must build from the state dir.
    expect(cli).toMatch(/openSync\(daemonLogPath\(\), 'a'\)/);
    expect(cli).toMatch(/path\.join\(config\.stateDir, 'browse-daemon\.log'\)/);
    expect(cli).toMatch(/openSync\(\$\{daemonLogPathStr\},'a'\)/);
  });

  test('append-mode log is growth-bounded: rotated at 10MB before daemon start', () => {
    const cli = SRC('cli.ts');
    expect(cli).toMatch(/DAEMON_LOG_MAX_BYTES = 10 \* 1024 \* 1024/);
    expect(cli).toMatch(/rotateDaemonLogIfOversized\(\);/);
    // Single generation: rename to .1, matching the repo's 10MB conventions.
    expect(cli).toMatch(/renameSync\(p, `\$\{p\}\.1`\)/);
  });

  test('rotation behavior: oversized rotates to a single .1 generation, small/missing are no-ops', () => {
    const os = require('os');
    const { rotateDaemonLogIfOversized } = require('../src/cli');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-daemon-log-'));
    try {
      const p = path.join(tmp, 'browse-daemon.log');
      // Missing log: no throw (first launch).
      rotateDaemonLogIfOversized(p, 1024);
      // Under the cap: untouched, no generation created.
      fs.writeFileSync(p, 'x'.repeat(10));
      rotateDaemonLogIfOversized(p, 1024);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.existsSync(`${p}.1`)).toBe(false);
      // Over the cap: rotated out of the way so the daemon starts fresh.
      fs.writeFileSync(p, 'y'.repeat(2048));
      rotateDaemonLogIfOversized(p, 1024);
      expect(fs.existsSync(p)).toBe(false);
      expect(fs.readFileSync(`${p}.1`, 'utf-8')).toContain('y');
      // Single generation: the next rotation REPLACES .1 (bounded at ~2x cap
      // total, never a .2).
      fs.writeFileSync(p, 'z'.repeat(2048));
      rotateDaemonLogIfOversized(p, 1024);
      expect(fs.readFileSync(`${p}.1`, 'utf-8')).toContain('z');
      expect(fs.existsSync(`${p}.2`)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('bun-polyfill routes Windows spawns through cross-spawn (ENOENT + cmd.exe injection fix)', () => {
    const polyfill = SRC('bun-polyfill.cjs');
    expect(polyfill).toContain("require('cross-spawn')");
    expect(polyfill).toMatch(/process\.platform === 'win32' \? crossSpawn\.sync : nodeSpawnSync/);
    expect(polyfill).toMatch(/process\.platform === 'win32' \? crossSpawn : nodeSpawn/);
    // The rejected-for-cause alternative must not creep back in: shell:true
    // on Windows routes through cmd.exe and does NOT neutralize & | ^ % < >.
    // (Strip comments — the header documents WHY shell:true was rejected.)
    const code = polyfill.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/shell:\s*true/);
  });
});

describe('F6 log hygiene: nothing secret or page-derived reaches daemon console', () => {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts') || f.endsWith('.cjs'));

  test('no console.* call passes a token value', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = SRC(file);
      for (const [idx, line] of content.split('\n').entries()) {
        if (!/console\.(log|error|warn|info)\(/.test(line)) continue;
        // Interpolated token values: ${...token} / ${...Token} — the
        // expression ENDS in token, i.e. the value IS the token. Names like
        // ${tokenInfo.clientId} don't match.
        if (/\$\{[^}]*[tT]oken\s*\}/.test(line)) {
          offenders.push(`${file}:${idx + 1}: ${line.trim().slice(0, 120)}`);
          continue;
        }
        // Bare token args: console.log('x', token) / (..., authToken)
        if (/console\.(log|error|warn|info)\([^)]*[^a-zA-Z_.][tT]oken\s*[,)]/.test(line)) {
          offenders.push(`${file}:${idx + 1}: ${line.trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('page-content carrier modules are console-free', () => {
    // Page-derived strings flow through these modules. Keeping them
    // console-free guarantees raw page content can't be echoed into
    // browse-daemon.log without passing an egress sanitizer first.
    for (const file of ['tab-session.ts', 'buffers.ts', 'content-security.ts', 'activity.ts']) {
      const content = SRC(file);
      const calls = content.match(/console\.(log|error|warn|info)\(/g) || [];
      expect({ file, count: calls.length }).toEqual({ file, count: 0 });
    }
  });
});
