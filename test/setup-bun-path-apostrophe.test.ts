/**
 * #4386: Git Bash converts a /c/... argument to C:/... before it starts a
 * native program such as Bun, but it skips any argument holding an apostrophe.
 * Under a home folder like C:\Users\O'Brien, setup handed Bun
 * /c/Users/O'Brien/.claude/skills/gstack/scripts/preflight-codex-overlap.ts
 * and Bun stopped with "Module not found". Setup now spells every path it
 * hands Bun through _bun_path, which uses cygpath -m on Windows. A one-off
 * windows-smoke run with an apostrophe in HOME proved the fix on a real
 * Windows runner; this test guards the source and the helper on any OS.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const BUN_START = 'bun --no-env-file --config="${GSTACK_BUN_CONFIG:-/dev/null}" ';

function bunPathHelper(): string {
  const start = SETUP.indexOf('_bun_path() {');
  expect(start).toBeGreaterThan(-1);
  const end = SETUP.indexOf('\n}\n', start);
  return SETUP.slice(start, end + 2);
}

function runHelper(ostype: string, arg: string, stubDir?: string) {
  const script = `OSTYPE=${ostype}\n${bunPathHelper()}\n_bun_path "$1"`;
  const PATH = stubDir ? `${stubDir}${path.delimiter}${process.env.PATH}` : process.env.PATH;
  return spawnSync('bash', ['-c', script, 'bash', arg], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PATH } });
}

describe('#4386: setup hands Bun paths it can open under an apostrophe home', () => {
  test('every Bun start whose script is a variable path goes through _bun_path', () => {
    const unwrapped = SETUP.split('\n').filter((line) => line.includes(`${BUN_START}"$`) && !line.includes(`${BUN_START}"$(_bun_path `));
    expect(unwrapped.map((line) => line.trim())).toEqual([`def="$(${BUN_START}"$SKILL_ROUTE_BIN" --default "$key" 2>/dev/null || true)"`]);
    expect(SETUP).toContain('SKILL_ROUTE_BIN="$(_bun_path "$SOURCE_GSTACK_DIR/bin/gstack-skill-route")"');
  });

  test('the Codex preflight gets converted --source and --namespace paths', () => {
    expect(SETUP).toContain('--source "$(_bun_path "$SOURCE_GSTACK_DIR")" --namespace "$(_bun_path "$CODEX_SKILLS")"');
  });

  test.skipIf(process.platform === 'win32')('_bun_path leaves a path unchanged off Windows, apostrophe included', () => {
    const r = runHelper('linux-gnu', "/home/o'brien/gstack/bin/gstack-harness");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("/home/o'brien/gstack/bin/gstack-harness\n");
  });

  test.skipIf(process.platform === 'win32')('_bun_path asks cygpath -m for the Windows spelling under Git Bash', () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-path-'));
    try {
      fs.writeFileSync(path.join(stubDir, 'cygpath'), '#!/bin/sh\n[ "$1" = -m ] || exit 9\nprintf "C:%s\\n" "$2"\n', { mode: 0o755 });
      const r = runHelper('msys', "/c/Users/O'Brien/.claude/skills/gstack/setup", stubDir);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("C:/c/Users/O'Brien/.claude/skills/gstack/setup\n");
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
