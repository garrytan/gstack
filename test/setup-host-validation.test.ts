import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');

function runSetupHost(host: string): { stderr: string; status: number | null; timedOut: boolean } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-host-'));
  const r = spawnSync('bash', [SETUP_SCRIPT, '--host', host], {
    cwd: ROOT,
    encoding: 'utf-8',
    input: '',
    timeout: 3000,
    env: { ...process.env, HOME: tmpDir },
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return {
    stderr: r.stderr || '',
    status: r.status,
    timedOut: r.signal === 'SIGTERM',
  };
}

describe('setup: --host validation accepts all registered hosts', () => {
  test('--host cursor is accepted (not rejected as unknown)', () => {
    const r = runSetupHost('cursor');
    expect(r.stderr).not.toContain('Unknown --host value');
    expect(r.status).not.toBe(1);
  });

  test('--host slate is accepted (not rejected as unknown)', () => {
    const r = runSetupHost('slate');
    expect(r.stderr).not.toContain('Unknown --host value');
    expect(r.status).not.toBe(1);
  });

  test('--host nonexistent is still rejected', () => {
    const r = runSetupHost('nonexistent');
    expect(r.stderr).toContain('Unknown --host value');
    expect(r.status).toBe(1);
  });
});
