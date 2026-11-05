/**
 * investigate-gate (GST-1461): with the investigate_gate switch on, a session
 * that loaded /investigate cannot change tracked non-test source until it has
 * stated a root cause as a `Root cause: <value>` line. Edit/Write are denied
 * at PreToolUse; Bash writes are caught by comparing the tracked tree before
 * (PreToolUse) and after (PostToolUse / PostToolUseFailure) the command, put
 * back, and reported. Every decision is a GSTACK_GATE marker in the hook log
 * and in the hook's output; every error fails open with an error marker.
 * Native hook payloads against a throwaway git repo.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { excludedReason } from '../lib/investigate-gate';
import { ROOT, hookEnv, result, runHook, say, skillsDir, slash, tmpDir, tool, user } from './helpers/skill-contract-fixture';

const HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'investigate-gate.ts');
const SRC = 'export const total = (a: number, b: number) => a - b;\n';
const FIXED = 'export const total = (a: number, b: number) => a + b;\n';

let state = '', skills = '', repo = '', work = '';
beforeEach(() => {
  state = tmpDir('gstack-igate-state-');
  work = tmpDir('gstack-igate-work-');
  repo = tmpDir('gstack-igate-repo-');
  skills = skillsDir(['investigate']);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'src', 'total.ts'), SRC);
  fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 1;\n');
  fs.writeFileSync(path.join(repo, 'test', 'total.test.ts'), 'expect(total(1, 2)).toBe(3);\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '-A');
  commit('seed');
});
afterEach(() => {
  for (const d of [state, skills, repo, work]) fs.rmSync(d, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const commit = (msg: string) => git('-c', 'user.name=Gate fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-q', '-m', msg);
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const sh = (command: string) => spawnSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8', timeout: 10_000 });

const LOADED = [user('total() is wrong, fix it'), tool('s1', 'Skill', { skill: 'investigate' }), result('s1', 'Launching skill: investigate')];
const LOOKED = [tool('r1', 'Read', { file_path: 'src/total.ts' }), result('r1', SRC)];
const ROOT_CAUSE = say('Root cause: total() subtracts b instead of adding it (src/total.ts:1).');
const RELEASED = [...LOADED, ...LOOKED, ROOT_CAUSE];
const record = () => JSON.parse(fs.readFileSync(path.join(state, 'skill-gates', 'sess-1', 'record.json'), 'utf8'));

function transcript(lines: string[]): string {
  const file = path.join(work, 'transcript.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
function fire(event: string, lines: string[], extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const payload = { session_id: 'sess-1', transcript_path: transcript(lines), cwd: repo, hook_event_name: event, ...extra };
  return runHook(HOOK, JSON.stringify(payload), hookEnv(state, skills, { GSTACK_INVESTIGATE_GATE: 'on', ...env }));
}
/** PreToolUse as Claude Code sends it: the call's own tool_use block is already in the transcript. */
const pre = (lines: string[], name: string, input: Record<string, unknown>, id = 'tu1', env: Record<string, string> = {}) =>
  fire('PreToolUse', [...lines, tool(id, name, input)], { tool_name: name, tool_input: input, tool_use_id: id }, env);
const post = (lines: string[], command: string, id = 'tu1', event = 'PostToolUse') =>
  fire(event, [...lines, tool(id, 'Bash', { command })], { tool_name: 'Bash', tool_input: { command }, tool_use_id: id, tool_response: { stdout: '', stderr: '', interrupted: false } });
