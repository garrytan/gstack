/**
 * /setup-gbrain's local stdio MCP registration (#2007, #1963). On Windows the
 * bun `gbrain.exe` binstub starts bun in a new console, so registering it made
 * every Claude Code session open a visible terminal; the skill registers
 * `bun.exe <gbrain entry> serve` instead, and `gbrain.exe` by its full name
 * when bun.exe or the entry is missing. POSIX keeps the binstub.
 *
 * Runs the generated fence under bash with stub `uname` and `claude` and a
 * temp HOME. The console behavior itself needs a real Windows machine.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL = fs.readFileSync(path.join(ROOT, 'setup-gbrain', 'SKILL.md'), 'utf-8');

function localStdioFence(): string {
  const section = SKILL.indexOf('### Paths 1, 2a, 2b, 3 (Local stdio)\n\nRegister at **user scope**');
  expect(section).toBeGreaterThan(-1);
  const start = SKILL.indexOf('```bash\n', section) + '```bash\n'.length;
  return SKILL.slice(start, SKILL.indexOf('\n```', start));
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-gbrain-mcp-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

function register(uname: string, files: string[], env: (home: string) => Record<string, string> = () => ({})) {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const home = path.join(dir, 'home');
  const stubs = path.join(dir, 'stubs');
  const log = path.join(dir, 'claude-argv');
  fs.mkdirSync(stubs, { recursive: true });
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), '');
  }
  fs.writeFileSync(path.join(stubs, 'uname'), `#!/bin/bash\necho ${uname}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'claude'), `#!/bin/bash\ncase "$2" in add) printf '%s\\n' "$@" > "${log}" ;; list) echo 'gbrain: stub - ✓ Connected' ;; esac\nexit 0\n`, { mode: 0o755 });
  const r = spawnSync('bash', ['-c', localStdioFence()], {
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: home, ...env(home) },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  expect(r.status).toBe(0);
  return { home, argv: fs.readFileSync(log, 'utf-8').trim().split('\n') };
}

const BUN_EXE = '.bun/bin/bun.exe';
const ENTRY = '.bun/install/global/node_modules/gbrain/src/cli.ts';

describe('setup-gbrain local stdio MCP registration', () => {
  test('Windows (MINGW64): registers bun.exe with the gbrain entry, not the binstub', () => {
    const { home, argv } = register('MINGW64_NT-10.0-26100', [BUN_EXE, ENTRY]);
    expect(argv).toEqual(['mcp', 'add', '--scope', 'user', 'gbrain', '--', path.join(home, BUN_EXE), path.join(home, ENTRY), 'serve']);
  });

  test('Windows honors BUN_INSTALL', () => {
    const files = ['custom-bun/bin/bun.exe', 'custom-bun/install/global/node_modules/gbrain/src/cli.ts'];
    const { home, argv } = register('MSYS_NT-10.0', files, (h) => ({ BUN_INSTALL: path.join(h, 'custom-bun') }));
    expect(argv).toEqual(['mcp', 'add', '--scope', 'user', 'gbrain', '--', ...files.map((f) => path.join(home, f)), 'serve']);
  });

  test('Windows without the entry: registers gbrain.exe by its full name', () => {
    const { home, argv } = register('MINGW64_NT-10.0', [BUN_EXE]);
    expect(argv).toEqual(['mcp', 'add', '--scope', 'user', 'gbrain', '--', path.join(home, '.bun/bin/gbrain.exe'), 'serve']);
  });

  test('Linux keeps the binstub registration', () => {
    const { home, argv } = register('Linux', [BUN_EXE, ENTRY]);
    expect(argv).toEqual(['mcp', 'add', '--scope', 'user', 'gbrain', '--', path.join(home, '.bun/bin/gbrain'), 'serve']);
  });
});
