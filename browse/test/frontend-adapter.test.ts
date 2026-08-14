import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  validateAdapter,
  loadAdapter,
  resolveEnv,
  adapterPath,
  ADAPTER_FILENAME,
} from '../src/frontend-adapter';

const XPLOR_CONFIG = path.join(
  import.meta.dir,
  '../../../../consumers/xplor-client/agent-browser.config.mjs',
);

async function importDefault(file: string): Promise<unknown> {
  const mod = await import(file);
  return mod.default ?? mod;
}

describe('U9 frontend adapter — xplor config', () => {
  it('loads and validates the xplor adapter', async () => {
    const mod = await importDefault(XPLOR_CONFIG);
    const adapter = validateAdapter(mod, XPLOR_CONFIG);
    expect(typeof adapter.realm).toBe('function');
    expect(adapter.token.storageKey).toBe('auth');
  });

  it('resolves release-6-6-0 and release-6-7-0 to realm "release"', async () => {
    const adapter = validateAdapter(await importDefault(XPLOR_CONFIG), XPLOR_CONFIG);
    expect(resolveEnv(adapter, 'release-6-6-0').realm).toBe('release');
    expect(resolveEnv(adapter, 'release-6-7-0').realm).toBe('release');
    // both point at their own origin but share the cache realm
    expect(resolveEnv(adapter, 'release-6-6-0').appOrigin).toBe('https://release-6-6-0.exlabs.cloud');
  });

  it('keeps demo and superman in their own realms', async () => {
    const adapter = validateAdapter(await importDefault(XPLOR_CONFIG), XPLOR_CONFIG);
    expect(resolveEnv(adapter, 'demo').realm).toBe('demo');
    expect(resolveEnv(adapter, 'superman').realm).toBe('superman');
  });

  it('runs the locked auth state machine: mfaRequired -> totp -> bearer', async () => {
    const adapter = validateAdapter(await importDefault(XPLOR_CONFIG), XPLOR_CONFIG);
    expect(adapter.auth.afterFirstStep({ mfaRequired: true })).toEqual({ need: 'totp' });
    const second = adapter.auth.afterSecondStep!({ bearerToken: 'x.y.z', roles: ['SUPER'] });
    expect(second).toEqual({ done: { bearerToken: 'x.y.z', roles: ['SUPER'] } });
  });

  it('surfaces QR-enrollment as an actionable error, not a hang', async () => {
    const adapter = validateAdapter(await importDefault(XPLOR_CONFIG), XPLOR_CONFIG);
    const outcome = adapter.auth.afterFirstStep({ authKey: 'k', qr: 'data:...' });
    expect('error' in outcome).toBe(true);
  });

  it('validates the token object shape', async () => {
    const adapter = validateAdapter(await importDefault(XPLOR_CONFIG), XPLOR_CONFIG);
    expect(() => adapter.token.validate({ bearerToken: 'x', roles: [] })).not.toThrow();
    expect(() => adapter.token.validate({ bearerToken: 'x' })).toThrow(/roles/);
    expect(() => adapter.token.validate({ roles: [] })).toThrow(/bearerToken/);
  });

  it('rejects an unknown env name with the valid list', async () => {
    const adapter = validateAdapter(await importDefault(XPLOR_CONFIG), XPLOR_CONFIG);
    expect(() => resolveEnv(adapter, 'nope')).toThrow(/Unknown env "nope"/);
  });
});

describe('U9 frontend adapter — validation errors', () => {
  it('rejects a config with no default export object', () => {
    expect(() => validateAdapter(null, 'test')).toThrow(/default export/);
  });

  it('rejects a malformed adapter missing auth.endpoint', () => {
    const bad = {
      envs: { demo: { appOrigin: 'https://d', apiOrigin: 'https://d' } },
      realm: () => 'demo',
      auth: { firstStep: () => ({}), afterFirstStep: () => ({ need: 'totp' }) },
      token: { storageKey: 'auth', validate: () => {}, bearer: () => '' },
    };
    expect(() => validateAdapter(bad, 'test')).toThrow(/auth\.endpoint/);
  });

  it('rejects an env missing apiOrigin', () => {
    const bad = {
      envs: { demo: { appOrigin: 'https://d' } },
      realm: () => 'demo',
      auth: { endpoint: () => '', firstStep: () => ({}), afterFirstStep: () => ({ need: 'totp' }) },
      token: { storageKey: 'auth', validate: () => {}, bearer: () => '' },
    };
    expect(() => validateAdapter(bad, 'test')).toThrow(/apiOrigin/);
  });
});

describe('U9 frontend adapter — loader + portability (R7/R8)', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-fixture-'));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('errors with the expected path when no adapter exists', async () => {
    await expect(loadAdapter(tmp)).rejects.toThrow(new RegExp(ADAPTER_FILENAME));
    expect(adapterPath(tmp)).toBe(path.join(tmp, ADAPTER_FILENAME));
  });

  it('loads a second (fixture) frontend adapter with no engine change', async () => {
    // A wholly different frontend: different envs, single-step auth, different key.
    const fixture = `
      export default {
        envs: { staging: { appOrigin: 'https://s.example', apiOrigin: 'https://api.s.example' } },
        realm: (n) => n,
        auth: {
          endpoint: (api) => api + '/login',
          firstStep: (c) => c,
          afterFirstStep: (d) => (d && d.jwt ? { done: d } : { error: 'no jwt' }),
        },
        token: {
          storageKey: 'session',
          validate: (o) => { if (!o || !o.jwt) throw new Error('missing jwt'); },
          bearer: (o) => o.jwt,
        },
      };
    `;
    fs.writeFileSync(adapterPath(tmp), fixture);
    const adapter = await loadAdapter(tmp);
    expect(adapter.token.storageKey).toBe('session');
    expect(resolveEnv(adapter, 'staging').realm).toBe('staging');
    expect(adapter.auth.afterFirstStep({ jwt: 'abc' })).toEqual({ done: { jwt: 'abc' } });
  });
});
