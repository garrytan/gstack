import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  acquireOrLoad,
  readCachedToken,
  writeCachedToken,
  cacheFilePath,
  type AcquiredToken,
} from '../src/token-manager';
import { validateAdapter, type FrontendAdapter } from '../src/frontend-adapter';

const XPLOR_CONFIG = path.join(
  import.meta.dir,
  '../../../../consumers/xplor-client/agent-browser.config.mjs',
);

async function xplorAdapter(): Promise<FrontendAdapter> {
  const mod = await import(XPLOR_CONFIG);
  return validateAdapter(mod.default ?? mod, XPLOR_CONFIG);
}

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ roles: ['SUPER'], exp: expSeconds })).toString(
    'base64url',
  );
  return `h.${payload}.s`;
}

const NOW = 1_000_000_000_000;
const future = (msFromNow: number) => Math.round((NOW + msFromNow) / 1000);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cache-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Scripted fetch counting how many acquisitions happen. */
function acquirer(expSeconds: number) {
  let acquires = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const isStep2 = 'authKey' in body;
    if (isStep2) acquires++;
    return {
      status: 200,
      text: async () =>
        JSON.stringify(isStep2 ? { bearerToken: jwt(expSeconds), roles: ['SUPER'] } : { mfaRequired: true }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    deps: {
      fetchImpl,
      credsProvider: () => ({ userName: 'Dev1', password: 'pw' }),
      totpProvider: () => '000000',
      now: () => NOW,
      frontendRoot: () => tmp,
    },
    acquires: () => acquires,
  };
}

function depsFor(a: ReturnType<typeof acquirer>) {
  return { ...a.deps, frontendRoot: tmp };
}

describe('U2 token cache', () => {
  it('first call acquires + writes; second call returns cache with no acquire', async () => {
    const adapter = await xplorAdapter();
    const a = acquirer(future(10 * 3600 * 1000) as unknown as number);
    const first = await acquireOrLoad(adapter, 'demo', depsFor(a));
    expect(first.cached).toBe(false);
    expect(a.acquires()).toBe(1);
    const second = await acquireOrLoad(adapter, 'demo', depsFor(a));
    expect(second.cached).toBe(true);
    expect(a.acquires()).toBe(1);
  });

  it('realm-share: release-6-6-0 then release-6-7-0 -> one acquire, one entry', async () => {
    const adapter = await xplorAdapter();
    const a = acquirer(future(10 * 3600 * 1000) as unknown as number);
    await acquireOrLoad(adapter, 'release-6-6-0', depsFor(a));
    const second = await acquireOrLoad(adapter, 'release-6-7-0', depsFor(a));
    expect(second.cached).toBe(true);
    expect(a.acquires()).toBe(1);
    const files = fs.readdirSync(path.join(tmp, '.auth'));
    expect(files).toEqual(['release-Dev1.json']);
  });

  it('expired entry -> re-acquires and overwrites', async () => {
    const adapter = await xplorAdapter();
    const a = acquirer(future(-1000) as unknown as number); // already expired
    const first = await acquireOrLoad(adapter, 'demo', depsFor(a));
    expect(first.cached).toBe(false);
    const second = await acquireOrLoad(adapter, 'demo', depsFor(a));
    expect(second.cached).toBe(false); // stale -> re-acquire
    expect(a.acquires()).toBe(2);
  });

  it('forceRefresh bypasses a fresh cache entry', async () => {
    const adapter = await xplorAdapter();
    const a = acquirer(future(10 * 3600 * 1000) as unknown as number);
    await acquireOrLoad(adapter, 'demo', depsFor(a));
    const refreshed = await acquireOrLoad(adapter, 'demo', { ...depsFor(a), forceRefresh: true });
    expect(refreshed.cached).toBe(false);
    expect(a.acquires()).toBe(2);
  });

  it('written cache file has mode 600', async () => {
    const token: AcquiredToken = {
      auth: { bearerToken: 'x', roles: [] },
      realm: 'demo',
      appOrigin: 'https://demo',
      env: 'demo',
      userName: 'Dev1',
      acquiredAt: NOW,
      expiresAt: NOW + 3600_000,
    };
    const file = writeCachedToken({ frontendRoot: tmp }, token);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(file).toBe(cacheFilePath({ frontendRoot: tmp }, 'demo', 'Dev1'));
  });

  it('portability: distinct userName -> distinct entry, no collision', async () => {
    writeCachedToken({ frontendRoot: tmp }, {
      auth: {}, realm: 'release', appOrigin: 'a', env: 'release-6-6-0',
      userName: 'Dev1', acquiredAt: NOW, expiresAt: NOW + 3600_000,
    } as AcquiredToken);
    writeCachedToken({ frontendRoot: tmp }, {
      auth: {}, realm: 'release', appOrigin: 'a', env: 'release-6-6-0',
      userName: 'Dev2', acquiredAt: NOW, expiresAt: NOW + 7200_000,
    } as AcquiredToken);
    const files = fs.readdirSync(path.join(tmp, '.auth')).sort();
    expect(files).toEqual(['release-Dev1.json', 'release-Dev2.json']);
    // read returns the freshest (Dev2)
    const hit = readCachedToken({ frontendRoot: tmp, now: () => NOW }, 'release');
    expect(hit?.userName).toBe('Dev2');
  });

  it('read returns null on miss', async () => {
    expect(readCachedToken({ frontendRoot: tmp, now: () => NOW }, 'release')).toBeNull();
  });
});
