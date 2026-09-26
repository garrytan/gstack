import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

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
      expect(content).toContain('S="$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh"');
      expect(content).toContain('[ -x "$S" ] && exec bash "$S"; exit 0');
      const commandLines = content.split('\n').filter((l) => l.trim().startsWith('command:'));
      expect(commandLines.length).toBeGreaterThan(0);
      for (const line of commandLines) {
        expect(line).not.toContain('CLAUDE_SKILL_DIR');
      }
    });

    test(`${rel} scope lock availability probe uses the $HOME anchor`, () => {
      expect(content).toContain('_FREEZE_SCRIPT="$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh"');
      expect(content).toContain('[ -x "$_FREEZE_SCRIPT" ] && echo "FREEZE_AVAILABLE" || echo "FREEZE_UNAVAILABLE"');
    });
  }
});

// #2845: the Scope Lock wrote `<detected-directory>/` verbatim (the skill's own
// example is the relative `src/auth/`) into the machine-global freeze-dir.txt,
// and no later phase removed it. check-freeze.sh resolves a relative boundary
// against $(pwd) of whatever tool call comes next, so one debug session's lock
// re-anchored to `<other-repo>/src/` in every later session on the machine, and
// stayed there until someone ran /unfreeze. The writer must resolve an absolute
// path the way /freeze and /guard do, and Phase 5 must release what it wrote.
const CHECK_FREEZE = path.join(ROOT, 'freeze', 'bin', 'check-freeze.sh');

function freezeVerdict(stateDir: string, cwd: string, filePath: string): 'allow' | 'deny' {
  const r = spawnSync('bash', [CHECK_FREEZE], {
    cwd,
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } }),
    env: { ...process.env, GSTACK_HOME: stateDir, CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '' },
    encoding: 'utf-8',
    timeout: 5000,
  });
  const out = JSON.parse(r.stdout.trim() || '{}');
  return out?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
}

describe('investigate scope lock is absolute and released (#2845)', () => {
  for (const rel of FILES) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');

    test(`${rel} resolves the lock directory to an absolute path before writing it`, () => {
      expect(content).toContain('FREEZE_DIR=$(cd "<detected-directory>" 2>/dev/null && pwd)');
      expect(content).toContain('echo "$FREEZE_DIR" > "$STATE_DIR/freeze-dir.txt"');
      expect(content).not.toContain('echo "<detected-directory>/" > "$STATE_DIR/freeze-dir.txt"');
    });

    test(`${rel} skips the lock loudly when the directory does not resolve`, () => {
      // An empty FREEZE_DIR would otherwise become "/" and freeze nothing.
      expect(content).toContain('SCOPE_LOCK_SKIPPED');
    });

    test(`${rel} releases its own lock in Phase 5, by compare-and-delete`, () => {
      const report = content.indexOf('DEBUG REPORT');
      const release = content.indexOf('rm -f "$STATE_DIR/freeze-dir.txt"');
      expect(report).toBeGreaterThan(-1);
      expect(release).toBeGreaterThan(report);
      // Never remove a boundary the user set with /freeze before invoking the skill.
      expect(content).toContain('[ "${CURRENT%/}/" = "$LOCKED" ]');
    });
  }

  test('a relative boundary re-anchors to the working directory; an absolute one does not', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-scope-lock-'));
    const stateDir = path.join(tmp, 'state');
    const wtA = path.join(tmp, 'wt-a');
    const wtB = path.join(tmp, 'wt-b');
    for (const d of [stateDir, path.join(wtA, 'src'), path.join(wtB, 'src'), path.join(wtB, 'scratch')]) {
      fs.mkdirSync(d, { recursive: true });
    }
    const freezeFile = path.join(stateDir, 'freeze-dir.txt');
    const inA = path.join(wtA, 'src', 'a.ts');
    const inB = path.join(wtB, 'src', 'b.ts');
    const scratchB = path.join(wtB, 'scratch', 'notes.md');
    try {
      // What the pre-fix Scope Lock wrote: the verdict for ONE file flips with cwd.
      fs.writeFileSync(freezeFile, 'src/\n');
      expect(freezeVerdict(stateDir, wtA, inA)).toBe('allow');
      expect(freezeVerdict(stateDir, wtB, inA)).toBe('deny');
      // ...and a session in wt-b that never locked anything is now confined to wt-b/src.
      expect(freezeVerdict(stateDir, wtB, scratchB)).toBe('deny');
      expect(freezeVerdict(stateDir, wtB, inB)).toBe('allow');

      // What the fixed Scope Lock writes: verdicts are independent of cwd.
      fs.writeFileSync(freezeFile, `${path.join(wtA, 'src')}/\n`);
      expect(freezeVerdict(stateDir, wtA, inA)).toBe('allow');
      expect(freezeVerdict(stateDir, wtB, inA)).toBe('allow');
      expect(freezeVerdict(stateDir, wtB, inB)).toBe('deny');
      expect(freezeVerdict(stateDir, wtB, scratchB)).toBe('deny');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('Phase 5 release block removes only the boundary this run wrote', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-scope-release-'));
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const freezeFile = path.join(stateDir, 'freeze-dir.txt');
    // The release block as rendered, with <locked-directory> substituted.
    const release = (locked: string) => spawnSync('bash', ['-c', [
      `STATE_DIR="${stateDir}"`,
      `LOCKED="${locked}"; LOCKED="\${LOCKED%/}/"`,
      'CURRENT=$(head -n 1 "$STATE_DIR/freeze-dir.txt" 2>/dev/null)',
      'if [ -n "$CURRENT" ] && [ "${CURRENT%/}/" = "$LOCKED" ]; then rm -f "$STATE_DIR/freeze-dir.txt"; echo released; else echo kept; fi',
    ].join('\n')], { encoding: 'utf-8', timeout: 5000 }).stdout.trim();
    try {
      fs.writeFileSync(freezeFile, '/tmp/repo/src/\n');
      expect(release('/tmp/repo/src')).toBe('released');       // trailing slash optional
      expect(fs.existsSync(freezeFile)).toBe(false);

      fs.writeFileSync(freezeFile, '/tmp/other/lib/\n');        // a /freeze the user set
      expect(release('/tmp/repo/src/')).toBe('kept');
      expect(fs.existsSync(freezeFile)).toBe(true);

      fs.rmSync(freezeFile);
      expect(release('/tmp/repo/src/')).toBe('kept');           // nothing to release, no error
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('freeze prose does not promise a session-scoped boundary (#2845)', () => {
  test.each(['freeze/SKILL.md.tmpl', 'freeze/SKILL.md', 'guard/SKILL.md.tmpl', 'guard/SKILL.md'])(
    '%s',
    (rel) => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(content).not.toContain('`/unfreeze` or end the session');
      expect(content).not.toContain('persists for the session');
      expect(content).not.toContain('To deactivate everything, end the session');
    },
  );
});
