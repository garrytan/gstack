/**
 * Manual maintenance scripts must not act on `--help` or a typo:
 * capture-baseline used to write test/fixtures/parity-baseline-current.json
 * for any argument list, and preflight-agent-sdk spent API on every run.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCaptureArgs } from '../scripts/capture-baseline';

const ROOT = path.resolve(import.meta.dir, '..');
const run = (script: string, args: string[]) =>
  Bun.spawnSync(['bun', 'run', script, ...args], { cwd: ROOT, timeout: 60_000, env: { ...process.env, ANTHROPIC_API_KEY: '' } });

describe('capture-baseline arguments', () => {
  test('parses --tag and --out and rejects unknown or valueless flags', () => {
    expect(parseCaptureArgs([])).toEqual({ help: false });
    expect(parseCaptureArgs(['--tag', 'v1', '--out', 'x.json'])).toEqual({ help: false, tag: 'v1', out: 'x.json' });
    expect(parseCaptureArgs(['-h'])).toEqual({ help: true });
    expect(() => parseCaptureArgs(['--tags', 'v1'])).toThrow('unknown argument "--tags"');
    expect(() => parseCaptureArgs(['--tag'])).toThrow('--tag needs a value');
    expect(() => parseCaptureArgs(['--out', '--tag'])).toThrow('--out needs a value');
  });

  test('--help prints usage and writes no fixture', () => {
    const fixture = path.join(ROOT, 'test/fixtures/parity-baseline-current.json');
    const existed = fs.existsSync(fixture);
    const result = run('scripts/capture-baseline.ts', ['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Usage: bun run scripts/capture-baseline.ts');
    expect(fs.existsSync(fixture)).toBe(existed);
  });
});

describe('preflight-agent-sdk arguments', () => {
  // Spawned, not imported: the script imports the Agent SDK and the Conductor
  // env shim, which promotes API keys in the importing process.
  test('--help names the opt-in --live query and exits 0; a typo exits 2 before any check', () => {
    const help = run('scripts/preflight-agent-sdk.ts', ['--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain('--live');
    const typo = run('scripts/preflight-agent-sdk.ts', ['--lvie']);
    expect(typo.exitCode).toBe(2);
    expect(typo.stderr.toString()).toContain('unknown argument "--lvie"');
    expect(typo.stdout.toString()).not.toContain('Overlay resolver');
  });
});
