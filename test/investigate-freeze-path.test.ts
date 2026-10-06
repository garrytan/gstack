import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const FILES = ['investigate/SKILL.md.tmpl', 'investigate/SKILL.md'];

// #2469: frontmatter hooks (and early skill bash) run before any runtime
// variable exists, so a ${CLAUDE_SKILL_DIR}-relative path silently never
// resolved and the scope-lock guard failed open via `|| exit 0`. Both the
// hook commands and the Scope Lock probe must anchor on $HOME like the
// careful/freeze skills (#1871). The old standalone `gstack-freeze` sibling
// fallback was part of the never-resolving path — prefix installs keep the
// payload at ~/.claude/skills/gstack/, so the $HOME anchor covers them.
describe('investigate freeze path resolution', () => {
  for (const rel of FILES) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');

    test(`${rel} hook resolves check-freeze via the $HOME anchor`, () => {
      // E1: cmd.exe-safe — no single-quoted words, no variable POSIX sh would expand to empty.
      expect(content).toContain(`command: 'bash -c "test -x \\"$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh\\" && exec bash \\"$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh\\"; exit 0"'`);
      expect(content).not.toContain('S="$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh"');
      const commandLines = content.split('\n').filter((l) => l.trim().startsWith('command:'));
      expect(commandLines.length).toBeGreaterThan(0);
      for (const line of commandLines) {
        expect(line).not.toContain('CLAUDE_SKILL_DIR');
      }
    });

    test(`${rel} scope lock availability probe uses the $HOME anchor`, () => {
      // The template names the host's runtime root; Claude's render keeps the $HOME anchor.
      expect(content).toContain(rel.endsWith('.tmpl')
        ? '_FREEZE_SCRIPT="{{RUNTIME_ROOT}}/freeze/bin/check-freeze.sh"'
        : '_FREEZE_SCRIPT="$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh"');
      expect(content).toContain('[ -x "$_FREEZE_SCRIPT" ] && echo "FREEZE_AVAILABLE" || echo "FREEZE_UNAVAILABLE"');
    });
  }
});

// E1 (#2876, #2354 residual). One canonicalization for the saved boundary and
// the tool's file_path, exercised through the real hook script. Hooks run via
// explicit `bash` argv with template-literal paths so the file stays in the
// windows-free lane (scripts/test-free-shards.ts --windows-only --list).
const IS_WIN = process.platform === 'win32';
const FREEZE_HOOK = `${ROOT}/freeze/bin/check-freeze.sh`;

function decision(stdout: string): string {
  const raw = stdout.trim();
  if (raw === '{}') return 'allow';
  return JSON.parse(raw)?.hookSpecificOutput?.permissionDecision ?? `unparsed: ${raw}`;
}

