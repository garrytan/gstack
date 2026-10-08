import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runBashScript } from './helpers/bash-script';

// #3071: scripts/build-cso.sh records each run's outcome in
// bin/.gstack-cso-build-result for setup's summary and gstack-doctor, and the
// parent clears its EXIT trap before exec'ing the native publisher so only the
// locked child cleans the stage. The real script runs; only compilation and
// the publisher lock are substituted (same seam as test/cso-distribution.test.ts).
const ROOT = resolve(import.meta.dir, '..');
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-cso-result-')); temps.push(dir);
  for (const sub of ['scripts', 'bin', 'lib/cso']) mkdirSync(join(dir, sub), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/build-cso.sh'), join(dir, 'scripts/build-cso.sh'));
  writeFileSync(join(dir, 'VERSION'), '9.9.9.9\n');
  writeFileSync(join(dir, 'publish lock'), '#!/bin/sh\nset -eu\nshift\nexport GSTACK_CSO_PUBLISH_LOCKED=1\nexec "$@"\n');
  chmodSync(join(dir, 'publish lock'), 0o755);
  const compiler = [
    '#!/bin/sh', 'set -eu',
    'count_file="$CSO_FIXTURE/compiler.count"; count=0',
    '[ ! -f "$count_file" ] || count=$(cat "$count_file")',
    'count=$((count+1)); printf "%s\\n" "$count" > "$count_file"',
    'if [ "${CSO_FAIL_COMPILER_N:-0}" = "$count" ]; then echo "fixture compiler failed" >&2; exit 42; fi',
    'output=""',
    'while [ "$#" -gt 0 ]; do case "$1" in --outfile|-o) shift; output="$1" ;; esac; shift; done',
    'if [ -n "$output" ]; then',
    '  case "$output" in',
    '    *gstack-cso-publish-lock*) cp "$CSO_FIXTURE/publish lock" "$output" ;;',
    '    *) printf "#!/bin/sh\\nprintf NEW\\\\n\\n" > "$output" ;;',
    '  esac',
    '  chmod +x "$output"',
    'fi', '',
  ].join('\n');
  writeFileSync(join(dir, 'compiler'), compiler); chmodSync(join(dir, 'compiler'), 0o755);
  return dir;
}

function seedOld(dir: string, installed = '9.9.9.8 (0123456789ab)') {
  for (const name of ['gstack-cso-launcher', 'gstack-cso-core', 'gstack-cso-watchdog']) {
    writeFileSync(join(dir, 'bin', name), '#!/bin/sh\nprintf OLD\\\\n\n'); chmodSync(join(dir, 'bin', name), 0o755);
  }
  writeFileSync(join(dir, 'bin', '.gstack-cso-generation'), '0'.repeat(64) + '\n');
  writeFileSync(join(dir, 'bin', '.gstack-cso-build-result'), `result=ok\nstage=publish\nreason=committed\nrevision=${installed}\ninstalled=${installed}\nlauncher=yes\ndiagnostic=old\n`);
}

function build(dir: string, env = '') {
  return runBashScript(`${env} GIT_CEILING_DIRECTORIES=${quote(dirname(dir))} CSO_FIXTURE=${quote(dir)} BUN_CMD=${quote(join(dir, 'compiler'))} CSO_CC=${quote(join(dir, 'compiler'))} bash ${quote(join(dir, 'scripts/build-cso.sh'))}`, { timeout: 15_000 });
}

function record(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(dir, 'bin', '.gstack-cso-build-result'), 'utf8').trim().split('\n')) {
    const at = line.indexOf('=');
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}
const stages = (dir: string) => readdirSync(join(dir, 'bin')).filter(name => name.startsWith('.gstack-cso-stage.'));
const launcherOutput = (dir: string) => readFileSync(join(dir, 'bin', 'gstack-cso-launcher'), 'utf8');

