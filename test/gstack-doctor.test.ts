/**
 * gstack-doctor: one row per readiness check, each ok / warn / not configured
 * / fail with a fix line when not ok; only fail makes the exit non-zero; fix
 * lines name helpers by absolute install-root path; the paid Codex model probe
 * runs only with --live. Also pins the `./setup --status` Codex row and its
 * trailing doctor path. Every run uses a fixture install root (copies of the
 * real helpers plus a stub gstack-codex-probe), a fixture state root, stub
 * bun/codex/claude on PATH and an explicit HOME. Scripts run through explicit
 * bash argv, so the file is in the curated Windows lane.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// setup builds browse/dist/browse.exe on Windows (Git Bash), browse/dist/browse elsewhere.
const BROWSE_BIN = process.platform === 'win32' ? 'browse/dist/browse.exe' : 'browse/dist/browse';
const EXE = process.platform === 'win32' ? '.exe' : '';
const OTHER_BINS = ['browse/dist/find-browse', 'design/dist/design', 'make-pdf/dist/pdf', 'bin/gstack-global-discover'].map(rel => rel + EXE);

const REPO = path.resolve(import.meta.dir, '..');
const COPIED = [
  'setup', 'VERSION',
  'bin/gstack-doctor', 'bin/gstack-codex-status.sh', 'bin/gstack-state-root.sh', 'bin/gstack-install-registry.sh',
  'bin/gstack-render-claude.sh', 'bin/gstack-bun-version.sh', 'bin/gstack-hook-check', 'bin/gstack-config',
  'autoplan/SKILL.md', // its frontmatter registers the autoplan hook the hooks-row test breaks
  'bin/gstack-launch-probe.sh',
  'bin/gstack-doctor-check.sh', 'bin/gstack-doctor-components.sh', 'bin/gstack-runtime-pins.ts', 'lib/runtime-pins.ts',
  'bin/gstack-windows-bash.ts', 'lib/script-invocation.ts', 'lib/bun-isolation.ts', 'lib/result-codes.ts', 'lib/result-codes-release.ts', 'lib/result-codes-capy.ts', 'lib/result-codes-budget.ts', // the windows bash row
];
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};
const script = (file: string, lines: string[]) => write(file, ['#!/usr/bin/env bash', ...lines].join('\n') + '\n', 0o755);

/** The fixture's PATH entries minus every directory holding a real bun, codex or claude. */
function hostPath(base: string): string {
  const names = ['bun', 'codex', 'claude'];
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.ps1'] : [''];
  return (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean).map((dir, i) => {
    if (!names.some(n => exts.some(e => fs.existsSync(path.join(dir, n + e))))) return dir;
    const shim = path.join(base, `host-${i}`);
    fs.mkdirSync(shim, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (names.some(n => exts.some(e => name === n + e))) continue;
      try { fs.symlinkSync(path.join(dir, name), path.join(shim, name)); } catch { /* unreadable entry */ }
    }
    return shim;
  }).join(path.delimiter);
}

interface Fixture { base: string; root: string; state: string; home: string; work: string; stub: string; probeLog: string; env: Record<string, string> }

function makeFixture(): Fixture {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-doctor-')));
  bases.push(base);
  const root = path.join(base, 'gstack');
  const state = path.join(base, 'state');
  const home = path.join(base, 'home');
  const work = path.join(base, 'work');
  const stub = path.join(base, 'stub');
  const probeLog = path.join(base, 'probe-calls');
  for (const dir of [state, home, work, stub]) fs.mkdirSync(dir, { recursive: true });
  for (const rel of COPIED) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    fs.chmodSync(path.join(root, rel), fs.statSync(path.join(REPO, rel)).mode);
  }
  script(path.join(root, 'bin/gstack-codex-probe'), [
    'echo "$*" >> "$DOCTOR_PROBE_LOG"',
    'case "$1" in',
    '  select-model) [ "${STUB_SELECT_FAIL:-}" = 1 ] && { echo "gstack-codex-probe: cannot find its scripts dir" >&2; exit 1; }',
    '    echo "CODEX_SEL: gpt-stub-5"; echo "CODEX_SEL_KIND: $2"; echo "CODEX_MODEL: gpt-stub-5 ($2; source: codex config.toml)" >&2 ;;',
    '  check-auth) [ "${STUB_AUTH_FAIL:-}" = 1 ] && { echo AUTH_FAILED; exit 1; }; echo AUTH_OK ;;',
    '  show-sandbox) echo "CODEX_SANDBOX: read-only" ;;',
    '  check-sandbox|check-version) ;;',
    '  probe-model) echo "CODEX_PROBE_STATE: ${STUB_PROBE_STATE:-ok}"; exit "${STUB_PROBE_EXIT:-0}" ;;',
    '  *) exit 64 ;;',
    'esac',
  ]);
  const listed = spawnSync('bash', [path.join(root, 'bin/gstack-hook-check'), '--list', root], { encoding: 'utf8', timeout: 20_000 });
  const hooks = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (!hooks.includes('autoplan/bin/phase-publication-hook')) throw new Error(`gstack-hook-check --list missed the autoplan hook: ${listed.stdout}${listed.stderr}`);
  for (const hook of hooks) write(path.join(root, hook), '#!/bin/sh\nexit 0\n', 0o755);
  // The doctor launches each compiled binary's --version (#2595), so the
  // stand-ins answer it like the real binaries do.
  for (const rel of [BROWSE_BIN, ...OTHER_BINS]) write(path.join(root, rel), '#!/bin/sh\necho built\n', 0o755);
  for (const rel of ['browse/dist/server-node.mjs', 'browse/dist/.build-complete']) write(path.join(root, rel), 'built\n', 0o755);
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  write(path.join(state, 'installs.tsv'),
    ['claude', 'global', '-', path.join(home, '.claude/skills'), root, root, version, 'false', 'committed', '2026-10-07T00:00:00Z'].join('\t') + '\n');
  // The stub answers --version; anything else (the pins row runs bin/gstack-runtime-pins.ts) goes to the real bun.
  script(path.join(stub, 'bun'), ['[ "$1" = --version ] && { echo "${STUB_BUN_VERSION:-1.4.2}"; exit 0; }', `exec "${process.execPath}" "$@"`]);
  script(path.join(stub, 'codex'), ['[ "$1" = --version ] && { echo "codex-cli 0.130.0"; exit 0; }', 'echo "unexpected codex call: $*" >> "$DOCTOR_PROBE_LOG"', 'exit 9']);
  script(path.join(stub, 'claude'), ['[ "$1" = --version ] && { echo "2.1.292 (Claude Code)"; exit 0; }', 'exit 9']);
  const env: Record<string, string> = {
    PATH: [stub, hostPath(base)].join(path.delimiter),
    HOME: home, GSTACK_STATE_ROOT: state, TMPDIR: base, DOCTOR_PROBE_LOG: probeLog,
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return { base, root, state, home, work, stub, probeLog, env };
}

function doctor(f: Fixture, args: string[] = [], extra: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(f.root, 'bin/gstack-doctor'), ...args], { cwd: f.work, encoding: 'utf8', env: { ...f.env, ...extra }, timeout: 60_000 });
  const out = `${r.stdout}${r.stderr}`;
  return { status: r.status, out, row: (name: string) => rowOf(r.stdout, name) };
}

/** The named row and its fix line: { state, detail, fix }. */
function rowOf(stdout: string, name: string) {
  const lines = stdout.split('\n');
  const i = lines.findIndex(l => l.slice(16, 32).trim() === name);
  if (i < 0) throw new Error(`no row "${name}" in:\n${stdout}`);
  const fix = lines[i + 1]?.startsWith(' '.repeat(32) + 'fix: ') ? lines[i + 1].slice(37) : '';
  return { state: lines[i].slice(0, 16).trim(), detail: lines[i].slice(32), fix };
}

