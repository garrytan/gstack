import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getHostConfig } from '../hosts/index';
import { freshnessInvocation, hostGeneratesTemplate } from '../scripts/skill-check';

const ROOT = path.resolve(import.meta.dir, '..');
const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('skill:check host-aware freshness', () => {
  test('does not require canonical outputs that the Claude host deliberately skips', () => {
    const claude = getHostConfig('claude');

    expect(hostGeneratesTemplate('claude/SKILL.md.tmpl', claude, ROOT)).toBe(false);
    expect(hostGeneratesTemplate('codex/SKILL.md.tmpl', claude, ROOT)).toBe(true);
    expect(hostGeneratesTemplate('SKILL.md.tmpl', claude, ROOT)).toBe(true);
  });

  test('uses the same effective Codex model resolution as setup', () => {
    const codexHome = tempDir('gstack-skill-check-codex-');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');

    const invocation = freshnessInvocation(getHostConfig('codex'), {
      HOME: tempDir('gstack-skill-check-home-'),
      CODEX_HOME: codexHome,
    });

    expect(invocation.model).toBe('gpt-5.6-sol');
    expect(invocation.modelSource).toBe(path.join(codexHome, 'config.toml'));
    expect(invocation.args).toEqual([
      'run',
      'scripts/gen-skill-docs.ts',
      '--host',
      'codex',
      '--model',
      'gpt-5.6-sol',
      '--dry-run',
    ]);
  });

  test('reports zero actionable findings when generated artifacts match the setup profile', () => {
    const fakeBin = tempDir('gstack-skill-check-bin-');
    const codexHome = tempDir('gstack-skill-check-live-codex-');
    const logPath = path.join(fakeBin, 'invocations.log');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
    fs.writeFileSync(
      path.join(fakeBin, 'bun'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SKILL_CHECK_INVOCATIONS"\nexit 0\n',
      { mode: 0o755 },
    );

    const result = Bun.spawnSync([process.execPath, path.join(ROOT, 'scripts/skill-check.ts')], {
      cwd: ROOT,
      timeout: 30_000,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        SKILL_CHECK_INVOCATIONS: logPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = result.stdout.toString();
    const invocations = fs.readFileSync(logPath, 'utf8');

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('claude/SKILL.md.tmpl');
    expect(stdout).toContain('skipped for Claude Code');
    expect(stdout).not.toContain('generated file missing');
    expect(stdout).toContain(`Profile: gpt-5.6-sol (${path.join(codexHome, 'config.toml')})`);
    expect(invocations).toContain(
      'run scripts/gen-skill-docs.ts --host codex --model gpt-5.6-sol --dry-run',
    );
  });
});
