import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const DIR = mkdtempSync(path.join(tmpdir(), 'claude-windows-job-'));
const FAKE = path.join(DIR, 'fake claude.ts');
const DESCENDANT = path.join(DIR, 'pipe holder.ts');
const PID_FILE = path.join(DIR, 'descendant.pid');
const CLI = path.join(ROOT, 'bin/gstack-claude-code');
const FAILED_JOB = path.join(DIR, 'failed job.ts');

// Exercise the initialization failure at the actual CLI boundary on every OS,
// without adding a production bypass flag for this safety requirement.
writeFileSync(FAILED_JOB, `
Object.defineProperty(process, 'platform', { value: 'win32' });
// OpenProcess(0) is invalid on Windows. Other OSes fail earlier opening the
// Windows DLL; both must fail closed before spawning the configured reviewer.
Object.defineProperty(process, 'pid', { value: 0 });
`);

// Publish readiness only after the grandchild has initialized and flushed both
// inherited pipes; a PID returned by spawn alone does not establish that state.
writeFileSync(DESCENDANT, `
import { writeFileSync } from 'node:fs';
setInterval(() => {}, 1000);
await new Promise(resolve => process.stdout.write(' ', resolve));
await new Promise(resolve => process.stderr.write(' ', resolve));
writeFileSync(process.env.PID_FILE!, String(process.pid));
`);

writeFileSync(FAKE, `
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
await Bun.stdin.text();
rmSync(process.env.PID_FILE!, { force: true });
const child = spawn(process.execPath, [process.env.DESCENDANT!], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
const readyBy = Date.now() + 2000;
while (!existsSync(process.env.PID_FILE!)) {
  if (child.exitCode !== null || Date.now() >= readyBy) throw new Error('Descendant did not initialize its inherited pipes');
  await Bun.sleep(5);
}
if (process.env.FAKE_MODE === 'timeout') await new Promise(() => {});
await new Promise(resolve => process.stdout.write(JSON.stringify({ result: 'NO_FINDINGS' }), resolve));
process.exit(0);
`);

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function environment(mode: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GSTACK_CLAUDE_BIN: process.execPath,
    GSTACK_CLAUDE_BIN_ARGS: JSON.stringify([FAKE]),
    FAKE_MODE: mode,
    PID_FILE,
    DESCENDANT,
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function expectDead(pid: number) {
  for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(25);
  expect(alive(pid)).toBe(false);
}

function cleanupDescendant() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8'));
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  } catch { /* No descendant was created. */ }
}

// These exercise the actual standalone CLI boundary. A job must never be
// attached to the test runner process, which owns unrelated concurrent work.
describe('Windows Claude CLI job containment', () => {
  test('job initialization failure stops before reviewer dispatch and emits a named error', () => {
    rmSync(PID_FILE, { force: true });
    const result = spawnSync(process.execPath, ['--preload', FAILED_JOB, CLI, '--cwd', DIR, '--access', 'none', '--timeout-ms', '2000'], {
      env: environment('descendant'), input: 'review', encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.provider).toBe('claude-code');
    expect(parsed.status).toBe('unavailable');
    expect(parsed.error.code).toBe('supervision');
    expect(parsed.error.message).toContain('Claude Code Windows process supervision could not initialize');
    expect(() => readFileSync(PID_FILE)).toThrow();
  });

  for (const [mode, expected] of [['descendant', 'output-drain'], ['timeout', 'timeout']]) {
    test.skipIf(process.platform !== 'win32')(`${mode} kills owned descendants and preserves a sibling process`, async () => {
      const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const started = Date.now();
      try {
        const result = spawnSync(process.execPath, [CLI, '--cwd', DIR, '--access', 'none', '--timeout-ms', '2000'], {
          env: environment(mode), input: 'review', encoding: 'utf8', timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.status).toBe('unavailable');
        expect(parsed.error.code).toBe(expected);
        expect(Date.now() - started).toBeLessThan(6000);
        await expectDead(Number(readFileSync(PID_FILE, 'utf8')));
        expect(alive(sibling.pid!)).toBe(true);
      } finally {
        cleanupDescendant();
        sibling.kill('SIGKILL');
      }
    });
  }

  test.skipIf(process.platform !== 'win32')('abrupt runner exit closes the job and reaps its descendants', async () => {
    rmSync(PID_FILE, { force: true });
    const runner = spawn(process.execPath, [CLI, '--cwd', DIR, '--access', 'none', '--timeout-ms', '10000'], {
      env: environment('timeout'), stdio: ['pipe', 'ignore', 'ignore'],
    });
    runner.stdin!.end('review');
    try {
      let descendant = 0;
      for (let i = 0; i < 200 && !descendant; i++) {
        try { descendant = Number(readFileSync(PID_FILE, 'utf8')); } catch { await Bun.sleep(25); }
      }
      expect(descendant).toBeGreaterThan(0);
      runner.kill('SIGKILL');
      await expectDead(descendant);
    } finally {
      runner.kill('SIGKILL');
      cleanupDescendant();
    }
  });
});
