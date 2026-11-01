// Split from test/gstack-doctor.test.ts: launch/CSO rows, launch Bun, wrapper drift, rescue refs and Windows bash.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { useDoctorCleanup, REPO, BROWSE_BIN, EXE, OTHER_BINS, write, script, bashPath, makeFixture, doctor, type Fixture } from './helpers/doctor-fixture';

useDoctorCleanup();

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
