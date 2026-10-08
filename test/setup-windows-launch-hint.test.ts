import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

// #2595/#2124: on Windows, setup launches each compiled binary's --version
// after the build and explains a Smart App Control block: the blocked
// binaries, the skills that need them, #2595, the shell and WSL status, how to
// undo it and the troubleshooting link. Runs setup's real function against
// stand-in binaries; a real SAC block cannot be produced in CI.
const ROOT = path.resolve(import.meta.dir, '..');
const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const fn = (name: string) => {
  const start = setup.indexOf(`\n${name}() {`);
  const end = setup.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`missing setup function ${name}`);
  return setup.slice(start + 1, end + 3);
};
const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });
const temp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmps.push(d); return d; };
const stub = (dir: string, name: string, body: string) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

test('setup runs the launch summary only on Windows, after the CSO summary', () => {
  const call = setup.indexOf('if [ "$IS_WINDOWS" -eq 1 ]; then\n  _windows_launch_summary\nfi');
  expect(call).toBeGreaterThan(setup.indexOf('# ─── CSO native-helper summary'));
});

describe.skipIf(process.platform === 'win32')('setup: Windows Smart App Control hint (#2595)', () => {
  function run(binaries: Record<string, string>, wsl: boolean) {
    const src = temp('gstack-sac-src-');
    const tools = temp('gstack-sac-tools-');
    fs.mkdirSync(path.join(src, 'bin'));
    fs.copyFileSync(path.join(ROOT, 'bin/gstack-launch-probe.sh'), path.join(src, 'bin/gstack-launch-probe.sh'));
    for (const [rel, body] of Object.entries(binaries)) {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), `#!/bin/sh\n${body}\n`, { mode: body === 'BLOCKED' ? 0o644 : 0o755 });
    }
    stub(tools, 'uname', 'echo MINGW64_NT-10.0-26200');
    if (wsl) stub(tools, 'wsl.exe', 'exit 0');
    const r = runBashScript(['QUIET=0', `SOURCE_GSTACK_DIR="${src}"`, 'log() { echo "$@"; }', fn('_windows_launch_summary'), '_windows_launch_summary'].join('\n'),
      { env: { ...process.env, PATH: `${tools}:${process.env.PATH}` }, timeout: 60_000 });
    expect(r.status).toBe(0);
    return { out: r.stdout, src };
  }
  const healthy = 'echo 1.0';

  test('blocked binaries are named with their skills, #2595, the shell, WSL status, undo and the docs link', () => {
    const { out } = run({
      'browse/dist/browse.exe': 'BLOCKED',
      'browse/dist/find-browse.exe': healthy,
      'design/dist/design.exe': healthy,
      'make-pdf/dist/pdf.exe': "echo \"Program 'pdf.exe' failed to run: An Application Control policy has blocked this file\" >&2; exit 1",
      'bin/gstack-global-discover.exe': healthy,
    }, false);
    expect(out).toContain('Windows blocked compiled gstack binaries at launch (Smart App Control or another application-control policy, #2595):');
    expect(out).toMatch(/browse\/dist\/browse\.exe: .*Permission denied.* -> \/browse, \/qa, /);
    expect(out).toContain('make-pdf/dist/pdf.exe: Program \'pdf.exe\' failed to run: An Application Control policy has blocked this file -> /make-pdf');
    expect(out).toContain('code integrity, not file permissions');
    expect(out).toContain('You ran setup from Git Bash, where the block applies; WSL is not installed (wsl --install)');
    expect(out).toContain('To undo: once Windows allows the binaries, re-run ./setup');
    expect(out).toContain('troubleshooting.md#windows-smart-app-control');
    expect(out).not.toContain('design/dist/design.exe');
  });

  test('WSL presence is reported', () => {
    expect(run({ 'browse/dist/browse.exe': 'BLOCKED' }, true).out).toContain('WSL is installed, and gstack inside WSL is not affected');
  });

  test('a binary that launches and fails is a build problem, not Smart App Control', () => {
    const { out, src } = run({
      'browse/dist/browse.exe': healthy, 'browse/dist/find-browse.exe': healthy, 'design/dist/design.exe': healthy,
      'make-pdf/dist/pdf.exe': healthy, 'bin/gstack-global-discover.exe': 'echo "Unknown argument: --version" >&2; exit 1',
    }, false);
    expect(out).not.toContain('Smart App Control or another');
    expect(out).toContain('bin/gstack-global-discover.exe: exit 1: Unknown argument: --version -> /retro global');
    expect(out).toContain(`Rebuild: cd ${src} && bun run build`);
  });

  test('healthy binaries print nothing', () => {
    const all = Object.fromEntries(['browse/dist/browse.exe', 'browse/dist/find-browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe', 'bin/gstack-global-discover.exe'].map(rel => [rel, healthy]));
    expect(run(all, false).out).toBe('');
  });
});
