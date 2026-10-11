// Persisted session bearer (#1796): a restarted daemon resumes the rotated
// bearer instead of relaunching the app, without weakening device binding or
// letting a rejected or foreign bearer be replayed. Restart scenarios run the
// production deviceTunnelSource wiring against the simulated device: daemon A
// bootstraps and exits, daemon B starts with the same session file.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDaemon, deviceTunnelSource } from '../src/index';
import { readSession, writeSession, type PersistedSession } from '../src/session-cache';
import { startFakeDevice, type FakeDevice } from './fake-device';
import type { SpawnImpl } from '../src/devicectl';

const BUNDLE = 'com.test.session';
let dir: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ios-qa-session-')); });
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const TUNNEL = { udid: 'UDID-1', ipv6Addr: '::1', port: 9999, bootTokenRotated: 'bearer-abc' };

describe('session file', () => {
  test('is written owner-only with the bearer and its binding, never a boot token', () => {
    const path = join(dir, 'write.json');
    writeSession(TUNNEL, BUNDLE, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as PersistedSession;
    expect(raw).toMatchObject({ version: 1, udid: 'UDID-1', bundle_id: BUNDLE, port: 9999, bearer: 'bearer-abc' });
    expect(Object.keys(raw).sort()).toEqual(['bearer', 'bundle_id', 'created_at', 'port', 'udid', 'version']);
    expect(readSession(path).session).toEqual(raw);
  });

  test('replaces a group-readable file or a symlink instead of writing through it', () => {
    const loose = join(dir, 'loose.json');
    writeFileSync(loose, '{}', { mode: 0o644 });
    chmodSync(loose, 0o644);
    writeSession(TUNNEL, BUNDLE, loose);
    expect(statSync(loose).mode & 0o777).toBe(0o600);

    const target = join(dir, 'link-target.txt');
    writeFileSync(target, 'untouched');
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    writeSession(TUNNEL, BUNDLE, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('untouched');
  });

  test('a file other users can read, a symlink, or an invalid session is removed unused', () => {
    const loose = join(dir, 'read-loose.json');
    writeSession(TUNNEL, BUNDLE, loose);
    chmodSync(loose, 0o640);
    expect(readSession(loose)).toEqual({ session: null, discarded: 'other users can access it (mode 640)' });
    expect(existsSync(loose)).toBe(false);

    const real = join(dir, 'read-real.json');
    writeSession(TUNNEL, BUNDLE, real);
    const link = join(dir, 'read-link.json');
    symlinkSync(real, link);
    expect(readSession(link).discarded).toBe('it is not a regular file');
    expect(existsSync(link)).toBe(false);

    for (const [name, body, reason] of [
      ['bad-json.json', '{', 'it is not valid JSON'],
      ['old-shape.json', JSON.stringify({ udid: 'U', bundleId: BUNDLE, port: 9999, rotatedToken: 't' }), 'it does not hold a version 1 session'],
    ] as const) {
      const path = join(dir, name);
      writeFileSync(path, body, { mode: 0o600 });
      expect(readSession(path)).toEqual({ session: null, discarded: reason });
      expect(existsSync(path)).toBe(false);
    }
    expect(readSession(join(dir, 'missing.json'))).toEqual({ session: null });
  });
});

describe('daemon restart (simulated device)', () => {
  async function device(opts: { udid?: string; bundleId?: string } = {}) {
    const fake = await startFakeDevice({ bundleId: opts.bundleId ?? BUNDLE, udid: opts.udid ?? 'FAKE-UDID-1' });
    cleanups.push(() => fake.close());
    return fake;
  }

  async function daemon(name: string, fake: FakeDevice, opts: { udid?: string; spawn?: SpawnImpl; sessionPath?: string } = {}) {
    const logs: string[] = [];
    const source = deviceTunnelSource({
      udid: opts.udid,
      bundleId: BUNDLE,
      port: fake.port,
      sessionPath: opts.sessionPath ?? join(dir, `${name}.session.json`),
      spawnImpl: opts.spawn ?? fake.spawn,
      resolveImpl: async () => ['::1'],
      keepalive: () => ({ stop() {} }),
      log: (line) => logs.push(line),
    });
    const d = await startDaemon({
      loopbackPort: 0,
      tailnetEnabled: false,
      pidfilePath: join(dir, `${name}-${Math.random().toString(36).slice(2)}.pid`),
      proxyTimeoutMs: 300,
      tunnelProvider: source.tunnelProvider,
      tunnelRecovery: source.tunnelRecovery,
    });
    if ('error' in d) throw new Error(d.error);
    let closed = false;
    const close = async () => { if (!closed) { closed = true; source.stop(); await d.close(); } };
    cleanups.push(close);
    const get = async (path: string, method = 'GET') => {
      const res = await fetch(`http://127.0.0.1:${d.loopbackPort}${path}`, { method, body: method === 'POST' ? '{}' : undefined });
      return { status: res.status, body: await res.text() };
    };
    return { logs, close, get };
  }

  /** Daemon A bootstraps, taps, records its bearer and exits. */
  async function firstRun(name: string, fake: FakeDevice) {
    const a = await daemon(name, fake);
    expect((await a.get('/tap', 'POST')).status).toBe(200);
    const bearer = fake.requests.at(-1)!.authorization!;
    await a.close();
    return bearer;
  }

  const terminations = (fake: FakeDevice) => fake.calls.filter((c) => c.includes('--terminate-existing')).length;
  const bootTokenReads = (fake: FakeDevice) => fake.calls.filter((c) => c.includes('device copy from')).length;
  const sentBearer = (fake: FakeDevice, bearer: string, since = 0) => fake.requests.slice(since).filter((r) => r.authorization === bearer);
  const persistedBearer = (path: string) => `Bearer ${readSession(path).session?.bearer}`;

  test('a restarted daemon resumes the persisted bearer: no relaunch, app state kept', async () => {
    const fake = await device();
    const bearer = await firstRun('resume', fake);
    expect(persistedBearer(join(dir, 'resume.session.json'))).toBe(bearer);

    const b = await daemon('resume', fake);
    const snap = await b.get('/state/snapshot');
    expect(snap.status).toBe(200);
    expect(JSON.parse(snap.body).state).toEqual({ generation: 1, marker: 'tapped' });
    expect(terminations(fake)).toBe(0);
    expect(bootTokenReads(fake)).toBe(1);
    expect(fake.requests.at(-1)?.authorization).toBe(bearer);
    expect(b.logs.some((l) => l.startsWith('session resumed: reused the persisted bearer for FAKE-UDID-1'))).toBe(true);
  });

  test('app relaunched between daemons: the old bearer is presented once, then a normal bootstrap', async () => {
    const fake = await device();
    const bearer = await firstRun('relaunched', fake);
    fake.relaunchExternally();
    const since = fake.requests.length;

    const b = await daemon('relaunched', fake);
    expect((await b.get('/screenshot')).status).toBe(200);
    expect(sentBearer(fake, bearer, since)).toHaveLength(1);
    expect(sentBearer(fake, bearer, since)[0]!.path).toBe('/state/snapshot');
    expect(bootTokenReads(fake)).toBe(2);
    expect(terminations(fake)).toBe(0);
    const fresh = persistedBearer(join(dir, 'relaunched.session.json'));
    expect(fresh).not.toBe(bearer);
    expect(fake.requests.at(-1)?.authorization).toBe(fresh);
    expect(b.logs.some((l) => l.includes('rejected the session bearer'))).toBe(true);
  });

  test('a resumed bearer that later gets 401 is never re-probed; the replacement is persisted', async () => {
    const fake = await device();
    const bearer = await firstRun('later-401', fake);
    const b = await daemon('later-401', fake);
    expect((await b.get('/screenshot')).status).toBe(200);

    fake.relaunchExternally();
    const since = fake.requests.length;
    expect((await b.get('/screenshot')).status).toBe(200);
    expect(sentBearer(fake, bearer, since)).toHaveLength(1);
    expect(sentBearer(fake, bearer, since)[0]!.path).toBe('/screenshot');
    expect(persistedBearer(join(dir, 'later-401.session.json'))).not.toBe(bearer);
    expect(terminations(fake)).toBe(0);
  });

  test('another device at the same address: the old bearer is never sent to it', async () => {
    const fake = await device({ udid: 'PHONE-UDID' });
    const bearer = await firstRun('replaced', fake);
    fake.replaceDevice('PAD-UDID', 'iPad');

    const b = await daemon('replaced', fake);
    expect((await b.get('/screenshot')).status).toBe(200);
    const pad = fake.requests.filter((r) => r.udid === 'PAD-UDID');
    expect(pad.length).toBeGreaterThan(0);
    expect(pad.some((r) => r.authorization === bearer)).toBe(false);
    expect(b.logs.some((l) => l.includes('target device changed from PHONE-UDID to PAD-UDID'))).toBe(true);
  });

  test('a session bound to another UDID or app is not sent anywhere', async () => {
    const fake = await device();
    const bearer = await firstRun('binding', fake);
    const path = join(dir, 'binding.session.json');
    const since = fake.requests.length;

    const pinned = await daemon('binding-udid', fake, { udid: 'OTHER-UDID', sessionPath: path });
    expect((await pinned.get('/screenshot')).status).toBe(503);
    expect(sentBearer(fake, bearer, since)).toHaveLength(0);
    expect(pinned.logs.some((l) => l.includes('persisted session belongs to com.test.session on FAKE-UDID-1'))).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test('a StateServer now owned by another app never receives the bearer', async () => {
    const fake = await device({ bundleId: 'com.other.app' });
    fake.relaunchExternally();
    const path = join(dir, 'wrong-app.session.json');
    writeSession({ udid: fake.udid, ipv6Addr: '::1', port: fake.port, bootTokenRotated: 'persisted-secret' }, BUNDLE, path);

    const b = await daemon('wrong-app', fake, { sessionPath: path });
    expect((await b.get('/screenshot')).status).toBe(503);
    expect(sentBearer(fake, 'Bearer persisted-secret')).toHaveLength(0);
    expect(b.logs.some((l) => l.includes('now belongs to com.other.app'))).toBe(true);
  });

  test('no devicectl address for the persisted UDID: the bearer is not sent to a fallback address', async () => {
    const fake = await device();
    const bearer = await firstRun('no-address', fake);
    const since = fake.requests.length;
    const noDetails: SpawnImpl = (cmd, args) => (args.join(' ').includes('info details')
      ? fake.spawn(cmd, ['unsupported'])
      : fake.spawn(cmd, args));

    const b = await daemon('no-address', fake, { spawn: noDetails });
    expect((await b.get('/screenshot')).status).toBe(200);
    expect(sentBearer(fake, bearer, since)).toHaveLength(0);
    expect(terminations(fake)).toBe(1);
    expect(b.logs.some((l) => l.includes('devicectl reported no tunnel address for FAKE-UDID-1'))).toBe(true);
  });

  test('an insecure session file is removed unused and replaced by a private one', async () => {
    const fake = await device();
    const bearer = await firstRun('insecure', fake);
    const path = join(dir, 'insecure.session.json');
    chmodSync(path, 0o644);
    const since = fake.requests.length;

    const b = await daemon('insecure', fake);
    expect((await b.get('/screenshot')).status).toBe(200);
    expect(sentBearer(fake, bearer, since)).toHaveLength(0);
    expect(b.logs.some((l) => l.includes('because other users can access it (mode 644)'))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('device momentarily unreachable: the file is kept and the next request resumes', async () => {
    const fake = await device();
    const bearer = await firstRun('blip', fake);
    const path = join(dir, 'blip.session.json');

    const b = await daemon('blip', fake);
    fake.dropConnections(1);
    expect((await b.get('/screenshot')).status).toBe(503);
    expect(persistedBearer(path)).toBe(bearer);
    expect(b.logs.some((l) => l.includes(`kept ${path} for the next request`))).toBe(true);

    expect((await b.get('/screenshot')).status).toBe(200);
    expect(fake.requests.at(-1)?.authorization).toBe(bearer);
    expect(terminations(fake)).toBe(0);
    expect(bootTokenReads(fake)).toBe(1);
  }, 15_000);
});
