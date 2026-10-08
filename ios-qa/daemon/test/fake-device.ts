// Simulated iOS device for daemon recovery tests: a `devicectl` emulator plus
// a StateServer stand-in with the real auth state machine (one-shot boot
// token file, scrubbed on /auth/rotate; rotated bearer held in memory; a
// relaunch mints a new boot token and forgets the bearer and all app state).
// It lets tests drive the production bootstrap + recovery wiring end-to-end
// without Xcode or an iPhone.

import { createServer, type Server } from 'http';
import type { Socket } from 'net';
import { writeFileSync } from 'fs';
import type { SpawnImpl } from '../src/devicectl';

export interface FakeDeviceEntry {
  identifier: string;
  name: string;
  productType: string;
  platform: string;
  deviceType: string;
  tunnelState?: string;
  transportType?: string;
  paired?: boolean;
}

export interface FakeDevice {
  udid: string;
  port: number;
  /** Tunnel address `devicectl device info details` reports for `udid`. */
  address: string;
  /** Entries `devicectl list devices` returns; mutate to simulate re-plugging. */
  devices: FakeDeviceEntry[];
  /** Every devicectl invocation, joined. */
  calls: string[];
  /** Every StateServer request, the bearer it carried, and the device it reached. */
  requests: Array<{ method: string; path: string; authorization?: string; udid: string }>;
  running: boolean;
  /** In-app QA state; lost whenever the app process is replaced. */
  appState: { generation: number; marker: string | null };
  spawn: SpawnImpl;
  /** Black-hole the next `count` requests (CoreDevice route blip: no reply until the proxy times out). */
  dropConnections(count: number): void;
  /** Simulate the app crashing or being stopped. */
  stopApp(): void;
  /** Simulate Xcode re-running the app: new process, new boot-token file. */
  relaunchExternally(): void;
  /**
   * Unplug this device and plug in another one that answers at the same
   * tunnel address and port (production StateServers all use one port). The
   * new device starts with the app not running.
   */
  replaceDevice(udid: string, deviceType: 'iPhone' | 'iPad'): void;
  close(): Promise<void>;
}

const BUNDLE_PATH = (bundleId: string) => `/private/var/containers/Bundle/Application/FAKE/${bundleId}.app/`;

function ret(status: number, stdout = '', stderr = ''): ReturnType<SpawnImpl> {
  return {
    pid: 0,
    output: [null, Buffer.from(stdout), Buffer.from(stderr)],
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    status,
    signal: null,
  } as ReturnType<SpawnImpl>;
}

function targetOf(args: string[]): string | undefined {
  const flag = args.findIndex((a) => a === '--device' || a === '-d');
  return flag === -1 ? undefined : args[flag + 1];
}

function writeJson(args: string[], payload: unknown): void {
  const at = args.indexOf('--json-output');
  if (at !== -1 && args[at + 1]) writeFileSync(args[at + 1]!, JSON.stringify(payload));
}

function writeListing(args: string[], entries: FakeDeviceEntry[]): void {
  writeJson(args, {
    result: {
      devices: entries.map((d) => ({
        identifier: d.identifier,
        connectionProperties: {
          tunnelState: d.tunnelState ?? 'connected',
          pairingState: d.paired === false ? 'unpaired' : 'paired',
          transportType: d.transportType ?? 'wired',
        },
        deviceProperties: { name: d.name },
        hardwareProperties: { productType: d.productType, platform: d.platform, deviceType: d.deviceType },
      })),
    },
  });
}

