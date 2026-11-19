import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

const source = fs.readFileSync(path.resolve(import.meta.dir, '../bin/gstack-doctor'), 'utf8');
const check = /^check_windows_bash\(\) \{[\s\S]*?^\}/m.exec(source)![0];
const cases = [
  { name: 'native path and source', output: 'WINDOWS_BASH: C:\\Program Files\\Git\\bin\\bash.exe\nWINDOWS_BASH_SOURCE: git --exec-path\n', rc: 0,
    state: 'ok', detail: 'C:\\Program Files\\Git\\bin\\bash.exe (chosen by git --exec-path)' },
  { name: 'warning remains a warning', output: 'WINDOWS_BASH: C:/Git/bash.exe\nWINDOWS_BASH_SOURCE: legacy\nWINDOWS_BASH_WARNING: legacy candidate ignored\n', rc: 0,
    state: 'warn', detail: 'C:/Git/bash.exe (chosen by legacy); legacy candidate ignored', fix: 'unset GSTACK_BASH' },
  { name: 'refusal outranks a path', output: 'WINDOWS_BASH: C:/Git/bash.exe\nWINDOWS_BASH_REFUSED: refused chosen candidate\n', rc: 1,
    state: 'fail', detail: 'refused chosen candidate', fix: 'GSTACK_GIT_BASH' },
  { name: 'first empty path is retained', output: 'WINDOWS_BASH: \nWINDOWS_BASH: C:/later/bash.exe\n', rc: 0,
    state: 'warn', detail: 'not checked: gstack-windows-bash exited 0 (WINDOWS_BASH: )', fix: './setup' },
  { name: 'first empty source and warning are retained', output: 'WINDOWS_BASH: C:/Git/bash.exe\nWINDOWS_BASH_SOURCE: \nWINDOWS_BASH_SOURCE: later\nWINDOWS_BASH_WARNING: \nWINDOWS_BASH_WARNING: later warning\n', rc: 0,
    state: 'ok', detail: 'C:/Git/bash.exe (chosen by )' },
  { name: 'failed helper stays unverified', output: 'discovery failed\nmore detail\n', rc: 42,
    state: 'warn', detail: 'not checked: gstack-windows-bash exited 42 (discovery failed)', fix: './setup' },
  { name: 'controls are removed and shell text remains literal', output: 'WINDOWS_BASH: C:/Git/$(untrusted)\r/bash.exe\nWINDOWS_BASH_SOURCE: \u001bgit\n', rc: 0,
    state: 'ok', detail: 'C:/Git/$(untrusted)/bash.exe (chosen by git)' },
];

// Value: protects=doctor uses the probe's first fields without misreporting readiness;
//   fails_when=empty/duplicate fields, native paths or refusal/error output changes its row
test.each(cases)('Windows Bash probe output: $name', scenario => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bash-output-'));
  try {
    fs.writeFileSync(path.join(dir, 'gstack-windows-bash.ts'), '');
    const output = path.join(dir, 'probe-output'); fs.writeFileSync(output, scenario.output);
    const result = runBashScript(`BIN="$DOCTOR_BASH_TEST_BIN"; SRC=fixture; DOCS=docs
bun() { cat "$DOCTOR_BASH_TEST_OUTPUT"; return "$DOCTOR_BASH_TEST_RC"; }
row() { printf '%s\\0' "$@"; }
${check}
check_windows_bash`, { env: { ...process.env, DOCTOR_BASH_TEST_BIN: dir.replaceAll('\\', '/'),
      DOCTOR_BASH_TEST_OUTPUT: output.replaceAll('\\', '/'), DOCTOR_BASH_TEST_RC: String(scenario.rc) }, timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const [state, label, detail, fix] = result.stdout.split('\0');
    expect(state).toBe(scenario.state); expect(label).toBe('windows bash'); expect(detail).toBe(scenario.detail);
    if (scenario.fix) expect(fix).toContain(scenario.fix);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
