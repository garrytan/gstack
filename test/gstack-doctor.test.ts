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
  const hooks = spawnSync('bash', [path.join(root, 'bin/gstack-hook-check'), '--list', root], { encoding: 'utf8', timeout: 20_000 }).stdout.trim().split('\n');
  for (const hook of hooks) write(path.join(root, hook), '#!/bin/sh\nexit 0\n', 0o755);
  // The doctor launches each compiled binary's --version (#2595), so the
  // stand-ins answer it like the real binaries do.
  for (const rel of [BROWSE_BIN, ...OTHER_BINS]) write(path.join(root, rel), '#!/bin/sh\necho built\n', 0o755);
  for (const rel of ['browse/dist/server-node.mjs', 'browse/dist/.build-complete']) write(path.join(root, rel), 'built\n', 0o755);
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  write(path.join(state, 'installs.tsv'),
    ['claude', 'global', '-', path.join(home, '.claude/skills'), root, root, version, 'false', 'committed', '2026-10-07T00:00:00Z'].join('\t') + '\n');
  script(path.join(stub, 'bun'), ['[ "$1" = --version ] && { echo "${STUB_BUN_VERSION:-1.4.2}"; exit 0; }', 'exit 0']);
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

  test('the cached probe is reported with its age; only --live runs probe-model', () => {
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

  test('artifacts sync: held, ok, stale push and stale drain', () => {
    const f = makeFixture();
    syncOn(f, { status: 'held', message: 'held 2 file(s): sk-ant-secret', held_count: 2, held: [{ path: 'projects/p/notes.md', rule: 'anthropic_key', dependents: [], fixes: ['edit', 'skip'] }, { path: 'projects/p/b.md', rule: 'anthropic_key', dependents: [], fixes: ['edit', 'skip'] }], drainable: 0, last_drain_at: iso(60), last_push_at: iso(60) });
    const held = doctor(f);
    expect(held.row('artifacts sync').state).toBe('warn');
    expect(held.row('artifacts sync').detail).toBe('status held (2 file(s) held by the secret scanner)');
    expect(held.out).not.toContain('sk-ant');

    syncOn(f, { status: 'ok', message: 'pushed 3 file(s)', drainable: 0, last_drain_at: iso(60), last_push_at: iso(60) });
    expect(doctor(f).row('artifacts sync').state).toBe('ok');

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
