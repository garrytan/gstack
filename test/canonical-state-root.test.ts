import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const created: string[] = [];

afterEach(() => {
  for (const entry of created.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
});

async function subject(): Promise<any> {
  return import('../lib/canonical-state-root').catch(() => null);
}

function accountHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-account-home-'));
  created.push(home);
  fs.chmodSync(home, 0o700);
  return home;
}

describe('canonical ECPE authority-state root', () => {
  test('uses the effective UID account home and creates only the fixed owner-only child', async () => {
    const api = await subject();
    expect(api).not.toBeNull();
    const home = accountHome();
    const resolved = api.resolveCanonicalStateRoot({
      effectiveUid: process.getuid!(),
      accountHome: home,
    });

    expect(resolved.root).toBe(path.join(fs.realpathSync(home), '.gstack'));
    expect(fs.statSync(resolved.root).mode & 0o777).toBe(0o700);
    expect(resolved.stateRootId).toMatch(/^state_[0-9a-f]{32}$/);
  });

  test('HOME, XDG and GSTACK_HOME cannot shadow the account-record root', async () => {
    const api = await subject();
    expect(api).not.toBeNull();
    const home = accountHome();
    const shadow = accountHome();
    const resolved = api.resolveCanonicalStateRoot({
      effectiveUid: process.getuid!(),
      accountHome: home,
      environment: { HOME: shadow, XDG_HOME: shadow, GSTACK_HOME: shadow },
    });

    expect(resolved.root.startsWith(fs.realpathSync(home))).toBe(true);
    expect(resolved.root.startsWith(fs.realpathSync(shadow))).toBe(false);
  });

  test('rejects symlink, unsafe mode, foreign owner and mismatched stamped roots', async () => {
    const api = await subject();
    expect(api).not.toBeNull();

    const symlinkHome = accountHome();
    const target = accountHome();
    fs.symlinkSync(target, path.join(symlinkHome, '.gstack'));
    expect(() => api.resolveCanonicalStateRoot({ effectiveUid: process.getuid!(), accountHome: symlinkHome }))
      .toThrow(/state_root_symlink/);

    const modeHome = accountHome();
    fs.mkdirSync(path.join(modeHome, '.gstack'), { mode: 0o755 });
    fs.chmodSync(path.join(modeHome, '.gstack'), 0o755);
    expect(() => api.resolveCanonicalStateRoot({ effectiveUid: process.getuid!(), accountHome: modeHome }))
      .toThrow(/state_root_mode/);

    const ownerHome = accountHome();
    fs.mkdirSync(path.join(ownerHome, '.gstack'), { mode: 0o700 });
    const realLstat = fs.lstatSync;
    expect(() => api.resolveCanonicalStateRoot({
      effectiveUid: process.getuid!(),
      accountHome: ownerHome,
      lstat: (candidate: string) => {
        const info = realLstat(candidate);
        if (candidate.endsWith('.gstack')) {
          return new Proxy(info, { get: (targetInfo, key) => key === 'uid' ? process.getuid!() + 1 : (targetInfo as any)[key] });
        }
        return info;
      },
    })).toThrow(/state_root_owner/);

    const goodHome = accountHome();
    const resolved = api.resolveCanonicalStateRoot({ effectiveUid: process.getuid!(), accountHome: goodHome });
    expect(() => api.assertStateRootId({ state_root_id: 'state_' + '0'.repeat(32) }, resolved))
      .toThrow(/state_root_id_mismatch/);
  });
});