export async function startFakeDevice(opts: {
  bundleId: string;
  udid?: string;
  deviceType?: 'iPhone' | 'iPad';
}): Promise<FakeDevice> {
  const entryFor = (udid: string, deviceType: 'iPhone' | 'iPad'): FakeDeviceEntry => ({
    identifier: udid,
    name: `Fake ${deviceType}`,
    productType: deviceType === 'iPad' ? 'iPad14,5' : 'iPhone15,2',
    platform: 'iOS',
    deviceType,
  });
  let bootToken: string | null = null;
  let bootTokenFile: string | null = null;
  let rotatedToken: string | null = null;
  let dropping = 0;
  const sockets = new Set<Socket>();

  const device: FakeDevice = {
    udid: opts.udid ?? 'FAKE-UDID-1',
    port: 0,
    address: '::1',
    devices: [],
    calls: [],
    requests: [],
    running: false,
    appState: { generation: 0, marker: null },
    spawn: undefined as unknown as SpawnImpl,
    dropConnections(count) { dropping = count; },
    stopApp() {
      device.running = false;
      rotatedToken = null;
      bootToken = null;
    },
    relaunchExternally() { launch(); },
    replaceDevice(udid, deviceType) {
      device.stopApp();
      device.udid = udid;
      device.devices = [entryFor(udid, deviceType)];
      device.appState = { generation: 0, marker: null };
    },
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };

  device.devices = [entryFor(device.udid, opts.deviceType ?? 'iPhone')];

  const launch = () => {
    device.running = true;
    device.appState = { generation: device.appState.generation + 1, marker: null };
    bootToken = `boot-${device.appState.generation}-${Math.random().toString(36).slice(2)}`;
    bootTokenFile = bootToken;
    rotatedToken = null;
  };

  const server: Server = createServer((req, res) => {
    if (!device.running) {
      req.socket.destroy();
      return;
    }
    if (dropping > 0) {
      dropping--;
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const authorization = req.headers.authorization;
      device.requests.push({ method: req.method ?? '', path: req.url ?? '', authorization, udid: device.udid });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
      if (req.method === 'GET' && req.url === '/healthz') {
        send(200, { version: '1.0.0', bundle_id: opts.bundleId });
        return;
      }
      if (req.method === 'POST' && req.url === '/auth/rotate') {
        if (!bootToken || bearer !== bootToken) { send(401, { error: 'boot_token_invalid' }); return; }
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { new_token: string };
        rotatedToken = parsed.new_token;
        bootToken = null;
        bootTokenFile = null;
        send(200, { ok: true });
        return;
      }
      if (!rotatedToken || bearer !== rotatedToken) { send(401, { error: 'unauthorized' }); return; }
      if (req.url === '/state/snapshot') { send(200, { state: device.appState }); return; }
      if (req.url === '/screenshot') { send(200, { png_base64: 'abc=' }); return; }
      if (req.method === 'POST' && req.url === '/tap') {
        device.appState.marker = 'tapped';
        send(200, { ok: true });
        return;
      }
      send(404, { error: 'not_found' });
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', () => resolve());
  });
  device.port = (server.address() as { port: number }).port;


  device.spawn = (cmd, args) => {
    const joined = `${cmd} ${args.join(' ')}`;
    device.calls.push(joined);
    if (/devicectl list devices/.test(joined)) {
      writeListing(args, device.devices);
      return ret(0);
    }
    const target = targetOf(args);
    if (target !== device.udid) return ret(1, '', `device ${target} not found`);
    if (/devicectl device info details/.test(joined)) {
      writeJson(args, { result: { connectionProperties: { tunnelIPAddress: device.address } } });
      return ret(0);
    }
    if (/devicectl device info processes/.test(joined)) {
      writeJson(args, {
        result: { runningProcesses: device.running ? [{ executable: `file://${BUNDLE_PATH(opts.bundleId)}App` }] : [] },
      });
      return ret(0);
    }
    if (/devicectl device process launch/.test(joined)) {
      if (device.running && !args.includes('--terminate-existing')) return ret(0);
      launch();
      return ret(0);
    }
    if (/devicectl device copy from/.test(joined)) {
      if (!bootTokenFile) return ret(1, '', 'file not found');
      writeFileSync(args[args.indexOf('--destination') + 1]!, bootTokenFile);
      return ret(0);
    }
    return ret(1, '', `unexpected devicectl call: ${joined}`);
  };

  return device;
}
