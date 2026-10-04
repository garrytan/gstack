/**
 * B4: DESIGN SETUP probes `"$D" --version` to prove the binary starts. The CLI
 * treated `--version` as an unknown command (exit 1), so the probe could never
 * pass. It prints the gstack version and exits 0, before auth or network.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

describe('design --version', () => {
  test('prints the gstack version and exits 0 without credentials', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'design/src/cli.ts'), '--version'], {
      encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim());
  });
});
