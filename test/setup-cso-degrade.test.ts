import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

// #3071: an optional CSO failure no longer aborts setup. The prerequisite
// probe prefers PowerShell 7 and keeps an unknown failure's own output; the
// summary reads bin/.gstack-cso-build-result and names the failed stage, the
// diagnostic and the retry; only GSTACK_STRICT_BUILD=1 makes an incomplete CSO
// set fatal. Runs setup's real blocks with tools stubbed.
const ROOT = path.resolve(import.meta.dir, '..');
const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const fn = (name: string) => {
  const start = setup.indexOf(`\n${name}() {`);
  const end = setup.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`missing setup function ${name}`);
  return setup.slice(start + 1, end + 3);
};
const between = (from: string, to: string) => {
  const start = setup.indexOf(from);
  const end = setup.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`missing setup block ${from}`);
  return setup.slice(start, end);
};
const SUMMARY_END = '#cso-build-or-publish-failed"\nfi\n';
const SUMMARY = between('# ─── CSO native-helper summary', SUMMARY_END) + SUMMARY_END;
const GATE = between('_CSO_READY=0\n', 'if [ "$_CSO_READY" -eq 1 ]; then');
const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });
const temp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmps.push(d); return d; };
const stub = (dir: string, name: string, body: string) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

function probe(tools: Record<string, string>) {
  const dir = temp('gstack-cso-probe-');
  for (const [name, body] of Object.entries(tools)) stub(dir, name, body);
  stub(dir, 'cygpath', 'shift; echo "$1"');
  return runBashScript([
    'IS_WINDOWS=1', `SOURCE_GSTACK_DIR="${ROOT}"`,
    'bun_cmd() { echo "--no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --no-compile-autoload-package-json"; }',
    fn('_cso_unavailable'), fn('probe_cso_build_prerequisites'),
    'probe_cso_build_prerequisites',
    'printf "available=%s\\nreason=%s\\ndetail=%s\\n" "$CSO_BUILD_AVAILABLE" "$CSO_FAIL_REASON" "$CSO_PROBE_DETAIL"',
  ].join('\n'), { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 30_000 });
}

function summary(record: string | null, opts: { launcher?: boolean } = {}) {
  const dir = temp('gstack-cso-summary-');
  fs.mkdirSync(path.join(dir, 'bin'));
  if (record !== null) fs.writeFileSync(path.join(dir, 'bin/.gstack-cso-build-result'), record);
  if (opts.launcher) for (const name of ['gstack-cso-launcher', 'gstack-cso-core']) stub(path.join(dir, 'bin'), name, 'echo OLD');
  const r = runBashScript(['QUIET=0', '_EXE=""', `SOURCE_GSTACK_DIR="${dir}"`, fn('log').trim() || 'log() { echo "$@"; }', SUMMARY].join('\n'), { timeout: 15_000 });
  expect(r.status).toBe(0);
  return { out: r.stdout, dir };
}

describe.skipIf(process.platform === 'win32')('setup: Windows CSO probe uses PowerShell 7 and keeps unknown failures (#3071)', () => {
  test('pwsh is preferred over Windows PowerShell 5.1', () => {
    const r = probe({ pwsh: 'exit 0', 'powershell.exe': 'echo "5.1 must not run" >&2; exit 1' });
    expect(r.stdout).toContain('available=1\n');
  });

  test('a crashed probe keeps its exit status and output instead of blaming the MSVC toolchain', () => {
    const r = probe({ pwsh: 'echo "Fatal error. 0xC0000005"; exit 139' });
    expect(r.stdout).toContain('reason=windows-toolchain-probe\n');
    expect(r.stdout).toContain('detail=pwsh exited 139: Fatal error. 0xC0000005\n');
  });

  test('the missing Visual Studio message still maps to the install instruction', () => {
    const r = probe({ pwsh: "echo 'CSO Windows build requires Visual Studio 2022 Build Tools with the Desktop development with C++ workload.' >&2; exit 1" });
    expect(r.stdout).toContain('reason=windows-msvc-toolchain\n');
  });

  test.skipIf(Bun.which('pwsh') !== null)('without pwsh the probe falls back to powershell.exe', () => {
    const r = probe({ 'powershell.exe': 'echo "Native CSO Windows compiler probe failed (2)." >&2; exit 1' });
    expect(r.stdout).toContain('reason=windows-msvc-compile\n');
  });
});