const log = () => {
  const f = path.join(state, 'hooks', 'investigate-gate.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const json = (stdout: string) => (stdout.trim() ? JSON.parse(stdout) : null);

/** Run a Bash command the way Claude Code does: PreToolUse, the command, then PostToolUse (or PostToolUseFailure on a non-zero exit). */
function bash(lines: string[], command: string, id = 'tu1') {
  const before = pre(lines, 'Bash', { command }, id);
  const ran = sh(command);
  const after = post(lines, command, id, ran.status === 0 ? 'PostToolUse' : 'PostToolUseFailure');
  return { before, ran, after };
}

describe('Edit and Write before a root cause', () => {
  test('an Edit to tracked source is denied with the blocked marker, and fired is logged once', () => {
    const r = pre(LOADED, 'Edit', { file_path: path.join(repo, 'src', 'total.ts'), old_string: 'a - b', new_string: 'a + b' });
    expect(r.code).toBe(0);
    const out = json(r.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe('PreToolUse');
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(/^GSTACK_GATE investigate-gate blocked session=sess-1 skill=investigate via=edit files=src\/total\.ts/);
    expect(out.permissionDecisionReason).toContain('Root cause:');
    expect(out.permissionDecisionReason).not.toMatch(/investigate_gate|gstack-config/);
    pre(LOADED, 'Write', { file_path: path.join(repo, 'src', 'other.ts'), content: 'x' }, 'tu2');
    expect(log().match(/ event=fired /g)?.length).toBe(1);
    expect(log().match(/ event=blocked /g)?.length).toBe(2);
  });

  test('MultiEdit and NotebookEdit are denied too; relative paths resolve against cwd', () => {
    expect(json(pre(LOADED, 'MultiEdit', { file_path: 'src/total.ts', edits: [] }).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(json(pre(LOADED, 'NotebookEdit', { notebook_path: 'src/total.ts', new_source: '' }, 'tu2').stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('test files, new untracked files, docs and paths outside the repo are allowed', () => {
    for (const [i, file] of [path.join(repo, 'test', 'total.test.ts'), path.join(repo, 'src', 'new.ts'), path.join(repo, 'README.md'), path.join(work, 'notes.ts')].entries()) {
      const r = pre(LOADED, 'Write', { file_path: file, content: 'x' }, `tu${i}`);
      expect(r.code).toBe(0);
      expect(json(r.stdout)?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    }
    expect(log()).not.toContain('event=blocked');
  });

  test('a placeholder, a hedge, a cause before any evidence, or a cause inside tool output does not release', () => {
    const cases: string[][] = [
      [...LOADED, ...LOOKED, say('Root cause: [what was actually wrong]')],
      [...LOADED, ...LOOKED, say('Root cause: unknown')],
      [...LOADED, ...LOOKED, say('**Root cause:** still investigating.')],
      [...LOADED, ROOT_CAUSE],
      [...LOADED, tool('b1', 'Bash', { command: 'echo' }), result('b1', 'Root cause: total subtracts')],
    ];
    for (const [i, lines] of cases.entries()) {
      const out = json(pre(lines, 'Edit', { file_path: 'src/total.ts' }, `tu${i}`).stdout).hookSpecificOutput;
      expect(out.permissionDecision).toBe('deny');
    }
    expect(json(pre(cases[1], 'Edit', { file_path: 'src/total.ts' }, 'tu9').stdout).hookSpecificOutput.permissionDecisionReason).toContain('"Root cause: unknown" does not count');
  });

  test('after a Root cause line the edit is allowed, released is logged once and carried into the transcript', () => {
    const r = pre(RELEASED, 'Edit', { file_path: 'src/total.ts' });
    const out = json(r.stdout);
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.systemMessage).toMatch(/^GSTACK_GATE investigate-gate fired session=sess-1 skill=investigate/m);
    expect(out.systemMessage).toMatch(/^GSTACK_GATE investigate-gate released session=sess-1 skill=investigate cause=[0-9a-f]{12} blocked=0$/m);
    expect(pre(RELEASED, 'Edit', { file_path: 'src/total.ts' }, 'tu2').stdout).toBe('');
    expect(log().match(/ event=released /g)?.length).toBe(1);
    const run = Object.values(record().hooks['investigate-gate'].runs)[0] as any;
    expect(run).toMatchObject({ skill: 'investigate', blocked: 0 });
    expect(run.released_at).toBeString();
  });

  test('a Root cause line that reaches the transcript after PreToolUse fires still releases (the hook waits for its own tool_use)', () => {
    const file = transcript([...LOADED, ...LOOKED]);
    const late = [ROOT_CAUSE, tool('tu1', 'Edit', { file_path: 'src/total.ts' })].join('\n');
    const writer = spawnSync('bash', ['-c', `(sleep 0.4; printf '%s\\n' "$1" >> "$2") >/dev/null 2>&1 &`, 'w', late, file], { timeout: 5000 });
    expect(writer.status).toBe(0);
    const payload = { session_id: 'sess-1', transcript_path: file, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/total.ts' }, tool_use_id: 'tu1' };
    const r = runHook(HOOK, JSON.stringify(payload), hookEnv(state, skills, { GSTACK_INVESTIGATE_GATE: 'on' }));
    const out = json(r.stdout);
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.systemMessage).toContain('investigate-gate released');
  });

  test('a fresh /investigate load re-arms the gate', () => {
    const lines = [...RELEASED, slash('investigate', 'another bug')];
    expect(json(pre(lines, 'Edit', { file_path: 'src/total.ts' }).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('no /investigate load, or the switch off: no output and no log', () => {
    expect(pre([user('fix it')], 'Edit', { file_path: 'src/total.ts' }).stdout).toBe('');
    expect(pre(LOADED, 'Edit', { file_path: 'src/total.ts' }, 'tu2', { GSTACK_INVESTIGATE_GATE: 'off' }).stdout).toBe('');
    expect(log()).toBe('');
  });
});

describe('Bash writes are caught by the tree check, put back and reported', () => {
  const WRITES: Record<string, string> = {
    'sed -i': "sed -i 's/a - b/a + b/' src/total.ts",
    'redirect': `printf '%s' '${FIXED}' > src/total.ts`,
    'tee': `printf '%s' '${FIXED}' | tee src/total.ts >/dev/null`,
    'python': "python3 -c \"import pathlib; p = pathlib.Path('src/total.ts'); p.write_text(p.read_text().replace('a - b', 'a + b'))\"",
    'perl -pi': "perl -pi -e 's/a - b/a + b/' src/total.ts",
    'node': "node -e \"const fs = require('fs'); fs.writeFileSync('src/total.ts', fs.readFileSync('src/total.ts', 'utf8').replace('a - b', 'a + b'))\"",
    'git apply': "printf '%s\\n' 'diff --git a/src/total.ts b/src/total.ts' '--- a/src/total.ts' '+++ b/src/total.ts' '@@ -1 +1 @@' '-export const total = (a: number, b: number) => a - b;' '+export const total = (a: number, b: number) => a + b;' | git apply",
    'heredoc into cat': `cat > src/total.ts <<'EOF'\n${FIXED}EOF`,
    'rm': 'rm src/other.ts',
  };
  for (const [name, command] of Object.entries(WRITES)) {
    test(`${name}: blocked, restored, marker in log and output`, () => {
      const { before, ran, after } = bash(LOADED, command);
      expect(json(before.stdout)?.hookSpecificOutput).toBeUndefined();
      expect(ran.status).toBe(0);
      const out = json(after.stdout);
      expect(out.decision).toBe('block');
      expect(out.reason).toMatch(/^GSTACK_GATE investigate-gate blocked session=sess-1 skill=investigate via=bash files=src\/(total|other)\.ts/);
      expect(read('src/total.ts')).toBe(SRC);
      expect(read('src/other.ts')).toBe('export const other = 1;\n');
      expect(git('status', '--porcelain')).toBe('');
      expect(log()).toContain('event=blocked');
    });
  }

  test('a command that writes and then fails is caught at PostToolUseFailure', () => {
    const { ran, after } = bash(LOADED, `${WRITES['sed -i']} && false`);
    expect(ran.status).not.toBe(0);
    expect(json(after.stdout).decision).toBe('block');
    expect(read('src/total.ts')).toBe(SRC);
  });

  test('write then commit in one command is caught and the worktree put back', () => {
    const head = git('rev-parse', 'HEAD');
    const { after } = bash(LOADED, `${WRITES['sed -i']} && git -c user.name=x -c user.email=x@x.test commit -qam fix`);
    const out = json(after.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('moved the branch back');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(read('src/total.ts')).toBe(SRC);
    expect(git('status', '--porcelain')).toBe('');
  });

  test('a file dirty at the start is put back to its dirty bytes, not HEAD', () => {
    const dirty = '// local note\n' + SRC;
    fs.writeFileSync(path.join(repo, 'src', 'total.ts'), dirty);
    const { after } = bash(LOADED, WRITES['sed -i']);
    expect(json(after.stdout).decision).toBe('block');
    expect(read('src/total.ts')).toBe(dirty);
  });

  test('reads, test writes, new files, reverts and checkouts of existing commits pass', () => {
    fs.writeFileSync(path.join(repo, 'src', 'total.ts'), FIXED);
    git('stash', '-q');
    git('checkout', '-q', '-b', 'other');
    fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 2;\n');
    git('add', '-A');
    commit('other');
    git('checkout', '-q', 'main');
    git('stash', 'pop', '-q');
    const commands = [
      'cat src/total.ts && git log --oneline | head -1',
      "sed -i 's/3/4/' test/total.test.ts",
      "printf 'x' > src/repro.ts",
      'git checkout -- src/total.ts',
      'git checkout -q other && git checkout -q main',
      'git stash -q && git stash pop -q || true',
    ];
    for (const [i, c] of commands.entries()) {
      const { after } = bash(LOADED, c, `tu${i}`);
      expect(json(after.stdout)?.decision).toBeUndefined();
    }
    expect(log()).not.toContain('event=blocked');
  }, 30_000);

  test('the bytes a restore replaces are saved in the session directory and named in the block', () => {
    const out = json(bash(LOADED, "sed -i 's/a - b/a + b/' src/total.ts").after.stdout);
    const saved = /The content it replaced is saved: src\/total\.ts at (\S+)\.$/m.exec(out.reason)?.[1];
    expect(saved).toBeDefined();
    expect(fs.readFileSync(saved!, 'utf8')).toBe(FIXED);
    expect(read('src/total.ts')).toBe(SRC);
  });

  test('a fix committed on another branch moves that branch back to its own tip, not to the baseline HEAD', () => {
    git('checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 2;\n');
    git('add', '-A');
    commit('side');
    const side = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    const { after } = bash(LOADED, "git checkout -q side && sed -i 's/a - b/a + b/' src/total.ts && git -c user.name=x -c user.email=x@x.test commit -qam fix");
    expect(json(after.stdout).decision).toBe('block');
    expect(git('rev-parse', 'side')).toBe(side);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('side');
    expect(read('src/total.ts')).toBe(SRC);
    expect(read('src/other.ts')).toBe('export const other = 2;\n');
    expect(git('status', '--porcelain')).toBe('');
  });

  test('a fix committed on a branch behind the baseline HEAD is undone: that branch goes back to its own tip (fc#1)', () => {
    const mainTip = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 2;\n');
    git('add', '-A');
    commit('feature');
    const featureTip = git('rev-parse', 'HEAD');
    const { after } = bash(LOADED, "git checkout -q main && sed -i 's/a - b/a + b/' src/total.ts && git -c user.name=x -c user.email=x@x.test commit -qam fix");
    const out = json(after.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(`moved the branch back to ${mainTip.trim().slice(0, 12)}`);
    expect(git('rev-parse', 'main')).toBe(mainTip);
    expect(git('rev-parse', 'feature')).toBe(featureTip);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(read('src/total.ts')).toBe(SRC);
    expect(read('src/other.ts')).toBe('export const other = 1;\n');
    expect(git('status', '--porcelain')).toBe('');
  });

  test('amending the tip of a branch behind the baseline HEAD is undone to that tip, keeping its own commit (fc#1)', () => {
    fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 3;\n');
    git('add', '-A');
    commit('main second');
    const mainTip = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture, feature\n');
    git('add', '-A');
    commit('feature');
    const { after } = bash(LOADED, "git checkout -q main && sed -i 's/a - b/a + b/' src/total.ts && git -c user.name=x -c user.email=x@x.test commit -q --amend -a --no-edit");
    expect(json(after.stdout).decision).toBe('block');
    expect(git('rev-parse', 'main')).toBe(mainTip);
    expect(read('src/total.ts')).toBe(SRC);
    expect(read('src/other.ts')).toBe('export const other = 3;\n');
    expect(git('status', '--porcelain')).toBe('');
  });

  test('amending the baseline HEAD with a fix moves the branch back to the baseline commit, not its parent', () => {
    fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 2;\n');
    git('add', '-A');
    commit('second');
    const head = git('rev-parse', 'HEAD');
    const { after } = bash(LOADED, "sed -i 's/a - b/a + b/' src/total.ts && git -c user.name=x -c user.email=x@x.test commit -q --amend -a --no-edit");
    expect(json(after.stdout).decision).toBe('block');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(read('src/total.ts')).toBe(SRC);
    expect(read('src/other.ts')).toBe('export const other = 2;\n');
    expect(git('status', '--porcelain')).toBe('');
  });

  test('a fix commit in a repo with hundreds of refs on distinct commits is still undone inside the deadline', () => {
    const head = git('rev-parse', 'HEAD');
    const stream = Array.from({ length: 300 }, (_, i) => `commit refs/tags/t${i}\ncommitter x <x@x.test> 1700000000 +0000\ndata ${String(i).length}\n${i}\nfrom ${head.trim()}\n`).join('');
    expect(spawnSync('git', ['fast-import', '--quiet'], { cwd: repo, input: stream, timeout: 10_000 }).status).toBe(0);
    const { after } = bash(LOADED, "sed -i 's/a - b/a + b/' src/total.ts && git -c user.name=x -c user.email=x@x.test commit -qam fix");
    expect(json(after.stdout).decision).toBe('block');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(read('src/total.ts')).toBe(SRC);
  }, 30_000);

  test('pulling or merging upstream commits fetched after the baseline is not undone', () => {
    const origin = path.join(work, 'origin.git');
    const up = path.join(work, 'up');
    git('clone', '-q', '--bare', repo, origin);
    git('remote', 'add', 'origin', origin);
    git('fetch', '-q', 'origin');
    bash(LOADED, 'ls', 'tu0');
    git('clone', '-q', origin, up);
    fs.writeFileSync(path.join(up, 'src', 'total.ts'), FIXED);
    fs.writeFileSync(path.join(up, 'test', 'total.test.ts'), 'expect(total(2, 2)).toBe(4);\n');
    for (const args of [['-c', 'user.name=x', '-c', 'user.email=x@x.test', 'commit', '-qam', 'upstream'], ['push', '-q', 'origin', 'main']]) {
      expect(spawnSync('git', args, { cwd: up, timeout: 10_000 }).status).toBe(0);
    }
    const pulled = bash(LOADED, 'git pull -q --ff-only origin main', 'tu1');
    expect(json(pulled.after.stdout)?.decision).toBeUndefined();
    expect(read('src/total.ts')).toBe(FIXED);
    fs.writeFileSync(path.join(up, 'src', 'other.ts'), 'export const other = 3;\n');
    for (const args of [['-c', 'user.name=x', '-c', 'user.email=x@x.test', 'commit', '-qam', 'upstream 2'], ['push', '-q', 'origin', 'main']]) {
      expect(spawnSync('git', args, { cwd: up, timeout: 10_000 }).status).toBe(0);
    }
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture, local\n');
    git('add', '-A');
    commit('local');
    const merged = bash(LOADED, 'git fetch -q origin && git -c user.name=x -c user.email=x@x.test merge -q --no-edit origin/main', 'tu2');
    expect(json(merged.after.stdout)?.decision).toBeUndefined();
    expect(git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    expect(read('src/other.ts')).toBe('export const other = 3;\n');
    expect(git('status', '--porcelain')).toBe('');
  });

  test('a background write after the command returned is caught at the next call, and at Stop', () => {
    bash(LOADED, 'ls', 'tu1');
    sh(WRITES['sed -i']);
    const out = json(pre(LOADED, 'Bash', { command: 'ls' }, 'tu2').stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(/^GSTACK_GATE investigate-gate blocked .*via=bash files=src\/total\.ts n=1/);
    expect(read('src/total.ts')).toBe(SRC);
    sh(WRITES['perl -pi']);
    const stop = json(fire('Stop', LOADED, { stop_hook_active: false }).stdout);
    expect(stop.decision).toBe('block');
    expect(stop.reason).toMatch(/^GSTACK_GATE investigate-gate blocked .*n=2/);
    expect(read('src/total.ts')).toBe(SRC);
  });

  test('lockfile and doc churn is observed, not reverted', () => {
    fs.writeFileSync(path.join(repo, 'bun.lock'), 'v1\n');
    git('add', 'bun.lock');
    commit('lock');
    const { after } = bash(LOADED, "printf 'v2\\n' > bun.lock && printf 'more\\n' >> README.md");
    expect(json(after.stdout)?.decision).toBeUndefined();
    expect(read('bun.lock')).toBe('v2\n');
    expect(log()).toContain('event=observed');
  });

  test.skipIf(process.platform === 'win32')('a gated file swapped for a symlink is put back as a file and the outside target is untouched', () => {
    const outside = path.join(work, 'outside.txt');
    fs.writeFileSync(outside, 'keep me\n');
    const { after } = bash(LOADED, `rm src/other.ts && ln -s ${outside} src/other.ts`);
    expect(json(after.stdout).decision).toBe('block');
    expect(fs.lstatSync(path.join(repo, 'src', 'other.ts')).isSymbolicLink()).toBe(false);
    expect(read('src/other.ts')).toBe('export const other = 1;\n');
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep me\n');
  });

  test('a path that cannot be put back gives GATE_RESTORE_FAILED and says the state is unknown', () => {
    const { after } = bash(LOADED, 'rm src/other.ts && mkdir src/other.ts && touch src/other.ts/x');
    const out = json(after.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('could not be put back and are in an unknown state: src/other.ts');
    expect(out.systemMessage).toMatch(/GSTACK_GATE investigate-gate error session=sess-1 code=GATE_RESTORE_FAILED/);
    expect(record().hooks['investigate-gate'].errors[0].code).toBe('GATE_RESTORE_FAILED');
  });

  test('after the root cause, Bash writes go through untouched', () => {
    const { after } = bash(RELEASED, WRITES['sed -i']);
    expect(json(after.stdout)?.decision).toBeUndefined();
    expect(read('src/total.ts')).toBe(FIXED);
  });

  test('outside a git repository the gate logs skipped once and stays out of the way', () => {
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    const { after } = bash(LOADED, WRITES['sed -i']);
    expect(after.stdout).toBe('');
    bash(LOADED, 'ls', 'tu2');
    expect(log().match(/ event=skipped skill=investigate reason=no-git/g)?.length).toBe(1);
  });
});

describe('a rollback restores bytes, index and mode exactly, and reads attributes from the baseline', () => {
  test('two dirty files that differ only in line endings keep their own bytes (ov#1)', () => {
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.sh text\n');
    fs.writeFileSync(path.join(repo, 'a.sh'), 'echo 0\n');
    fs.writeFileSync(path.join(repo, 'b.sh'), 'echo 0\n');
    git('add', '-A');
    commit('scripts');
    fs.writeFileSync(path.join(repo, 'a.sh'), 'echo 1\n');
    fs.writeFileSync(path.join(repo, 'b.sh'), 'echo 1\r\n');
    const { after } = bash(LOADED, "printf 'echo 2\\n' > a.sh && printf 'echo 2\\n' > b.sh");
    expect(json(after.stdout).decision).toBe('block');
    expect(read('a.sh')).toBe('echo 1\n');
    expect(read('b.sh')).toBe('echo 1\r\n');
  });

  test('a rejected edit that was staged leaves the index at the baseline too (ov#2)', () => {
    const { after } = bash(LOADED, "sed -i 's/a - b/a + b/' src/total.ts && git add src/total.ts");
    expect(json(after.stdout).decision).toBe('block');
    expect(read('src/total.ts')).toBe(SRC);
    expect(git('show', ':src/total.ts')).toBe(SRC);
    expect(git('status', '--porcelain')).toBe('');
  });

  test('a file staged at the baseline gets its staged entry back, not HEAD (ov#2)', () => {
    const staged = '// staged note\n' + SRC;
    fs.writeFileSync(path.join(repo, 'src', 'total.ts'), staged);
    git('add', 'src/total.ts');
    const { after } = bash(LOADED, "sed -i 's/a - b/a + b/' src/total.ts && git add src/total.ts");
    expect(json(after.stdout).decision).toBe('block');
    expect(read('src/total.ts')).toBe(staged);
    expect(git('show', ':src/total.ts')).toBe(staged);
  });

  test('a change staged at the baseline whose worktree matches HEAD keeps its staged entry', () => {
    const staged = '// staged only\n' + SRC;
    fs.writeFileSync(path.join(repo, 'src', 'total.ts'), staged);
    git('add', 'src/total.ts');
    fs.writeFileSync(path.join(repo, 'src', 'total.ts'), SRC);
    const { after } = bash(LOADED, "sed -i 's/a - b/a + b/' src/total.ts");
    expect(json(after.stdout).decision).toBe('block');
    expect(read('src/total.ts')).toBe(SRC);
    expect(git('show', ':src/total.ts')).toBe(staged);
  });

  test.skipIf(process.platform === 'win32')('a file clean at the baseline keeps its own permissions (ov#3)', () => {
    fs.chmodSync(path.join(repo, 'src', 'total.ts'), 0o600);
    const { after } = bash(LOADED, "sed -i 's/a - b/a + b/' src/total.ts");
    expect(json(after.stdout).decision).toBe('block');
    expect(read('src/total.ts')).toBe(SRC);
    expect(fs.statSync(path.join(repo, 'src', 'total.ts')).mode & 0o777).toBe(0o600);
  });

  test('a new worktree .gitattributes cannot mark source generated (ov#4)', () => {
    const { after } = bash(LOADED, "printf '*.ts linguist-generated\\n' > .gitattributes && sed -i 's/a - b/a + b/' src/total.ts");
    expect(json(after.stdout).decision).toBe('block');
    expect(read('src/total.ts')).toBe(SRC);
    const r = pre(LOADED, 'Edit', { file_path: path.join(repo, 'src', 'total.ts'), old_string: 'a - b', new_string: 'a + b' }, 'tu9');
    expect(json(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('errors fail open with an error marker', () => {
  test('a payload that is not JSON: exit 0, no decision, error marker on stderr and in the log', () => {
    const r = runHook(HOOK, 'not json', hookEnv(state, skills, { GSTACK_INVESTIGATE_GATE: 'on' }));
    expect(r.code).toBe(0);
    expect(json(r.stdout).hookSpecificOutput).toBeUndefined();
    expect(r.stderr).toMatch(/^GSTACK_GATE investigate-gate error session=unknown code=GATE_BAD_PAYLOAD why=/);
    expect(json(r.stdout).systemMessage).toMatch(/^GSTACK_GATE investigate-gate error session=unknown code=GATE_BAD_PAYLOAD/);
    expect(log()).toContain('event=error');
  });

  test('an unreadable transcript: the error marker rides systemMessage and nothing is denied', () => {
    const r = runHook(HOOK, JSON.stringify({ session_id: 'sess-1', transcript_path: path.join(work, 'missing.jsonl'), cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/total.ts' }, tool_use_id: 'tu1' }),
      hookEnv(state, skills, { GSTACK_INVESTIGATE_GATE: 'on' }));
    expect(r.code).toBe(0);
    const out = json(r.stdout);
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.systemMessage).toMatch(/^GSTACK_GATE investigate-gate error session=sess-1 code=GATE_TRANSCRIPT why=/);
    expect(record().hooks['investigate-gate'].errors[0].code).toBe('GATE_TRANSCRIPT');
  });

  test('a hook past its deadline fails open with an error marker', () => {
    const r = pre(LOADED, 'Edit', { file_path: 'src/total.ts' }, 'tu1', { GSTACK_SKILL_GATE_DEADLINE_MS: '1' });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('"deny"');
    expect(log()).toMatch(/event=error code=GATE_TIMEOUT why="timed out after 1 ms"/);
  });
});

describe('which tracked paths the gate leaves alone', () => {
  test('tests, fixtures, docs, lockfiles, generated files and symlinks are excluded; source is gated', () => {
    expect(excludedReason('test/total.test.ts')).toBe('test');
    expect(excludedReason('src/total.spec.ts')).toBe('test');
    expect(excludedReason('pkg/fixtures/case.json')).toBe('test');
    expect(excludedReason('docs/guide.md')).toBe('doc');
    expect(excludedReason('web/bun.lock')).toBe('lockfile');
    expect(excludedReason('src/schema.gen.ts', '100644', true)).toBe('generated');
    expect(excludedReason('src/link.ts', '120000')).toBe('symlink');
    expect(excludedReason('src/total.ts', '100644')).toBeNull();
    expect(excludedReason('src/contest.ts')).toBeNull();
  });
});
