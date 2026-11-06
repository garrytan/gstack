import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { stopQaOnlyBrowser } from './helpers/qa-only-cleanup';
import { isAgentRecordGone, isOurAgent, readAgentRecord, spawnTerminalAgent, stopAgentByRecord } from '../browse/src/terminal-agent-control';
import { readPidStartTime } from '../browse/src/xvfb';

const ROOT = path.resolve(import.meta.dir, '..');
const waitFor = async (check: () => boolean, timeout = 10_000) => {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('QA cleanup fixture did not become ready');
    await Bun.sleep(25);
  }
};

test('missing owned state never consults ambient state or bootstraps a daemon', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-clean-'));
  const prior = process.env.BROWSE_STATE_FILE;
  const ambient = path.join(dir, 'ambient.json');
  fs.writeFileSync(ambient, 'must not read or mutate');
  process.env.BROWSE_STATE_FILE = ambient;
  try {
    await stopQaOnlyBrowser(dir, 200);
    expect(fs.readdirSync(dir)).toEqual(['ambient.json']);
    expect(fs.readFileSync(ambient, 'utf8')).toBe('must not read or mutate');
  } finally {
    if (prior === undefined) delete process.env.BROWSE_STATE_FILE;
    else process.env.BROWSE_STATE_FILE = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('linked owned state cannot redirect cleanup to a sibling', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-clean-'));
  const sibling = path.join(dir, 'sibling');
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'browse.json'), 'untouched');
  fs.symlinkSync(sibling, path.join(dir, '.gstack'));
  try {
    await expect(stopQaOnlyBrowser(dir, 200)).rejects.toThrow('state directory is a link');
    expect(fs.readFileSync(path.join(sibling, 'browse.json'), 'utf8')).toBe('untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test.each(['ack-only', 'replaced-state', 'terminal-mismatch', 'chromium-mismatch', 'missing-terminal', 'blocked-identity'])('cleanup refuses unconfirmed settlement: %s', async scenario => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-clean-'));
  const stateDir = path.join(dir, '.gstack');
  fs.mkdirSync(stateDir);
  const script = path.join(dir, 'server.ts');
  const stateFile = path.join(stateDir, 'browse.json');
  const requestFile = path.join(dir, 'request.json');
  const signalFile = path.join(dir, 'signal.json');
  fs.writeFileSync(script, `
import * as fs from 'node:fs';
const chromium = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)', 'chromium']);
process.on('SIGTERM', async () => { chromium.kill(); await chromium.exited; process.exit(0); });
fs.writeFileSync(${JSON.stringify(path.join(dir, 'chromium-pid'))}, String(chromium.pid));
process.on('SIGINT', () => {
  fs.writeFileSync(${JSON.stringify(signalFile)}, JSON.stringify({ signal: 'SIGINT' }));
  if (${JSON.stringify(scenario)} === 'replaced-state') {
    const file = ${JSON.stringify(stateFile)};
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), instanceId: 'successor' }));
  }
});
const server = Bun.serve({ port: 0, async fetch(request) {
  fs.writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify(await request.json()));
  return new Response('Unexpected HTTP request');
} });
fs.writeFileSync(${JSON.stringify(path.join(dir, 'port'))}, String(server.port));
`);
  const daemon = Bun.spawn([process.execPath, script], { cwd: dir, stdout: 'ignore', stderr: 'inherit' });
  let agent: ReturnType<typeof readAgentRecord>;
  let restore: (() => void) | undefined;
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await waitFor(() => fs.existsSync(path.join(dir, 'port')));
    const port = Number(fs.readFileSync(path.join(dir, 'port'), 'utf8'));
    const chromiumPid = Number(fs.readFileSync(path.join(dir, 'chromium-pid'), 'utf8'));
    expect(spawnTerminalAgent({ stateFile, serverPort: port, ownerPid: daemon.pid, cwd: dir,
      extraEnv: { GSTACK_TERMINAL_OWNER_WATCHDOG_MS: '25' } })).toBeGreaterThan(0);
    agent = readAgentRecord(stateDir);
    expect(agent).not.toBeNull();
    fs.writeFileSync(stateFile, JSON.stringify({ pid: daemon.pid, port, token: 'fixture-local-token', instanceId: 'owned', serverPath: script,
      chromiumPid, chromiumStartTime: scenario === 'chromium-mismatch' ? 'stale start' : readPidStartTime(chromiumPid) }));
    const agentFile = path.join(stateDir, 'terminal-agent-pid');
    if (scenario === 'terminal-mismatch') fs.writeFileSync(agentFile, JSON.stringify({ ...agent, ownerPid: process.pid }));
    if (scenario === 'missing-terminal') {
      fs.unlinkSync(agentFile);
      fs.writeFileSync(path.join(stateDir, 'browse-daemon.log'), '[browse] terminal-agent exit remains unconfirmed: fixture\n');
    }
    if (scenario === 'blocked-identity') {
      const preload = path.join(dir, 'block-identity.ts');
      fs.writeFileSync(preload, `
import * as fs from 'node:fs';
const original = Bun.spawnSync;
Bun.spawnSync = (...args) => {
  if (args[0][0] === 'ps') {
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'identity-blocked'))}, String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'late-identity'))}, 'unexpected late work');
  }
  return original(...args);
};
`);
      const original = Bun.spawn;
      const spy = spyOn(Bun, 'spawn').mockImplementation(((args: string[], options: any) => {
        expect(args[1]).toBe(path.join(ROOT, 'test/helpers/qa-only-cleanup.ts'));
        worker = original([args[0], '--preload', preload, ...args.slice(1)], options);
        return worker;
      }) as typeof Bun.spawn);
      restore = () => spy.mockRestore();
    }
    const started = performance.now();
    const errors = { 'ack-only': 'settlement deadline exceeded', 'replaced-state': 'daemon state was replaced',
      'terminal-mismatch': 'terminal ownership is unconfirmed', 'chromium-mismatch': 'Chromium ownership is unconfirmed',
      'missing-terminal': /terminal identity is unavailable \(record absent; terminal-port .*daemon log terminal-agent lines: \[browse\] terminal-agent exit remains unconfirmed: fixture\)/, 'blocked-identity': 'owned worker settlement deadline exceeded' };
    await expect(stopQaOnlyBrowser(dir, 1000)).rejects.toThrow(errors[scenario]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(daemon.exitCode).toBeNull();
    expect(readPidStartTime(chromiumPid)).not.toBe('');
    expect(fs.existsSync(stateFile)).toBe(true);
    if (scenario === 'blocked-identity') {
      expect(fs.readFileSync(path.join(dir, 'identity-blocked'), 'utf8')).toBe(String(worker!.pid));
      expect(await worker!.exited).toBe(137);
      expect(fs.existsSync(path.join(dir, 'late-identity'))).toBe(false);
    }
    if (['ack-only', 'replaced-state'].includes(scenario)) expect(JSON.parse(fs.readFileSync(signalFile, 'utf8'))).toEqual({ signal: 'SIGINT' });
    else expect(fs.existsSync(signalFile)).toBe(false);
    expect(fs.existsSync(requestFile)).toBe(false);
  } finally {
    restore?.();
    if (agent) expect(stopAgentByRecord(agent, 300)).toBe(true);
    daemon.kill();
    await daemon.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test.each(['owned-endpoint', 'sibling-endpoint'])('real Chromium and terminal settle before removal without harming a live sibling or recreating state: %s', async scenario => {
  const page = Bun.serve({ port: 0, fetch: () => new Response('<h1>Owned QA fixture</h1>', { headers: { 'Content-Type': 'text/html' } }) });
  const fixtures: Array<{ dir: string; child: ReturnType<typeof Bun.spawn>; state?: any; agent?: ReturnType<typeof readAgentRecord> }> = [];
  const launch = async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-live-'));
    const stateFile = path.join(dir, '.gstack/browse.json');
    const child = Bun.spawn([process.execPath, path.join(ROOT, 'browse/src/server.ts')], {
      cwd: dir, stdout: Bun.file(path.join(dir, 'server.log')), stderr: Bun.file(path.join(dir, 'server-error.log')),
      env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
        BROWSE_STATE_FILE: stateFile, BROWSE_PORT: '0', BROWSE_PARENT_PID: '0', BROWSE_HEADED: '0', BROWSE_HEADLESS_SKIP: '0',
        GSTACK_TERMINAL_OWNER_WATCHDOG_MS: '25', GSTACK_AGENT_WATCHDOG_TICK_MS: '100',
        TMPDIR: dir, TMP: dir, TEMP: dir, CHROMIUM_PROFILE: path.join(dir, 'profile') },
    });
    const fixture = { dir, child, state: undefined as any, agent: undefined as ReturnType<typeof readAgentRecord> };
    fixtures.push(fixture);
    await waitFor(() => fs.existsSync(stateFile) && fs.existsSync(path.join(dir, '.gstack/terminal-port')));
    fixture.state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fixture.agent = readAgentRecord(path.dirname(stateFile));
    expect(fixture.state.pid).toBe(child.pid);
    const children = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 1000 });
    expect(children.status).toBe(0);
    expect(children.stdout.split('\n').some(line => {
      const row = line.trim().split(/\s+/);
      return Number(row[1]) === child.pid && /chrom|headless_shell/.test(row.slice(2).join(' '));
    })).toBe(true);
    expect(isOurAgent(fixture.agent!, child.pid)).toBe(true);
    const response = await fetch(`http://127.0.0.1:${fixture.state.port}/command`, { method: 'POST',
      headers: { Authorization: `Bearer ${fixture.state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'goto', args: [`http://127.0.0.1:${page.port}/`] }), signal: AbortSignal.timeout(3000) });
    expect(response.ok, await response.text()).toBe(true);
    return fixture;
  };
  try {
    const owned = await launch(), sibling = await launch();
    const stateFile = path.join(owned.dir, '.gstack/browse.json');
    const original = fs.readFileSync(stateFile, 'utf8');
    fs.writeFileSync(stateFile, JSON.stringify(sibling.state));
    await expect(stopQaOnlyBrowser(owned.dir, 1000)).rejects.toThrow('daemon belongs to another fixture');
    fs.writeFileSync(stateFile, original);
    if (scenario === 'sibling-endpoint') fs.writeFileSync(stateFile, JSON.stringify({
      ...owned.state, port: sibling.state.port, token: sibling.state.token,
    }));
    const started = performance.now();
    let cleanupError: unknown;
    try { await stopQaOnlyBrowser(owned.dir, 4000); }
    catch (error) { cleanupError = error; }
    expect(isOurAgent(sibling.agent!, sibling.child.pid), 'Sibling terminal must survive cleanup even when only its endpoint was copied').toBe(true);
    if (cleanupError) throw cleanupError;
    expect(performance.now() - started).toBeLessThan(4000);
    expect([0, 137]).toContain(await owned.child.exited);
    expect(isAgentRecordGone(owned.agent!)).toBe(true);
    fs.rmSync(owned.dir, { recursive: true, force: true });
    const until = performance.now() + 250;
    while (performance.now() < until) {
      expect(fs.existsSync(owned.dir)).toBe(false);
      expect(isOurAgent(sibling.agent!, sibling.child.pid)).toBe(true);
      await Bun.sleep(25);
    }
    expect((await fetch(`http://127.0.0.1:${sibling.state.port}/health`, { signal: AbortSignal.timeout(1000) })).ok).toBe(true);
    await stopQaOnlyBrowser(sibling.dir, 4000);
    expect([0, 137]).toContain(await sibling.child.exited);
    expect(isAgentRecordGone(sibling.agent!)).toBe(true);
    fs.rmSync(sibling.dir, { recursive: true, force: true });
    await Bun.sleep(100);
    expect(fixtures.every(fixture => !fs.existsSync(fixture.dir))).toBe(true);
  } finally {
    page.stop(true);
    for (const fixture of fixtures) {
      if (!fs.existsSync(fixture.dir)) continue;
      if (fixture.state) fs.writeFileSync(path.join(fixture.dir, '.gstack/browse.json'), JSON.stringify(fixture.state));
      try { await stopQaOnlyBrowser(fixture.dir, 4000); }
      catch { fixture.child.kill('SIGINT'); }
      await Promise.race([fixture.child.exited, Bun.sleep(3000)]);
      if (fixture.child.exitCode === null) fixture.child.kill('SIGKILL');
      await fixture.child.exited;
      if (fixture.agent) expect(stopAgentByRecord(fixture.agent, 300)).toBe(true);
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
}, 30_000);