describe.skipIf(process.platform === 'win32')('build-cso.sh build-result record (#3071)', () => {
  test('a successful build records ok with this revision installed', () => {
    const dir = fixture();
    const r = build(dir, `GSTACK_CSO_BUILD_LOG=${quote(join(dir, 'cso.log'))}`);
    expect(r.status, r.stderr).toBe(0);
    expect(record(dir)).toMatchObject({ result: 'ok', stage: 'publish', revision: '9.9.9.9', installed: '9.9.9.9', launcher: 'yes', diagnostic: join(dir, 'cso.log') });
    expect(stages(dir)).toEqual([]);
  });

  test('a fresh build failure records the build stage with no usable launcher', () => {
    const dir = fixture();
    const r = build(dir, 'CSO_FAIL_COMPILER_N=1');
    expect(r.status).toBe(42);
    expect(record(dir)).toMatchObject({ result: 'failed', stage: 'build', reason: 'exit 42', installed: '', launcher: 'no' });
    expect(stages(dir)).toEqual([]);
  });

  test('a failed upgrade keeps the previous generation and names its revision', () => {
    const dir = fixture(); seedOld(dir);
    const r = build(dir, 'GSTACK_CSO_BUILD_TESTING=1 GSTACK_CSO_BUILD_TEST_FAIL_AFTER=publish-core');
    expect(r.status).toBe(86);
    expect(launcherOutput(dir)).toContain('OLD');
    expect(record(dir)).toMatchObject({ result: 'failed', stage: 'publish', reason: 'exit 86', revision: '9.9.9.9', installed: '9.9.9.8 (0123456789ab)', launcher: 'yes' });
    expect(stages(dir)).toEqual([]);
  });

  test('a publish killed mid-flight leaves an interrupted publish record', () => {
    const dir = fixture(); seedOld(dir);
    const r = build(dir, 'GSTACK_CSO_BUILD_TESTING=1 GSTACK_CSO_BUILD_TEST_KILL_AFTER=publish-core');
    expect(r.status).not.toBe(0);
    expect(record(dir)).toMatchObject({ result: 'failed', stage: 'publish', reason: 'interrupted' });
    expect(existsSync(join(dir, 'bin', 'gstack-cso-launcher'))).toBe(false);
  });

  test('a missing publisher at exec time cleans the stage and keeps the old generation', () => {
    const dir = fixture(); seedOld(dir);
    const r = build(dir, 'GSTACK_CSO_BUILD_TESTING=1 GSTACK_CSO_BUILD_TEST_REMOVE_LOCKER_AFTER=before-exec');
    expect(r.status).toBe(127);
    expect(r.stderr).toContain('CSO publication could not start');
    expect(stages(dir)).toEqual([]);
    expect(launcherOutput(dir)).toContain('OLD');
    expect(record(dir)).toMatchObject({ result: 'failed', stage: 'publish', reason: 'exit 127', installed: '9.9.9.8 (0123456789ab)', launcher: 'yes' });
  });
});

describe('build-cso.sh publisher handoff (#3071)', () => {
  const source = readFileSync(join(ROOT, 'scripts/build-cso.sh'), 'utf8');
  test('the parent checks the publisher, then clears its EXIT trap, then execs', () => {
    const exec = source.indexOf('exec "$CSO_STAGE_LOCKER"');
    const clear = source.lastIndexOf('trap - EXIT', exec);
    const check = source.lastIndexOf('cso_valid_artifact "$CSO_STAGE_LOCKER"', clear);
    expect(exec).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(check);
    expect(check).toBeGreaterThan(0);
    expect(source.slice(check, exec)).toContain('shopt -s execfail');
    expect(source.slice(exec)).toContain('cso_cleanup "$cso_exec_status"');
  });

  test('the Windows build prefers PowerShell 7 and falls back to Windows PowerShell', () => {
    expect(source).toContain('CSO_POWERSHELL="$(command -v pwsh 2>/dev/null || command -v powershell.exe 2>/dev/null || true)"');
    expect(source).not.toMatch(/^\s*powershell\.exe /m);
  });
});
