/**
 * The one Bun resolution contract (plan A1, A-d): `gstack_bun_resolve` in
 * bin/gstack-bun-version.sh and `resolveBun` / `launchRuntime` in
 * lib/pregate/runtime.ts must pick the same binary (by realpath) for the
 * GBRA-60 layout: the image's old Bun first on PATH, Bun 1.4.2 in
 * $BUN_INSTALL/bin, Bun 1.4.4 elsewhere, a project pinning 1.4.4 only through
 * a CI lane, an unpinned project and a directory outside any project. A file
 * carrying the shim marker is never returned, and a candidate is chosen only
 * when it satisfies every applicable pin.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUN_SHIM_MARKER, bunStore, launchRuntime, projectBunPins, resolveBun } from '../lib/pregate/runtime';

const ROOT = path.resolve(import.meta.dir, '..');
const REAL_BUN = fs.realpathSync(process.execPath);
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const fakeBun = (file: string, version: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env bash\n[ "$1" = --version ] && { echo ${version}; exit 0; }\nexec "${REAL_BUN}" "$@"\n`, { mode: 0o755 });
  return file;
};

function layout(opts: { storeVersions?: string[]; homeVersion?: string } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bun-resolve-')));
  bases.push(base);
  const home = path.join(base, 'home'), state = path.join(home, '.gstack');
  const image = fakeBun(path.join(base, 'usr-local-bin/bun'), '1.3.14');
  const bunInstall = path.join(base, 'bun-install');
  fakeBun(path.join(bunInstall, 'bin/bun'), '1.4.2');
  for (const v of opts.storeVersions ?? []) fakeBun(path.join(bunStore(state), v, 'bun'), v);
  if (opts.homeVersion) fakeBun(path.join(home, '.bun/bin/bun'), opts.homeVersion);
  const shimDir = path.join(home, '.local/bin');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'bun'), `#!/bin/sh\n${BUN_SHIM_MARKER}\nexec ${image} "$@"\n`, { mode: 0o755 });
  const pinned = path.join(base, 'gbrain');
  fs.mkdirSync(path.join(pinned, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(pinned, 'package.json'), '{ "name": "gbrain", "engines": { "bun": ">=1.4.0" } }\n');
  fs.writeFileSync(path.join(pinned, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.4.4\n');
  const unpinned = path.join(base, 'plain');
  fs.mkdirSync(unpinned);
  fs.writeFileSync(path.join(unpinned, 'package.json'), '{ "name": "plain" }\n');
  for (const d of [pinned, unpinned]) spawnSync('git', ['init', '-q', d], { timeout: 30_000 });
  const outside = path.join(base, 'tmp');
  fs.mkdirSync(outside);
  const env = { HOME: home, BUN_INSTALL: bunInstall, PATH: `${shimDir}:${path.dirname(image)}:/usr/bin:/bin`, GSTACK_STATE_ROOT: state };
  return { base, home, state, bunInstall, pinned, unpinned, outside, env };
}

/** The Bash twin with the installer's project-pin hook: the doctor's parser, run by a real Bun. */
function bashResolve(l: ReturnType<typeof layout>, project: string | null): string {
  const script = `
. "$R/bin/gstack-bun-version.sh"
PIN_EXACT=""
if [ -n "$P" ]; then
  PIN_EXACT=$("$RB" "$R/bin/gstack-runtime-pins.ts" --project "$P" | sed -n 's/^PIN: bun \\([^ ]*\\) exact [^ ]* lane=\\(any\\|linux\\)$/\\1/p' | sort -u)
  [ "$(printf '%s\\n' "$PIN_EXACT" | grep -c .)" -le 1 ] || PIN_EXACT=""
fi
accept() { [ -z "$P" ] || "$RB" "$R/bin/gstack-runtime-pins.ts" --project "$P" --bun "$1" | grep -Eq '^PINS_VERDICT: (pass|none)$'; }
gstack_bun_resolve "$(gstack_bun_store "$GSTACK_STATE_ROOT")" "$PIN_EXACT" accept && printf '%s %s %s\\n' "$_gb_bin" "$_gb_ver" "$_gb_rule"`;
  const r = spawnSync('bash', ['-c', script], { cwd: project ?? l.outside, encoding: 'utf8', timeout: 60_000, env: { ...l.env, R: ROOT, RB: REAL_BUN, P: project ?? '' } });
  return r.stdout.trim();
}

