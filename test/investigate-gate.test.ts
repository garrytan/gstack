/**
 * /investigate reproduce-first gate (GST-938 plan v3): hook, record-only bin,
 * eval recorder and scorer, driven with native Claude Code hook payloads in a
 * throwaway git repository.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { bashSourceWrite, exitMasked, pairsWithRepro, qualifiesAsFailingRun, qualifiesAsPassingRun, splitSegments } from '../lib/investigate-gate';
import { scoreLines } from '../scripts/investigate-gate/score';
import type { RecorderLine } from '../scripts/investigate-gate/recorder';
import { armSettings } from '../scripts/investigate-gate/settings';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'investigate-gate');
const BIN = path.join(ROOT, 'bin', 'gstack-investigate-step');
const RECORDER = path.join(ROOT, 'scripts', 'investigate-gate', 'recorder.ts');

let tmp: string;
let repo: string;
let stateRoot: string;

function sh(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  delete e.GSTACK_HOME;
  delete e.GSTACK_STATE_DIR;
  delete e.GSTACK_INVESTIGATE_GATES;
  e.GSTACK_STATE_ROOT = stateRoot;
  return { ...e, ...extra };
}

function hook(payload: object, extra: Record<string, string> = { GSTACK_INVESTIGATE_GATES: '1' }) {
  const r = spawnSync(HOOK, [], { cwd: repo, env: env(extra), input: JSON.stringify(payload), encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, out: (r.stdout ?? '').trim() ? JSON.parse(r.stdout) : null };
}

function step(session: string, ...args: string[]) {
  const r = spawnSync(BIN, ['--session', session, ...args], { cwd: repo, env: env(), encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const edit = (session: string, file: string) => ({ session_id: session, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo, file), old_string: 'a', new_string: 'b' } });
const preBash = (session: string, command: string) => ({ session_id: session, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } });
const ranOk = (session: string, command: string, stdout = 'ok') => ({ session_id: session, cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false } });
const ranFail = (session: string, command: string, code = 1, text = 'E   assert 1 == 2') => ({ session_id: session, cwd: repo, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error: `Exit code ${code}\n${text}`, is_interrupt: false });
const denied = (r: { out: any }) => r.out?.hookSpecificOutput?.permissionDecision === 'deny';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gig-'));
  repo = path.join(tmp, 'repo');
  stateRoot = path.join(tmp, 'state');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'app.py'), 'def add(a, b):\n    return a - b\n');
  fs.writeFileSync(path.join(repo, 'tests', 'test_app.py'), 'from src.app import add\n');
  sh('git', ['init', '-q'], repo);
  sh('git', ['add', '.'], repo);
  sh('git', ['commit', '-qm', 'seed'], repo);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('investigate gate hook', () => {
  test('is a no-op when investigate_gates is off, and on with the config key', () => {
    expect(hook(edit('s0', 'src/app.py'), {}).out).toBeNull();
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, 'config.yaml'), 'investigate_gates: true\n');
    expect(denied(hook(edit('s0', 'src/app.py'), {}))).toBe(true);
  });

  test('denies tracked source before a reproduction, allows tests and untracked files', () => {
    const r = hook(edit('s1', 'src/app.py'));
    expect(denied(r)).toBe(true);
    expect(r.out.hookSpecificOutput.permissionDecisionReason).toContain('gstack-investigate-step hypothesis');
    expect(hook(edit('s1', 'tests/test_app.py')).out).toBeNull();
    expect(hook(edit('s1', 'repro.py')).out).toBeNull();
  });

  test('binds the latest failing run across intervening lookups, then allows edits', () => {
    hook(edit('s2', 'src/app.py'));
    hook(ranFail('s2', 'pytest tests/test_app.py'));
    hook(ranOk('s2', 'ls src'));
    hook(ranOk('s2', 'git diff'));
    const b = step('s2', 'hypothesis', 'add subtracts', '--repro-last');
    expect(b.status).toBe(0);
    expect(b.out).toContain('bound to pytest tests/test_app.py (exit 1)');
    expect(hook(edit('s2', 'src/app.py')).out).toBeNull();
  });

  test('an untracked repro script binds; ritual and command-not-found runs do not', () => {
    hook(edit('s3', 'src/app.py'));
    hook(ranFail('s3', 'false'));
    hook(ranFail('s3', 'pyhton repro.py', 127, 'command not found'));
    expect(step('s3', 'hypothesis', 'x', '--repro-last').status).toBe(1);
    fs.writeFileSync(path.join(repo, 'repro.py'), 'assert False\n');
    hook(ranFail('s3', 'python repro.py', 1, 'AssertionError'));
    expect(step('s3', 'hypothesis', 'x', '--repro-last').status).toBe(0);
  });

  test('a dirty worktree at start is the baseline, not a block', () => {
    fs.appendFileSync(path.join(repo, 'src', 'app.py'), '# local tweak\n');
    hook(edit('s4', 'src/app.py'));
    hook(ranFail('s4', 'pytest -x'));
    expect(step('s4', 'hypothesis', 'x', '--repro-last').status).toBe(0);
  });

  test('a failing run after a Bash source edit is refused and the edit is a recorded bypass', () => {
    hook(edit('s5', 'src/app.py'));
    fs.writeFileSync(path.join(repo, 'src', 'app.py'), 'def add(a, b):\n    return a + b\n');
    hook(ranOk('s5', 'python - <<EOF\nopen("src/app.py","w").write("x")\nEOF'));
    hook(ranFail('s5', 'pytest'));
    const r = step('s5', 'hypothesis', 'x', '--repro-last');
    expect(r.status).toBe(1);
    expect(r.out).toContain('ran after source changed');
    const files = fs.readdirSync(path.join(stateRoot, 'investigate'));
    const st = JSON.parse(fs.readFileSync(path.join(stateRoot, 'investigate', files[0], 's5.json'), 'utf8'));
    expect(st.investigations[0].bypasses[0].kind).toBe('bash-edit');
  });

  test('a masked exit qualifies by failure marker; background runs never do', () => {
    hook(edit('s6', 'src/app.py'));
    hook({ ...ranOk('s6', 'pytest & '), tool_input: { command: 'pytest &', run_in_background: true } });
    expect(step('s6', 'hypothesis', 'x', '--repro-last').status).toBe(1);
    hook(ranOk('s6', 'pytest 2>&1 | tail -5', '=== 1 failed, 3 passed ==='));
    expect(step('s6', 'hypothesis', 'x', '--repro-last').status).toBe(0);
  });

  test('--no-repro is logged and unlocks; report without binding is a bypass; open re-arms', () => {
    hook(edit('s7', 'src/app.py'));
    expect(step('s7', 'hypothesis', 'race in worker pool', '--no-repro', 'fails 1 in 200 runs').status).toBe(0);
    expect(hook(edit('s7', 'src/app.py')).out).toBeNull();
    expect(step('s7', 'report').out).toContain('no repro: fails 1 in 200 runs');
    expect(step('s7', 'open').status).toBe(0);
    expect(denied(hook(edit('s7', 'src/app.py')))).toBe(true);
    const rep = step('s7', 'report');
    expect(rep.out).toContain('recorded as bypass');
  });

  test('adds --session to helper calls and denies Bash writes to source', () => {
    const r = hook(preBash('s8', '~/.claude/skills/gstack/bin/gstack-investigate-step hypothesis "x" --repro-last'));
    expect(r.out.hookSpecificOutput.updatedInput.command).toBe('~/.claude/skills/gstack/bin/gstack-investigate-step --session s8 hypothesis "x" --repro-last');
    expect(r.out.hookSpecificOutput.updatedInput.description).toBe('x');
    expect(denied(hook(preBash('s8', "sed -i 's/-/+/' src/app.py")))).toBe(true);
    expect(hook(preBash('s8', 'echo note > notes.txt')).out).toBeNull();
    expect(hook(preBash('s8', 'pytest -x')).out).toBeNull();
  });

  test('sessions are isolated; malformed input and a missing state root fail open', () => {
    hook(edit('a', 'src/app.py'));
    hook(ranFail('a', 'pytest'));
    expect(step('a', 'hypothesis', 'x', '--repro-last').status).toBe(0);
    expect(denied(hook(edit('b', 'src/app.py')))).toBe(true);
    const bad = spawnSync(HOOK, [], { cwd: repo, env: env({ GSTACK_INVESTIGATE_GATES: '1' }), input: '{not json', encoding: 'utf8', timeout: 30_000 });
    expect(bad.status).toBe(0);
    expect(bad.stdout.trim()).toBe('');
    expect(fs.existsSync(stateRoot)).toBe(true);
  });

  test('the bin refuses without --session', () => {
    const r = spawnSync(BIN, ['check'], { cwd: repo, env: env(), encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(2);
  });
});

describe('command classification', () => {
  test('segments, masking and pairing', () => {
    expect(splitSegments('cd a && pytest -x | tail -3; echo $?')).toEqual(['cd a', 'pytest -x', 'tail -3', 'echo $?']);
    expect(exitMasked('pytest || true')).toBe(true);
    expect(exitMasked('set -o pipefail; pytest | tail')).toBe(false);
    expect(qualifiesAsFailingRun({ command: 'grep foo src', exit: 1, background: false, tail: '' })).toBe(false);
    expect(qualifiesAsPassingRun({ command: 'pytest | tail', exit: 0, background: false, tail: '3 passed' })).toBe(false);
    expect(pairsWithRepro('pytest tests/test_app.py::test_add', 'pytest tests/test_app.py')).toBe(true);
    expect(pairsWithRepro('pytest tests/test_app.py', 'npm run lint')).toBe(false);
    expect(bashSourceWrite('git apply fix.patch', () => false)).toBe('git apply');
    expect(bashSourceWrite('cp /tmp/x src/app.py', (f) => f === 'src/app.py')).toBe('cp onto src/app.py');
  });
});

describe('eval recorder and scorer', () => {
  function recordAll(session: string, payloads: object[], dir: string) {
    for (const p of payloads) spawnSync('bun', ['--no-env-file', '--config=/dev/null', RECORDER], { cwd: repo, env: env({ GSTACK_INVESTIGATE_RECORDER_DIR: dir }), input: JSON.stringify(p), encoding: 'utf8', timeout: 30_000 });
    return fs.readFileSync(path.join(dir, `${session}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RecorderLine);
  }

  test('scores fail-then-pass from worktree deltas, whatever tool wrote the source', () => {
    const dir = path.join(tmp, 'rec');
    const s = 'r1';
    const first = { session_id: s, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pytest tests/test_app.py' } };
    const lines = recordAll(s, [first, ranFail(s, 'pytest tests/test_app.py')], dir);
    fs.writeFileSync(path.join(repo, 'src', 'app.py'), 'def add(a, b):\n    return a + b\n');
    const more = recordAll(s, [ranOk(s, "perl -pi -e 's/-/+/' src/app.py", ''), ranOk(s, 'pytest tests/test_app.py', '1 passed')], dir);
    expect(more.length).toBe(3);
    expect(more[1].delta).toEqual(['src/app.py']);
    const row = scoreLines(s, more);
    expect(row).toMatchObject({ edited: true, repro: 'pytest tests/test_app.py', paired: true, follow: true, test_after: true });
    expect(lines[0].delta).toEqual([]);
  });

  test('a ritual failure or an unpaired pass is not a follow; no edit and no events are reported', () => {
    const L = (i: number, command: string, exit: number, delta: string[], tail = ''): RecorderLine => ({ i, ts: '', event: exit ? 'PostToolUseFailure' : 'PostToolUse', tool: 'Bash', tool_use_id: null, command, exit, background: false, tail, delta });
    expect(scoreLines('x', [L(0, 'false', 1, []), L(1, 'edit', 0, ['src/a.py']), L(2, 'pytest', 0, ['src/a.py'])]).follow).toBe(false);
    expect(scoreLines('x', [L(0, 'pytest t/a.py', 1, []), L(1, 'edit', 0, ['src/a.py']), L(2, 'npm run lint', 0, ['src/a.py'])]).follow).toBe(false);
    expect(scoreLines('x', [L(0, 'pytest', 1, [])]).edited).toBe(false);
    expect(scoreLines('x', []).unscorable).toBe(true);
  });
});

describe('arm settings', () => {
  test('every arm records; only H adds the gate, and the skill text is untouched', () => {
    const n = armSettings('N', 'rec');
    const h = armSettings('H', 'rec', '/g/investigate-gate');
    expect(armSettings('S', 'rec')).toEqual(n);
    expect(n.hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: 'rec' }] }]);
    expect(h.hooks.PreToolUse[1]).toEqual({ matcher: 'Edit|Write|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'GSTACK_INVESTIGATE_GATES=1 /g/investigate-gate' }] });
    expect(h.hooks.PostToolUseFailure.map((e) => e.matcher)).toEqual(['*', 'Bash']);
    expect(() => armSettings('H', 'rec')).toThrow();
    expect(fs.readFileSync(path.join(ROOT, 'investigate', 'SKILL.md.tmpl'), 'utf8')).not.toContain('investigate-gate');
  });
});
