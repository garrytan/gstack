// Cold-start launch env. BuckHound (and any app that gates its debug bridge
// behind an env var) needs the daemon to pass that var when it launches the
// app itself. Without it, a cold start (app not already running) launches the
// app WITHOUT the bridge -> the StateServer never binds -> state_server_unreachable,
// and `/ios-qa` only works if the operator pre-launches by hand. The daemon
// reads GSTACK_IOS_LAUNCH_ENV (a JSON dict) and forwards it to
// `devicectl device process launch --environment-variables`.

import { describe, test, expect } from 'bun:test';
import { launchApp, type SpawnImpl } from '../src/devicectl';
import { bootstrapTunnel } from '../src/tunnel-bootstrap';
import { writeFileSync } from 'fs';

function makeReturn(exit: number, stdout = '', stderr = '') {
  return {
    pid: 0,
    output: [null, Buffer.from(stdout), Buffer.from(stderr)],
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    status: exit,
    signal: null,
  } as ReturnType<SpawnImpl>;
}

describe('launchApp environment variables', () => {
  test('passes --environment-variables with the JSON dict, bundle id stays last', () => {
    let captured: string[] = [];
    const spawn: SpawnImpl = ((_cmd: string, args: string[]) => { captured = args; return makeReturn(0); }) as SpawnImpl;
    const r = launchApp('UDID-1', 'com.test.app', spawn, { BH_ENABLE_IOS_QA_BRIDGE: '1' });
    expect(r.ok).toBe(true);
    const i = captured.indexOf('--environment-variables');
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(captured[i + 1]!)).toEqual({ BH_ENABLE_IOS_QA_BRIDGE: '1' });
    expect(captured[captured.length - 1]).toBe('com.test.app'); // bundle id is the trailing positional
  });

  test('omits --environment-variables when env is undefined or empty', () => {
    for (const env of [undefined, {}]) {
      let captured: string[] = [];
      const spawn: SpawnImpl = ((_cmd: string, args: string[]) => { captured = args; return makeReturn(0); }) as SpawnImpl;
      launchApp('UDID-1', 'com.test.app', spawn, env);
      expect(captured.includes('--environment-variables')).toBe(false);
      expect(captured[captured.length - 1]).toBe('com.test.app');
    }
  });
});

describe('bootstrapTunnel forwards launchEnv on cold start', () => {
  test('threads launchEnv into the launch when the app is not already running', async () => {
    const calls: string[][] = [];
    const spawn: SpawnImpl = ((_cmd: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      const writeJson = (obj: object) => {
        const fi = args.indexOf('--json-output');
        if (fi !== -1 && args[fi + 1]) writeFileSync(args[fi + 1]!, JSON.stringify(obj));
      };
      if (joined.includes('list devices')) {
        writeJson({ result: { devices: [{ identifier: 'UDID-1', connectionProperties: { tunnelState: 'connected', pairingState: 'paired' }, deviceProperties: { name: 'Test' }, hardwareProperties: { productType: 'iPhone17,1' } }] } });
        return makeReturn(0);
      }
      if (joined.includes('info processes')) { writeJson({ result: { runningProcesses: [] } }); return makeReturn(0); } // not running -> launch
      if (joined.includes('process launch')) { return makeReturn(0); }
      if (joined.includes('info details')) { writeJson({ result: { connectionProperties: { tunnelIPAddress: 'fd00::1' } } }); return makeReturn(0); }
      if (joined.includes('copy from')) {
        const fi = args.indexOf('--destination');
        if (fi !== -1 && args[fi + 1]) writeFileSync(args[fi + 1]!, 'BOOT-TOK\n');
        return makeReturn(0);
      }
      return makeReturn(1, '', 'unexpected ' + joined);
    }) as SpawnImpl;

    const r = await bootstrapTunnel({
      udid: 'UDID-1',
      bundleId: 'com.test.app',
      launchEnv: { BH_ENABLE_IOS_QA_BRIDGE: '1' },
      spawnImpl: spawn,
      resolveImpl: async () => ['fd00::1'],
      fetchImpl: (async (url: unknown) => {
        const u = String(url);
        if (u.endsWith('/healthz')) return new Response('{"version":"1.0.0"}', { status: 200 });
        if (u.endsWith('/auth/rotate')) return new Response('{"ok":true}', { status: 200 });
        return new Response('nope', { status: 404 });
      }) as typeof fetch,
      startupTimeoutMs: 1_000,
    });

    expect(r.ok).toBe(true);
    const launchCall = calls.find((a) => a.join(' ').includes('process launch'));
    expect(launchCall).toBeDefined();
    const i = launchCall!.indexOf('--environment-variables');
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(launchCall![i + 1]!)).toEqual({ BH_ENABLE_IOS_QA_BRIDGE: '1' });
  });
});