function tsResolve(l: ReturnType<typeof layout>, project: string | null): string {
  const { pinExact, accept } = projectBunPins(project);
  const { resolution } = resolveBun({ store: bunStore(l.state), env: l.env, pinExact, accept });
  return resolution ? `${resolution.bin} ${resolution.version} ${resolution.rule}` : '';
}

describe('one Bun resolution contract, two twins', () => {
  test('GBRA-60: 1.4.4 in the store, 1.4.2 in $BUN_INSTALL, a CI-lane pin of 1.4.4 — both twins pick the store 1.4.4 for the project and for an unpinned or outside directory', () => {
    const l = layout({ storeVersions: ['1.4.4'] });
    const store144 = path.join(bunStore(l.state), '1.4.4/bun');
    for (const [project, want] of [[l.pinned, `${store144} 1.4.4 pin`], [l.unpinned, `${store144} 1.4.4 default`], [null, `${store144} 1.4.4 default`]] as const) {
      expect(bashResolve(l, project)).toBe(want);
      expect(tsResolve(l, project)).toBe(want);
    }
    const lanes = launchRuntime(l.pinned, l.env);
    expect(path.join(lanes.dir!, 'bun')).toBe(store144);
    expect(lanes.verdict).toBe('skipped');
    expect(lanes.label).toContain('install verdict: not checked');
  });

  test('1.4.2 in $BUN_INSTALL and 1.4.4 in ~/.bun/bin, nothing in the store: the pinned project skips the ineligible 1.4.2; unpinned directories take $BUN_INSTALL first', () => {
    const l = layout({ homeVersion: '1.4.4' });
    const home144 = path.join(l.home, '.bun/bin/bun');
    const bi142 = path.join(l.bunInstall, 'bin/bun');
    for (const [project, want] of [[l.pinned, `${home144} 1.4.4 home`], [l.unpinned, `${bi142} 1.4.2 BUN_INSTALL`], [null, `${bi142} 1.4.2 BUN_INSTALL`]] as const) {
      expect(bashResolve(l, project)).toBe(want);
      expect(tsResolve(l, project)).toBe(want);
    }
  });

  test('no eligible candidate: both twins return nothing (the shim and the old image Bun are never chosen)', () => {
    const l = layout();
    fs.rmSync(path.join(l.bunInstall, 'bin/bun'));
    expect(bashResolve(l, l.pinned)).toBe('');
    expect(tsResolve(l, l.pinned)).toBe('');
    expect(launchRuntime(l.pinned, l.env).dir).toBeNull();
  });

  test('a symlinked candidate resolves to its target realpath in both twins (portable readlink loop, no realpath(1))', () => {
    const l = layout({ storeVersions: ['1.4.4'] });
    const linkDir = path.join(l.base, 'links');
    fs.mkdirSync(linkDir);
    fs.symlinkSync('../home/.gstack/runtimes/bun/1.4.4/bun', path.join(linkDir, 'bun'));
    fs.rmSync(path.join(l.bunInstall, 'bin/bun'));
    const env = { ...l.env, GSTACK_STATE_ROOT: path.join(l.base, 'elsewhere'), PATH: `${linkDir}:${l.env.PATH}` };
    const want = `${path.join(bunStore(l.state), '1.4.4/bun')} 1.4.4 PATH`;
    expect(bashResolve({ ...l, env, state: env.GSTACK_STATE_ROOT }, null)).toBe(want);
    expect(tsResolve({ ...l, env, state: env.GSTACK_STATE_ROOT }, null)).toBe(want);
  });

  // Integration item 8: the gstack checkout itself binds the 'none' verdict.
  test('launchRuntime on the gstack checkout reads the none verdict and launches its recorded Bun', () => {
    const l = layout({ storeVersions: ['1.4.4'] });
    const { installVerdictPath } = require('../lib/install-verdict') as typeof import('../lib/install-verdict');
    const checkout = fs.realpathSync(ROOT);
    const file = installVerdictPath(checkout, l.state, null);
    const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema_version: 2, checkout, project: '', head, for: 'ship', required: ['claude', 'codex', 'patch'], pins_planning_only: false, ok: true, trailer: 'gstack: ok', min_revision: '', launch_path: '', time: '', bun_path: REAL_BUN, bun_version: Bun.version }));
    const r = launchRuntime(ROOT, l.env);
    expect(r.refusal).toBeNull();
    expect(r.verdict).toBe('ok');
    expect(r.label).toBe(`bun ${Bun.version} at ${REAL_BUN} (recorded by the install verdict)`);
    expect(r.dir).toBe(path.dirname(REAL_BUN));
    const launch = path.join(l.state, 'install-verdicts', 'x.launch');
    fs.mkdirSync(launch, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), launch_path: launch }));
    const viaLaunch = launchRuntime(ROOT, l.env);
    expect(viaLaunch.dir).toBe(launch);
    expect(viaLaunch.env.PATH?.split(path.delimiter)[0]).toBe(launch);
  });

  // GST-1233: a docs child's install replaced the shared verdict and republished the shared launch
  // directory with its own Bun; the finish pregate admits from ship's own record and launches ship's Bun.
  test("launchRuntime admits /ship from its own record when another workflow's install replaced the shared verdict, and never launches that install's Bun", () => {
    const l = layout({ storeVersions: ['1.4.4'] });
    const { installVerdictPath } = require('../lib/install-verdict') as typeof import('../lib/install-verdict');
    const checkout = fs.realpathSync(ROOT);
    const file = installVerdictPath(checkout, l.state, null);
    const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const childBun = path.join(bunStore(l.state), '1.4.4/bun');
    const launch = file.replace(/\.json$/, '.launch');
    fs.mkdirSync(launch, { recursive: true });
    fs.symlinkSync(childBun, path.join(launch, 'bun'));
    const record = { schema_version: 2, checkout, project: '', head, pins_planning_only: false, ok: true, min_revision: '', launch_path: launch, time: '' };
    fs.writeFileSync(file, JSON.stringify({ ...record, for: 'document-release', required: ['claude'], trailer: 'gstack: ok for=document-release', bun_path: fs.realpathSync(childBun), bun_version: '1.4.4' }));
    const refused = launchRuntime(ROOT, l.env);
    expect(refused.refusal).toMatchObject({ code: 'INSTALL_UNVERIFIED' });
    expect(refused.refusal?.detail).toContain('certified for=document-release');
    const own = file.replace(/\.json$/, '.for/ship.json');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, JSON.stringify({ ...record, for: 'ship', required: ['claude', 'codex', 'patch'], trailer: 'gstack: ok for=ship', bun_path: REAL_BUN, bun_version: Bun.version }));
    const r = launchRuntime(ROOT, l.env);
    expect(r.refusal).toBeNull();
    expect(r.verdict).toBe('ok');
    expect(r.label).toBe(`bun ${Bun.version} at ${REAL_BUN} (recorded by the install verdict)`);
    expect(r.dir).toBe(path.dirname(REAL_BUN));
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ok: false, trailer: 'gstack: fail setup — ./setup failed' }));
    expect(launchRuntime(ROOT, l.env).refusal?.detail).toBe('install verdict: the install verdict says: gstack: fail setup — ./setup failed');
  });
});
