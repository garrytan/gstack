/**
 * setup.ps1: the Windows entry point checks Git for Windows, Bun and Node.js,
 * then runs ./setup in Git Bash with every argument passed as its own argv
 * entry, never pasted into shell source. The behavioral cases copy the script
 * next to a stub ./setup that prints its argv and run it under pwsh.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.resolve(import.meta.dir, '..', 'setup.ps1');
const SOURCE = fs.readFileSync(SCRIPT, 'utf-8');
const PWSH = Bun.which('pwsh');
const BASH = Bun.which('bash');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function stubCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ps1-'));
  dirs.push(dir);
  fs.copyFileSync(SCRIPT, path.join(dir, 'setup.ps1'));
  fs.writeFileSync(path.join(dir, 'setup'), '#!/usr/bin/env bash\nprintf \'cwd=%s\\n\' "$PWD"\nfor a in "$@"; do printf \'arg=[%s]\\n\' "$a"; done\nexit 7\n', { mode: 0o755 });
  return dir;
}

function runPs1(dir: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(PWSH!, ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'setup.ps1'), ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf-8',
    env: { ...process.env, ...(process.platform === 'win32' ? {} : { GSTACK_GIT_BASH: BASH! }), ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('setup.ps1', () => {
  test('passes arguments as an array to a constant bash script', () => {
    expect(SOURCE).toContain(`& $bash -c 'exec ./setup "$@"' setup @args`);
    expect(SOURCE).not.toMatch(/-join|Invoke-Expression|\biex\b|git-bash\.exe/);
    expect([...SOURCE].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  test.skipIf(!PWSH || !BASH)('forwards every argument literally from the script directory and keeps the exit code', () => {
    const dir = stubCheckout();
    const args = ['--host', 'codex', 'two words', '$(touch PWNED)', "it's", '"quoted"', ';echo injected', '`whoami`'];
    const { code, out } = runPs1(dir, args);
    expect(code).toBe(7);
    const lines = out.split(/\r?\n/);
    expect(lines.filter((l) => l.startsWith('arg=['))).toEqual(args.map((a) => `arg=[${a}]`));
    expect(lines.find((l) => l.startsWith('cwd='))).toContain(path.basename(dir));
    expect(out).not.toContain('injected\n');
    expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
    expect(fs.existsSync(path.join(os.tmpdir(), 'PWNED'))).toBe(false);
  });

  test.skipIf(!PWSH || !BASH || process.platform === 'win32')('a missing prerequisite names its winget command and runs nothing', () => {
    const dir = stubCheckout();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ps1-bin-'));
    dirs.push(bin);
    for (const tool of ['git', 'node']) {
      const real = Bun.which(tool);
      if (real) fs.symlinkSync(real, path.join(bin, tool));
    }
    const { code, out } = runPs1(dir, ['--host', 'codex'], { PATH: bin });
    expect(code).toBe(1);
    expect(out).toContain('Bun: winget install --id Oven-sh.Bun -e');
    expect(out).not.toContain('Git for Windows:');
    expect(out).not.toContain('arg=[');
  });
});
