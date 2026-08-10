/**
 * browse/src/find-security-sidecar.ts — resolves the Node entry for the L4 ML
 * classifier sidecar.
 *
 * Zero coverage before this file. When resolution silently returns null the
 * /pty-inject-scan endpoint reports `l4 { available: false }` and the extension
 * degrades to WARN+confirm (D7) — no crash, no log, just a quietly weaker
 * security tier. These tests pin the two decisions that produce that outcome:
 * "is Node on PATH" and "does an entry resolve from the source checkout".
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { findSecuritySidecar } from '../src/find-security-sidecar';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const MODULE_PATH = path.join(REPO_ROOT, 'browse', 'src', 'find-security-sidecar.ts');
const savedPath = process.env.PATH;
const hasNode = Bun.which('node') !== null;
const isWindows = process.platform === 'win32';
let sandboxBin: string | null = null;

/**
 * Shadow `node` with a stub that exits non-zero. Emptying PATH is not enough —
 * the child-process layer still resolves system binaries from its own default
 * search path.
 */
function shadowNodeWithFailingStub(): string {
  sandboxBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-bin-'));
  const stub = path.join(sandboxBin, 'node');
  fs.writeFileSync(stub, '#!/usr/bin/env sh\nexit 1\n');
  fs.chmodSync(stub, 0o755);
  return sandboxBin;
}

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (sandboxBin) {
    fs.rmSync(sandboxBin, { recursive: true, force: true });
    sandboxBin = null;
  }
});

describe('findSecuritySidecar', () => {
  test.skipIf(!hasNode)('resolves the dev entry from the source checkout', () => {
    const loc = findSecuritySidecar();
    expect(loc).not.toBeNull();
    expect(loc!.node).toBe('node');
    expect(loc!.mode).toBe('dev');
    expect(loc!.entry).toBe(path.join(REPO_ROOT, 'browse', 'src', 'security-sidecar-entry.ts'));
    expect(fs.existsSync(loc!.entry)).toBe(true);
  });

  test.skipIf(!hasNode)('is deterministic across calls (no cache drift)', () => {
    expect(findSecuritySidecar()).toEqual(findSecuritySidecar());
  });

  test.skipIf(isWindows)('returns null when Node cannot run — degrades, never throws', () => {
    // Must run in a child process: the PATH the sidecar's `node --version`
    // probe resolves against is the one the process started with, so mutating
    // process.env.PATH in-process would not shadow the real node.
    const bin = shadowNodeWithFailingStub();
    const script = `
      const { findSecuritySidecar } = await import(${JSON.stringify(MODULE_PATH)});
      console.log(JSON.stringify(findSecuritySidecar()));
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: bin },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('null');
  });
});
