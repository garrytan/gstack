import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

// #3071: CSO is optional, so a failed CSO build or publish must not abort
// scripts/build.sh before the browse server bundle and the completion stamp.
// GSTACK_STRICT_BUILD=1 (CI) keeps it fatal. Runs build.sh's real CSO block
// with scripts/build-cso.sh replaced by a stub that fails at a chosen stage.
const ROOT = path.resolve(import.meta.dir, '..');
const BUILD = fs.readFileSync(path.join(ROOT, 'scripts/build.sh'), 'utf8');
const START = 'if [ "${GSTACK_SETUP_RUNNING:-0}" = "1" ] && [ "${GSTACK_SETUP_SKIP_CSO_BUILD:-0}" = "1" ]; then';
const END = '\nbash browse/scripts/build-node-server.sh';
const block = BUILD.slice(BUILD.indexOf(START), BUILD.indexOf(END));
const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

function run(strict: string | undefined, status = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-build-cso-nonfatal-'));
  tmps.push(dir);
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts/build-cso.sh'), [
    'echo "stub CSO output (log=$GSTACK_CSO_BUILD_LOG)"',
    'echo "Staged CSO core is not one executable regular file." >&2',
    "printf 'result=failed\\nstage=publish\\n' > bin/.gstack-cso-build-result",
    `exit ${status}`, '',
  ].join('\n'));
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (strict !== undefined) env.GSTACK_STRICT_BUILD = strict;
  const r = runBashScript(`set -e\nROOT=${JSON.stringify(dir)}\nBUN_CMD=bun\n${block}\necho BUILD-CONTINUED`, { cwd: dir, env, timeout: 15_000 });
  return { ...r, dir, log: path.join(dir, 'bin/.gstack-cso-build.log') };
}

// The block runs under any bash; Windows paths in the messages would only add
// quoting noise, and the Windows lane covers this in windows-setup-e2e.
describe.skipIf(process.platform === 'win32')('scripts/build.sh: CSO failure is non-fatal unless GSTACK_STRICT_BUILD=1 (#3071)', () => {
  test('a CSO publish failure is reported with its stage, log and retry, and the build continues', () => {
    const r = run(undefined);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('BUILD-CONTINUED');
    expect(r.stderr).toContain('CSO unavailable: the publish step failed; the rest of the build continues.');
    expect(r.stderr).toContain(`Log: ${r.log}`);
    expect(r.stderr).toContain(`Retry: cd ${r.dir} && bun run build:cso`);
    const log = fs.readFileSync(r.log, 'utf8');
    expect(log).toContain(`stub CSO output (log=${r.log})`);
    expect(log).toContain('Staged CSO core is not one executable regular file.');
  });

  test('GSTACK_STRICT_BUILD=0 is the same non-fatal path', () => {
    expect(run('0').status).toBe(0);
  });

  test('GSTACK_STRICT_BUILD=1 makes the same failure fatal', () => {
    const r = run('1');
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('BUILD-CONTINUED');
    expect(r.stderr).toContain('CSO publish failed and GSTACK_STRICT_BUILD=1 makes it fatal.');
  });

  test('a successful CSO build prints no unavailable line', () => {
    const r = run('1', 0);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('CSO unavailable');
  });

});

describe('scripts/build.sh: CSO step order (#3071)', () => {
  test('the server bundle and stamp still come after the CSO step', () => {
    const cso = BUILD.indexOf('bash scripts/build-cso.sh');
    expect(BUILD.indexOf('bash browse/scripts/build-node-server.sh')).toBeGreaterThan(cso);
    expect(BUILD.indexOf('mv -f "$BUILD_STAMP_TMP" "$BUILD_STAMP"')).toBeGreaterThan(cso);
  });
});
