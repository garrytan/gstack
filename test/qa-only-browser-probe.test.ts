import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startTestServer } from '../browse/test/test-server';
import { bunIsolationArgs } from '../lib/bun-isolation';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'test/fixtures/qa-only-browser-probe.ts');
const FILE_OWNERS = path.join(ROOT, 'browse/test/fixtures/native-cookie-file-owners.ts');

// Windows Free Tests 40624015029, 40842574997, 41068546881 and 41172879765: rm of qa-probe-* hit EBUSY after every child
// had exited. Restart Manager names the holder: a process outside the test (the runner's %TEMP%\provjobd.exe agent)
// opens each newly run browse.exe and lets go 1-52 ms later (GSTA-199 scratch runs 41205291567, 41205903081). Wait only for an
// outside holder of browse.exe, then remove once more; a test-host owner, a holder past 5 s or a second failure throws
// with the owners named.
function removeProbeDirectory(directory: string, browse: string) {
  try { fs.rmSync(directory, { recursive: true, force: true }); return; }
  catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY' || !fs.existsSync(browse)) throw error;
  }
  const deadline = Date.now() + 5_000;
  let receipt: { available?: boolean; owners?: { isTestHost: boolean }[] };
  for (;;) {
    const result = spawnSync(process.execPath, [...bunIsolationArgs(), FILE_OWNERS,
      Buffer.from(JSON.stringify({ root: directory, file: browse, testPid: process.pid })).toString('base64')],
    { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    try { receipt = JSON.parse(result.stdout); } catch { receipt = { available: false }; }
    const outside = receipt.available === true && !!receipt.owners?.length && !receipt.owners.some(owner => owner.isTestHost);
    if (!outside || Date.now() > deadline) break;
    Bun.sleepSync(25);
  }
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch (error) { throw new Error(`${(error as Error).message}; browse.exe owners: ${JSON.stringify(receipt)}`); }
}

test('the report-only fixture serves exactly one bounded, observable defect', async () => {
  const { server, url } = startTestServer();
  try {
    const response = await fetch(url + '/qa-only.html');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toBe(fs.readFileSync(path.join(ROOT, 'browse/test/fixtures/qa-only.html'), 'utf8'));
    expect(html.match(/console\.error\(/g)).toHaveLength(1);
    expect(html).not.toMatch(/<(?:a|form|img)\b/);
    expect(html).toContain('Cannot read properties of undefined');
  } finally {
    server.stop(true);
  }
});

test.each(['success', 'failure', 'existing-screenshot'])('the browser probe retains structured command evidence: %s', scenario => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-probe-'));
  const browse = path.join(directory, process.platform === 'win32' ? 'browse.exe' : 'browse');
  const source = path.join(directory, 'browse.ts');
  const calls = path.join(directory, 'calls.jsonl');
  const screenshot = path.join(directory, 'initial.png');
  if (scenario === 'existing-screenshot') fs.writeFileSync(screenshot, 'previous screenshot');
  fs.writeFileSync(source, `
import {appendFileSync, writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='console' && ${JSON.stringify(scenario)}==='failure') {
  process.stderr.write('console failed\\n');process.exit(7);
}
if(args[0]==='screenshot')writeFileSync(args[1],'fixture image');
process.stdout.write(args[0]+' result\\n\\n');
process.stderr.write(args[0]+' diagnostic\\n');
`, { mode: 0o700 });
  try {
    const compiled = spawnSync(process.execPath, ['build', '--compile', source, '--outfile', browse], {
      encoding: 'utf8', timeout: 5000,
    });
    expect(compiled.error).toBeUndefined();
    expect(compiled.status, compiled.stderr).toBe(0);
    const result = spawnSync(process.execPath, [PROBE, browse, 'http://fixture.invalid/', screenshot], {
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    if (scenario === 'existing-screenshot') {
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Refusing to overwrite a previous screenshot');
      expect(fs.existsSync(calls)).toBe(false);
      expect(fs.readFileSync(screenshot, 'utf8')).toBe('previous screenshot');
      return;
    }
    const commands = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (scenario === 'failure') {
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('console failed: 7: console failed');
      expect(commands).toEqual([['goto', 'http://fixture.invalid/'], ['console', '--errors']]);
      expect(fs.existsSync(screenshot)).toBe(false);
      return;
    }
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(commands).toEqual([['goto', 'http://fixture.invalid/'], ['console', '--errors'], ['screenshot', screenshot]]);
    const observed = JSON.parse(result.stdout);
    expect(Object.keys(observed)).toEqual(['navigation', 'console', 'screenshot']);
    for (const [name, command] of [['navigation', 'goto'], ['console', 'console'], ['screenshot', 'screenshot']]) {
      expect(observed[name]).toEqual({ stdout: command + ' result\n\n', stderr: command + ' diagnostic\n', exitCode: 0 });
    }
    expect(fs.readFileSync(screenshot, 'utf8')).toBe('fixture image');
  } finally {
    removeProbeDirectory(directory, browse);
  }
});
