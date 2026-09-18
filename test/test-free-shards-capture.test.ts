/** Faults stay inside fresh Bun children; no spawn mock can leak into a shard. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SUMMARY = 'Ran 3 tests across 1 files. [12.00ms]';
const PARTIAL = 'captured stdout before the pipe was lost';
const CAUSE = 'fixture stdout read failed: EIO';
type Mode = 'clean' | 'destroyed' | 'destroyed-error' | 'delayed-error' | 'partial' | 'absent';

function runCapture(mode: Mode, exitCode = 0) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'free-capture-'));
  const scratch = path.join(fixture, 'scratch');
  const receipt = path.join(fixture, 'receipt.json');
  const logFilePath = path.join(fixture, 'capture.log');
  const script = path.join(ROOT, 'test/fixtures/free-shard-capture.ts');
  fs.mkdirSync(scratch);
  try {
    const config = { mode, exitCode, summary: SUMMARY, partial: PARTIAL, cause: CAUSE, receipt, logFilePath };
    const result = Bun.spawnSync([process.execPath, script, 'harness', JSON.stringify(config)], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    });
    const stderr = result.stderr.toString();
    const evidence = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null;
    expect(result.exitCode, JSON.stringify({ stderr, evidence })).toBe(0);
    expect(evidence.watchdog).toBe(false);
    expect(evidence.unhandled).toEqual([]);
    expect(evidence.childTmp.startsWith(scratch + path.sep)).toBe(true);
    expect(fs.existsSync(evidence.childTmp)).toBe(false);
    expect(fs.readdirSync(scratch)).toEqual([]);
    const captured = fs.readFileSync(logFilePath, 'utf8');
    expect(captured).toContain(SUMMARY); // A valid stderr summary cannot certify lost stdout.
    return { outcome: evidence.outcome, captured, stderr };
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

describe('free shard capture integrity', () => {
  test('normal end followed by close preserves complete capture and passes', () => {
    const result = runCapture('clean');
    expect(result.outcome.status).toBe('passed');
    expect(result.outcome.exitCode).toBe(0);
    expect(result.outcome.unattributedFailures).toBe(0);
    expect(result.captured).toContain(PARTIAL);
  });

  test('stdout destroyed before spawn returns fails despite a valid stderr summary', () => {
    const result = runCapture('destroyed');
    expect(result.outcome.status).toBe('failed');
    expect(result.outcome.exitCode).toBe(0);
    expect(result.outcome.unattributedFailures).toBeGreaterThan(0);
    expect(result.stderr).toContain('stdout');
    expect(result.stderr).toContain('incomplete');
  });

  test('an already-destroyed stream retains an error emitted on the next tick', () => {
    const result = runCapture('destroyed-error');
    expect(result.outcome.status).toBe('failed');
    expect(result.outcome.exitCode).toBe(0);
    expect(result.stderr).toContain(CAUSE);
    expect(result.captured).toContain(CAUSE);
  });

  test('a delayed stream error preserves its cause and the real child exit', () => {
    const result = runCapture('delayed-error', 7);
    expect(result.outcome.status).toBe('failed');
    expect(result.outcome.exitCode).toBe(7);
    expect(result.outcome.unattributedFailures).toBeGreaterThan(0);
    expect(result.stderr).toContain(CAUSE);
    expect(result.captured).toContain(CAUSE);
  });

  test('partial bytes remain logged and loss prevents retrying only an attributed failure', () => {
    const result = runCapture('partial');
    expect(result.outcome.status).toBe('failed');
    expect(result.outcome.failingFiles).toEqual(['test/capture-fixture.test.ts']);
    expect(result.outcome.unattributedFailures).toBeGreaterThan(0);
    expect(result.captured).toContain(PARTIAL);
    expect(result.stderr).toContain('incomplete');
  });

  test('an absent configured stdout pipe is a capture failure', () => {
    const result = runCapture('absent');
    expect(result.outcome.status).toBe('failed');
    expect(result.outcome.exitCode).toBe(0);
    expect(result.outcome.unattributedFailures).toBeGreaterThan(0);
    expect(result.stderr).toContain('stdout');
  });
});
