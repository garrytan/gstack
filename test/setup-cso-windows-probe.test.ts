import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

// E2 (#3015): the Windows /cso build compiles with /W4 /WX, and the Windows
// SDK's winbase.h raises C5105, so every MSVC build failed; and setup reported
// every probe failure as a missing Visual Studio toolchain. The probe and the
// helper builds disable only C5105, and a probe that found MSVC but could not
// compile gets its own reason with the compiler's first diagnostic. Runs the
// real setup function on any OS with powershell.exe/cygpath stubbed.
const ROOT = path.resolve(import.meta.dir, '..');
const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const ps1 = fs.readFileSync(path.join(ROOT, 'scripts/build-cso-windows.ps1'), 'utf8');
const fn = (name: string) => {
  const start = setup.indexOf(`\n${name}() {`);
  const end = setup.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`missing setup function ${name}`);
  return setup.slice(start + 1, end + 3);
};
const summaryStart = setup.indexOf('  case "$CSO_FAIL_REASON" in');
const summaryCase = setup.slice(summaryStart, setup.indexOf('\n  esac\n', summaryStart) + 8);

const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

function probe(powershellOutput: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cso-win-'));
  tmps.push(tmp);
  // setup resolves pwsh before powershell.exe (#3071); stub both so a runner's
  // real PowerShell 7 never answers the probe.
  for (const name of ['pwsh', 'powershell.exe']) {
    fs.writeFileSync(path.join(tmp, name), `#!/bin/sh\ncat <<'OUT' >&2\n${powershellOutput}\nOUT\nexit 1\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(tmp, 'cygpath'), '#!/bin/sh\nshift; echo "$1"\n', { mode: 0o755 });
  return runBashScript([
    'IS_WINDOWS=1', `SOURCE_GSTACK_DIR="${ROOT}"`,
    'bun_cmd() { echo "--no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --no-compile-autoload-package-json"; }',
    fn('_cso_unavailable'), fn('probe_cso_build_prerequisites'),
    'probe_cso_build_prerequisites', summaryCase,
    'printf "reason=%s\\nprereq=%s\\n" "$CSO_FAIL_REASON" "$_CSO_PREREQ"',
  ].join('\n'), { env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` }, timeout: 30_000 });
}

describe('setup: Windows /cso build probe (E2)', () => {
  test('both MSVC compile lines disable only C5105 and keep /W4 /WX', () => {
    const lines = ps1.split('\n').filter(l => l.includes('& $compiler'));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toContain('/W4 /WX /wd5105 ');
  });
});

// The stubs are POSIX shell scripts named powershell.exe and cygpath, so the
// reason mapping runs off Windows; the real probe needs MSVC (not verified here).
describe.skipIf(process.platform === 'win32')('setup: Windows /cso probe failure mapping (E2)', () => {
  test('a compile failure with MSVC present names the compiler error, not a missing toolchain', () => {
    const r = probe([
      "C:\\Program Files (x86)\\Windows Kits\\10\\include\\10.0.19041.0\\um\\winbase.h(9531): error C2220: the following warning is treated as an error",
      'Native CSO Windows compiler probe failed (2).',
    ].join('\n'));
    expect(r.stdout).toContain('reason=windows-msvc-compile\n');
    expect(r.stdout).toContain('prereq=fix the MSVC compile error its toolchain probe reported (');
    expect(r.stdout).toContain('error C2220: the following warning is treated as an error');
    expect(r.stdout).toContain('Visual Studio is already installed');
  });

  test('a missing Visual Studio toolchain keeps the install instruction', () => {
    const r = probe('CSO Windows build requires Visual Studio 2022 Build Tools with the Desktop development with C++ workload.');
    expect(r.stdout).toContain('reason=windows-msvc-toolchain\n');
    expect(r.stdout).toContain('prereq=install Visual Studio 2022 Build Tools with Desktop development with C++\n');
  });
});
