import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  REGISTRY_SOCKET_PATH_MAX_BYTES,
  RegistryEgressBroker,
  superviseRegistrySocket,
  type SupervisedRegistrySocket,
} from '../lib/cso/preparation-docker';

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

posixDescribe('short supervised CSO registry sockets', () => {
  let fixtureRoot = '';
  let watchdogPath = '';

  beforeAll(() => {
    fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cso-registry-socket-')));
    watchdogPath = path.join(fixtureRoot, 'watchdog');
    const result = spawnSync('/usr/bin/cc', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O2', '-Wall', '-Wextra',
      path.resolve(import.meta.dir, '../lib/cso/watchdog.c'), '-o', watchdogPath], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
  });

  afterAll(() => { if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true }); });

  async function close(handle: SupervisedRegistrySocket | undefined): Promise<void> {
    if (!handle) return;
    await handle.dispose();
  }

  test('binds and connects through a private collision-resistant path below the Darwin limit', async () => {
    const first = await superviseRegistrySocket({ watchdogPath, ownerPid: process.pid, deadline: Date.now() + 10_000 });
    const second = await superviseRegistrySocket({ watchdogPath, ownerPid: process.pid, deadline: Date.now() + 10_000 });
    const broker = new RegistryEgressBroker(first.socketPath, ['registry.npmjs.org'], Date.now() + 10_000, 1024 * 1024);
    try {
      expect(first.root).not.toBe(second.root);
      expect(Buffer.byteLength(first.socketPath)).toBeLessThanOrEqual(REGISTRY_SOCKET_PATH_MAX_BYTES);
      expect(Buffer.byteLength(second.socketPath)).toBeLessThanOrEqual(REGISTRY_SOCKET_PATH_MAX_BYTES);
      for (const handle of [first, second]) {
        expect(path.basename(handle.root)).toMatch(/^gscso-\d+-[a-f0-9]{32}$/);
        const stat = fs.lstatSync(handle.root);
        expect(stat.isDirectory()).toBe(true); expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.mode & 0o077).toBe(0); if (process.getuid) expect(stat.uid).toBe(process.getuid());
        expect(fs.realpathSync(handle.root)).toBe(handle.root);
      }
      await broker.start();
      const socketStat = fs.lstatSync(first.socketPath);
      expect(socketStat.isSocket()).toBe(true); expect(socketStat.isSymbolicLink()).toBe(false);
      expect(socketStat.mode & 0o077).toBe(0); if (process.getuid) expect(socketStat.uid).toBe(process.getuid());
      const reply = await new Promise<string>((resolveReply, reject) => {
        const socket = net.createConnection({ path: first.socketPath }); let output = '';
        socket.once('connect', () => socket.write('CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n'));
        socket.on('data', chunk => { output += chunk.toString(); }); socket.once('end', () => resolveReply(output)); socket.once('error', reject);
      });
      expect(reply).toContain('403 Forbidden');
    } finally {
      await broker.close(); await close(first); await close(second);
    }
    expect(fs.existsSync(first.root)).toBe(false); expect(fs.existsSync(second.root)).toBe(false);
  });

  test('owner-death cleanup removes the exact socket root while preserving an unrelated concurrent root', async () => {
    const owner = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const doomed = await superviseRegistrySocket({ watchdogPath, ownerPid: owner.pid!, deadline: Date.now() + 10_000 });
    const survivor = await superviseRegistrySocket({ watchdogPath, ownerPid: process.pid, deadline: Date.now() + 10_000 });
    const broker = new RegistryEgressBroker(doomed.socketPath, ['registry.npmjs.org'], Date.now() + 10_000, 1024 * 1024);
    try {
      await broker.start(); owner.kill('SIGKILL'); await new Promise(resolve => owner.once('close', resolve));
      for (let attempt = 0; attempt < 50 && fs.existsSync(doomed.root); attempt++) await Bun.sleep(100);
      expect(fs.existsSync(doomed.root)).toBe(false);
      expect(fs.existsSync(survivor.root)).toBe(true);
    } finally {
      try { owner.kill('SIGKILL'); } catch {}
      await broker.close(); await close(doomed); await close(survivor);
    }
  }, 15_000);

  test('deadline cleanup removes the whole per-call socket root without a global temp sweep', async () => {
    const doomed = await superviseRegistrySocket({ watchdogPath, ownerPid: process.pid, deadline: Date.now() + 150 });
    const survivor = await superviseRegistrySocket({ watchdogPath, ownerPid: process.pid, deadline: Date.now() + 10_000 });
    const broker = new RegistryEgressBroker(doomed.socketPath, ['registry.npmjs.org'], Date.now() + 10_000, 1024 * 1024);
    try {
      await broker.start(); fs.writeFileSync(path.join(doomed.root, 'owned-fixture'), 'bounded');
      for (let attempt = 0; attempt < 50 && fs.existsSync(doomed.root); attempt++) await Bun.sleep(100);
      expect(fs.existsSync(doomed.root)).toBe(false);
      expect(fs.existsSync(survivor.root)).toBe(true);
    } finally {
      await broker.close(); await close(doomed); await close(survivor);
    }
  }, 15_000);

  test('the detached cleaner refuses a same-path replacement instead of deleting it', async () => {
    const base = fs.realpathSync('/tmp'), root = fs.mkdtempSync(path.join(base, 'gscso-identity-')),
      control = path.join(root, 'control'), moved = `${root}.original`;
    fs.chmodSync(root, 0o700); fs.mkdirSync(control, { mode: 0o700 });
    const owner = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const child = spawn(watchdogPath, ['--ephemeral-owner', String(owner.pid), '--deadline', String(Math.ceil((Date.now() + 10_000) / 1000)),
      '--control-dir', control, '--work-root', root, '--run-root', base], { cwd: control, env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
    const ownerClosed = new Promise(resolve => owner.once('close', resolve)), childClosed = new Promise(resolve => child.once('close', resolve));
    try {
      for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(control, 'attempt.ready')); attempt++) await Bun.sleep(10);
      expect(fs.existsSync(path.join(control, 'attempt.ready'))).toBe(true);
      fs.renameSync(root, moved); fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(control, { mode: 0o700 });
      owner.kill('SIGKILL'); await ownerClosed;
      const event = path.join(control, 'attempt.event');
      for (let attempt = 0; attempt < 50 && !fs.existsSync(event); attempt++) await Bun.sleep(100);
      expect(fs.readFileSync(event, 'utf8')).toContain('identity changed; refusing removal');
      expect(fs.existsSync(root)).toBe(true); expect(fs.existsSync(moved)).toBe(true);
    } finally {
      try { owner.kill('SIGKILL'); } catch {} child.kill('SIGKILL');
      await childClosed;
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      if (fs.existsSync(moved)) fs.rmSync(moved, { recursive: true, force: true });
    }
  }, 15_000);
});
