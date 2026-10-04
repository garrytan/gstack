/**
 * Owned detached browser settlement fixture for scripts/test-free-shards.ts:
 * a real daemon/leaf process tree with browse state, a sibling shard's tree,
 * and the runner's settlement after success, failure, timeout, cancellation
 * and every ownership-mismatch mode. The modes are split across two test
 * files so the packer can balance them (each mode spawns real processes).
 */
import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPidStartTime } from '../../browse/src/xvfb';
import type { eligibleFreeRetryFiles as EligibleFreeRetryFiles } from '../../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '../..');

export const SETTLEMENT_MODE_GROUPS = {
  lifecycle: ['success', 'failure', 'timeout', 'cancel', 'cancel-force', 'cancel-cold-probes', 'settle-cold-probes', 'settle-slow-exit', 'cancel-vanishing-record'],
  ownership: ['endpoint-mix', 'full-state-mix', 'terminal-mix', 'chromium-mix', 'replaced-pid', 'stale-child-start', 'replaced-start',
    'exit-environment-race', 'unavailable-environment', 'directory-remove-failure'],
} as const;

const OWNERSHIP_ACTOR = `
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { spyOn } from 'bun:test';
import { readPidStartTime } from ${JSON.stringify(path.join(ROOT, 'browse/src/xvfb.ts'))};
const [role, directory, mode, name = 'owned'] = process.argv.slice(2);
const file = (suffix) => path.join(directory, name + suffix);
const wait = async (filename) => {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(filename)) {
    if (Date.now() > deadline) throw new Error('fixture readiness deadline');
    await Bun.sleep(10);
  }
};
const write = (filename, value) => {
  fs.mkdirSync(path.dirname(filename), {recursive:true});
  fs.writeFileSync(filename + '.tmp', JSON.stringify(value));
  fs.renameSync(filename + '.tmp', filename);
};
const identity = (pid) => ({pid, start: readPidStartTime(pid), ticks: process.platform === 'linux'
  ? fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].trim().split(/\\s+/)[19] : null});
if (role === 'leaf') {
  setInterval(() => {}, 1000);
} else if (role === 'daemon') {
  const children = [0,1].map(index => spawn(process.execPath, [import.meta.filename, 'leaf', directory, mode, name], {
    detached:true, stdio:'ignore', env:process.env,
  }));
  await Bun.sleep(50);
  const owned = [identity(process.pid), ...children.map(child => identity(child.pid))];
  const server = Bun.serve({hostname:'127.0.0.1', port:0, fetch() {
    fs.appendFileSync(file('.http'), 'request\\n'); return new Response('ok');
  }});
  const state = {pid:process.pid, instanceId:name + '-' + process.pid, port:server.port, token:crypto.randomUUID(),
    chromiumPid:owned[1].pid, chromiumStartTime:owned[1].start};
  const agent = {pid:owned[2].pid, startTime:owned[2].start, gen:'fixture', ownerPid:process.pid, ownerStartTime:owned[0].start};
  write(process.env.BROWSE_STATE_FILE, state);
  write(path.join(path.dirname(process.env.BROWSE_STATE_FILE), 'terminal-agent-pid'), agent);
  write(file('.ready'), {owned, state, agent, stateFile:process.env.BROWSE_STATE_FILE});
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {
    write(file('.interrupted'), {at:Date.now()});
    if (mode === 'cancel-force') return;
    const current = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.BROWSE_STATE_FILE), 'terminal-agent-pid'), 'utf8'));
    try { process.kill(current.pid, 'SIGTERM'); } catch {}
    for (const child of children) try { child.kill('SIGTERM'); } catch {}
    if (mode === 'settle-slow-exit') return;
    const finish = () => {
      fs.rmSync(process.env.BROWSE_STATE_FILE, {force:true});
      fs.rmSync(path.join(path.dirname(process.env.BROWSE_STATE_FILE), 'terminal-agent-pid'), {force:true});
      process.exit(0);
    };
    if (mode === 'cancel-cold-probes') setTimeout(finish, 2200);
    else if (mode === 'exit-environment-race') setTimeout(finish, 200);
    else finish();
  });
} else if (role === 'shard') {
  const daemon = spawn(process.execPath, [import.meta.filename, 'daemon', directory, mode], {
    detached:true, stdio:'ignore', env:process.env,
  });
  daemon.unref();
  await wait(file('.ready'));
  if (!mode.endsWith('cold-probes')) await Bun.sleep(400);
  const own = JSON.parse(fs.readFileSync(file('.ready'), 'utf8'));
  if (mode.includes('mix') || mode === 'replaced-pid') {
    const sibling = JSON.parse(fs.readFileSync(path.join(directory, 'sibling.ready'), 'utf8'));
    if (mode === 'endpoint-mix') write(process.env.BROWSE_STATE_FILE, {...own.state, port:sibling.state.port, token:sibling.state.token});
    if (mode === 'full-state-mix') {
      write(process.env.BROWSE_STATE_FILE, sibling.state);
      write(path.join(path.dirname(process.env.BROWSE_STATE_FILE), 'terminal-agent-pid'), sibling.agent);
    }
    if (mode === 'terminal-mix') write(path.join(path.dirname(process.env.BROWSE_STATE_FILE), 'terminal-agent-pid'),
      {...sibling.agent, ownerPid:own.state.pid, ownerStartTime:own.owned[0].start});
    if (mode === 'chromium-mix') write(process.env.BROWSE_STATE_FILE,
      {...own.state, chromiumPid:sibling.state.chromiumPid, chromiumStartTime:sibling.state.chromiumStartTime});
    if (mode === 'replaced-pid') write(process.env.BROWSE_STATE_FILE, {...own.state, pid:sibling.state.pid});
  }
  if (mode === 'stale-child-start') write(process.env.BROWSE_STATE_FILE, {...own.state, chromiumStartTime:'stale'});
  if (mode === 'replaced-start') write(file('.replace-start'), true);
  write(file('.shard-ready'), true);
  if (mode === 'timeout' || mode.startsWith('cancel')) await new Promise(() => {});
  console.log('Ran 3 tests across 1 files. [12.00ms]');
  process.exit(mode === 'failure' ? 3 : 0);
} else if (role === 'harness') {
  if (mode === 'settle-cold-probes') Object.defineProperty(process, 'platform', {value:'darwin'});
  let spy;
  if (['replaced-start', 'exit-environment-race', 'unavailable-environment', 'settle-slow-exit'].includes(mode)) {
    const original = fs.readFileSync;
    spy = spyOn(fs, 'readFileSync').mockImplementation((filename, ...args) => {
      const value = original(filename, ...args);
      if (mode === 'settle-slow-exit' && String(filename).endsWith('/environ') && fs.existsSync(file('.interrupted'))) Bun.sleepSync(300);
      if (String(filename).endsWith('/environ') && fs.existsSync(file('.ready'))
        && (mode === 'unavailable-environment' || mode === 'exit-environment-race' && fs.existsSync(file('.interrupted')))) {
        const own = JSON.parse(original(file('.ready'), 'utf8'));
        if (String(filename) === '/proc/' + own.state.pid + '/environ') {
          fs.appendFileSync(file('.denials'), 'denied\\n');
          throw Object.assign(new Error('controlled unavailable environment ' + own.state.token), {code:'EACCES', path:String(filename)});
        }
      }
      if (String(filename).endsWith('/stat') && fs.existsSync(file('.replace-start'))) {
        const own = JSON.parse(original(file('.ready'), 'utf8'));
        if (String(filename) === '/proc/' + own.state.pid + '/stat') {
          const split = value.lastIndexOf(') ') + 2;
          const fields = value.slice(split).trim().split(/\\s+/); fields[19] = String(Number(fields[19]) + 1);
          return value.slice(0, split) + fields.join(' ');
        }
      }
      return value;
    });
  } else if (mode === 'cancel-vanishing-record') {
    // The daemon removes its state file on SIGINT: one existence check sees it,
    // and it is gone before the record is read.
    const original = fs.existsSync;
    spy = spyOn(fs, 'existsSync').mockImplementation((filename) => {
      if (original(file('.interrupted')) && original(file('.ready')) && !original(file('.vanished'))
        && String(filename) === JSON.parse(fs.readFileSync(file('.ready'), 'utf8')).stateFile) {
        fs.rmSync(String(filename), {force:true});
        fs.writeFileSync(file('.vanished'), 'true');
        return true;
      }
      return original(filename);
    });
  } else if (mode === 'directory-remove-failure') {
    const original = fs.rmSync;
    spy = spyOn(fs, 'rmSync').mockImplementation((filename, ...args) => {
      if (fs.existsSync(file('.ready'))) {
        const own = JSON.parse(fs.readFileSync(file('.ready'), 'utf8'));
        if (String(filename) === path.dirname(path.dirname(own.stateFile))) {
          throw Object.assign(new Error('controlled directory removal failure'), {code:'EACCES'});
        }
      }
      return original(filename, ...args);
    });
  }
  try {
    const {runFreeShard} = await import(${JSON.stringify(path.join(ROOT, 'scripts/test-free-shards.ts'))});
    const result = await runFreeShard(['ownership-fixture'], 1, 1, {
      rootDir:${JSON.stringify(ROOT)}, quiet:true, log:() => {}, wallTimeoutMs:mode === 'timeout' ? 1200 : 15000,
      env:mode.endsWith('cold-probes') ? {...process.env, PATH:process.env.GSTACK_FIXTURE_PATH} : process.env,
      commandFor:() => ({command:process.execPath, args:[import.meta.filename, 'shard', directory, mode]}),
    });
    write(file('.result'), result);
  } finally { spy?.mockRestore(); }
}
`;

