/** Free reproduction of upgrade prompts intercepting seeded PTY scope gates. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hermeticChildEnv, hermeticSkillsConfigDir } from './helpers/hermetic-env';

const ROOT = path.resolve(import.meta.dir, '..');
const OLD_VERSION = '1.72.0.0';
const NEW_VERSION = '1.81.0.0';
const UPGRADE = `UPGRADE_AVAILABLE ${OLD_VERSION} ${NEW_VERSION}\n`;
function extractPreamble(source: string): string {
  const heading = /^## Preamble(?: \([^\r\n]*\))?[ \t]*\r?\n/m.exec(source);
  if (!heading) throw new Error('Generated skill has no Preamble section');
  const remaining = source.slice(heading.index + heading[0].length);
  const nextHeading = remaining.search(/^#{1,2} /m);
  const section = nextHeading < 0 ? remaining : remaining.slice(0, nextHeading);
  const block = /^```bash\r?\n([\s\S]*?)\r?\n```[ \t]*\r?$/m.exec(section);
  if (!block) throw new Error('Generated Preamble has no complete Bash block');
  return block[1];
}

const preamble = extractPreamble(fs.readFileSync(path.join(ROOT, 'plan-eng-review', 'SKILL.md'), 'utf8'));

describe('generated Preamble extraction', () => {
  test.each(['run first', 'after scope gate'])('allows guidance before the command (%s)', label => {
    const source = `## Preamble (${label})\n\n**Before the command below:** resolve the Scope gate.\n\n\`\`\`bash\nprintf first\n\`\`\`\n\n\`\`\`bash\nprintf second\n\`\`\`\n\n## Next section\n`;
    expect(extractPreamble(source)).toBe('printf first');
  });

  test.each([
    '## Other section\n\n```bash\nprintf elsewhere\n```\n',
    '## Preamble (after scope gate)\n\nNo command.\n\n## Next section\n```bash\nprintf elsewhere\n```\n',
    '## Preamble (after scope gate)\n\n```sh\nprintf other-language\n```\n',
    '## Preamble (after scope gate)\n\n```bash\nprintf unclosed\n\n## Next section\n```\n',
  ])('rejects absent or incomplete Preamble Bash without borrowing another section (%#)', source => {
    expect(() => extractPreamble(source)).toThrow(/Preamble/);
  });
});

function withOldInstall(check: (fixture: {
  home: string;
  cache: string;
  version: string;
  env: Record<string, string>;
  networkLog: string;
}) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-upgrade-home-'));
  try {
    const install = path.join(home, '.claude', 'skills', 'gstack');
    const state = path.join(home, '.gstack');
    const commandBin = path.join(home, 'commands');
    fs.mkdirSync(install, { recursive: true });
    fs.mkdirSync(state);
    fs.mkdirSync(commandBin);
    // Real runtime, older installed VERSION: the preamble resolves through HOME.
    fs.symlinkSync(path.join(ROOT, 'bin'), path.join(install, 'bin'), 'dir');
    const version = path.join(install, 'VERSION');
    const cache = path.join(state, 'last-update-check');
    const networkLog = path.join(home, 'unexpected-network');
    fs.writeFileSync(version, `${OLD_VERSION}\n`);
    fs.writeFileSync(cache, UPGRADE);
    fs.writeFileSync(path.join(state, '.codex-desc-healed'), '');
    fs.writeFileSync(path.join(commandBin, 'curl'), '#!/usr/bin/env bash\nprintf reached > "$PTY_UPGRADE_NETWORK_LOG"\nexit 1\n', { mode: 0o755 });
    const env = hermeticChildEnv({
      HOME: home,
      PATH: `${commandBin}${path.delimiter}${process.env.PATH ?? ''}`,
      PTY_UPGRADE_NETWORK_LOG: networkLog,
    });
    env.CLAUDE_CONFIG_DIR = hermeticSkillsConfigDir();
    check({ home, cache, version, env, networkLog });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runPreamble(home: string, env: Record<string, string>): string {
  return execFileSync('bash', ['-c', preamble], {
    cwd: home, env, encoding: 'utf8', timeout: 20_000,
  });
}

describe('seeded PTY update-check isolation', () => {
  test('private default config prevents an old HOME install from intercepting the scope gate', () => {
    withOldInstall(({ home, cache, version, env, networkLog }) => {
      const output = runPreamble(home, env);
      expect(output).toContain('SKILL_START_PROTO: 1');
      expect(output).not.toContain('UPGRADE_AVAILABLE');
      expect(output).not.toContain('GSTACK_INSTRUCTION_BEGIN: upgrade-flow');
      expect(output).toContain('UPDATE_CHECK: false');
      expect(fs.readFileSync(version, 'utf8')).toBe(`${OLD_VERSION}\n`);
      expect(fs.readFileSync(cache, 'utf8')).toBe(UPGRADE);
      expect(fs.existsSync(networkLog)).toBe(false);
    });
  });

  test('an explicit per-test state override can still exercise the real upgrade flow', () => {
    withOldInstall(({ home, cache, env, networkLog }) => {
      const state = path.join(home, 'explicit-state');
      fs.mkdirSync(state);
      fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: true\nartifacts_sync_mode_prompted: true\n');
      const output = runPreamble(home, { ...env, GSTACK_HOME: state });
      expect(output).toContain(UPGRADE.trim());
      expect(output).toContain('GSTACK_INSTRUCTION_BEGIN: upgrade-flow');
      expect(output).toContain('UPDATE_CHECK: true');
      expect(fs.readFileSync(cache, 'utf8')).toBe(UPGRADE);
      expect(fs.existsSync(networkLog)).toBe(false);
    });
  });
});
