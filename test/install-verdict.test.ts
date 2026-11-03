/**
 * lib/install-verdict.ts and bin/gstack-install-verdict.sh: the one reader of
 * the install verdict gstack-capy-install writes, shared by gstack-skill-start
 * (Bash) and gstack-autoplan's mutating verbs (TypeScript). Pinned on the
 * admission decision (who must hold a verdict, what a verdict admits), the
 * verdict path keyed by the source checkout's realpath, and the source-root
 * resolution through an installed root's .source-path.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkInstallAdmission, installVerdictPath, legacyInstallVerdictPath, readInstallVerdict, sourceRoot } from '../lib/install-verdict';

const ROOT = path.resolve(import.meta.dir, '..');
const REAL = fs.realpathSync(ROOT);
const HEAD = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 }).trim();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'install-verdict-')); dirs.push(d); return d; };
const writeVerdict = (stateRoot: string, over: Record<string, unknown> = {}, file = installVerdictPath(REAL, stateRoot, (over.project as string) || null)) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1, checkout: REAL, head: HEAD, for: 'autoplan',
    required: ['claude', 'codex', 'patch', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision'],
    pins_planning_only: false, ok: true, trailer: 'gstack: ok 9.9.9.9 for=autoplan', min_revision: 'unknown', launch_path: '', time: '2026-10-12T00:00:00Z', ...over,
  }));
  return file;
};

describe('install verdict (TypeScript)', () => {
  test('the verdict path is keyed by sha256 of the checkout and of the project (or "none") under <state root>/install-verdicts; the schema 1 path stays readable', () => {
    const sr = tmp();
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    expect(installVerdictPath(REAL, sr)).toBe(path.join(sr, 'install-verdicts', sha(REAL), `${sha('none')}.json`));
    expect(installVerdictPath(REAL, sr, '/p/a')).toBe(path.join(sr, 'install-verdicts', sha(REAL), `${sha('/p/a')}.json`));
    expect(legacyInstallVerdictPath(REAL, sr)).toBe(path.join(sr, 'install-verdicts', `${sha(REAL)}.json`));
    const bashPath = spawnSync('bash', ['-c', `. "${path.join(ROOT, 'bin/gstack-install-verdict.sh')}" && gstack_install_verdict_path "$1" "$2" "$3" && gstack_install_verdict_path "$1" "$2" "" && gstack_install_verdict_legacy_path "$1" "$2"`, '_', sr, REAL, '/p/a'], { encoding: 'utf8', timeout: 30_000 });
    expect(bashPath.stdout.trim().split('\n')).toEqual([installVerdictPath(REAL, sr, '/p/a'), installVerdictPath(REAL, sr), legacyInstallVerdictPath(REAL, sr)]);
    expect(readInstallVerdict(path.join(sr, 'nope.json'))).toBeNull();
    expect(readInstallVerdict(writeVerdict(sr))?.head).toBe(HEAD);
  });

  test('admission: only unattended and Capy-spawned sessions apply; a runtime below the minimum refuses; GSTACK_CAPY=1 needs a matching verdict', () => {
    const sr = tmp();
    const base = { skill: 'autoplan', gstackRoot: ROOT, bunVersion: '1.4.2' };
    expect(checkInstallAdmission({ ...base, env: {} }).applies).toBe(false);
    const unattended = { GSTACK_SESSION_KIND: 'unattended', GSTACK_STATE_ROOT: sr };
    expect(checkInstallAdmission({ ...base, env: unattended })).toMatchObject({ applies: true, refuse: false });
    const oldBun = checkInstallAdmission({ ...base, env: unattended, bunVersion: '1.3.14' });
    expect(oldBun).toMatchObject({ refuse: true, status: 'runtime', code: 'RUNTIME_BELOW_MINIMUM' });
    expect(oldBun.line).toMatch(/^INSTALL: fail runtime — bun 1\.3\.14 .*below the supported minimum 1\.4\.2; fix: .+ \(RUNTIME_BELOW_MINIMUM\)$/);
    const capy = { ...unattended, GSTACK_CAPY: '1' };
    expect(checkInstallAdmission({ ...base, env: capy })).toMatchObject({ refuse: true, status: 'verdict', code: 'INSTALL_UNVERIFIED' });
    writeVerdict(sr);
    expect(checkInstallAdmission({ ...base, env: capy })).toMatchObject({ refuse: false, status: 'ok' });
    expect(checkInstallAdmission({ ...base, skill: 'qa', env: capy })).toMatchObject({ refuse: true, status: 'verdict' });
    writeVerdict(sr, { pins_planning_only: true });
    expect(checkInstallAdmission({ ...base, skill: 'ship', env: capy }).refuse).toBe(true);
    writeVerdict(sr, { head: 'f'.repeat(40) });
    expect(checkInstallAdmission({ ...base, env: capy }).detail).toContain('another HEAD');
    const over = checkInstallAdmission({ ...base, env: { ...capy, GSTACK_ALLOW_UNSUPPORTED_RUNTIME: '1' } });
    expect(over).toMatchObject({ refuse: false, overridden: true });
    expect(checkInstallAdmission({ ...base, env: { GSTACK_SESSION_KIND: 'spawned', GSTACK_CAPY: '1', GSTACK_STATE_ROOT: sr } }).refuse).toBe(true);
    expect(checkInstallAdmission({ ...base, env: { OPENCLAW_SESSION: '1', GSTACK_STATE_ROOT: sr }, bunVersion: '1.3.14' })).toMatchObject({ applies: true, refuse: false, warn: true });
  });
});

// Plan A-c/A5: one record per (checkout, project) holding the Bun resolution;
// both twins pick the same file, bind workflows that run the repo's tests to
// the project, and refuse a running Bun the record did not certify.
describe('install verdict keyed by (checkout, project): both twins', () => {
  const BUN = fs.realpathSync(process.execPath);
  const project = (name: string) => { const d = path.join(fs.realpathSync(tmp()), name); fs.mkdirSync(d); execFileSync('git', ['init', '-q', d], { timeout: 30_000 }); return d; };
  const bashAdmit = (skill: string, cwd: string, env: Record<string, string>) => {
    const r = spawnSync('bash', ['-c', `. "$R/bin/gstack-bun-version.sh" && . "$R/bin/gstack-doctor-components.sh" && . "$R/bin/gstack-install-verdict.sh" && gstack_install_admission "$R/bin" "$1" unattended; printf '%s|%s|%s\n' "$_ia_refuse" "$_ia_status" "$_ia_line"`, '_', skill],
      { cwd, encoding: 'utf8', timeout: 30_000, env: { PATH: `${path.dirname(BUN)}:/usr/bin:/bin`, HOME: os.homedir(), R: ROOT, GSTACK_CAPY: '1', GSTACK_SESSION_KIND: 'unattended', ...env } });
    const [refuse, status, line] = r.stdout.trim().split('|');
    return { refuse: refuse === '1', status, line: line ?? '' };
  };
  const tsAdmit = (skill: string, cwd: string, env: Record<string, string>, bunPath = BUN) =>
    checkInstallAdmission({ skill, gstackRoot: ROOT, cwd, bunVersion: '1.4.2', bunPath, env: { GSTACK_CAPY: '1', GSTACK_SESSION_KIND: 'unattended', ...env } });
  const both = (skill: string, cwd: string, env: Record<string, string>) => {
    const b = bashAdmit(skill, cwd, { _GH: env.GSTACK_STATE_ROOT, ...env });
    const t = tsAdmit(skill, cwd, env);
    expect({ refuse: b.refuse, status: b.status }).toEqual({ refuse: t.refuse, status: t.status });
    return t;
  };

  test('A-B-A across two projects, a no-project directory, explicit GSTACK_INSTALL_VERDICT and the old checkout-only schema', () => {
    const sr = tmp();
    const env = { GSTACK_STATE_ROOT: sr };
    const a = project('a'), b = project('b'), none = fs.realpathSync(tmp());
    const fileA = writeVerdict(sr, { project: a, bun_path: BUN, bun_version: '1.4.2', schema_version: 2, for: 'review' });
    writeVerdict(sr, { project: b, bun_path: BUN, bun_version: '1.4.2', schema_version: 2, for: 'review' });
    for (const dir of [a, b, a]) expect(both('review', dir, env)).toMatchObject({ refuse: false, status: 'ok' });
    expect(both('review', none, env)).toMatchObject({ refuse: true, status: 'verdict' });
    writeVerdict(sr, { project: '', bun_path: BUN, bun_version: '1.4.2', schema_version: 2 });
    expect(both('autoplan', none, env)).toMatchObject({ refuse: false });
    fs.rmSync(installVerdictPath(REAL, sr, b));
    const viaExplicit = both('review', b, { ...env, GSTACK_INSTALL_VERDICT: fileA });
    expect(viaExplicit).toMatchObject({ refuse: true, status: 'verdict' });
    expect(viaExplicit.detail).toBe(`the install verdict checked ${a}, not ${b}, and review runs the repo's tests`);
    expect(viaExplicit.line).toContain(`from ${b}`);
    expect(both('autoplan', b, { ...env, GSTACK_INSTALL_VERDICT: fileA })).toMatchObject({ refuse: false });
    const legacySr = tmp();
    writeVerdict(legacySr, { for: 'review' }, legacyInstallVerdictPath(REAL, legacySr));
    expect(both('review', b, { GSTACK_STATE_ROOT: legacySr })).toMatchObject({ refuse: false, status: 'ok' });
  });

  test("GSTA-85: an installer run from the skill's own folder (no project) leaves /ship from the project with no verdict; both twins name the project directory to run the installer from", () => {
    const sr = tmp();
    const env = { GSTACK_STATE_ROOT: sr };
    const proj = project('lane');
    writeVerdict(sr, { project: '', bun_path: BUN, bun_version: '1.4.2', schema_version: 2, for: 'ship' });
    const r = both('ship', proj, env);
    expect(r).toMatchObject({ refuse: true, status: 'verdict', code: 'INSTALL_UNVERIFIED' });
    expect(r.detail).toBe(`no install verdict at ${installVerdictPath(REAL, sr, proj)} for ${REAL}`);
    const fix = `fix: run the Capy skill installer (scripts/install.sh --for ship) from ${proj}: the verdict is keyed by the project directory the installer runs in, so a run from the skill's own folder does not cover ${proj}; then launch with the GSTACK_LAUNCH line it prints (INSTALL_UNVERIFIED)`;
    expect(r.line).toContain(fix);
    expect(bashAdmit('ship', proj, { _GH: sr, ...env }).line).toContain(fix);
    const file = installVerdictPath(REAL, sr, proj);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json\n');
    const corrupt = both('ship', proj, env);
    expect(corrupt).toMatchObject({ refuse: true, status: 'verdict', code: 'INSTALL_UNVERIFIED' });
    expect(corrupt.detail).toBe(`the install verdict at ${file} is unreadable or has an unsupported schema_version; rerun the installer`);
    expect(bashAdmit('ship', proj, { _GH: sr, ...env }).line).toContain(`the install verdict at ${file} is unreadable or has an unsupported schema_version; rerun the installer`);
    writeVerdict(sr, { project: proj, bun_path: BUN, bun_version: '1.4.2', schema_version: 3, for: 'ship' });
    const future = both('ship', proj, env);
    expect(future).toMatchObject({ refuse: true, status: 'verdict' });
    expect(future.detail).toContain('unsupported schema_version');
  });

  test('GST-1161: a review-voice install on a shared machine never shadows the verdict the session launched with', () => {
    const sr = tmp();
    const proj = project('evals');
    const launched = writeVerdict(sr, { project: '', bun_path: BUN, bun_version: '1.4.2', schema_version: 2, for: 'autoplan' });
    const env = { GSTACK_STATE_ROOT: sr, GSTACK_INSTALL_VERDICT: launched };
    expect(both('autoplan', proj, env)).toMatchObject({ refuse: false, status: 'ok' });
    writeVerdict(sr, { project: proj, bun_path: BUN, bun_version: '1.4.2', schema_version: 2, for: 'review-voice',
      required: ['patch', 'runtime', 'helpers', 'state-root', 'privacy', 'cores', 'revision'], trailer: 'gstack: ok 9.9.9.9 for=review-voice' });
    expect(both('autoplan', proj, env)).toMatchObject({ refuse: false, status: 'ok' });
    const alone = both('autoplan', proj, { GSTACK_STATE_ROOT: sr });
    expect(alone).toMatchObject({ refuse: true, status: 'verdict', code: 'INSTALL_UNVERIFIED' });
    expect(alone.detail).toContain('certified for=review-voice');
    const gone = both('autoplan', proj, { GSTACK_STATE_ROOT: sr, GSTACK_INSTALL_VERDICT: path.join(sr, 'gone.json') });
    expect(gone.detail).toContain('certified for=review-voice');
    writeVerdict(sr, { project: proj, schema_version: 3, for: 'review-voice' });
    expect(both('autoplan', proj, env).detail).toContain('unsupported schema_version');
  });

  test('a running Bun other than the recorded one refuses with BUN_RESOLUTION_DRIFT and names both', () => {
    const sr = tmp();
    const a = project('a');
    writeVerdict(sr, { project: a, bun_path: '/opt/other/bun', bun_version: '1.4.3', schema_version: 2, for: 'review' });
    const t = both('review', a, { GSTACK_STATE_ROOT: sr });
    expect(t).toMatchObject({ refuse: true, status: 'runtime', code: 'BUN_RESOLUTION_DRIFT' });
    expect(t.line).toBe(`INSTALL: fail runtime — bun 1.4.2 at ${BUN} is running, but the install verdict recorded bun 1.4.3 at /opt/other/bun; fix: launch with the GSTACK_LAUNCH line (PATH=/opt/other:$PATH), or re-run the Capy skill installer with --check (scripts/install.sh --check --for review) to see what changed (BUN_RESOLUTION_DRIFT)`);
    expect(bashAdmit('review', a, { _GH: sr }).line).toContain('(BUN_RESOLUTION_DRIFT)');
  });
});

describe('source root and support file (one helper, direct and symlinked layouts)', () => {
  const bash = (bin: string, fn: string) => spawnSync('bash', ['-c', `. "${path.join(ROOT, 'bin/gstack-install-verdict.sh')}" && ${fn}`, '_', bin], { encoding: 'utf8', timeout: 30_000 });
  test('a checkout bin resolves to the checkout; an installed root follows .source-path; both read capy/support.env', () => {
    const runtime = tmp();
    fs.symlinkSync(path.join(ROOT, 'bin'), path.join(runtime, 'bin'));
    fs.writeFileSync(path.join(runtime, '.source-path'), `${ROOT}\n`);
    const linked = path.join(tmp(), 'gstack');
    fs.symlinkSync(ROOT, linked);
    for (const bin of [path.join(ROOT, 'bin'), path.join(runtime, 'bin'), path.join(linked, 'bin')]) {
      expect(bash(bin, 'gstack_source_root "$1"').stdout.trim(), bin).toBe(REAL);
      expect(sourceRoot(path.dirname(bin))).toBe(REAL);
      expect(bash(bin, 'gstack_support_env_get "$(gstack_source_root "$1")" GSTACK_MIN_REVISION').stdout.trim()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });
});