describe.skipIf(process.platform === 'win32')('setup: CSO summary reads the build-result record per stage (#3071)', () => {
  const failed = (stage: string, reason: string, installed = '') =>
    `result=failed\nstage=${stage}\nreason=${reason}\nrevision=1.91.99.0 (abcdef123456)\ninstalled=${installed}\nlauncher=${installed ? 'yes' : 'no'}\ndiagnostic=/src/bin/.gstack-cso-build.log\n`;

  test('a probe failure keeps the prerequisite instruction and names the probe stage', () => {
    const { out } = summary('result=unavailable\nstage=probe\nreason=windows-toolchain-probe\nrevision=1.0\ninstalled=\nlauncher=no\ndiagnostic=pwsh exited 139: Fatal error\n');
    expect(out).toContain('CSO unavailable: its native helper was not built (windows-toolchain-probe).');
    expect(out).toContain('Failed stage: probe.');
    expect(out).toContain('fix the PowerShell toolchain probe failure (pwsh exited 139: Fatal error)');
  });

  test('a fresh build failure names the stage, the log and the retry, never a prerequisite install', () => {
    const { out, dir } = summary(failed('build', 'exit 42'));
    expect(out).toContain("CSO unavailable: the native helper's build step failed (exit 42), so /cso will report not assessed.");
    expect(out).toContain('Diagnostic: /src/bin/.gstack-cso-build.log');
    expect(out).toContain('Everything else is installed and works.');
    expect(out).toContain(`Retry: cd ${dir} && bun run build:cso && ./setup`);
    expect(out).toContain('troubleshooting.md#cso-build-or-publish-failed');
    expect(out).not.toContain('To enable /cso');
    expect(out).not.toMatch(/prerequisite|\binstall (?:a|the|Visual|Git|Bun)\b/i);
  });

  test('a failed publish that kept the earlier helper says previous CSO kept', () => {
    const { out } = summary(failed('publish', 'exit 1', '1.91.34.0 (f67c478f05d8)'), { launcher: true });
    expect(out).toContain('CSO publish step failed (exit 1) for 1.91.99.0 (abcdef123456); previous CSO kept: 1.91.34.0 (f67c478f05d8).');
    expect(out).not.toContain('CSO unavailable');
  });

  test('a recorded old helper whose files are gone is reported unavailable', () => {
    expect(summary(failed('publish', 'exit 1', '1.91.34.0'), { launcher: false }).out).toContain("CSO unavailable: the native helper's publish step failed (exit 1)");
  });

  test('an interrupted publish says so', () => {
    expect(summary(failed('publish', 'interrupted')).out).toContain("publish step was interrupted");
  });

  test('a successful build or a legacy install without a record prints nothing', () => {
    expect(summary('result=ok\nstage=publish\nreason=committed\nrevision=1\ninstalled=1\nlauncher=yes\ndiagnostic=x\n').out).toBe('');
    expect(summary(null).out).toBe('');
  });
});

describe.skipIf(process.platform === 'win32')('setup: an incomplete CSO set is fatal only under GSTACK_STRICT_BUILD=1 (#3071)', () => {
  function gate(strict?: string) {
    const dir = temp('gstack-cso-gate-');
    fs.mkdirSync(path.join(dir, 'bin'));
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    if (strict !== undefined) env.GSTACK_STRICT_BUILD = strict;
    return runBashScript(['set -e', 'CSO_BUILD_AVAILABLE=1', 'IS_WINDOWS=0', '_EXE=""', `SOURCE_GSTACK_DIR="${dir}"`, GATE, 'echo "ready=$_CSO_READY"'].join('\n'), { env, timeout: 15_000 });
  }
  test('by default setup continues without CSO', () => {
    const r = gate();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ready=0');
  });
  test('GSTACK_STRICT_BUILD=1 stops setup', () => {
    const r = gate('1');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CSO build completed without its required native artifact set (GSTACK_STRICT_BUILD=1)');
  });
});