/** How bash spells a directory (Git Bash on Windows prints /c/...). */
const bashPath = (dir: string) => spawnSync('bash', ['-c', 'cd "$1" && pwd', '_', dir], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
const probeCalls = (f: Fixture) => fs.existsSync(f.probeLog) ? fs.readFileSync(f.probeLog, 'utf8') : '';
const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const syncOn = (f: Fixture, status: Record<string, unknown>) => {
  fs.mkdirSync(path.join(f.state, '.git'), { recursive: true });
  write(path.join(f.state, 'config.yaml'), 'artifacts_sync_mode: artifacts-only\n');
  write(path.join(f.state, '.brain-sync-status.json'), JSON.stringify(status).replace(/":/g, '": ').replace(/,"/g, ', "') + '\n');
};

describe('gstack-doctor', () => {
  test('a healthy fixture: every core row ok, exit 0, and no paid probe', () => {
    const f = makeFixture();
    const r = doctor(f);
    expect(r.status, r.out).toBe(0);
    for (const name of ['install root', 'state root', 'bun', 'hooks', 'browse bundle']) expect(r.row(name).state, `${name}\n${r.out}`).toBe('ok');
    expect(r.row('install root').detail).toContain('claude global current');
    expect(r.row('state root').detail).toContain('GSTACK_STATE_ROOT');
    expect(r.row('bun').detail).toContain('1.4.2');
    expect(r.row('codex').state).toBe('ok');
    expect(r.row('codex').detail).toContain('gpt-stub-5 (source: codex config.toml)');
    expect(r.row('codex probe').state).toBe('warn');
    expect(r.row('codex probe').detail).toContain('not probed');
    expect(r.row('codex probe').fix).toBe(`${bashPath(f.root)}/bin/gstack-doctor --live (one short paid Codex call)`);
    expect(r.row('artifacts sync').state).toBe('not configured');
    expect(r.row('claude code').detail).toContain('2.1.292');
    expect(r.row('guard log').detail).toBe('no guard decisions logged');
    expect(probeCalls(f)).not.toContain('probe-model');
    expect(probeCalls(f)).toContain('select-model exec');
    expect(r.out).toMatch(/\d+ ok, \d+ warn, \d+ not configured, 0 fail/);
  });

  test('each DX-8 state appears, and only fail makes the exit non-zero', () => {
    const f = makeFixture();
    const warn = doctor(f, [], { STUB_BUN_VERSION: '1.4.0' });
    expect(warn.row('bun').state).toBe('warn');
    expect(warn.row('bun').fix).toContain('bun upgrade');
    expect(warn.status, warn.out).toBe(0);

    write(path.join(f.state, 'config.yaml'), 'codex_reviews: disabled\n');
    const off = doctor(f);
    expect(off.row('codex').state).toBe('not configured');
    expect(off.row('codex').detail).toContain('outside reviews in /review, /ship, /autoplan and /codex');
    expect(off.row('codex').fix).toBe(`${bashPath(f.root)}/bin/gstack-config set codex_reviews enabled`);
    expect(off.status, off.out).toBe(0);
    expect(probeCalls(f)).not.toContain('probe-model');

    const fail = doctor(f, [], { STUB_BUN_VERSION: '1.3.2' });
    expect(fail.row('bun').state).toBe('fail');
    expect(fail.row('bun').fix).toContain('bun upgrade');
    expect(fail.status, fail.out).toBe(1);
    expect(fail.out).toMatch(/, 1 fail/);
  });

  test('Codex: absent CLI is not configured, unauthenticated warns, a failed self-locate fails', () => {
    const f = makeFixture();
    fs.rmSync(path.join(f.stub, 'codex'));
    const absent = doctor(f);
    expect(absent.row('codex').state).toBe('not configured');
    expect(absent.row('codex').detail).toContain('Codex CLI not installed');
    expect(absent.row('codex').fix).toContain('npm install -g @openai/codex');
    expect(absent.status).toBe(0);

    const g = makeFixture();
    const unauthed = doctor(g, [], { STUB_AUTH_FAIL: '1' });
    expect(unauthed.row('codex').state).toBe('warn');
    expect(unauthed.row('codex').detail).toContain('not_authed');
    expect(unauthed.row('codex').fix).toContain('codex login');
    expect(unauthed.status).toBe(0);

    const broken = doctor(g, [], { STUB_SELECT_FAIL: '1' });
    expect(broken.row('codex').state).toBe('fail');
    expect(broken.row('codex').detail).toContain('helper_unavailable');
    expect(broken.row('codex').fix).toContain(`${bashPath(g.root)}/bin/gstack-codex-probe select-model exec`);
    expect(broken.status).toBe(1);
  });

  test('the cached probe is reported with its age and is never re-run without --live', () => {
    const f = makeFixture();
    const now = Math.floor(Date.now() / 1000);
    write(path.join(f.state, '.codex-model-probe'), `MODEL_OK ${now - 7300} 123456789\n`);
    const cached = doctor(f);
    expect(cached.row('codex probe').state).toBe('ok');
    expect(cached.row('codex probe').detail).toBe('cached MODEL_OK, 2h ago (not re-run; --live probes now)');
    write(path.join(f.state, '.codex-model-probe'), `MODEL_QUOTA_EXHAUSTED ${now - 125} 123456789\nCodex says: try again at 5pm sk-should-not-print\n`);
    const quota = doctor(f);
    expect(quota.row('codex probe').state).toBe('warn');
    expect(quota.row('codex probe').detail).toContain('cached MODEL_QUOTA_EXHAUSTED, 2m ago');
    expect(quota.out).not.toContain('sk-should-not-print');
    write(path.join(f.state, '.codex-model-probe'), `$(rm -rf ~) ${now} x\n`);
    expect(doctor(f).row('codex probe').detail).toContain('unrecognized');
    expect(probeCalls(f)).not.toContain('probe-model');
  });

  test('--live runs probe-model once and maps its exit to the codex probe row', () => {
    const f = makeFixture();
    const live = doctor(f, ['--live']);
    expect(probeCalls(f).match(/probe-model exec/g)?.length).toBe(1);
    expect(live.row('codex probe').state).toBe('ok');
    expect(live.row('codex probe').detail).toContain('live probe: ok');
    const unusable = doctor(f, ['--live'], { STUB_PROBE_EXIT: '1', STUB_PROBE_STATE: 'model_unusable' });
    expect(unusable.row('codex probe').state).toBe('warn');
    expect(unusable.row('codex probe').detail).toContain('model_unusable');
    const brokenInstall = doctor(f, ['--live'], { STUB_PROBE_EXIT: '2', STUB_PROBE_STATE: 'broken_install' });
    expect(brokenInstall.row('codex probe').state).toBe('fail');
    expect(brokenInstall.status).toBe(1);
  });

  test('a hook shim that does not parse fails the hooks row', () => {
    const f = makeFixture();
    write(path.join(f.root, 'autoplan/bin/phase-publication-hook'), '#!/bin/sh\nif then\n', 0o755);
    const r = doctor(f);
    expect(r.row('hooks').state).toBe('fail');
    expect(r.row('hooks').detail).toContain('autoplan/bin/phase-publication-hook');
    expect(r.row('hooks').fix).toContain('./setup');
    expect(r.status).toBe(1);
  });

  test('artifacts sync: a hostile status clamps to unknown and is never echoed', () => {
    const f = makeFixture();
    syncOn(f, { status: 'AKIAIOSFODNN7EXAMPLE leaked', message: 'blocked: AKIAIOSFODNN7EXAMPLE in /secret/path.md', ts: iso(10) });
    const r = doctor(f);
    expect(r.row('artifacts sync').state).toBe('warn');
    expect(r.row('artifacts sync').detail).toBe('status unknown');
    expect(r.row('artifacts sync').fix).toBe(`${bashPath(f.root)}/bin/gstack-brain-sync --status`);
    expect(r.out).not.toContain('AKIA');
    expect(r.out).not.toContain('/secret/path.md');
    expect(r.out).not.toContain('.brain-sync-status.json');
  });

  test('artifacts sync: held, then ok', () => {
    const f = makeFixture();
    syncOn(f, { status: 'held', message: 'held 2 file(s): sk-ant-secret', held_count: 2, held: [{ path: 'projects/p/notes.md', rule: 'anthropic_key', dependents: [], fixes: ['edit', 'skip'] }, { path: 'projects/p/b.md', rule: 'anthropic_key', dependents: [], fixes: ['edit', 'skip'] }], drainable: 0, last_drain_at: iso(60), last_push_at: iso(60) });
    const held = doctor(f);
    expect(held.row('artifacts sync').state).toBe('warn');
    expect(held.row('artifacts sync').detail).toBe('status held (2 file(s) held by the secret scanner)');
    expect(held.out).not.toContain('sk-ant');

    syncOn(f, { status: 'ok', message: 'pushed 3 file(s)', drainable: 0, last_drain_at: iso(60), last_push_at: iso(60) });
    expect(doctor(f).row('artifacts sync').state).toBe('ok');
  });

  test('artifacts sync: case-colliding paths warn with the clamped names, held or not', () => {
    const f = makeFixture();
    syncOn(f, { status: 'collision', message: 'held projects/myapp/x.md', case_held: 1, case_names: 'MyApp,myapp', drainable: 0, last_drain_at: iso(60), last_push_at: iso(60) });
    const held = doctor(f);
    expect(held.row('artifacts sync').state).toBe('warn');
    expect(held.row('artifacts sync').detail).toBe('status collision; artifact paths differ only by letter case (MyApp,myapp), see docs/troubleshooting.md#artifact-case-collision');
    expect(held.out).not.toContain('projects/myapp');

    syncOn(f, { status: 'ok', message: 'pushed 1 file(s)', case_held: 0, case_names: 'OLD,old', drainable: 0, last_drain_at: iso(60), last_push_at: iso(60) });
    expect(doctor(f).row('artifacts sync').state).toBe('warn');
    syncOn(f, { status: 'ok', message: 'pushed 1 file(s)', case_held: 0, case_names: '', drainable: 0, last_drain_at: iso(60), last_push_at: iso(60) });
    expect(doctor(f).row('artifacts sync').state).toBe('ok');
  });

  test('artifacts sync: stale push and stale drain warn, a fresh push clears them', () => {
    const f = makeFixture();
    syncOn(f, { status: 'ok', message: 'x', drainable: 4, last_drain_at: iso(60), last_push_at: iso(90_000) });
    const stalePush = doctor(f).row('artifacts sync');
    expect(stalePush.state).toBe('warn');
    expect(stalePush.detail).toContain('no push for 24h while 4 record(s) wait');

    write(path.join(f.state, '.brain-queue.d/1-1-a.json'), '{}\n');
    syncOn(f, { status: 'idle', message: 'x', drainable: 0, last_drain_at: iso(200_000), last_push_at: iso(60) });
    const staleDrain = doctor(f).row('artifacts sync');
    expect(staleDrain.state).toBe('warn');
    expect(staleDrain.detail).toContain('no drain for 24h while 1 record(s) are queued');

    syncOn(f, { status: 'ok', message: 'pushed' });
    expect(doctor(f).row('artifacts sync').state).toBe('ok');
  });

  test('triage rows: Claude Code absent, largest journal, last five schema-1 guard codes', () => {
    const f = makeFixture();
    fs.rmSync(path.join(f.stub, 'claude'));
    expect(doctor(f).row('claude code').state).toBe('not configured');
    expect(doctor(f).row('session journal').detail).toBe('no session journals for this project');

    const cwd = process.platform === 'win32'
      ? spawnSync('bash', ['-c', 'pwd -W'], { cwd: f.work, encoding: 'utf8', timeout: 10_000 }).stdout.trim()
      : f.work;
    const project = path.join(f.home, '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    write(path.join(project, 'a.jsonl'), 'x'.repeat(1000));
    write(path.join(project, 'b.jsonl'), 'x'.repeat(3 * 1024 * 1024));
    const journal = doctor(f).row('session journal');
    expect(journal.state).toBe('ok');
    expect(journal.detail).toBe('largest of 2: 3.0 MiB');

    const line = (schema: unknown, code: string | null, decision = 'deny') =>
      JSON.stringify({ schema, ts: '2026-10-07T00:00:00Z', decision, ...(code ? { reason_code: code } : {}), path: 'journal', cc_version: '2.1.292', disposition: 'hard' });
    write(path.join(f.state, 'analytics/autoplan-guard.jsonl'), [
      line(1, 'code_one'), line(2, 'future_schema'), line(1, 'code_two'), line(1, null, 'allow'), 'not json',
      line(1, 'code_three'), line(1, 'code_four'), line('1', 'string_schema'), line(1, 'code_five'), line(1, 'code_six'),
    ].join('\n') + '\n');
    const guard = doctor(f).row('guard log');
    expect(guard.state).toBe('ok');
    expect(guard.detail).toBe('7 decisions (6 denied); last codes: code_two, code_three, code_four, code_five, code_six');
  });

  test('every fix line names gstack helpers by absolute install-root path', () => {
    const f = makeFixture();
    write(path.join(f.state, 'config.yaml'), 'codex_reviews: disabled\n');
    fs.rmSync(path.join(f.root, BROWSE_BIN));
    const other = path.join(f.base, 'other');
    write(path.join(f.state, 'installs.tsv'), ['codex', 'global', '-', path.join(f.home, '.codex/skills'), other, other, '1', 'false', 'committed', 'x'].join('\t') + '\n');
    const r = doctor(f, [], { STUB_BUN_VERSION: '1.3.2' });
    const fixes = r.out.split('\n').filter(l => l.trimStart().startsWith('fix: '));
    expect(fixes.length).toBeGreaterThanOrEqual(5);
    expect(r.row('install root').fix).toContain(`${other}/bin/gstack-doctor`);
    const bin = `${bashPath(f.root)}/bin/`;
    for (const fix of fixes) {
      const scrubbed = fix.split(bin).join('<BIN>/').split(`${other}/bin/`).join('<OTHER>/').split(bashPath(f.base)).join('<BASE>');
      for (const m of scrubbed.matchAll(/gstack-[a-z]/g)) expect(/<(BIN|OTHER)>\/$/.test(scrubbed.slice(0, m.index)), fix).toBe(true);
    }
    expect(r.row('browse bundle').state).toBe('warn');
    expect(r.row('browse bundle').detail).toContain('/browse, /qa, /qa-only, /design-review, /make-pdf, /pair-agent');
  });

  test('usage errors exit 2', () => {
    const f = makeFixture();
    expect(doctor(f, ['--bogus']).status).toBe(2);
    const help = doctor(f, ['--help']);
    expect(help.status).toBe(0);
    expect(help.out).toContain('--live');
  });
});

describe('./setup --status Codex row', () => {
  const status = (f: Fixture) => spawnSync('bash', [path.join(f.root, 'setup'), '--status'], { cwd: f.work, encoding: 'utf8', env: f.env, timeout: 60_000 });

  test('reports install, version, codex_reviews and the cached probe, then ends with the doctor path', () => {
    const f = makeFixture();
    write(path.join(f.state, '.codex-model-probe'), `MODEL_UNUSABLE ${Math.floor(Date.now() / 1000) - 600} 1\n`);
    const r = status(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Codex: installed (codex-cli 0.130.0); codex_reviews=enabled; model probe: MODEL_UNUSABLE 10m ago');
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(`Readiness check: ${bashPath(f.root)}/bin/gstack-doctor`);
    expect(probeCalls(f)).toBe('');
  });

  test('without Codex the row says so, and nothing is written', () => {
    const f = makeFixture();
    fs.rmSync(path.join(f.stub, 'codex'));
    write(path.join(f.state, 'config.yaml'), 'codex_reviews: disabled\n');
    const before = fs.readdirSync(f.state).sort();
    const r = status(f);
    expect(r.stdout).toContain('Codex: not installed (codex_reviews=disabled;');
    expect(fs.readdirSync(f.state).sort()).toEqual(before);
  });
});

describe('bug-report template and README (DX-2, DX-12)', () => {
  const template = fs.readFileSync(path.join(REPO, '.github/ISSUE_TEMPLATE/bug_report.md'), 'utf8');

  test('the template asks for the doctor output with the Claude Code path and a lookup for other hosts', () => {
    expect(template).toContain('~/.claude/skills/gstack/bin/gstack-doctor');
    expect(template).toContain('./setup --status');
    expect(template).toContain('/bin/gstack-paths --get GSTACK_STATE_ROOT');
  });

  test('the template names no bare gstack- command', () => {
    for (const m of template.matchAll(/gstack-[a-z]/g)) expect(template.slice(0, m.index).endsWith('/bin/'), template.slice(m.index! - 40, m.index! + 20)).toBe(true);
  });

  test('README troubleshooting points at the doctor by absolute path', () => {
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Troubleshooting'));
    expect(section).toContain('`~/.claude/skills/gstack/bin/gstack-doctor`');
  });
});

// #2595/#2124 and #3071: compiled binaries by launch state, and CSO from the
// build-result record. A blocked binary is simulated by the application-control
// message reporters captured (#2595), which works on every OS.
describe('gstack-doctor launch and CSO rows', () => {
  const BLOCKED = `#!/bin/sh\necho "Program 'x.exe' failed to run: An Application Control policy has blocked this file" >&2\nexit 1\n`;
  const record = (f: Fixture, text: string) => write(path.join(f.root, 'bin/.gstack-cso-build-result'), text);
  const cso = (f: Fixture) => { for (const name of ['gstack-cso-launcher', 'gstack-cso-core']) write(path.join(f.root, 'bin', name + EXE), '#!/bin/sh\necho cso\n', 0o755); };

  test('healthy binaries are ok; a blocked browse says blocked, not "not built"', () => {
    const f = makeFixture();
    let r = doctor(f);
    expect(r.row('binaries').state).toBe('ok');
    expect(r.row('binaries').detail).toContain('(4 of 4)');
    write(path.join(f.root, BROWSE_BIN), BLOCKED, 0o755);
    r = doctor(f);
    expect(r.row('browse bundle').state).toBe('warn');
    expect(r.row('browse bundle').detail).toContain('built, but blocked at launch (Program');
    expect(r.row('browse bundle').detail).not.toContain('not built');
    expect(r.row('browse bundle').fix).toContain(process.platform === 'win32' ? 'Smart App Control' : 'the OS refused to execute it');
    expect(r.status).toBe(0);
  });

  test('blocked, broken and missing binaries are told apart', () => {
    const f = makeFixture();
    write(path.join(f.root, OTHER_BINS[1]), BLOCKED, 0o755);
    let r = doctor(f);
    expect(r.row('binaries').detail).toContain('blocked at launch: design');
    expect(r.row('binaries').detail).toContain('unavailable: /design-consultation');
    write(path.join(f.root, OTHER_BINS[1]), '#!/bin/sh\necho ok\n', 0o755);
    write(path.join(f.root, OTHER_BINS[2]), '#!/bin/sh\necho "usage" >&2\nexit 2\n', 0o755);
    r = doctor(f);
    expect(r.row('binaries').detail).toBe('launched but failed: pdf (exit 2: usage)');
    expect(r.row('binaries').fix).toBe(`cd ${bashPath(f.root)} && bun run build`);
    fs.rmSync(path.join(f.root, OTHER_BINS[2]));
    r = doctor(f);
    expect(r.row('binaries').detail).toBe('not built: pdf');
  });

  test('the CSO row reads the build-result record', () => {
    const f = makeFixture();
    const none = doctor(f).row('cso');
    expect(none.state).toBe('not configured');
    expect(none.detail).toBe('native helper not built; /cso reports not assessed');
    expect(none.fix).toContain('./setup (it names any missing build prerequisite)');
    record(f, 'result=failed\nstage=build\nreason=exit 42\nrevision=1.2 (abc)\ninstalled=\nlauncher=no\ndiagnostic=/x/cso.log\n');
    let r = doctor(f);
    expect(r.row('cso').state).toBe('warn');
    expect(r.row('cso').detail).toBe('unavailable: the build step failed (exit 42); /cso reports not assessed');
    expect(r.row('cso').fix).toContain('bun run build:cso && ./setup (log: /x/cso.log;');
    cso(f);
    record(f, 'result=failed\nstage=publish\nreason=exit 1\nrevision=1.2 (abc)\ninstalled=1.1 (def)\nlauncher=yes\ndiagnostic=/x/cso.log\n');
    expect(doctor(f).row('cso').detail).toBe('publish step failed (exit 1) for 1.2 (abc); previous CSO kept: 1.1 (def)');
    record(f, 'result=ok\nstage=publish\nreason=committed\nrevision=1.2 (abc)\ninstalled=1.2 (abc)\nlauncher=yes\ndiagnostic=x\n');
    r = doctor(f);
    expect(r.row('cso')).toEqual({ state: 'ok', detail: 'native helper 1.2 (abc)', fix: '' });
    expect(r.status).toBe(0);
  });
});

// A1: `--check` is the one-line verdict a parent agent greps. Rows are
// `PASS | FAIL | SKIP <id>` from lib/doctor-components.ts; the trailer is
// `gstack: ok <revision> for=<what>` (exit 0) or `gstack: fail <ids>` (exit 1).
// Pinned on tokens, ids, exit codes and the JSON shape, not prose.
describe('gstack-doctor --check', () => {
  const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
  const row = (f: Fixture, args: string[], extra: Record<string, string> = {}) => {
    const r = doctor(f, ['--check', ...args], extra);
    const lines = r.out.split('\n');
    const rows = Object.fromEntries(lines.filter(l => /^(PASS|FAIL|SKIP|WARN) /.test(l)).map(l => {
      const m = l.match(/^(PASS|FAIL|SKIP|WARN) ([a-z-]+)(?:\s(.*))?$/)!;
      return [m[2], { status: m[1], rest: m[3] ?? '' }];
    }));
    const trailer = lines.filter(l => l.startsWith('gstack: ')).at(-1) ?? '';
    const required = lines.find(l => l.startsWith('required: '))?.slice(10).split(' ') ?? [];
    return { status: r.status, out: r.out, rows, trailer, required, trailers: lines.filter(l => l.startsWith('gstack: ')).length };
  };
  /** Register a Codex install from this checkout and render a review skill, with or without the Astra patch. */
  const installCodex = (f: Fixture, patch = true) => {
    const dest = path.join(f.home, '.codex/skills');
    fs.appendFileSync(path.join(f.state, 'installs.tsv'),
      ['codex', 'global', '-', dest, path.join(dest, 'gstack'), f.root, VERSION, 'true', 'committed', '2026-10-07T00:00:00Z'].join('\t') + '\n');
    fs.mkdirSync(path.join(dest, 'gstack'), { recursive: true });
    write(path.join(dest, 'gstack-review/SKILL.md'), `---\nname: gstack-review\n---\n# Review\n${patch ? '\n## Model-Specific Behavioral Patch (gpt-6-astra)\n' : ''}`);
    return dest;
  };
  const installPlaywrightStub = (f: Fixture, launches: boolean) => write(path.join(f.root, 'node_modules/playwright/index.js'),
    launches
      ? 'module.exports.chromium = { launch: async () => ({ version: () => "141.0.1", close: async () => {}, newPage: async () => ({ setContent: async () => {}, title: async () => "gstack smoke test" }) }) };'
      : 'module.exports.chromium = { launch: async () => { throw new Error("browserType.launch: Executable doesn\'t exist"); } };');

  test('healthy Claude + Codex installs: every required row PASS, exactly one trailer, exit 0, no paid probe', () => {
    const f = makeFixture();
    installCodex(f);
    const r = row(f, []);
    expect(r.status, r.out).toBe(0);
    expect(r.required).toEqual(['claude', 'codex', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision', 'floor', 'wrapper']);
    for (const id of r.required.filter(x => x !== 'pins' && x !== 'floor' && x !== 'wrapper')) expect(r.rows[id]?.status, `${id}\n${r.out}`).toBe('PASS');
    // The work dir is not a git repository, so there is no project to read pins or a floor from: SKIP with the reason, never silent.
    expect(r.rows.pins).toEqual({ status: 'SKIP', rest: expect.stringContaining('no project') });
    expect(r.rows.floor).toEqual({ status: 'SKIP', rest: expect.stringContaining('no project to read .gstack/ship-policy.json from') });
    // No ~/.capy/drive skill copy and no active wrapper: not a Capy machine.
    expect(r.rows.wrapper).toEqual({ status: 'SKIP', rest: expect.stringContaining('not a Capy machine') });
    expect(r.rows.patch.status).toBe('PASS');
    expect(r.rows['codex-cli'].status).toBe('PASS');
    expect(r.rows.browser).toEqual({ status: 'SKIP', rest: '(lazy; gstack-browser-ensure installs on first use)' });
    expect(r.rows.cso.status).toBe('SKIP');
    expect(r.trailer).toBe(`gstack: ok ${VERSION} for=installed-hosts:claude,codex`);
    expect(r.trailers).toBe(1);
    expect(r.rows.runtime.rest).toContain('floor 1.3.3, supported minimum 1.4.2');
    expect(r.rows.privacy.rest).toBe('telemetry=off artifacts_sync=off codex_reviews=enabled update_check=true');
    expect(r.rows['state-root'].rest).toContain('durable=yes');
    expect(probeCalls(f)).not.toContain('probe-model');
  });

  // Value: protects=the --check state-root row names the variable that selected the root, after earlier rows read config;
  //   fails_when=an in-process config read reselects the root from the doctor's own GSTACK_STATE_ROOT;
  //   why_new=every other fixture sets GSTACK_STATE_ROOT itself, so a wrong "selected by" still reads GSTACK_STATE_ROOT; seam=none;
  //   no_claim=CLAUDE_PLUGIN_DATA and default selection (GSTACK_HOME stands in for every selector other than GSTACK_STATE_ROOT)
  test('the state-root row names GSTACK_HOME when GSTACK_HOME selected the root, in text and JSON', () => {
    const f = makeFixture();
    installCodex(f);
    const byHome = { GSTACK_STATE_ROOT: '', GSTACK_HOME: f.state };
    const r = row(f, [], byHome);
    expect(r.rows['state-root'].rest, r.out).toContain('(selected by GSTACK_HOME;');
    const json = JSON.parse(doctor(f, ['--json'], byHome).out);
    expect(json.rows.find((x: { id: string }) => x.id === 'state-root').detail).toContain('(selected by GSTACK_HOME;');
  });

  test('--for autoplan: healthy Capy machine with Claude subagents as the outside voice and no Codex CLI passes', () => {
    const f = makeFixture();
    installCodex(f);
    fs.rmSync(path.join(f.stub, 'codex'));
    const r = row(f, ['--for', 'autoplan']);
    expect(r.status, r.out).toBe(0);
    expect(r.required).toEqual(['claude', 'codex', 'patch', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision', 'floor', 'wrapper']);
    expect(r.rows.patch).toEqual({ status: 'PASS', rest: 'gpt-6-astra (gstack-review/SKILL.md)' });
    expect(r.rows['codex-cli'].status).toBe('SKIP');
    expect(r.rows['codex-cli'].rest).toContain('optional');
    expect(r.trailer).toBe(`gstack: ok ${VERSION} for=autoplan`);
    // The same machine with a stale Codex render fails the patch row.
    installCodex(f, false);
    const noPatch = row(f, ['--for', 'autoplan']);
    expect(noPatch.status).toBe(1);
    expect(noPatch.rows.patch.status).toBe('FAIL');
    expect(noPatch.rows.patch.rest).toContain('fix: ');
    expect(noPatch.rows.patch.rest).toContain('(COMPONENT_MISSING; ');
    expect(noPatch.rows.patch.rest).toContain('--host codex --model');
    expect(noPatch.trailer).toBe('gstack: fail patch');
  });

  test('--for autoplan: a hoisted Codex render carries the patch in its shared sections/preamble.md', () => {
    const f = makeFixture();
    const dest = installCodex(f, false);
    write(path.join(dest, 'gstack-review/sections/preamble.md'), '# gstack shared preamble 0123456789ab\n\n## Model-Specific Behavioral Patch (gpt-6-astra)\n');
    const r = row(f, ['--for', 'autoplan']);
    expect(r.rows.patch, r.out).toEqual({ status: 'PASS', rest: 'gpt-6-astra (gstack-review/sections/preamble.md)' });
  });

  test('an empty installed-host set is never ok: claude is required and FAILs', () => {
    const f = makeFixture();
    write(path.join(f.state, 'installs.tsv'), '');
    const r = row(f, []);
    expect(r.status).toBe(1);
    expect(r.required).toContain('claude');
    expect(r.rows.claude.status).toBe('FAIL');
    expect(r.rows.claude.rest).toContain(`fix: cd ${bashPath(f.root)} && ./setup --host claude --no-prefix`);
    expect(r.trailer).toBe('gstack: fail claude');
    expect(JSON.parse(doctor(f, ['--json']).out).for).toBe('installed-hosts:none(claude required)');
  });

  test('wrong host: an install registered from another checkout does not count; --require names what is missing', () => {
    const f = makeFixture();
    const other = path.join(f.base, 'other');
    write(path.join(f.state, 'installs.tsv'), ['codex', 'global', '-', path.join(f.home, '.codex/skills'), other, other, VERSION, 'false', 'committed', 'x'].join('\t') + '\n');
    const r = row(f, ['--require', 'codex,patch']);
    expect(r.status).toBe(1);
    expect(r.rows.codex.status).toBe('FAIL');
    expect(r.rows.patch.status).toBe('FAIL');
    expect(r.rows.claude.status).toBe('SKIP');
    expect(r.trailer).toBe('gstack: fail codex,patch');
    expect(JSON.parse(doctor(f, ['--json', '--require', 'codex,patch']).out).for).toBe('codex,patch');
  });

  test('missing authentication: --for codex needs the CLI; absent, unauthenticated and present are told apart, --live probes once', () => {
    const f = makeFixture();
    installCodex(f);
    const unauthed = row(f, ['--for', 'codex'], { STUB_AUTH_FAIL: '1' });
    expect(unauthed.status).toBe(1);
    expect(unauthed.rows['codex-cli'].status).toBe('FAIL');
    expect(unauthed.rows['codex-cli'].rest).toContain('not authenticated');
    expect(unauthed.rows['codex-cli'].rest).toContain('codex login --with-api-key');
    expect(unauthed.trailer).toBe('gstack: fail codex-cli');

    const authed = row(f, ['--for', 'codex']);
    expect(authed.status, authed.out).toBe(0);
    expect(authed.rows['codex-cli'].rest).toContain('paid probe not run; add --live');
    expect(probeCalls(f)).not.toContain('probe-model');

    const live = row(f, ['--for', 'codex', '--live']);
    expect(live.status, live.out).toBe(0);
    expect(live.rows['codex-cli'].rest).toContain('live probe ok');
    expect(probeCalls(f).match(/probe-model exec/g)?.length).toBe(1);

    fs.rmSync(path.join(f.stub, 'codex'));
    const absent = row(f, ['--for', 'codex']);
    expect(absent.rows['codex-cli'].status).toBe('FAIL');
    expect(absent.rows['codex-cli'].rest).toContain('npm install -g @openai/codex');
  });

  test('runtime mismatch: the supported minimum (1.4.2) and the floor (1.3.3) both FAIL in --check', () => {
    const f = makeFixture();
    const untested = row(f, [], { STUB_BUN_VERSION: '1.3.14' });
    expect(untested.status).toBe(1);
    expect(untested.rows.runtime.status).toBe('FAIL');
    expect(untested.rows.runtime.rest).toContain('below the supported minimum 1.4.2');
    expect(untested.rows.runtime.rest).toContain('(RUNTIME_BELOW_MINIMUM; ');
    expect(untested.trailer).toBe('gstack: fail runtime');
    const old = row(f, [], { STUB_BUN_VERSION: '1.3.2' });
    expect(old.rows.runtime.rest).toContain('below the security floor 1.3.3');
    expect(old.trailer).toBe('gstack: fail runtime');
  });

  test('bun removed from PATH: the doctor still reports, runtime FAILs, pins SKIPs with a reason, one trailer', () => {
    const f = makeFixture();
    fs.rmSync(path.join(f.stub, 'bun'));
    const r = row(f, []);
    expect(r.status).toBe(1);
    expect(r.rows.runtime.status).toBe('FAIL');
    expect(r.rows.runtime.rest).toContain('bun not found on PATH');
    expect(r.rows.pins).toEqual({ status: 'SKIP', rest: expect.stringContaining('no bun to evaluate the project pins') });
    expect(r.rows.claude.status).toBe('PASS');
    expect(r.trailer).toBe('gstack: fail runtime');
    expect(r.trailers).toBe(1);
  });

  test('project pins: --project reads the target repository, a range mismatch FAILs with its source, a match PASSes', () => {
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    write(path.join(project, 'package.json'), '{\n  "engines": {\n    "bun": ">=1.4.2"\n  }\n}\n');
    const bad = row(f, ['--project', project], { STUB_BUN_VERSION: '1.3.14' });
    expect(bad.rows.pins.status).toBe('FAIL');
    expect(bad.rows.pins.rest).toContain('bun 1.3.14 outside engines.bun >=1.4.2 (package.json:3)');
    expect(bad.rows.pins.rest).toContain('(PROJECT_PIN_MISMATCH; ');
    expect(bad.trailer).toBe('gstack: fail runtime,pins');
    const good = row(f, ['--project', project]);
    expect(good.rows.pins).toEqual({ status: 'PASS', rest: `${project}: bun >=1.4.2 (engines.bun, package.json:3)` });
    const none = row(f, ['--project', f.work]);
    expect(none.rows.pins.status).toBe('PASS');
    expect(none.rows.pins.rest).toContain('pins no runtime');
    const missing = row(f, ['--project', path.join(f.base, 'nope')]);
    expect(missing.rows.pins.status).toBe('SKIP');
  });

  test('project pins on Capy: the PROJECT_PIN_MISMATCH fix is the exact bootstrapper command, which installs a verified pinned Bun', () => {
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    write(path.join(project, 'package.json'), '{\n  "engines": {\n    "bun": ">=1.4.2"\n  }\n}\n');
    const wrapper = '/drive/skills/gstack/scripts/install.sh';
    const capy = row(f, ['--project', project], { STUB_BUN_VERSION: '1.3.14', GSTACK_CAPY_WRAPPER_PATH: wrapper });
    expect(capy.rows.pins.status).toBe('FAIL');
    expect(capy.rows.pins.rest).toContain(`fix: bash ${wrapper} (installs the project's pinned Bun when it is a verified version: 1.4.2 1.4.3 1.4.4; otherwise it names the conflict), or change the pin in ${project}`);
    expect(capy.rows.pins.rest).toContain('(PROJECT_PIN_MISMATCH; ');
    const forSkill = row(f, ['--project', project, '--for', 'review'], { STUB_BUN_VERSION: '1.3.14', GSTACK_CAPY_WRAPPER_PATH: wrapper });
    expect(forSkill.rows.pins.rest).toContain(`fix: bash ${wrapper} --for review (installs`);
    const plain = row(f, ['--project', project], { STUB_BUN_VERSION: '1.3.14' });
    expect(plain.rows.pins.rest).toContain('fix: install the pinned version for this platform');
    expect(plain.rows.pins.rest).not.toContain(wrapper);
  });

  test('project pins: a Node-only pin mismatch is a WARN (the trailer stays ok) that names the node it read and a fix that installs the pinned Node', () => {
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    write(path.join(project, '.github/workflows/native-locks.yml'), 'jobs:\n  locks:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24.18.0\n');
    script(path.join(f.stub, 'node'), ['echo v24.21.0']);
    const wrapper = '/drive/skills/gstack/scripts/install.sh';
    const capy = row(f, ['--project', project, '--for', 'health'], { GSTACK_CAPY_WRAPPER_PATH: wrapper });
    expect(capy.rows.pins.status).toBe('WARN');
    expect(capy.rows.pins.rest).toContain(`node 24.21.0 outside CI 24.18.0 (.github/workflows/native-locks.yml:6); node read from ${bashPath(f.stub)}/node (node pin only; bun pins pass)`);
    expect(capy.rows.pins.rest).toContain(`fix: bash ${wrapper} --for health (installs the project's pinned Node 24.18.0 into gstack's runtime store and launches it through the GSTACK_LAUNCH PATH), or change the pin in ${project}`);
    expect(capy.rows.pins.rest).toContain('(PROJECT_NODE_PIN_UNMET; ');
    expect(capy.trailer).toBe(`gstack: ok ${VERSION} for=health`);
    const plain = row(f, ['--project', project, '--for', 'health']);
    expect(plain.rows.pins.rest).toContain(`fix: nvm install 24.18.0 and put its bin directory first on PATH`);
    // A Bun pin that also fails keeps the FAIL and its code: only a Node-only gap is advisory.
    write(path.join(project, 'package.json'), '{\n  "engines": {\n    "bun": ">=1.4.2"\n  }\n}\n');
    const both = row(f, ['--project', project, '--for', 'health'], { STUB_BUN_VERSION: '1.3.14' });
    expect(both.rows.pins.status).toBe('FAIL');
    expect(both.rows.pins.rest).toContain('(PROJECT_PIN_MISMATCH; ');
    fs.rmSync(path.join(project, 'package.json'));
    script(path.join(f.stub, 'node'), ['echo v24.18.0']);
    expect(row(f, ['--project', project, '--for', 'health']).rows.pins.status).toBe('PASS');
  });

  test('floor: min_gstack_version in the project\'s .gstack/ship-policy.json PASSes at or below the installed version, WARNs above it with the upgrade as the fix, and SKIPs when absent or null', () => {
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    fs.mkdirSync(project, { recursive: true });
    const none = row(f, ['--project', project]);
    expect(none.rows.floor).toEqual({ status: 'SKIP', rest: `(${project} declares none (.gstack/ship-policy.json absent; set min_gstack_version there to require a gstack version))` });
    write(path.join(project, '.gstack/ship-policy.json'), '{\n  "bump": "patch",\n  "min_gstack_version": null\n}\n');
    expect(row(f, ['--project', project]).rows.floor).toEqual({ status: 'SKIP', rest: `(${project}/.gstack/ship-policy.json sets no min_gstack_version (null or absent))` });
    // A present value that is not a dotted version is named as such, never read as "absent"; the shell never evaluates it.
    const marker = path.join(project, 'evaluated-marker');
    write(path.join(project, '.gstack/ship-policy.json'), `{\n  "min_gstack_version": "1.2.3-rc1; $(touch ${marker})"\n}\n`);
    expect(row(f, ['--project', project]).rows.floor).toEqual({ status: 'SKIP', rest: `(${project}/.gstack/ship-policy.json sets min_gstack_version to something other than a plain dotted version)` });
    expect(fs.existsSync(marker)).toBe(false);
    write(path.join(project, '.gstack/ship-policy.json'), `{\n  "min_gstack_version": "${VERSION}"\n}\n`);
    const met = row(f, ['--project', project]);
    expect(met.rows.floor).toEqual({ status: 'PASS', rest: `${VERSION} declared by ${project}/.gstack/ship-policy.json (installed ${VERSION})` });
    // Valid JSON may put the value on the line after its field (found by Codex in /ship's adversarial review).
    write(path.join(project, '.gstack/ship-policy.json'), `{\n  "bump": "patch",\n  "min_gstack_version":\n    "${VERSION}"\n}\n`);
    expect(row(f, ['--project', project]).rows.floor.status).toBe('PASS');
    // The first occurrence is the top-level field: a later nested one never lowers the floor (found by Codex).
    write(path.join(project, '.gstack/ship-policy.json'), '{\n  "min_gstack_version": "999.0.0.0",\n  "$schema": {"min_gstack_version": "0.0.0"}\n}\n');
    expect(row(f, ['--project', project]).rows.floor.status).toBe('WARN');
    write(path.join(project, '.gstack/ship-policy.json'), '{\n  "min_gstack_version": "999.0.0.0"\n}\n');
    const wrapper = '/drive/skills/gstack/scripts/install.sh';
    const unmet = row(f, ['--project', project, '--for', 'health'], { GSTACK_CAPY_WRAPPER_PATH: wrapper });
    expect(unmet.status, unmet.out).toBe(0);
    expect(unmet.rows.floor.status).toBe('WARN');
    expect(unmet.rows.floor.rest).toContain(`installed ${VERSION} is below the floor 999.0.0.0 that ${project}/.gstack/ship-policy.json declares (min_gstack_version); fix: bash ${wrapper} --for health (fast-forwards a clean checkout to origin and reinstalls), or `);
    expect(unmet.rows.floor.rest).toContain('(PROJECT_FLOOR_UNMET; ');
    expect(unmet.trailer).toBe(`gstack: ok ${VERSION} for=health`);
    const plain = row(f, ['--project', project]);
    expect(plain.rows.floor.rest).toContain('fix: ');
    expect(plain.rows.floor.rest).toContain('bin/gstack-upgrade (fast-forwards to the remote default branch');
    expect(plain.rows.floor.rest).not.toContain(wrapper);
  });

  test('--revision: a matching VERSION passes, an unmet revision is never ok', () => {
    const f = makeFixture();
    const ok = row(f, ['--revision', VERSION]);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.rows.revision.status).toBe('PASS');
    const unmet = row(f, ['--revision', 'v9.9.9.9']);
    expect(unmet.status).toBe(1);
    expect(unmet.rows.revision.status).toBe('FAIL');
    expect(unmet.rows.revision.rest).toContain(`installed ${VERSION}`);
    expect(unmet.rows.revision.rest).toContain('(requested v9.9.9.9)');
    expect(unmet.rows.revision.rest).toContain('(REVISION_UNMET; ');
    expect(unmet.trailer).toBe('gstack: fail revision');
  });

  test('browser skills: the bundle and a Chromium launch plus render are required; planning skills never launch it', () => {
    const f = makeFixture();
    installCodex(f);
    installPlaywrightStub(f, false);
    const broken = row(f, ['--for', 'qa']);
    expect(broken.status).toBe(1);
    expect(broken.rows['browse-bundle'].status).toBe('PASS');
    expect(broken.rows.browser.status).toBe('FAIL');
    expect(broken.rows.browser.rest).toContain("Executable doesn't exist");
    expect(broken.rows.browser.rest).toContain(`fix: ${bashPath(f.root)}/bin/gstack-browser-ensure (BROWSER_UNAVAILABLE; `);
    expect(broken.trailer).toBe('gstack: fail browser');
    installPlaywrightStub(f, true);
    const ok = row(f, ['--for', 'qa']);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.rows.browser).toEqual({ status: 'PASS', rest: 'Chromium 141.0.1 launched and rendered (node)' });
    fs.rmSync(path.join(f.root, BROWSE_BIN));
    const noBundle = row(f, ['--for', 'browse']);
    expect(noBundle.rows['browse-bundle'].status).toBe('FAIL');
    expect(noBundle.rows['browse-bundle'].rest).toContain('fix: cd ');
    installPlaywrightStub(f, false);
    expect(row(f, ['--for', 'autoplan']).rows.browser.status).toBe('SKIP');
  });

  test('cso: optional by default (SKIP, never silent), required by --for cso', () => {
    const f = makeFixture();
    expect(row(f, []).rows.cso).toEqual({ status: 'SKIP', rest: '(optional; toolchain absent or helper not built)' });
    const r = row(f, ['--for', 'cso']);
    expect(r.rows.cso.status).toBe('FAIL');
    expect(r.trailer).toBe('gstack: fail cso');
    for (const name of ['gstack-cso-launcher', 'gstack-cso-core']) write(path.join(f.root, 'bin', name + EXE), '#!/bin/sh\necho cso\n', 0o755);
    expect(row(f, ['--for', 'cso']).rows.cso.status).toBe('PASS');
  });

  test('state root: GSTACK_EPHEMERAL=1 reports durable=no in --check (PASS) and warns in the dashboard', () => {
    const f = makeFixture();
    const r = row(f, [], { GSTACK_EPHEMERAL: '1' });
    expect(r.rows['state-root'].status).toBe('PASS');
    expect(r.rows['state-root'].rest).toContain(`${f.state} durable=no`);
    expect(r.rows['state-root'].rest).toContain('GSTACK_EPHEMERAL=1');
    expect(r.status, r.out).toBe(0);
    const dash = doctor(f, [], { GSTACK_EPHEMERAL: '1' });
    expect(dash.row('state root').state).toBe('warn');
    expect(dash.row('state root').detail).toContain('durable=no');
    expect(dash.row('state root').fix).toContain('GSTACK_STATE_ROOT');
    expect(doctor(f).row('state root').detail).toContain('durable=yes');
  });

  test('--json: the same rows as objects keyed by the component ids, ok/failed/required and the trailer', () => {
    const f = makeFixture();
    installCodex(f);
    const r = doctor(f, ['--json', '--for', 'autoplan'], { STUB_BUN_VERSION: '1.3.14' });
    expect(r.status).toBe(1);
    const json = JSON.parse(r.out.trim().split('\n').at(-1)!);
    expect(json.schema_version).toBe(1);
    expect(json.revision).toBe(VERSION);
    expect(json.for).toBe('autoplan');
    expect(json.ok).toBe(false);
    expect(json.failed).toEqual(['runtime']);
    expect(json.required).toEqual(['claude', 'codex', 'patch', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision', 'floor', 'wrapper']);
    expect(json.rows.map((x: { id: string }) => x.id)).toEqual(['claude', 'codex', 'patch', 'codex-cli', 'browse-bundle', 'browser', 'cso', 'helpers', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision', 'floor', 'wrapper']);
    const runtime = json.rows.find((x: { id: string }) => x.id === 'runtime');
    expect(runtime.status).toBe('FAIL');
    expect(runtime.code).toBe('RUNTIME_BELOW_MINIMUM');
    expect(runtime.anchor).toBe('doctor-runtime-below-minimum');
    expect(runtime.fix).toContain('gstack-capy-install');
    expect(json.trailer).toBe('gstack: fail runtime');
    expect(r.out.trim().split('\n')).toHaveLength(1);
    const ok = JSON.parse(doctor(f, ['--json']).out.trim());
    expect(ok.ok).toBe(true);
    expect(ok.trailer).toBe(`gstack: ok ${VERSION} for=installed-hosts:claude,codex`);
  });

  test('usage: --for with --require, an unknown skill or component, and a flag without a value exit 2', () => {
    const f = makeFixture();
    expect(doctor(f, ['--check', '--for', 'autoplan', '--require', 'claude']).status).toBe(2);
    expect(doctor(f, ['--for', 'no-such-skill']).status).toBe(2);
    expect(doctor(f, ['--require', 'claude,bogus']).status).toBe(2);
    expect(doctor(f, ['--check', '--project']).status).toBe(2);
    expect(doctor(f, ['--help']).out).toContain('--check');
  });
});

// Field wave lane A: the trailer agrees with the Bun workflows run (A3), a
// remote minimum fails the revision row (A2), and planning-only workflows do
// not fail on a repo test-pin mismatch (A3 amendment).
describe('gstack-doctor --check: launch Bun, supported minimum, planning-only pins', () => {
  const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
  const check = (f: Fixture, args: string[], extra: Record<string, string> = {}) => {
    const r = doctor(f, ['--check', ...args], extra);
    const lines = r.out.split('\n');
    const rows = Object.fromEntries(lines.filter(l => /^(PASS|FAIL|SKIP|WARN) /.test(l)).map(l => {
      const m = l.match(/^(PASS|FAIL|SKIP|WARN) ([a-z-]+)(?:\s(.*))?$/)!;
      return [m[2], { status: m[1], rest: m[3] ?? '' }];
    }));
    return { status: r.status, out: r.out, rows, trailer: lines.filter(l => l.startsWith('gstack: ')).at(-1) ?? '' };
  };
  /** A verified Bun in $HOME/.bun/bin (off PATH) that answers --version and runs TypeScript. */
  const verifiedBun = (f: Fixture, version = '1.4.2') =>
    script(path.join(f.home, '.bun/bin/bun'), [`[ "$1" = --version ] && { echo "${version}"; exit 0; }`, `exec "${process.execPath}" "$@"`]);

  test('PATH Bun 1.3.14 with a verified 1.4.2 off PATH: runtime FAILs naming where it was found; with the launch PATH it PASSes', () => {
    const f = makeFixture();
    verifiedBun(f);
    const fresh = check(f, [], { STUB_BUN_VERSION: '1.3.14' });
    expect(fresh.rows.runtime.status).toBe('FAIL');
    const home = bashPath(f.home);
    expect(fresh.rows.runtime.rest).toContain(`bun 1.4.2 found at ${home}/.bun/bin (not on PATH)`);
    expect(fresh.rows.runtime.rest).toContain(`fix: export PATH="${home}/.bun/bin:$PATH" or prefix commands with the GSTACK_LAUNCH line`);
    expect(fresh.rows.runtime.rest).toContain('(RUNTIME_BELOW_MINIMUM; ');
    const launched = check(f, [], { STUB_BUN_VERSION: '1.3.14', PATH: `${f.home}/.bun/bin${path.delimiter}${f.env.PATH}` });
    expect(launched.rows.runtime.status, launched.out).toBe('PASS');
    expect(launched.rows.runtime.rest).toContain(`at ${home}/.bun/bin/bun`);
  });

  test('--min-revision: below FAILs with REVISION_BELOW_MINIMUM naming the upgrade command; at or above PASSes; unknown says so and never claims the minimum', () => {
    const f = makeFixture();
    const below = check(f, ['--min-revision', '99.0.0.0']);
    expect(below.status).toBe(1);
    expect(below.rows.revision.status).toBe('FAIL');
    expect(below.rows.revision.rest).toContain(`installed ${VERSION}`);
    expect(below.rows.revision.rest).toContain('below the supported minimum 99.0.0.0');
    expect(below.rows.revision.rest).toContain(`${bashPath(f.root)}/bin/gstack-upgrade`);
    expect(below.rows.revision.rest).toContain('(REVISION_BELOW_MINIMUM; ');
    expect(below.trailer).toBe('gstack: fail revision');
    const wrapped = check(f, ['--min-revision', '99.0.0.0'], { GSTACK_CAPY_WRAPPER_PATH: '/drive/skills/gstack/scripts/install.sh' });
    expect(wrapped.rows.revision.rest).toContain('fix: bash /drive/skills/gstack/scripts/install.sh (fast-forwards)');
    const at = check(f, ['--min-revision', VERSION]);
    expect(at.rows.revision.status, at.out).toBe('PASS');
    expect(at.rows.revision.rest).toContain(`>= supported minimum ${VERSION}`);
    const unknown = check(f, ['--min-revision', 'unknown']);
    expect(unknown.rows.revision.status).toBe('PASS');
    expect(unknown.rows.revision.rest).toContain('remote minimum unknown (fetch failed)');
    expect(unknown.rows.revision.rest).not.toContain('>= supported minimum');
  });

  test('planning-only workflows SKIP a repo test-pin mismatch; test-running workflows and --require keep pins required', () => {
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    write(path.join(project, '.bun-version'), '1.4.2\n');
    const planning = check(f, ['--for', 'autoplan', '--project', project], { STUB_BUN_VERSION: '1.4.3' });
    expect(planning.rows.pins.status, planning.out).toBe('SKIP');
    expect(planning.rows.pins.rest).toMatch(/^\(planning-only; repo pins .*1\.4\.2.*, launch bun 1\.4\.3\)$/);
    for (const args of [['--for', 'review'], ['--for', 'ship'], ['--require', 'claude']]) {
      const tests = check(f, [...args, '--project', project], { STUB_BUN_VERSION: '1.4.3' });
      expect(tests.rows.pins.status, args.join(' ')).toBe('FAIL');
    }
  });
});

// Plan A8/A-h: the Capy skill copy. Active-wrapper provenance decides; without
// it the Drive copies do, failing only when every copy is stale. The printed
// workaround (the checkout's own wrapper) certifies with the stale Drive copy
// left unchanged. Plan A5: a drifted resolution is a runtime FAIL.
describe('gstack-doctor --check: wrapper and runtime drift', () => {
  const posixPathTest = process.platform === 'win32' ? test.skip : test;
  const PRE_BOOTSTRAPPER = '#!/usr/bin/env bash\n# gstack Capy skill installer (pre-bootstrapper)\nset -u\nroot="${GSTACK_CAPY_ROOT:-$HOME/.local/share/gstack}"\nexec "$root/bin/gstack-capy-install" "$@"\n';
  const parse = (f: Fixture, args: string[], extra: Record<string, string> = {}) => {
    const r = doctor(f, ['--check', ...args], extra);
    const line = (id: string) => r.out.split('\n').find(l => new RegExp(`^(PASS|FAIL|SKIP|WARN) ${id}\\b`).test(l)) ?? '';
    return { status: r.status, out: r.out, line, trailer: r.out.split('\n').filter(l => l.startsWith('gstack: ')).at(-1) ?? '' };
  };
  const drive = (f: Fixture, scope: string, text: string) => { const file = path.join(f.home, '.capy/drive', scope, 'skills/gstack/scripts/install.sh'); write(file, text); return file; };
  const withSupport = (f: Fixture, min = 1) => write(path.join(f.root, 'capy/support.env'), `GSTACK_MIN_REVISION=1.0.0.0\nGSTACK_CAPY_MIN_WRAPPER=${min}\n`);
  const current = fs.readFileSync(path.join(REPO, 'capy/skill/gstack/scripts/install.sh'), 'utf8');
  const currentRev = current.match(/^GSTACK_CAPY_WRAPPER=(\d+)$/m)![1];

  posixPathTest('direct doctor run: a pre-bootstrapper Drive copy (no revision line) fails wrapper with both fixes; a current copy is not flagged', () => {
    const f = makeFixture();
    withSupport(f);
    const stale = drive(f, 'user-garry-tan', PRE_BOOTSTRAPPER);
    const r = parse(f, []);
    expect(r.status).toBe(1);
    expect(r.trailer).toBe('gstack: fail wrapper');
    const row = r.line('wrapper');
    expect(row).toContain(`FAIL wrapper — every Capy skill copy is stale (minimum wrapper 1): ${stale} (wrapper 0); fix: bash ${f.root}/capy/skill/gstack/scripts/install.sh --check (this session); owner: copy ${f.root}/capy/skill/gstack/ over the Drive skill folder, or have Capy re-sync it; this recurs every session until the Drive copy changes`);
    expect(row).toContain('(CAPY_WRAPPER_STALE; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-wrapper-stale)');
    write(stale, current);
    const fresh = parse(f, []);
    expect(fresh.line('wrapper')).toBe(`PASS wrapper Drive copy ${stale} (wrapper ${currentRev}) (minimum 1)`);
    expect(fresh.status, fresh.out).toBe(0);
  });

  posixPathTest('direct doctor run: a bootstrapper Drive copy below the minimum still works, so it is an owner-action WARN with an ok trailer (only a pre-bootstrapper copy fails)', () => {
    const f = makeFixture();
    withSupport(f, Number(currentRev) + 1);
    const old = drive(f, 'user-garry-tan', current);
    const r = parse(f, []);
    expect(r.status, r.out).toBe(0);
    expect(r.trailer).toMatch(/^gstack: ok /);
    expect(r.line('wrapper')).toBe(`WARN wrapper — every Capy skill copy is below the minimum wrapper ${Number(currentRev) + 1} (it still works): ${old} (wrapper ${currentRev}); owner action: copy ${f.root}/capy/skill/gstack/ over the Drive skill folder, or have Capy re-sync it; this recurs every session until the Drive copy changes (CAPY_WRAPPER_STALE; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-wrapper-stale)`);
    const json = JSON.parse(doctor(f, ['--check', '--json']).out);
    expect(json.ok).toBe(true);
    expect(json.rows.find((x: { id: string }) => x.id === 'wrapper')).toMatchObject({ status: 'WARN', code: 'CAPY_WRAPPER_STALE' });
    // A pre-bootstrapper copy beside it keeps the FAIL: that copy cannot hand over at all.
    drive(f, 'org', PRE_BOOTSTRAPPER);
    expect(parse(f, []).trailer).toBe('gstack: fail wrapper');
  });

  posixPathTest('two Drive copies, one current: PASS naming the stale one; GSTACK_CAPY_WRAPPER_PATH alone decides when set without a revision', () => {
    const f = makeFixture();
    withSupport(f);
    const stale = drive(f, 'org', PRE_BOOTSTRAPPER);
    const good = drive(f, 'user', current);
    const r = parse(f, []);
    expect(r.line('wrapper')).toBe(`PASS wrapper Drive copy ${good} (wrapper ${currentRev}) (minimum 1); stale copies: ${stale} (wrapper 0)`);
    expect(parse(f, [], { GSTACK_CAPY_WRAPPER_PATH: stale }).trailer).toBe('gstack: fail wrapper');
  });

  posixPathTest('the printed workaround certifies: a current active wrapper passes with the stale Drive copy unchanged (WARN, owner action); a stale active wrapper is a WARN too', () => {
    const f = makeFixture();
    withSupport(f);
    const stale = drive(f, 'user-garry-tan', PRE_BOOTSTRAPPER);
    const checkoutCopy = path.join(f.root, 'capy/skill/gstack/scripts/install.sh');
    const r = parse(f, [], { GSTACK_CAPY_WRAPPER_REV: '1', GSTACK_CAPY_WRAPPER_PATH: checkoutCopy });
    expect(r.status, r.out).toBe(0);
    expect(r.trailer).toMatch(/^gstack: ok /);
    expect(r.line('wrapper')).toBe(`WARN wrapper — active wrapper 1 (${checkoutCopy}) is current; stale Drive copies (minimum 1): ${stale} (wrapper 0); owner action: copy ${f.root}/capy/skill/gstack/ over the Drive skill folder, or have Capy re-sync it; this recurs every session until the Drive copy changes (CAPY_WRAPPER_STALE; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-wrapper-stale)`);
    expect(fs.readFileSync(stale, 'utf8')).toBe(PRE_BOOTSTRAPPER);
    const json = JSON.parse(doctor(f, ['--check', '--json'], { GSTACK_CAPY_WRAPPER_REV: '1', GSTACK_CAPY_WRAPPER_PATH: checkoutCopy }).out);
    expect(json.ok).toBe(true);
    expect(json.rows.find((x: { id: string }) => x.id === 'wrapper')).toMatchObject({ status: 'WARN', code: 'CAPY_WRAPPER_STALE' });
    withSupport(f, 2);
    const old = parse(f, [], { GSTACK_CAPY_WRAPPER_REV: '1', GSTACK_CAPY_WRAPPER_PATH: stale });
    // Integration item 2: an active copy below the minimum still works, so it
    // is an owner-action WARN and the trailer stays ok.
    expect(old.status, old.out).toBe(0);
    expect(old.trailer).toMatch(/^gstack: ok /);
    expect(old.line('wrapper')).toBe(`WARN wrapper — the active Capy skill copy ${stale} is wrapper 1, minimum 2 (it still works); owner action: copy ${f.root}/capy/skill/gstack/ over the Drive skill folder, or have Capy re-sync it; this recurs every session until the Drive copy changes (CAPY_WRAPPER_STALE; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-wrapper-stale)`);
  });

  test('a drifted Bun resolution is a runtime FAIL carrying the installer\'s detail, fix and BUN_RESOLUTION_DRIFT', () => {
    const f = makeFixture();
    const r = parse(f, [], { GSTACK_DOCTOR_RUNTIME_DRIFT: 'recorded bun 1.4.3 at /s/bun (home), now no eligible bun; changed: the recorded binary is gone', GSTACK_DOCTOR_RUNTIME_DRIFT_FIX: 'bash /d/install.sh --for review' });
    expect(r.trailer).toBe('gstack: fail runtime');
    expect(r.line('runtime')).toBe('FAIL runtime — bun resolution drifted: recorded bun 1.4.3 at /s/bun (home), now no eligible bun; changed: the recorded binary is gone; fix: bash /d/install.sh --for review (BUN_RESOLUTION_DRIFT; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#bun-resolution-drift)');
  });

  posixPathTest('the runtime row shows gstack\'s bun shim and where it resolves from here, or names a foreign ~/.local/bin/bun it left alone', () => {
    const f = makeFixture();
    const shim = path.join(f.home, '.local/bin/bun');
    write(shim, '#!/bin/sh\n# gstack-bun-shim: gstack-owned; delete this file to remove it\n[ "$GSTACK_BUN_SHIM_EXPLAIN" = 1 ] && echo "gstack bun shim: project=none record=none chose=/store/1.4.3/bun rule=default" >&2\necho 1.4.3\n', 0o755);
    expect(parse(f, []).line('runtime')).toContain(`; shim ${shim} -> /store/1.4.3/bun`);
    write(shim, '#!/bin/sh\necho mine\n', 0o755);
    expect(parse(f, []).line('runtime')).toContain(`; ${shim} is not gstack's shim (no marker), left untouched: launch with the GSTACK_LAUNCH line`);
    expect(parse(f, [], { GSTACK_BUN_INSTALL_VERSION: '1.4.2' }).line('runtime')).toContain('; install version 1.4.2 from GSTACK_BUN_INSTALL_VERSION');
  });

  test('A-a: the Capy skill\'s dispatch examples (fail revision, fail runtime,pins, fail pins) match the real failure heads, unchanged', () => {
    const skill = fs.readFileSync(path.join(REPO, 'capy/skill/gstack/SKILL.md'), 'utf8');
    const step = skill.split('\n').find(l => l.includes('If the trailer names `revision`, `runtime` or `pins`'))!;
    const examples = [...step.matchAll(/`(gstack: fail [^`]+)`/g)].map(m => m[1]);
    expect(examples).toEqual(['gstack: fail revision …', 'gstack: fail runtime,pins', 'gstack: fail pins']);
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    write(path.join(project, '.bun-version'), '1.4.2\n');
    const real: Record<string, string> = {
      revision: parse(f, ['--require', 'claude', '--min-revision', '99.0.0.0']).trailer,
      'runtime,pins': parse(f, ['--require', 'claude', '--project', project], { STUB_BUN_VERSION: '1.3.14' }).trailer,
      pins: parse(f, ['--require', 'claude', '--project', project], { STUB_BUN_VERSION: '1.4.3' }).trailer,
    };
    for (const example of examples) {
      const ids = example.slice('gstack: fail '.length).replace(/ …$/, '');
      const head = real[ids];
      expect(head === `gstack: fail ${ids}` || head.startsWith(`gstack: fail ${ids} — `), `${example} vs ${head}`).toBe(true);
      expect(head.match(/^gstack: fail ([a-z,-]+)/)?.[1].split(',')).toEqual(ids.split(','));
    }
  });
});

// Lane F item D: the plain report lists rescue refs with their commands, warns
// about a CLAUDE.md gstack section that enumerates skills (#3169), and on
// Windows names the bash gstack's TypeScript hands its scripts to. GSTACK_DOCTOR_PLATFORM
// injects the platform and GSTACK_DOCTOR_BASH_PROBE the discovery inputs, so
// every case runs on every OS.
describe('gstack-doctor: rescue refs, CLAUDE.md skill lists, Windows bash', () => {
  const git = (f: Fixture, args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync('git', args, {
      cwd: f.root, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HOME: f.home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', ...extra },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** A git install with one rescue commit per entry: a user edit on top of HEAD, committed on the given date. */
  const withRescues = (f: Fixture, rescues: Array<{ date: string; unmerged?: boolean }>) => {
    git(f, ['init', '-q']);
    git(f, ['add', '-A']);
    git(f, ['commit', '-qm', 'release']);
    const index = path.join(f.base, 'rescue.idx');
    return rescues.map(({ date, unmerged }, i) => {
      const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.root, input: `edit ${i}\n`, encoding: 'utf8', timeout: 20_000 }).stdout.trim();
      git(f, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: index });
      git(f, ['update-index', '--add', '--cacheinfo', `100644,${blob},local-edit-${i}.txt`], { GIT_INDEX_FILE: index });
      const tree = git(f, ['write-tree'], { GIT_INDEX_FILE: index });
      const message = `gstack rescue: local edits that conflicted with abc\n${unmerged ? '\nNeeds manual resolution: the install had unmerged files; their captured\ncontent may contain conflict markers.\n' : ''}`;
      const oid = spawnSync('git', ['commit-tree', tree, '-p', 'HEAD'], {
        cwd: f.root, input: message, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, HOME: f.home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'gstack rescue', GIT_AUTHOR_EMAIL: 'gstack@localhost', GIT_COMMITTER_NAME: 'gstack rescue', GIT_COMMITTER_EMAIL: 'gstack@localhost', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      }).stdout.trim();
      git(f, ['update-ref', `refs/gstack/rescue/${oid}`, oid]);
      return `refs/gstack/rescue/${oid}`;
    });
  };
  const rescueRefs = (f: Fixture) => git(f, ['for-each-ref', '--format=%(refname)', 'refs/gstack/rescue/']).split('\n').filter(Boolean);
  const commandFor = (out: string, label: 'inspect' | 'delete', ref: string) =>
    out.split('\n').map(l => l.trim()).find(l => l.startsWith(`${label}:`) && l.includes(`'${ref}'`))?.replace(/^[a-z]+:\s+/, '') ?? '';

  test('rescue refs: two refs are listed newest first with their dates; the printed inspect command shows the edit and the printed delete command removes the ref', () => {
    const f = makeFixture();
    const [older, newer] = withRescues(f, [{ date: '2026-10-01T12:00:00Z' }, { date: '2026-10-14T08:30:00Z', unmerged: true }]);
    const r = doctor(f);
    const row = r.row('rescue refs');
    expect(row.state, r.out).toBe('warn');
    expect(row.detail).toContain(`2 in ${bashPath(f.root)}`);
    expect(row.fix).toContain('#auto-update-rescued-edits');
    const listing = r.out.split('\n').map(l => l.trim());
    expect(listing.findIndex(l => l.startsWith(newer))).toBeLessThan(listing.findIndex(l => l.startsWith(older)));
    expect(listing).toContain(`${older} (2026-10-01)`);
    expect(listing).toContain(`${newer} (2026-10-14, needs manual resolution)`);
    const q = `'${bashPath(f.root)}'`;
    expect(commandFor(r.out, 'inspect', older)).toBe(`git -C ${q} diff '${older}^' '${older}'`);
    expect(commandFor(r.out, 'delete', older)).toBe(`git -C ${q} update-ref -d '${older}'`);
    const shown = spawnSync('bash', ['-c', commandFor(r.out, 'inspect', older)], { cwd: f.work, encoding: 'utf8', timeout: 20_000 });
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('+edit 0');
    const deleted = spawnSync('bash', ['-c', commandFor(r.out, 'delete', older)], { cwd: f.work, encoding: 'utf8', timeout: 20_000 });
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(rescueRefs(f)).toEqual([newer]);
    expect(doctor(f).row('rescue refs').detail).toContain(`1 in ${bashPath(f.root)}`);
    spawnSync('bash', ['-c', commandFor(r.out, 'delete', newer)], { cwd: f.work, encoding: 'utf8', timeout: 20_000 });
    const none = doctor(f);
    expect(none.row('rescue refs')).toEqual({ state: 'ok', detail: `none in ${bashPath(f.root)}`, fix: '' });
    expect(none.status, none.out).toBe(0);
  });

  const LISTING = '## gstack\nUse /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.\nAvailable skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,\n/design-consultation, /design-shotgun, /design-html, /review, /ship, /qa, /browse, /retro, /investigate.\n';
  const SHORT = '## gstack\nUse /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.\n';
  const replacement = (out: string) => out.split('\n').filter(l => l.startsWith(' '.repeat(34))).map(l => l.slice(34));

  test('CLAUDE.md: a gstack section that enumerates skills warns with the short replacement block, for ~/.claude/CLAUDE.md and the project CLAUDE.md', () => {
    const f = makeFixture();
    const user = path.join(f.home, '.claude/CLAUDE.md');
    write(user, `# Me\n\n${LISTING}\n## Other\ntext\n`);
    const r = doctor(f);
    const row = r.row('CLAUDE.md');
    expect(row.state, r.out).toBe('warn');
    expect(row.detail).toContain(`${bashPath(f.home)}/.claude/CLAUDE.md lists 13 skills`);
    expect(row.fix).toContain('#claude-md-skill-list');
    expect(fs.readFileSync(path.join(REPO, 'docs/troubleshooting.md'), 'utf8')).toContain('<a id="claude-md-skill-list"></a>');
    expect(replacement(r.out)).toEqual(['## gstack', 'Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.']);
    expect(r.status, r.out).toBe(0);
    write(user, SHORT);
    write(path.join(f.work, 'CLAUDE.md'), `# Project\n\n## gstack (recommended)\nskills: /office-hours /plan-ceo-review /plan-eng-review /review /ship /qa /browse /retro /investigate\n`);
    const project = doctor(f).row('CLAUDE.md');
    expect(project.state).toBe('warn');
    expect(project.detail).toContain(`${bashPath(f.work)}/CLAUDE.md lists 9 skills`);
    expect(project.detail).not.toContain('.claude/CLAUDE.md');
  });

  test('CLAUDE.md: the short block, team-init\'s block, a separate Skill routing section and paths do not warn; no CLAUDE.md does not warn', () => {
    const f = makeFixture();
    const none = doctor(f).row('CLAUDE.md');
    expect(none.state).toBe('ok');
    expect(none.fix).toBe('');
    write(path.join(f.home, '.claude/CLAUDE.md'), SHORT);
    write(path.join(f.work, 'CLAUDE.md'), [
      '## gstack (recommended)',
      'Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,',
      'and /browse are available. Use the install path ~/.claude/skills/gstack/bin/gstack-config /usr/local/bin/bun /opt/a/b /x/y /z/w.',
      '',
      '## Skill routing',
      '- Product ideas → invoke /office-hours',
      '- Strategy → invoke /plan-ceo-review',
      '- Architecture → invoke /plan-eng-review',
      '- Design → invoke /design-consultation or /plan-design-review',
      '- Review → invoke /autoplan, /investigate, /qa, /review, /ship',
      '',
    ].join('\n'));
    const r = doctor(f);
    expect(r.row('CLAUDE.md').state, r.out).toBe('ok');
    expect(replacement(r.out)).toEqual([]);
  });

  /** A JSON probe file: the discovery inputs resolveWindowsBash takes, in test/fixtures/windows-bash-resolution.json's shape. */
  const probe = (f: Fixture, inputs: Record<string, unknown>) => { const file = path.join(f.base, 'bash-probe.json'); write(file, JSON.stringify(inputs)); return file; };
  const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

  test('windows bash: on Windows the row names the resolved bash and what chose it', () => {
    const f = makeFixture();
    const found = doctor(f, [], { GSTACK_DOCTOR_PLATFORM: 'windows', GSTACK_DOCTOR_BASH_PROBE: probe(f, { exists: [GIT_BASH], gitExecPath: 'C:/Program Files/Git/mingw64/libexec/git-core' }) });
    expect(found.row('windows bash'), found.out).toEqual({ state: 'ok', detail: `${GIT_BASH} (chosen by git --exec-path)`, fix: '' });
    const override = doctor(f, [], { GSTACK_DOCTOR_PLATFORM: 'windows', GSTACK_GIT_BASH: 'D:\\tools\\bash.exe', GSTACK_DOCTOR_BASH_PROBE: probe(f, { exists: ['D:/tools/bash.exe', GIT_BASH] }) });
    expect(override.row('windows bash').detail).toBe('D:/tools/bash.exe (chosen by GSTACK_GIT_BASH)');
  });

  test('windows bash: GSTACK_GIT_BASH and a different deprecated GSTACK_BASH warn naming both', () => {
    const f = makeFixture();
    const differ = doctor(f, [], { GSTACK_DOCTOR_PLATFORM: 'windows', GSTACK_GIT_BASH: 'D:/a/bash.exe', GSTACK_BASH: 'D:/b/bash.exe', GSTACK_DOCTOR_BASH_PROBE: probe(f, { exists: ['D:/a/bash.exe', 'D:/b/bash.exe'] }) });
    expect(differ.row('windows bash').state).toBe('warn');
    expect(differ.row('windows bash').detail).toContain('D:/a/bash.exe (chosen by GSTACK_GIT_BASH)');
    expect(differ.row('windows bash').detail).toContain('GSTACK_GIT_BASH (D:/a/bash.exe) and the deprecated GSTACK_BASH (D:/b/bash.exe) differ');
  });

  test('windows bash: a refusal fails with BASH_UNAVAILABLE naming GSTACK_GIT_BASH; off Windows there is no row', () => {
    const f = makeFixture();
    const refused = doctor(f, [], { GSTACK_DOCTOR_PLATFORM: 'windows', GSTACK_DOCTOR_BASH_PROBE: probe(f, { exists: [], gitExecPath: null, which: { bash: 'C:/Windows/System32/bash.exe' } }) });
    const row = refused.row('windows bash');
    expect(row.state, refused.out).toBe('fail');
    expect(row.detail).toContain('(BASH_UNAVAILABLE)');
    expect(row.detail).toContain('PATH C:/Windows/System32/bash.exe: WSL launcher, not Git Bash');
    expect(row.detail).toContain(`install path ${GIT_BASH}: not found`);
    expect(row.fix).toContain('GSTACK_GIT_BASH');
    expect(row.fix).toContain('#bash-unavailable');
    expect(refused.status).toBe(1);
    expect(doctor(f, [], { GSTACK_DOCTOR_PLATFORM: 'posix' }).out).not.toContain('windows bash');
  });
});
