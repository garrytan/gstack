import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`Could not locate ${name}() in setup`);
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`Could not locate end of ${name}() in setup`);
  return src.slice(start, end + 2);
}

describe('setup: Claude runtime alias for non-gstack install dirs', () => {
  test('setup calls the runtime alias helper before linking Claude skills', () => {
    const helperIdx = SETUP.indexOf('ensure_claude_runtime_alias "$INSTALL_GSTACK_DIR" "$INSTALL_SKILLS_DIR"');
    const linkIdx = SETUP.indexOf('link_claude_skill_dirs "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"');

    expect(helperIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeLessThan(linkIdx);
  });

  test.skipIf(process.platform === 'win32')('helper creates skills/gstack -> install dir when install basename is not gstack', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-alias-'));
    try {
      const skillsDir = path.join(tmp, '.claude', 'skills');
      const installDir = path.join(skillsDir, 'gstack-dev');
      fs.mkdirSync(installDir, { recursive: true });

      const linkHelper = extractFunction(SETUP, '_link_or_copy');
      const noteHelper = extractFunction(SETUP, '_print_windows_copy_note_once');
      const aliasHelper = extractFunction(SETUP, 'ensure_claude_runtime_alias');
      const script = `
        set -e
        HOME='${tmp}'
        IS_WINDOWS=0
        QUIET=0
        _WINDOWS_COPY_NOTE_PRINTED=0
        log() { echo "$@"; }
        ${linkHelper}
        ${noteHelper}
        ${aliasHelper}
        ensure_claude_runtime_alias '${installDir}' '${skillsDir}'
      `;

      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      const alias = path.join(skillsDir, 'gstack');
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(alias)).toBe(installDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('helper ignores non-Claude skills directories', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-alias-'));
    try {
      const skillsDir = path.join(tmp, 'skills');
      const installDir = path.join(skillsDir, 'gstack-dev');
      fs.mkdirSync(installDir, { recursive: true });

      const linkHelper = extractFunction(SETUP, '_link_or_copy');
      const noteHelper = extractFunction(SETUP, '_print_windows_copy_note_once');
      const aliasHelper = extractFunction(SETUP, 'ensure_claude_runtime_alias');
      const script = `
        set -e
        HOME='${tmp}'
        IS_WINDOWS=0
        QUIET=0
        _WINDOWS_COPY_NOTE_PRINTED=0
        log() { echo "$@"; }
        ${linkHelper}
        ${noteHelper}
        ${aliasHelper}
        ensure_claude_runtime_alias '${installDir}' '${skillsDir}'
      `;

      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(skillsDir, 'gstack'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('helper leaves canonical skills/gstack installs alone', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-alias-'));
    try {
      const skillsDir = path.join(tmp, '.claude', 'skills');
      const installDir = path.join(skillsDir, 'gstack');
      fs.mkdirSync(installDir, { recursive: true });

      const linkHelper = extractFunction(SETUP, '_link_or_copy');
      const noteHelper = extractFunction(SETUP, '_print_windows_copy_note_once');
      const aliasHelper = extractFunction(SETUP, 'ensure_claude_runtime_alias');
      const script = `
        set -e
        HOME='${tmp}'
        IS_WINDOWS=0
        QUIET=0
        _WINDOWS_COPY_NOTE_PRINTED=0
        log() { echo "$@"; }
        ${linkHelper}
        ${noteHelper}
        ${aliasHelper}
        ensure_claude_runtime_alias '${installDir}' '${skillsDir}'
      `;

      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(fs.lstatSync(installDir).isDirectory()).toBe(true);
      expect(fs.lstatSync(installDir).isSymbolicLink()).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
