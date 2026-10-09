import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

// #2595/#2124: Smart App Control blocks unsigned binaries at launch and Git
// Bash reports it as "Permission denied" (exit 126). bin/gstack-launch-probe.sh
// runs each binary's --version and tells blocked from broken from healthy.
// The exact Windows text is unverified (no SAC machine); these cases use the
// shapes reporters captured in #2595 and #2124.
const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin/gstack-launch-probe.sh');
const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

function fakeBinary(body: string | null, mode = 0o755) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-launch-probe-'));
  tmps.push(dir);
  const file = path.join(dir, 'tool');
  if (body !== null) fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode });
  return file;
}

function probe(file: string) {
  const r = runBashScript(`. ${JSON.stringify(PROBE)}\ngstack_launch_probe ${JSON.stringify(file)}\nprintf 'state=%s\\ndetail=%s\\n' "$_glp_state" "$_glp_detail"`, { timeout: 30_000 });
  expect(r.status).toBe(0);
  return { state: r.stdout.match(/^state=(.*)$/m)![1], detail: r.stdout.match(/^detail=(.*)$/m)![1] };
}

// POSIX execute bits stand in for a refused launch; Windows has no such bit,
// and a real SAC block cannot be produced in CI.
describe.skipIf(process.platform === 'win32')('gstack-launch-probe.sh classification', () => {
  test('a binary that answers --version is native', () => {
    expect(probe(fakeBinary('[ "$1" = --version ] && echo 1.2.3'))).toEqual({ state: 'native', detail: '1.2.3' });
  });

  test('a binary the OS refuses to execute is blocked (Git Bash "Permission denied", exit 126)', () => {
    const r = probe(fakeBinary('echo never', 0o644));
    expect(r.state).toBe('blocked');
    expect(r.detail).toContain('Permission denied');
  });

  test('an application-control message is blocked even with another exit code', () => {
    const r = probe(fakeBinary("echo \"Program 'browse.exe' failed to run: An Application Control policy has blocked this file\" >&2; exit 1"));
    expect(r.state).toBe('blocked');
    expect(r.detail).toContain('An Application Control policy has blocked this file');
  });

  test('a binary that launches and exits non-zero is broken, not blocked', () => {
    expect(probe(fakeBinary('echo "Unknown argument: --version" >&2; exit 3'))).toEqual({ state: 'broken', detail: 'exit 3: Unknown argument: --version' });
  });

  test('an absent binary is missing', () => {
    expect(probe(fakeBinary(null)).state).toBe('missing');
  });

  test('probe_all groups blocked, broken and missing binaries by repo path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-launch-root-'));
    tmps.push(root);
    const write = (rel: string, body: string, mode = 0o755) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), `#!/bin/sh\n${body}\n`, { mode });
    };
    write('browse/dist/browse.exe', 'echo x', 0o644);
    write('browse/dist/find-browse.exe', 'echo ok');
    write('design/dist/design.exe', 'echo ok');
    write('make-pdf/dist/pdf.exe', 'exit 2');
    const r = runBashScript(`. ${JSON.stringify(PROBE)}\ngstack_launch_probe_all ${JSON.stringify(root)} .exe\nprintf 'blocked=[%s]\\nbroken=[%s]\\nmissing=[%s]\\n' "$_glp_blocked" "$_glp_broken" "$_glp_missing"`, { timeout: 30_000 });
    expect(r.stdout).toContain('blocked=[browse/dist/browse\t');
    expect(r.stdout).toContain('broken=[make-pdf/dist/pdf\texit 2');
    expect(r.stdout).toContain('missing=[bin/gstack-global-discover]');
    expect(r.stdout).not.toContain('design/dist/design');
  });
});