function withState<T>(boundary: string, fn: (env: Record<string, string>) => T): T {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e1-freeze-'));
  try {
    fs.writeFileSync(path.join(stateDir, 'freeze-dir.txt'), `${boundary}\n`);
    return fn({ ...process.env, GSTACK_STATE_ROOT: stateDir } as Record<string, string>);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function freezeDecision(boundary: string, filePath: string): string {
  return withState(boundary, (env) => {
    const r = Bun.spawnSync(['bash', FREEZE_HOOK], {
      stdin: Buffer.from(JSON.stringify({ tool_input: { file_path: filePath } })),
      env,
      timeout: 15_000,
    });
    expect(r.exitCode).toBe(0);
    return decision(r.stdout.toString());
  });
}

describe('E1: freeze boundary and target share one platform-aware normalization (#2876)', () => {
  test.each([
    ['C:\\dev\\proj\\src\\', 'C:\\dev\\proj\\src\\a.py', 'allow'],
    ['/c/dev/proj/src/', 'C:\\dev\\proj\\src\\a.py', 'allow'],
    ['C:\\dev\\proj\\src\\', '/c/dev/proj/src/a.py', 'allow'],
    ['c:/dev/proj/src/', 'C:\\dev\\proj\\src\\a.py', 'allow'],
    ['C:/dev/proj/src', 'c:\\dev\\proj\\src\\deep\\new\\file.py', 'allow'],
    ['C:\\dev\\proj\\src\\', 'C:\\dev\\proj\\src-old\\a.py', 'deny'],
    ['C:\\dev\\proj\\src\\', 'D:\\dev\\proj\\src\\a.py', 'deny'],
    ['C:\\dev\\proj\\src\\', 'C:\\dev\\proj\\other\\missing\\a.py', 'deny'],
    // A reserved .invalid host fails name resolution at once; a single-label
    // host makes Windows probe the network for ~10 s per filesystem call.
    ['\\\\server.invalid\\share\\proj\\', '\\\\server.invalid\\share\\proj\\a.py', 'allow'],
    ['\\\\server.invalid\\share\\proj\\', '\\\\server.invalid\\other\\proj\\a.py', 'deny'],
    ['\\\\server.invalid\\share\\proj\\', '/server.invalid/share/proj/a.py', 'deny'],
  ])('boundary %s, target %s → %s', (boundary, target, expected) => {
    expect(freezeDecision(boundary, target)).toBe(expected);
  });

  test.skipIf(!IS_WIN)('Windows: drive and path case differences do not decide the outcome', () => {
    expect(freezeDecision('C:\\Dev\\Proj\\Src\\', 'c:\\dev\\proj\\src\\a.py')).toBe('allow');
    expect(freezeDecision('c:\\dev\\proj\\src\\', 'C:\\DEV\\PROJ\\SRC-OLD\\a.py')).toBe('deny');
  });

  test.skipIf(!IS_WIN)('Windows: a junction inside the boundary that points outside is denied', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e1-junction-')));
    try {
      fs.mkdirSync(path.join(base, 'boundary'));
      fs.mkdirSync(path.join(base, 'outside'));
      fs.symlinkSync(path.join(base, 'outside'), path.join(base, 'boundary', 'escape'), 'junction');
      expect(freezeDecision(`${path.join(base, 'boundary')}\\`, path.join(base, 'boundary', 'escape', 'a.py'))).toBe('deny');
      expect(freezeDecision(`${path.join(base, 'boundary')}\\`, path.join(base, 'boundary', 'a.py'))).toBe('allow');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test.skipIf(IS_WIN)('POSIX: a backslash in a filename stays a filename character', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e1-bslash-')));
    try {
      const boundary = path.join(base, 'boundary');
      fs.mkdirSync(boundary);
      expect(freezeDecision(`${boundary}/`, `${boundary}/a\\..\\..\\etc\\x`)).toBe('allow');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

// #2354 residual: on Windows Claude Code spawns hook commands through
// `cmd.exe /d /s /c`, which never expands $HOME, so `bash $HOME/...` handed
// bash a literal "$HOME/..." path, exited 127, and the hook silently failed
// open. Run every registered freeze/guard/careful command the way cmd.exe
// does (no $ expansion, MSVC argv quoting) and the way POSIX sh does.
function registeredHookCommands(rel: string): string[] {
  const fm = fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n---')[0];
  return [...fm.matchAll(/^\s*command:\s*(.+)$/gm)].map((m) => {
    const v = m[1].trim();
    if (v.startsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
    if (v.startsWith('"')) return JSON.parse(v);
    return v;
  });
}

/** argv as a Windows program (bash.exe) parses its command line from cmd.exe. */
function msvcArgv(command: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\') {
      let n = 0;
      while (command[i] === '\\') { n++; i++; }
      if (command[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) cur += '"'; else { inQuotes = !inQuotes; }
      } else {
        cur += '\\'.repeat(n);
        i--;
      }
      started = true;
    } else if (c === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if ((c === ' ' || c === '\t') && !inQuotes) {
      if (started) args.push(cur);
      cur = '';
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) args.push(cur);
  return args;
}

function withInstalledHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e1-home-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(ROOT, path.join(home, '.claude', 'skills', 'gstack'), 'junction');
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const HOOKED = ['freeze/SKILL.md.tmpl', 'guard/SKILL.md.tmpl', 'careful/SKILL.md.tmpl', 'investigate/SKILL.md.tmpl'];

describe('E1: registered hook commands run under cmd.exe and POSIX sh (#2354)', () => {
  for (const rel of HOOKED) {
    const commands = registeredHookCommands(rel);
    test(`${rel} registers $HOME-anchored hooks`, () => {
      expect(commands.length).toBeGreaterThan(0);
    });
    for (const [i, command] of commands.entries()) {
      const isFreeze = command.includes('check-freeze.sh');
      const input = isFreeze ? { tool_input: { file_path: `${os.tmpdir()}${path.sep}outside-boundary.txt` } } : { tool_input: { command: 'rm -rf /' } };
      const expected = 'deny';
      const shells: Array<[string, (home: string) => string[]]> = IS_WIN
        ? [['cmd.exe', () => ['cmd.exe', '/d', '/s', '/c', `"${command}"`]]]
        : [['cmd.exe argv', () => msvcArgv(command)], ['POSIX shell', () => ['sh', '-c', command]]];
      for (const [label, argv] of shells) {
        test(`${rel} hook #${i + 1} reaches a decision via ${label}`, () => {
          withInstalledHome((home) => withState(path.join(home, 'frozen'), (env) => {
            // Claude Code hands cmd.exe its command line verbatim (Node's shell
            // spawn); MSVC-quoting it would escape the inner quotes cmd.exe reads.
            const r = Bun.spawnSync(argv(home), {
              stdin: Buffer.from(JSON.stringify(input)),
              env: { ...env, HOME: home },
              timeout: 15_000,
              windowsVerbatimArguments: IS_WIN,
            });
            expect(r.exitCode, r.stderr.toString()).toBe(0);
            expect(decision(r.stdout.toString())).toBe(expected);
          }));
        });
      }
    }
  }
});
