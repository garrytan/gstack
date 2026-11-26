/**
 * #3415: gstack's shell bins start Bun with
 * --config="${GSTACK_BUN_CONFIG:-/dev/null}", and each defines
 * GSTACK_BUN_CONFIG as NUL when OSTYPE is msys or cygwin and cygpath is on PATH
 * (Git Bash, MSYS2, Cygwin). Native bun.exe cannot
 * open /dev/null (EINVAL), so a Windows bash with MSYS path conversion off
 * (MSYS_NO_PATHCONV=1, MSYS2_ARG_CONV_EXCL=*) made the literal spelling fail:
 * the record bins wrote nothing, and gstack-timeline-log still exited 0.
 *
 * On every platform the free lanes run, windows-latest included, the record
 * bins run through lib/script-invocation.ts with conversion off in a hostile
 * repository: each writes its record, and the repository's bunfig.toml preload
 * and .env never load. On POSIX a simulated Windows bash (OSTYPE=msys, a
 * cygpath, a bun that rejects /dev/null the way bun.exe does) reproduces the
 * bug; its controls, without OSTYPE=msys, show each bin fails loudly with
 * nothing written instead of exiting 0. An OSTYPE=msys inherited by a POSIX
 * bash with no cygpath keeps /dev/null, so a file named NUL in the repository
 * is never read as Bun's config.
 *
 * gstack-question-log starts a detached gstack-developer-profile --derive after
 * each write, and that process keeps writing into the state root after its
 * test returns, while the next test resets it (Trunk 4c32732f: a control then
 * saw the previous test's record). Every call here sets
 * GSTACK_QUESTION_LOG_NO_DERIVE, the bin's test opt-out, so no process outlives
 * the test that started it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScriptSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
const IS_WINDOWS = process.platform === 'win32';

let tmp = '';
let repo = '';
let stateRoot = '';
let evilRoot = '';
let preloadMarker = '';
let fakeBun = '';
let crashBun = '';

const BINS: Array<{ bin: string; input: string; log: string }> = [
  { bin: 'gstack-review-log', log: 'main-reviews.jsonl', input: JSON.stringify({ skill: 'plan-eng-review', timestamp: '2026-10-25T00:00:00Z', status: 'clean', unresolved: 0, critical_gaps: 0, issues_found: 0, mode: 'FULL_REVIEW', commit: 'abc1234' }) },
  { bin: 'gstack-question-log', log: 'question-log.jsonl', input: JSON.stringify({ skill: 'ship', question_id: 'ship-test-failure-triage', question_summary: 'Tests failed', options_count: 3, user_choice: 'fix-now', recommended: 'fix-now', session_id: 's1' }) },
  { bin: 'gstack-learnings-log', log: 'learnings.jsonl', input: JSON.stringify({ skill: 'review', type: 'pitfall', key: 'n-plus-one', insight: 'fixture insight', confidence: 8, source: 'observed' }) },
  { bin: 'gstack-timeline-log', log: 'timeline.jsonl', input: JSON.stringify({ skill: 'review', event: 'started', branch: 'main' }) },
];

function env(pathPrefix?: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GSTACK_|MSYS|OSTYPE$)/.test(k)) out[k] = v;
  const PATH = Object.keys(out).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  if (pathPrefix) out[PATH] = pathPrefix + path.delimiter + (out[PATH] ?? '');
  return { ...out, HOME: path.join(tmp, 'home'), GSTACK_STATE_ROOT: stateRoot, GSTACK_QUESTION_LOG_NO_DERIVE: '1', MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*', ...extra };
}

function run(bin: string, input: string, pathPrefix?: string, extra: Record<string, string> = {}, rest: string[] = []) {
  return runScriptSync(path.join(ROOT, 'bin', bin), [input, ...rest], { cwd: repo, env: env(pathPrefix, extra), encoding: 'utf8', timeout: 60_000 });
}

function records(log: string): string[] {
  const projects = path.join(stateRoot, 'projects');
  if (!fs.existsSync(projects)) return [];
  return fs.readdirSync(projects).flatMap(slug => {
    const file = path.join(projects, slug, log);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  });
}

function resetState(): void {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  fs.rmSync(preloadMarker, { force: true });
  fs.mkdirSync(stateRoot, { recursive: true });
}

function writeExec(file: string, text: string): void {
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bunconfig-')));
  repo = path.join(tmp, 'repo');
  stateRoot = path.join(tmp, 'state');
  evilRoot = path.join(tmp, 'evil');
  preloadMarker = path.join(tmp, 'preload-ran');
  for (const d of [repo, stateRoot, path.join(tmp, 'home')]) fs.mkdirSync(d, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
    expect(spawnSync('git', args, { cwd: repo, timeout: 30_000 }).status).toBe(0);
  }
  fs.writeFileSync(path.join(repo, '.env'), `GSTACK_STATE_ROOT=${evilRoot}\nGSTACK_HOME=${evilRoot}\n`);
  fs.writeFileSync(path.join(repo, 'preload.ts'), `require('fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran');\n`);
  fs.writeFileSync(path.join(repo, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
  if (IS_WINDOWS) return;
  fakeBun = path.join(tmp, 'fake-bun');
  fs.mkdirSync(fakeBun);
  writeExec(path.join(fakeBun, 'bun'), [
    '#!/usr/bin/env bash',
    'a=()',
    'for x in "$@"; do',
    '  case "$x" in',
    '    --config=/dev/null) echo "EINVAL: Invalid argument (open())" >&2; echo "while reading config \\"/dev/null\\"" >&2; exit 1 ;;',
    '    --config=NUL) a+=(--config=/dev/null) ;;',
    '    *) a+=("$x") ;;',
    '  esac',
    'done',
    `exec ${JSON.stringify(process.execPath)} "\${a[@]}"`,
    '',
  ].join('\n'));
  crashBun = path.join(tmp, 'crash-bun');
  fs.mkdirSync(crashBun);
  writeExec(path.join(crashBun, 'bun'), '#!/usr/bin/env bash\nexit 3\n');
  writeExec(path.join(fakeBun, 'cygpath'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "${@: -1}"\n');
});

afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe('#3415: record bins start Bun on a Windows bash with path conversion off', () => {
  test('fixture control: a plain bun in the repository runs its bunfig preload', () => {
    const r = spawnSync(process.execPath, ['-e', '0'], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(fs.existsSync(preloadMarker)).toBe(true);
    fs.rmSync(preloadMarker);
  });

  for (const { bin, input, log } of BINS) {
    test(`${bin} writes its record and ignores the repository bunfig.toml and .env`, () => {
      resetState();
      const r = run(bin, input);
      expect(r.stderr).not.toContain('EINVAL');
      expect(r.status).toBe(0);
      expect(records(log).length).toBe(1);
      expect(fs.existsSync(preloadMarker)).toBe(false);
      expect(fs.existsSync(evilRoot)).toBe(false);
    });
  }

  test('gstack-timeline-log still skips invalid input silently with exit 0', () => {
    resetState();
    for (const bad of ['not json', '{"skill":"review"}', 'null']) {
      const r = run('gstack-timeline-log', bad);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    }
    expect(records('timeline.jsonl')).toEqual([]);
  });
});

describe.skipIf(IS_WINDOWS)('#3415: simulated Windows bash (POSIX hosts)', () => {
  test('gstack-developer-profile --log-session reports a Bun failure instead of skipping it, and still skips invalid input silently', () => {
    resetState();
    const session = JSON.stringify({ date: '2026-10-25', mode: 'startup' });
    const failed = run('gstack-developer-profile', '--log-session', fakeBun, {}, [session]);
    expect(failed.stderr).toContain('EINVAL');
    expect(failed.stderr).toContain('nothing was logged');
    expect(failed.status).not.toBe(0);
    for (const bad of ['not json', '{"date":"2026-10-25"}', 'null']) {
      const r = run('gstack-developer-profile', '--log-session', undefined, {}, [bad]);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    }
  });

  test('a Bun that dies with exit 3 (how a Bun crash exits on Windows) is reported, never read as invalid input', () => {
    resetState();
    const timeline = run('gstack-timeline-log', JSON.stringify({ skill: 'review', event: 'started' }), crashBun);
    expect(timeline.status).not.toBe(0);
    expect(timeline.stderr).toContain('bun exited 3');
    expect(records('timeline.jsonl')).toEqual([]);
    const profile = run('gstack-developer-profile', '--log-session', crashBun, {}, [JSON.stringify({ date: '2026-10-25', mode: 'startup' })]);
    expect(profile.status).not.toBe(0);
    expect(profile.stderr).toContain('bun exited 3');
  });

  for (const { bin, input, log } of BINS) {
    test(`${bin} passes NUL and writes its record`, () => {
      resetState();
      const r = run(bin, input, fakeBun, { OSTYPE: 'msys' });
      expect(r.stderr).not.toContain('EINVAL');
      expect(r.status).toBe(0);
      expect(records(log).length).toBe(1);
      expect(fs.existsSync(preloadMarker)).toBe(false);
    });

    test(`an inherited OSTYPE=msys without cygpath keeps /dev/null: ${bin} never reads a repository file named NUL`, () => {
      resetState();
      const nul = path.join(repo, 'NUL');
      fs.writeFileSync(nul, 'preload = ["./preload.ts"]\n');
      try {
        const r = run(bin, input, undefined, { OSTYPE: 'msys' });
        expect(r.status).toBe(0);
        expect(records(log).length).toBe(1);
        expect(fs.existsSync(preloadMarker)).toBe(false);
      } finally {
        fs.rmSync(nul, { force: true });
        fs.rmSync(preloadMarker, { force: true });
      }
    });

    test(`control: when Bun rejects the config, ${bin} fails loudly and writes nothing`, () => {
      resetState();
      const r = run(bin, input, fakeBun);
      expect(r.stderr).toContain('EINVAL');
      expect(r.status).not.toBe(0);
      expect(records(log)).toEqual([]);
    });
  }
});
