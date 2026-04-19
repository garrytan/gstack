/**
 * gstack-model-benchmark CLI tests (offline).
 *
 * Covers CLI wiring that unit tests against benchmark-runner.ts can't see:
 *   - --dry-run auth/provider-list resolution
 *   - unknown provider WARN path
 *   - provider default (claude) when --models omitted
 *   - prompt resolution (inline --prompt vs positional file path)
 *   - output format flag wiring via --dry-run (avoids real CLI invocation)
 *
 * All tests use --dry-run so no API calls happen.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-model-benchmark');

function run(args: string[], opts: { env?: Record<string, string> } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bun', ['run', BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    encoding: 'utf-8',
    timeout: 15000,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

describe('gstack-model-benchmark --dry-run', () => {
  test('prints provider availability report and exits 0', () => {
    const r = run(['--prompt', 'hi', '--models', 'claude,gpt,gemini', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gstack-model-benchmark --dry-run');
    expect(r.stdout).toContain('claude');
    expect(r.stdout).toContain('gpt');
    expect(r.stdout).toContain('gemini');
    expect(r.stdout).toContain('no prompts sent');
  });

  test('reports default provider when --models omitted', () => {
    const r = run(['--prompt', 'hi', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('providers:  claude');
  });

  test('unknown provider in --models emits WARN and is dropped', () => {
    const r = run(['--prompt', 'hi', '--models', 'claude,gpt-42-fake', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('unknown provider');
    expect(r.stderr).toContain('gpt-42-fake');
    expect(r.stdout).toContain('providers:  claude');
    expect(r.stdout).not.toContain('gpt-42-fake');
  });

  test('empty --models list falls back to claude default', () => {
    const r = run(['--prompt', 'hi', '--models', '', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('providers:  claude');
  });

  test('--timeout-ms and --workdir flags flow through to dry-run report', () => {
    const r = run(['--prompt', 'hi', '--timeout-ms', '9999', '--workdir', '/tmp', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('timeout_ms: 9999');
    expect(r.stdout).toContain('workdir:    /tmp');
  });

  test('--judge flag reported in dry-run output', () => {
    const r = run(['--prompt', 'hi', '--judge', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('judge:      on');
  });

  test('--output flag reported in dry-run', () => {
    const r = run(['--prompt', 'hi', '--output', 'json', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('output:     json');
  });

  test('each adapter reports either OK or NOT READY, never crashes', () => {
    const r = run(['--prompt', 'hi', '--models', 'claude,gpt,gemini', '--dry-run']);
    expect(r.status).toBe(0);
    // Each provider line must end in OK or NOT READY
    const lines = r.stdout.split('\n');
    const adapterLines = lines.filter(l => /^\s+(claude|gpt|gemini):/.test(l));
    expect(adapterLines.length).toBe(3);
    for (const line of adapterLines) {
      expect(line).toMatch(/(OK|NOT READY)/);
    }
  });

  test('NOT READY path fires when auth env vars are stripped', () => {
    // On a dev machine with full auth configured, the default --dry-run output
    // shows OK for every provider with credentials. Strip auth env vars AND
    // point HOME at an empty temp dir so adapters can't find file-based creds.
    // This test exists to catch regressions where the NOT READY branch itself
    // breaks (crash, missing remediation hint, wrong message format).
    //
    // Note: claude adapter's `os.homedir()` call is sometimes cached by Bun and
    // doesn't always pick up the HOME override, so this test asserts only on
    // gpt + gemini adapters where HOME redirection reliably makes the adapter's
    // credentials-path check fail. Two adapters hitting NOT READY with full
    // remediation messages is sufficient coverage for the branch.
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-noauth-home-'));
    try {
      const minimalEnv: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        TERM: process.env.TERM ?? 'xterm',
        HOME: emptyHome,
      };
      const result = spawnSync('bun', ['run', BIN, '--prompt', 'hi', '--models', 'claude,gpt,gemini', '--dry-run'], {
        cwd: ROOT,
        env: minimalEnv,
        encoding: 'utf-8',
        timeout: 15000,
      });
      expect(result.status).toBe(0);
      const out = result.stdout?.toString() ?? '';
      // gpt + gemini must report NOT READY in this clean env (their auth check
      // reads paths under the overridden HOME).
      expect(out).toMatch(/gpt:\s+NOT READY/);
      expect(out).toMatch(/gemini:\s+NOT READY/);
      // Every NOT READY line must include a concrete remediation hint so users
      // can resolve the missing auth. This is the regression we care about.
      const notReadyLines = out.split('\n').filter(l => l.includes('NOT READY'));
      expect(notReadyLines.length).toBeGreaterThanOrEqual(2);
      for (const line of notReadyLines) {
        expect(line).toMatch(/(install|Install|login|export|Run|Log in)/);
      }
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test('long prompt is truncated in dry-run display', () => {
    const longPrompt = 'x'.repeat(200);
    const r = run(['--prompt', longPrompt, '--dry-run']);
    expect(r.status).toBe(0);
    // Summary truncates to 80 chars + ellipsis
    expect(r.stdout).toMatch(/prompt:\s+x{80}…/);
  });
});

describe('gstack-model-benchmark prompt resolution', () => {
  test('positional file path is read and passed as prompt', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-prompt-'));
    const promptFile = path.join(tmp, 'prompt.txt');
    fs.writeFileSync(promptFile, 'hello from file');
    try {
      const r = run([promptFile, '--dry-run']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('hello from file');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('positional non-file arg is treated as inline prompt', () => {
    const r = run(['treat-me-as-inline', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('treat-me-as-inline');
  });

  test('missing prompt exits non-zero', () => {
    const r = run(['--dry-run']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('specify a prompt');
  });
});
