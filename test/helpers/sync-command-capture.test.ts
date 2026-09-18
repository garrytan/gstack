import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCapturedCommand } from './sync-command-capture';

test('captures actual stdin/stdout/stderr and a nonzero exit through private regular files', () => {
  const result = runCapturedCommand(process.execPath, ['-e', `
    const fs = require('node:fs');
    const info = {
      input: fs.readFileSync(0, 'utf8'),
      files: [0, 1, 2].map(fd => fs.fstatSync(fd).isFile()),
      modes: [0, 1, 2].map(fd => fs.fstatSync(fd).mode & 0o777),
      outputPath: process.platform === 'linux' ? fs.realpathSync('/proc/self/fd/1') : null,
    };
    fs.writeSync(1, JSON.stringify(info));
    fs.writeSync(2, 'first diagnostic\\nlast diagnostic\\n');
    process.exit(7);
  `], { input: 'first input\nsecond input', captureStdout: true, timeout: 30_000 });
  expect(result.status).toBe(7);
  expect(result.stderr).toBe('first diagnostic\nlast diagnostic\n');
  const info = JSON.parse(result.stdout);
  expect(info.input).toBe('first input\nsecond input');
  expect(info.files).toEqual([true, true, true]);
  if (process.platform !== 'win32') expect(info.modes).toEqual([0o600, 0o600, 0o600]);
  if (info.outputPath) expect(fs.existsSync(path.dirname(info.outputPath))).toBe(false);
});

test('empty input reaches EOF and returns the actual empty stdout', () => {
  const result = runCapturedCommand(process.execPath, ['-e', `
    const fs = require('node:fs');
    fs.writeSync(1, fs.readFileSync(0));
  `], { input: '', captureStdout: true, timeout: 30_000 });
  expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
});

test('unused input/output are ignored while stderr and exit status remain observable', () => {
  const result = runCapturedCommand(process.execPath, ['-e', `
    const fs = require('node:fs');
    if (fs.readFileSync(0).length !== 0) process.exit(9);
    fs.writeSync(1, 'unused output');
    fs.writeSync(2, 'retained diagnostic');
  `], { timeout: 30_000 });
  expect(result).toEqual({ status: 0, stdout: '', stderr: 'retained diagnostic' });
});

test('launch failure retains the original cause and cannot become a successful status', () => {
  const missing = path.join(os.tmpdir(), 'gstack-missing-command-' + randomUUID());
  const result = runCapturedCommand(missing, [], { captureStdout: true, timeout: 30_000 });
  expect(result.status).toBeNull();
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('[spawn]');
  expect(result.stderr).toContain(missing);
});

test('the actual deadline retains diagnostics and cleans up the waiting child', () => {
  const result = runCapturedCommand(process.execPath, ['-e', `
    const fs = require('node:fs');
    fs.writeSync(1, String(process.pid));
    fs.writeSync(2, 'waiting-child diagnostic\\n');
    setInterval(() => {}, 1000);
  `], { captureStdout: true, timeout: 1000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('waiting-child diagnostic\n');
  expect(result.stderr).toContain('ETIMEDOUT');
  const pid = Number(result.stdout.trim());
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  let errorCode: string | undefined;
  try { process.kill(pid, 0); } catch (error) { errorCode = (error as NodeJS.ErrnoException).code; }
  expect(errorCode).toBe('ESRCH');
});
