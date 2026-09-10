import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { gitArgvIn } from './helpers/scratch-repo';

const ROOT = path.resolve(import.meta.dir, '..');
const CAREFUL_SCRIPT = path.join(ROOT, 'careful', 'bin', 'check-careful.sh');
const FREEZE_SCRIPT = path.join(ROOT, 'freeze', 'bin', 'check-freeze.sh');

function runHook(scriptPath: string, input: object, env?: Record<string, string>, cwd?: string): { exitCode: number; output: any; raw: string } {
  const result = spawnSync('bash', [scriptPath], {
    input: JSON.stringify(input),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    cwd,
    timeout: 5000,
  });
  const raw = result.stdout.toString().trim();
  let output: any = {};
  try {
    output = JSON.parse(raw);
  } catch {}
  return { exitCode: result.status ?? 1, output, raw };
}

// Scratch git repo with a resolvable origin default branch — the HIGH-tier
// force-push check reads `git symbolic-ref refs/remotes/origin/HEAD` from the
// hook's cwd, and Conductor worktrees don't reliably carry that ref.
function withGitRepo(defaultBranch: string, currentBranch: string, fn: (repoDir: string) => void) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-git-'));
  try {
    const git = (args: string[]) => gitArgvIn(repoDir, args);
    git(['init', '-q', '-b', defaultBranch]);
    git(['commit', '--allow-empty', '-q', '-m', 'init']);
    // A symbolic ref may dangle; the hook only reads its NAME.
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`]);
    if (currentBranch !== defaultBranch) git(['checkout', '-q', '-b', currentBranch]);
    fn(repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

function runHookRaw(scriptPath: string, rawInput: string, env?: Record<string, string>): { exitCode: number; output: any; raw: string } {
  const result = spawnSync('bash', [scriptPath], {
    input: rawInput,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    timeout: 5000,
  });
  const raw = result.stdout.toString().trim();
  let output: any = {};
  try {
    output = JSON.parse(raw);
  } catch {}
  return { exitCode: result.status ?? 1, output, raw };
}

function carefulInput(command: string) {
  return { tool_input: { command } };
}

function freezeInput(filePath: string) {
  return { tool_input: { file_path: filePath } };
}

function withFreezeDir(freezePath: string, fn: (stateDir: string) => void) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-test-'));
  fs.writeFileSync(path.join(stateDir, 'freeze-dir.txt'), freezePath);
  try {
    fn(stateDir);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// The freeze WRITER resolves its state root through bin/gstack-paths, which
// trusts CLAUDE_PLUGIN_DATA only when CLAUDE_PLUGIN_ROOT names gstack; the
// reader mirrors that exact chain (#1459 / #1509). A test standing in for a
// plugin install must supply both, and must neutralize a GSTACK_HOME inherited
// from the shard's process.env (an empty value reads as unset in ${VAR:-}).
function freezeEnv(stateDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { GSTACK_HOME: '', CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_ROOT: '/plugins/gstack', ...extra };
}

const HOOK_EXTRACT = path.join(ROOT, 'careful', 'bin', 'hook-extract.sh');
const GSTACK_PATHS = path.join(ROOT, 'bin', 'gstack-paths');

/** What the hook helper resolves as the state root under a given env. */
function hookStateRoot(env: Record<string, string>): string {
  const r = spawnSync('bash', ['-c', `. "${HOOK_EXTRACT}" && gstack_hook_state_root`], {
    env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf-8', timeout: 5000,
  });
  return r.stdout.trim();
}

/** What bin/gstack-paths resolves as GSTACK_STATE_ROOT under the same env. */
function pathsStateRoot(env: Record<string, string>): string {
  const r = spawnSync('bash', ['-c', `eval "$("${GSTACK_PATHS}")" && printf '%s' "$GSTACK_STATE_ROOT"`], {
    env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf-8', timeout: 5000,
  });
  return r.stdout.trim();
}

// ============================================================
// Frontmatter hook wiring (#2469 / #1871)
// ============================================================
// Frontmatter hooks run before any runtime variable exists, so a
// ${CLAUDE_SKILL_DIR}-relative command silently never resolves and the guard
// never fires. Every command: line must anchor on $HOME like careful/freeze.
function withEmptyDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hook-empty-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('frontmatter hook command paths', () => {
  test.each(['investigate/SKILL.md', 'careful/SKILL.md', 'freeze/SKILL.md', 'guard/SKILL.md'])(
    '%s hook commands are $HOME-anchored, never CLAUDE_SKILL_DIR',
    (rel) => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      const commandLines = content.split('\n').filter((l) => l.trim().startsWith('command:'));
      expect(commandLines.length).toBeGreaterThan(0);
      for (const line of commandLines) {
        expect(line).not.toContain('CLAUDE_SKILL_DIR');
        expect(line).toContain('$HOME/.claude/skills/gstack/');
      }
    },
  );
});

// ============================================================
// check-careful.sh tests
// ============================================================
describe('check-careful.sh', () => {

  // --- Destructive rm commands ---

  describe('rm -rf / rm -r', () => {
    test('rm -rf /var/data warns with recursive delete message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /var/data'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -r ./some-dir warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -r ./some-dir'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -rf node_modules allows (safe exception)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('rm -rf .next dist allows (multiple safe targets)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf .next dist'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('rm -rf node_modules /var/data warns (mixed safe+unsafe)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules /var/data'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // The safe exception matches the COMPLETE command against an anchored
    // whitelist shape — anything else (chains, comments, substitution) falls
    // through to the destructive-pattern warning.
    test('rm -rf /; rm -rf node_modules warns (semicolon chain, dangerous first)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /; rm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -rf /etc/data && rm -rf dist warns (&& chain, dangerous first)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /etc/data && rm -rf dist'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -rf node_modules; rm -rf /home/user/data warns (safe first, dangerous last)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules; rm -rf /home/user/data'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // Command substitution can end in a whitelisted suffix while running
    // anything inside $(...) or backticks — the whitelist's target tokens
    // exclude `(` and backtick so these cannot ride the safe exception.
    test('rm -rf $(./wipe-all)/node_modules warns (command substitution)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf $(./wipe-all)/node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -rf `./wipe-all`/node_modules warns (backtick substitution)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf `./wipe-all`/node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // Capital -R is the documented recursive flag on BSD rm (macOS) and accepted
    // by GNU rm. Both greps previously required a lowercase r, so `rm -R /`
    // silently allowed. A bare recursive delete of / is now HIGH-tier: denied,
    // not asked.
    test('rm -R / denies (HIGH tier: recursive delete of root)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -R /'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('HIGH');
    });

    test('rm -fR /home/user warns (capital R in flag cluster)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -fR /home/user'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -Rf node_modules allows (capital R, single safe target)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -Rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    // The old grep extractor stopped at the first escaped quote in the JSON
    // string, so any quoted argument truncated the command BEFORE the pattern
    // checks ran — hiding everything after it. (#2426)
    test.each([
      'git commit -m "wip" && rm -rf /',
      'bash -c "rm -rf /"',
      'echo "x"; rm -rf ~',
      'npm run build --msg "done" && rm -rf /',
    ])('a quoted argument cannot hide a later destructive command: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // JSON-escaped newline (literal two-char \n surviving the grep extraction
    // path) breaks the anchored whitelist shape → falls through to the warn.
    test('newline-chained rm warns (escaped-newline separator branch)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /etc/x\nrm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // Deliberate false positive, pinned: a safe-prefix chain ending in a safe rm
    // is indistinguishable from the dangerous-first exploit shape without real
    // shell parsing, so warn-on-all-chains is the designed fail-closed direction.
    // A future per-segment parser must consciously change this test.
    test('cd app && rm -rf node_modules asks (fail-closed on chains, by design)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('cd app && rm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test.each([
      'rm -rf /; rm -rf node_modules',
      'rm -rf / && rm -rf node_modules',
      'rm -rf / # rm -rf node_modules',
      'rm -rf node_modules; rm -rf /',
      'rm -rf node_modules || rm -rf /',
      'echo ok && rm -rf /',
      'rm -rf node_modules\nrm -rf /',
    ])('never lets a safe-looking target hide a destructive command: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });
  });

  // --- Shell obfuscation ---

  describe('shell obfuscation', () => {
    test.each([
      'rm${IFS}-rf${IFS}/',
      'rm$IFS-rf$IFS/',
      'echo cm0gLXJmIC8= | base64 -d | sh',
    ])('asks when the command hides its shape behind expansion: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('obfuscation');
    });

    test('ordinary commands are unaffected', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('cat file.b64 | base64 -d > out.bin'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });
  });

  // --- JSON payload extraction ---

  describe('command extraction', () => {
    test('fails closed when the payload is not valid JSON', () => {
      const { exitCode, output } = runHookRaw(CAREFUL_SCRIPT, 'this is not json');
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('parse');
    });

    test('allows a well-formed payload with no command field', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, { tool_input: { file_path: '/tmp/x' } });
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('allows when command is present but not a string', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, { tool_input: { command: 42 } });
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('preserves escaped quotes in the extracted command', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('echo "hello world"'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });
  });

  // --- SQL destructive commands ---
  // Embedded double quotes are now safe to use here. They previously truncated the
  // extracted command (the grep-based extractor stopped at the first \"), which hid
  // the SQL keyword from the pattern matcher — so the older tests had to be written
  // without quotes, in a shape no one actually types. The JSON-parser extraction
  // fixed that, and the quoted forms below are the realistic ones.

  describe('SQL destructive commands', () => {
    test('psql DROP TABLE warns with DROP in message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('psql -c DROP TABLE users;'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('DROP');
    });

    test.each([
      'psql -c "DROP TABLE users"',
      'psql -c "TRUNCATE orders"',
      'mysql -e "DROP DATABASE prod"',
    ])('a quoted SQL statement is still inspected: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
    });

    test('mysql drop database warns (case insensitive)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('mysql -e drop database mydb'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason.toLowerCase()).toContain('drop');
    });

    test('psql TRUNCATE warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('psql -c TRUNCATE orders;'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('TRUNCATE');
    });
  });

  // --- Git destructive commands ---

  describe('git destructive commands', () => {
    // Force-push to a NON-default branch is MEDIUM (ask). Force-push to the
    // default branch is HIGH (deny) — covered in the HIGH tier describe. The
    // fixture repo pins the default branch so the split is deterministic
    // regardless of the host repo's origin/HEAD.
    test('git push --force warns with force-push (non-default target)', () => {
      withGitRepo('trunk', 'trunk', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push --force origin main'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('force-push');
      });
    });

    test('git push -f warns (non-default target)', () => {
      withGitRepo('trunk', 'trunk', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push -f origin main'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('force-push');
      });
    });

    test('git reset --hard warns with uncommitted', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git reset --hard HEAD~3'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('uncommitted');
    });

    test('git checkout . warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git checkout .'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('uncommitted');
    });

    test('git restore . warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git restore .'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('uncommitted');
    });
  });

  // --- Container / infra destructive commands ---

  describe('container and infra commands', () => {
    test('kubectl delete warns with kubectl in message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('kubectl delete pod my-pod'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('kubectl');
    });

    test('docker rm -f warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('docker rm -f container123'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Docker');
    });

    test('docker system prune -a warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('docker system prune -a'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Docker');
    });
  });

  // --- Safe commands ---

  describe('safe commands allow without warning', () => {
    const safeCmds = [
      'ls -la',
      'git status',
      'npm install',
      'cat README.md',
      'echo hello',
    ];

    for (const cmd of safeCmds) {
      test(`"${cmd}" allows`, () => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(cmd));
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    }
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    test('empty command allows gracefully', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(''));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('missing command field allows gracefully', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, { tool_input: {} });
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('malformed JSON input fails CLOSED (asks instead of allowing)', () => {
      // Pre-#2426 this allowed (`{}`) — a hook that gates destructive commands
      // must not allow-by-default on input it cannot read.
      const { exitCode, output } = runHookRaw(CAREFUL_SCRIPT, 'this is not json at all{{{{');
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('parse');
    });

    test('Python fallback: grep fails on multiline JSON, Python parses it', () => {
      // Construct JSON where "command": and the value are on separate lines.
      // grep works line-by-line, so it cannot match "command"..."value" across lines.
      // This forces CMD to be empty, triggering the Python fallback which handles
      // the full JSON correctly.
      const rawJson = '{"tool_input":{"command":\n"rm -rf /tmp/important"}}';
      const { exitCode, output } = runHookRaw(CAREFUL_SCRIPT, rawJson);
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });
  });

  // --- HIGH tier (hard deny) ---
  // A tiny set of catastrophic SIMPLE commands is denied outright while
  // /careful is active. Best-effort advisory hard-stop, not a policy boundary:
  // compound commands always fall through to the MEDIUM ask.

  describe('HIGH tier (hard deny)', () => {
    test.each(['rm -rf /', 'rm -rf ~', 'rm -rf $HOME', 'sudo rm -rf /', 'rm -Rf ~/'])(
      'denies catastrophic recursive delete: %s',
      (command) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('HIGH');
      },
    );

    test('rm -rf ~/subdir stays MEDIUM ask (not the whole home dir)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf ~/subdir'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
    });

    test('git push --force origin <default branch> denies', () => {
      withGitRepo('main', 'feature', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push --force origin main'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('default branch');
      });
    });

    test('bare git push --force while ON the default branch denies', () => {
      withGitRepo('main', 'main', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push --force'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('HIGH');
      });
    });

    test('bare git push --force on a feature branch asks (MEDIUM)', () => {
      withGitRepo('main', 'feature', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push --force'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('force-push');
      });
    });

    test('git push -f origin feature asks (MEDIUM — not the default branch)', () => {
      withGitRepo('main', 'main', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push -f origin feature'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('force-push');
      });
    });

    test('compound force-push falls through to ask, never deny (cannot resolve cwd)', () => {
      withGitRepo('main', 'main', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('cd elsewhere && git push --force origin main'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      });
    });

    test.each(['rm -rf --no-preserve-root /', 'rm -rf / --no-preserve-root', 'rm -rf /*'])(
      'denies catastrophic rm variant: %s',
      (command) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('HIGH');
      },
    );

    test('plus-refspec force to the default branch denies (git push origin +main)', () => {
      withGitRepo('main', 'feature', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push origin +main'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('HIGH');
      });
    });

    test('refspec-form force to the default branch denies (git push -f origin HEAD:main)', () => {
      withGitRepo('main', 'feature', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push -f origin HEAD:main'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      });
    });

    test('plus-refspec force to a FEATURE branch asks (MEDIUM, not silent allow)', () => {
      withGitRepo('main', 'main', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push origin +feature'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('force-push');
      });
    });

    test('slashed default branch is matched whole (git push -f origin release/2.0)', () => {
      withGitRepo('release/2.0', 'feature', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push -f origin release/2.0'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('release/2.0');
      });
    });

    test.each(['rm -rf "/"', "rm -rf '~'", 'rm -rf //'])('quoted root targets still deny: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
    });

    test('quoted default-branch ref still denies (git push -f origin "main")', () => {
      withGitRepo('main', 'feature', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push -f origin "main"'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      });
    });

    test('missing origin/HEAD symbolic ref falls back to origin/main probe (Conductor worktrees)', () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-nohead-'));
      try {
        const git = (args: string[]) => gitArgvIn(repoDir, args);
        git(['init', '-q', '-b', 'main']);
        git(['commit', '--allow-empty', '-q', '-m', 'init']);
        // No symbolic-ref — only a plain remote-tracking ref, like a Conductor worktree.
        git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
        git(['checkout', '-q', '-b', 'feature']);
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push --force origin main'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    test('--force-with-lease is never HIGH (the safe force variant)', () => {
      withGitRepo('main', 'main', (repoDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push --force-with-lease origin main'), undefined, repoDir);
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).not.toBe('deny');
      });
    });
  });

  // --- Additive project patterns ---
  // Config can only ADD warn rules. The files are consulted after the baseline
  // families, so no file content can suppress a baseline match.

  describe('additive project patterns', () => {
    function withPatternFile(content: string, fn: (gstackHome: string) => void) {
      const gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-pat-'));
      fs.writeFileSync(path.join(gstackHome, 'careful-patterns.txt'), content);
      try {
        fn(gstackHome);
      } finally {
        fs.rmSync(gstackHome, { recursive: true, force: true });
      }
    }

    test('a project pattern adds an ask rule', () => {
      withPatternFile('# infra safety\nterraform\\s+destroy\n', (gstackHome) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('terraform destroy -auto-approve'), { GSTACK_HOME: gstackHome });
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Project rule');
      });
    });

    test('a garbage pattern file cannot suppress a baseline match (additive invariant)', () => {
      withPatternFile('# override: allow everything\nallow-everything\nignore baseline\n', (gstackHome) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /var/data'), { GSTACK_HOME: gstackHome });
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
      });
    });

    test('an invalid regex line is skipped without breaking the hook', () => {
      withPatternFile('([unclosed\nterraform\\s+destroy\n', (gstackHome) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('terraform destroy'), { GSTACK_HOME: gstackHome });
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Project rule');
      });
    });

    test('an older hook-extract.sh without gstack_hook_state_root still loads rules from $HOME/.gstack and emits a decision (no set -e death)', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-oldhelper-'));
      const carefulBin = path.join(base, 'careful', 'bin');
      fs.mkdirSync(carefulBin, { recursive: true });
      fs.copyFileSync(CAREFUL_SCRIPT, path.join(carefulBin, 'check-careful.sh'));
      const helper = fs.readFileSync(HOOK_EXTRACT, 'utf-8');
      const start = helper.indexOf('gstack_hook_state_root() {');
      const end = helper.indexOf('\n}\n', start) + 3;
      fs.writeFileSync(path.join(carefulBin, 'hook-extract.sh'), helper.slice(0, start) + helper.slice(end));
      const fakeHome = path.join(base, 'home');
      fs.mkdirSync(path.join(fakeHome, '.gstack'), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, '.gstack', 'careful-patterns.txt'), 'terraform\\s+destroy\n');
      try {
        const { exitCode, output } = runHook(path.join(carefulBin, 'check-careful.sh'), carefulInput('terraform destroy'), { HOME: fakeHome, GSTACK_HOME: '' });
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Project rule');
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    test('plugin install: patterns under CLAUDE_PLUGIN_DATA load when CLAUDE_PLUGIN_ROOT names gstack (same root the writer uses)', () => {
      withPatternFile('terraform\\s+destroy\n', (pluginData) => {
        withEmptyDir((fakeHome) => {
          const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('terraform destroy'),
            { HOME: fakeHome, GSTACK_HOME: '', CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' });
          expect(exitCode).toBe(0);
          expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
          expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Project rule');
        });
      });
    });

    test('GSTACK_HOME outranks CLAUDE_PLUGIN_DATA for careful patterns, exactly as for the freeze file', () => {
      withPatternFile('terraform\\s+destroy\n', (gstackHome) => {
        withEmptyDir((pluginData) => {
          const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('terraform destroy'),
            { GSTACK_HOME: gstackHome, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' });
          expect(exitCode).toBe(0);
          expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
          expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Project rule');
        });
      });
    });

    test('safe commands still allow with a pattern file present', () => {
      withPatternFile('terraform\\s+destroy\n', (gstackHome) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('ls -la'), { GSTACK_HOME: gstackHome });
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    });
  });
});

// ============================================================
// check-freeze.sh tests
// ============================================================
describe('check-freeze.sh', () => {

  describe('edits inside freeze boundary', () => {
    test('edit inside freeze boundary allows', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src/index.ts'),
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    });

    test('edit in subdirectory of freeze path allows', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src/components/Button.tsx'),
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    });
  });

  describe('edits outside freeze boundary', () => {
    test('edit outside freeze boundary denies', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/other-project/index.ts'),
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('freeze');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('outside');
      });
    });

    test('write outside freeze boundary denies', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/etc/hosts'),
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('freeze');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('outside');
      });
    });
  });

  describe('trailing slash prevents prefix confusion', () => {
    test('freeze at /src/ denies /src-old/ (trailing slash prevents prefix match)', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src-old/index.ts'),
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('outside');
      });
    });
  });

  describe('no freeze file exists', () => {
    test('allows everything when no freeze file present', () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-test-'));
      try {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/anywhere/at/all.ts'),
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('edge cases', () => {
    test('missing file_path field allows gracefully', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          { tool_input: {} },
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    });

    test('malformed JSON payload DENIES (fail closed — freeze is a deny-tier hook)', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHookRaw(
          FREEZE_SCRIPT,
          'not json at all {{{{',
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('fail closed');
      });
    });

    test('a quote-bearing path outside the boundary emits PARSEABLE deny JSON', () => {
      // The old printf-interpolated deny emitted malformed JSON for paths
      // containing quotes — Claude Code silently ignored the whole decision,
      // so the deny no-oped exactly when the path was hostile.
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output, raw } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/tmp/evil"quoted/x.ts'),
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(() => JSON.parse(raw)).not.toThrow();
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      });
    });

    test('a newline-bearing path outside the boundary emits PARSEABLE deny JSON', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output, raw } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/tmp/evil\npath.ts'),
          freezeEnv(stateDir),
        );
        expect(exitCode).toBe(0);
        expect(() => JSON.parse(raw)).not.toThrow();
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      });
    });
  });

  describe('space-bearing freeze boundary', () => {
    // The old `tr -d '[:space:]'` stripped INTERNAL spaces from the freeze
    // path, so a boundary like ".../My Project/src" never matched anything.
    test('a boundary containing spaces allows edits inside it', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-space-'));
      const boundary = path.join(base, 'My Project', 'src');
      fs.mkdirSync(boundary, { recursive: true });
      try {
        withFreezeDir(boundary + '/', (stateDir) => {
          const inside = runHook(FREEZE_SCRIPT, freezeInput(path.join(boundary, 'index.ts')), freezeEnv(stateDir));
          expect(inside.exitCode).toBe(0);
          expect(inside.output.hookSpecificOutput?.permissionDecision).toBeUndefined();

          const outside = runHook(FREEZE_SCRIPT, freezeInput(path.join(base, 'elsewhere.ts')), freezeEnv(stateDir));
          expect(outside.exitCode).toBe(0);
          expect(outside.output.hookSpecificOutput?.permissionDecision).toBe('deny');
        });
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('broken install fails closed', () => {
    test('a missing hook-extract helper DENIES instead of proceeding', () => {
      // Copy the freeze hook into a tree with NO careful sibling — the source
      // fails, and a deny-tier boundary must fail CLOSED, not fall through.
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-broken-'));
      const binDir = path.join(base, 'freeze', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const script = path.join(binDir, 'check-freeze.sh');
      fs.copyFileSync(FREEZE_SCRIPT, script);
      try {
        withFreezeDir('/Users/dev/project/src/', (stateDir) => {
          const { exitCode, output } = runHook(script, freezeInput('/Users/dev/project/src/x.ts'), freezeEnv(stateDir));
          expect(exitCode).toBe(0);
          expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
          expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('fail closed');
        });
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('symlink boundary escape', () => {
    // The old resolver followed the parent directory but NOT the final path
    // component, so an in-boundary symlink pointing outside the boundary was
    // allowed while the write landed outside.
    test('an in-boundary symlink to an outside target denies', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-link-'));
      const boundary = path.join(base, 'boundary');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(boundary, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(boundary, 'link.txt'));
      try {
        withFreezeDir(boundary + '/', (stateDir) => {
          const viaLink = runHook(FREEZE_SCRIPT, freezeInput(path.join(boundary, 'link.txt')), freezeEnv(stateDir));
          expect(viaLink.exitCode).toBe(0);
          expect(viaLink.output.hookSpecificOutput?.permissionDecision).toBe('deny');

          // A real in-boundary file is unaffected.
          fs.writeFileSync(path.join(boundary, 'real.txt'), 'y');
          const real = runHook(FREEZE_SCRIPT, freezeInput(path.join(boundary, 'real.txt')), freezeEnv(stateDir));
          expect(real.exitCode).toBe(0);
          expect(real.output.hookSpecificOutput?.permissionDecision).toBeUndefined();
        });
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  });
});

// ============================================================
// check-freeze.sh state-root resolution (#1459 / #1509)
// ============================================================
// /freeze writes freeze-dir.txt under the root gstack-paths resolves
// (GSTACK_HOME first). The reader used to read ${CLAUDE_PLUGIN_DATA:-$HOME/.gstack}
// — so with GSTACK_HOME set it found no file and ALLOWED everything. A deny-tier
// boundary that fails open is not a boundary; writer and reader now share one
// chain (gstack_hook_state_root in careful/bin/hook-extract.sh).
describe('check-freeze.sh state-root resolution (#1459 / #1509)', () => {
  const BOUNDARY = '/Users/dev/project/src/';
  const OUTSIDE = '/Users/dev/other-project/index.ts';


  test('REGRESSION: freeze file under GSTACK_HOME (HOME has none) denies an outside edit', () => {
    withFreezeDir(BOUNDARY, (gstackHome) => {
      withEmptyDir((fakeHome) => {
        const { exitCode, output } = runHook(FREEZE_SCRIPT, freezeInput(OUTSIDE), {
          GSTACK_HOME: gstackHome, HOME: fakeHome, CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '',
        });
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      });
    });
  });

  test('GSTACK_HOME wins over CLAUDE_PLUGIN_DATA (matches gstack-paths precedence)', () => {
    withFreezeDir(BOUNDARY, (pluginData) => {
      withEmptyDir((gstackHome) => {
        // The freeze file lives under CLAUDE_PLUGIN_DATA, but GSTACK_HOME is set and
        // has none — the writer would have written there, so the reader must look there.
        const { output } = runHook(FREEZE_SCRIPT, freezeInput(OUTSIDE),
          freezeEnv(pluginData, { GSTACK_HOME: gstackHome }));
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    });
  });

  test('CLAUDE_PLUGIN_DATA is ignored when CLAUDE_PLUGIN_ROOT is another plugin', () => {
    withFreezeDir(BOUNDARY, (pluginData) => {
      withEmptyDir((fakeHome) => {
        const { output } = runHook(FREEZE_SCRIPT, freezeInput(OUTSIDE),
          freezeEnv(pluginData, { CLAUDE_PLUGIN_ROOT: '/plugins/codex', HOME: fakeHome }));
        // Falls through to $HOME/.gstack, which has no freeze file → allow.
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    });
  });

  test('CLAUDE_PLUGIN_DATA is honoured when CLAUDE_PLUGIN_ROOT names gstack', () => {
    withFreezeDir(BOUNDARY, (pluginData) => {
      withEmptyDir((fakeHome) => {
        const { output } = runHook(FREEZE_SCRIPT, freezeInput(OUTSIDE), freezeEnv(pluginData, { HOME: fakeHome }));
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      });
    });
  });

  test('gstack_hook_state_root is byte-identical to gstack-paths GSTACK_STATE_ROOT', () => {
    const combos: Record<string, string>[] = [
      { HOME: '/home/u', GSTACK_HOME: '/state/x', CLAUDE_PLUGIN_DATA: '/plug/data', CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
      { HOME: '/home/u', GSTACK_HOME: '', CLAUDE_PLUGIN_DATA: '/plug/data', CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
      { HOME: '/home/u', GSTACK_HOME: '', CLAUDE_PLUGIN_DATA: '/plug/data', CLAUDE_PLUGIN_ROOT: '/plugins/codex' },
      { HOME: '/home/u', GSTACK_HOME: '', CLAUDE_PLUGIN_DATA: '/plug/data', CLAUDE_PLUGIN_ROOT: '' },
      { HOME: '/home/u', GSTACK_HOME: '', CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '' },
      { HOME: '', GSTACK_HOME: '', CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '' },
    ];
    for (const env of combos) {
      expect(hookStateRoot(env)).toBe(pathsStateRoot(env));
    }
  });
});

// ============================================================
// gstack_hook_log_fire analytics sink follows the same state root (#1459)
// ============================================================
// The hook_fire record lands under ${GSTACK_HOME:-$HOME/.gstack}/analytics —
// the SAME two-step chain every other analytics writer and reader uses
// (gstack-skill-start, gstack-retro-metrics, gstack-analytics) — deliberately
// NOT the plugin-aware state root the freeze FILE uses, so the usage log stays
// one file. Logging is best-effort: an unwritable sink never changes the decision.
describe('gstack_hook_log_fire writes under the resolved state root', () => {
  const BOUNDARY = '/Users/dev/project/src/';
  const OUTSIDE = '/Users/dev/other-project/index.ts';

  function lastRecord(file: string): any {
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  }

  test('REGRESSION: a freeze deny under GSTACK_HOME appends hook_fire to $GSTACK_HOME/analytics, not $HOME/.gstack', () => {
    withFreezeDir(BOUNDARY, (gstackHome) => {
      withEmptyDir((fakeHome) => {
        const { exitCode, output } = runHook(FREEZE_SCRIPT, freezeInput(OUTSIDE), {
          GSTACK_HOME: gstackHome, HOME: fakeHome, CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '',
        });
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        const rec = lastRecord(path.join(gstackHome, 'analytics', 'skill-usage.jsonl'));
        expect(rec.event).toBe('hook_fire');
        expect(rec.skill).toBe('freeze');
        expect(rec.pattern).toBe('boundary_deny');
        expect(typeof rec.ts).toBe('string');
        expect(fs.existsSync(path.join(fakeHome, '.gstack'))).toBe(false);
      });
    });
  });

  test('plugin install: the freeze FILE is read from CLAUDE_PLUGIN_DATA but hook_fire still lands under $HOME/.gstack/analytics (one usage log)', () => {
    withFreezeDir(BOUNDARY, (pluginData) => {
      withEmptyDir((fakeHome) => {
        const { output } = runHook(FREEZE_SCRIPT, freezeInput(OUTSIDE),
          freezeEnv(pluginData, { HOME: fakeHome, CLAUDE_PLUGIN_ROOT: '/Plugins/GSTACK' }));
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        const rec = lastRecord(path.join(fakeHome, '.gstack', 'analytics', 'skill-usage.jsonl'));
        expect(rec.event).toBe('hook_fire');
        expect(rec.skill).toBe('freeze');
        expect(fs.existsSync(path.join(pluginData, 'analytics'))).toBe(false);
      });
    });
  });

  test('a GSTACK_HOME ending in a newline round-trips exactly (writer %q and reader sentinel agree)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-nl-'));
    const nlDir = path.join(base, 'root\n');
    fs.mkdirSync(nlDir);
    fs.writeFileSync(path.join(nlDir, 'freeze-dir.txt'), BOUNDARY);
    try {
      const { output } = runHook(FREEZE_SCRIPT, freezeInput(OUTSIDE), {
        GSTACK_HOME: nlDir, HOME: base, CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '',
      });
      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('an unexpected set -e death inside the hook (a tool on PATH failing) DENIES via the EXIT backstop instead of exiting with no JSON', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-backstop-'));
    const fakeBin = path.join(base, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'head'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(fakeBin, 'head'), 0o755);
    try {
      withFreezeDir(BOUNDARY, (stateDir) => {
        const { exitCode, output } = runHook(FREEZE_SCRIPT, freezeInput('/Users/dev/project/src/x.ts'),
          freezeEnv(stateDir, { PATH: `${fakeBin}:${process.env.PATH ?? ''}` }));
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('failed unexpectedly');
      });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('a hook helper from an older install that lacks gstack_hook_state_root DENIES (fail closed), never exit 127', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-oldhelper-'));
    const freezeBin = path.join(base, 'freeze', 'bin');
    const carefulBin = path.join(base, 'careful', 'bin');
    fs.mkdirSync(freezeBin, { recursive: true });
    fs.mkdirSync(carefulBin, { recursive: true });
    fs.copyFileSync(FREEZE_SCRIPT, path.join(freezeBin, 'check-freeze.sh'));
    const helper = fs.readFileSync(HOOK_EXTRACT, 'utf-8');
    const start = helper.indexOf('gstack_hook_state_root() {');
    const end = helper.indexOf('\n}\n', start) + 3;
    fs.writeFileSync(path.join(carefulBin, 'hook-extract.sh'), helper.slice(0, start) + helper.slice(end));
    try {
      withFreezeDir(BOUNDARY, (stateDir) => {
        const { exitCode, output } = runHook(path.join(freezeBin, 'check-freeze.sh'), freezeInput('/Users/dev/project/src/x.ts'), freezeEnv(stateDir));
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        // 'out of date' is the helper-without-function branch; the plain
        // helpers-unavailable deny also says 'fail closed', so pin the specific one.
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('out of date');
      });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('an unwritable analytics sink never changes the decision: deny is still emitted as valid JSON', () => {
    withFreezeDir(BOUNDARY, (gstackHome) => {
      // `analytics` is a regular FILE, so mkdir -p and the >> append both fail.
      fs.writeFileSync(path.join(gstackHome, 'analytics'), 'not a directory');
      withEmptyDir((fakeHome) => {
        const { exitCode, output, raw } = runHook(FREEZE_SCRIPT, freezeInput(OUTSIDE), {
          GSTACK_HOME: gstackHome, HOME: fakeHome, CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '',
        });
        expect(exitCode).toBe(0);
        expect(() => JSON.parse(raw)).not.toThrow();
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(fs.readFileSync(path.join(gstackHome, 'analytics'), 'utf-8')).toBe('not a directory');
      });
    });
  });
});