function ownershipProcessAlive(identity: { pid: number; start: string; ticks: string | null }): boolean {
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/);
      return fields[0] !== 'Z' && fields[0] !== 'X' && fields[19] === identity.ticks;
    } catch { return false; }
  }
  return readPidStartTime(identity.pid) === identity.start;
}

/** The caller passes the runner's retry-eligibility rule: an unattributed settlement failure must never be retried. */
export function registerOwnedBrowserSettlementCases(modes: readonly string[], { eligibleFreeRetryFiles }: { eligibleFreeRetryFiles: typeof EligibleFreeRetryFiles }): void {
  for (const mode of modes) {
    test.skipIf(process.platform === 'win32' || ((['replaced-start', 'exit-environment-race', 'unavailable-environment', 'settle-slow-exit', 'cancel-vanishing-record'].includes(mode) || mode.endsWith('cold-probes')) && process.platform !== 'linux'))(mode, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free-owned-browser-'));
      const actor = path.join(directory, 'actor.ts');
      fs.writeFileSync(actor, OWNERSHIP_ACTOR);
      const probeLog = path.join(directory, 'probes.jsonl');
      const bin = path.join(directory, 'bin');
      if (mode.endsWith('cold-probes')) {
        fs.mkdirSync(bin);
        for (const tool of ['ps', 'pgrep']) {
          fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env bun
  import * as fs from 'node:fs';
  const args = process.argv.slice(2);
  const record = (event) => fs.appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify({event, pid:process.pid, parent:process.ppid, at:Date.now(), args}) + '\\n');
  record('start');
  await Bun.sleep(args.includes('lstart=') ? 1700 : 350);
  const child = Bun.spawn([${JSON.stringify(Bun.which(tool))}, ...args], {stdout:'inherit', stderr:'inherit', timeout:1000});
  const code = await child.exited;
  record('complete');
  process.exit(code);
  `, { mode: 0o755 });
        }
      }
      const waitFor = async (filename: string) => {
        const deadline = Date.now() + 8000;
        while (!fs.existsSync(filename)) {
          if (Date.now() > deadline) throw new Error('ownership fixture did not become ready');
          await Bun.sleep(10);
        }
      };
      const processes: ReturnType<typeof Bun.spawn>[] = [];
      try {
        const sibling = Bun.spawn([process.execPath, actor, 'daemon', directory, 'sibling', 'sibling'], {
          env: { ...process.env, BROWSE_STATE_FILE: path.join(directory, 'sibling-state', 'browse.json'), GSTACK_FREE_SHARD_ID: 'sibling' },
          stdout: 'ignore', stderr: 'ignore',
        });
        processes.push(sibling);
        await waitFor(path.join(directory, 'sibling.ready'));
        const harness = Bun.spawn([process.execPath, actor, 'harness', directory, mode], {
          env: mode.endsWith('cold-probes') ? { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GSTACK_FIXTURE_PATH: process.env.PATH } : process.env,
          stdout: 'ignore', stderr: 'pipe',
        });
        processes.push(harness);
        const stderr = new Response(harness.stderr).text();
        await waitFor(path.join(directory, 'owned.shard-ready'));
        const readyAt = Date.now();
        let cancelledAt: number | undefined;
        if (mode.startsWith('cancel')) {
          cancelledAt = Date.now();
          harness.kill('SIGTERM');
        }
        const watchdog = setTimeout(() => harness.kill('SIGKILL'), 20000);
        let exit: number;
        try { exit = await harness.exited; } finally { clearTimeout(watchdog); }
        const output = await stderr;
        expect({ exit, output }).toEqual({ exit: mode.startsWith('cancel') ? 143 : 0, output: expect.any(String) });
        const own = JSON.parse(fs.readFileSync(path.join(directory, 'owned.ready'), 'utf8'));
        const other = JSON.parse(fs.readFileSync(path.join(directory, 'sibling.ready'), 'utf8'));
        const result = JSON.parse(fs.readFileSync(path.join(directory, 'owned.result'), 'utf8'));
        expect(output).not.toContain(own.state.token);
        expect(output).not.toContain(other.state.token);
        const invalid = ['full-state-mix', 'terminal-mix', 'chromium-mix', 'replaced-pid', 'stale-child-start', 'replaced-start',
          'unavailable-environment', 'directory-remove-failure', 'settle-cold-probes'].includes(mode);
        expect(result.status).toBe(mode === 'timeout' ? 'timed-out' : invalid || mode === 'failure' || mode.startsWith('cancel') ? 'failed' : 'passed');
        expect(result.unattributedFailures).toBe(invalid || mode === 'timeout' || mode.startsWith('cancel') ? 1 : 0);
        // Run 13 (feaa28d) and a 16-vCPU stress run: the cancelled daemon's state file
        // vanished between the existence check and the read ('browser ownership unavailable').
        if (mode === 'cancel-vanishing-record') expect(fs.existsSync(path.join(directory, 'owned.vanished'))).toBe(true);
        if (invalid) {
          expect(fs.existsSync(path.dirname(own.stateFile))).toBe(true);
          expect(fs.existsSync(path.join(directory, 'owned.interrupted'))).toBe(mode === 'directory-remove-failure');
          expect(eligibleFreeRetryFiles([result])).toBeNull();
        } else {
          await Bun.sleep(100);
          expect(fs.existsSync(path.dirname(path.dirname(own.stateFile)))).toBe(false);
          expect(fs.existsSync(path.join(directory, 'owned.interrupted'))).toBe(true);
        }
        if (cancelledAt !== undefined) {
          const interruption = JSON.parse(fs.readFileSync(path.join(directory, 'owned.interrupted'), 'utf8'));
          expect(interruption.at - cancelledAt).toBeLessThan(mode === 'cancel-cold-probes' ? 2500 : 1000);
          expect(Date.now() - cancelledAt).toBeLessThan(mode === 'cancel-cold-probes' ? 6500 : 7000);
        }
        if (mode.endsWith('cold-probes')) {
          if (mode === 'settle-cold-probes') expect(Date.now() - readyAt).toBeLessThan(10400);
          const before = fs.readFileSync(probeLog, 'utf8');
          const probes = before.trim().split('\n').map(line => JSON.parse(line));
          const starts = probes.filter(row => row.event === 'start');
          expect(starts.length).toBeGreaterThan(0);
          if (mode === 'cancel-cold-probes') {
            expect(starts.every(row => row.at >= cancelledAt!)).toBe(true);
            expect(probes.filter(row => row.event === 'complete').length).toBe(3);
          }
          for (const probe of starts) {
            expect(fs.existsSync('/proc/' + probe.pid)).toBe(false);
            const completed = probes.find(row => row.pid === probe.pid && row.event === 'complete');
            if (completed) expect(completed.at - probe.at).toBeLessThan(probe.args.includes('lstart=') ? 2000 : 500);
          }
          await Bun.sleep(300);
          expect(fs.readFileSync(probeLog, 'utf8')).toBe(before);
        }
        expect(own.owned.map(ownershipProcessAlive)).toEqual(mode === 'unavailable-environment'
          ? [true, true, true] : [mode === 'replaced-start', false, false]);
        expect(other.owned.map(ownershipProcessAlive)).toEqual([true, true, true]);
        expect(fs.existsSync(path.join(directory, 'sibling.interrupted'))).toBe(false);
        expect(fs.existsSync(path.join(directory, 'sibling.http'))).toBe(false);
        expect(fs.existsSync(path.join(directory, 'owned.http'))).toBe(false);
        if (mode === 'exit-environment-race' || mode === 'unavailable-environment') expect(fs.existsSync(path.join(directory, 'owned.denials'))).toBe(true);
      } finally {
        for (const name of ['owned', 'sibling']) {
          const receipt = path.join(directory, `${name}.ready`);
          if (!fs.existsSync(receipt)) continue;
          const metadata = JSON.parse(fs.readFileSync(receipt, 'utf8'));
          for (const identity of metadata.owned) if (ownershipProcessAlive(identity)) process.kill(identity.pid, 'SIGKILL');
          const ownedRoot = path.dirname(path.dirname(metadata.stateFile));
          if (name === 'owned' && path.dirname(ownedRoot) === fs.realpathSync(os.tmpdir())
            && /^gstack-free-shard-[A-Za-z0-9]+$/.test(path.basename(ownedRoot))
            && fs.existsSync(ownedRoot) && fs.realpathSync(ownedRoot) === ownedRoot) {
            fs.rmSync(ownedRoot, { recursive: true, force: true });
          }
        }
        for (const child of processes) {
          if (child.exitCode === null) child.kill('SIGKILL');
          await child.exited;
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }, 30000);
  }
}

