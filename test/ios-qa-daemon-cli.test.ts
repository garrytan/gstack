/**
 * G6 rider (#1932): `gstack-ios-qa-daemon --help` started the daemon (it
 * exec'd bun with every argument). Help must print and exit without ever
 * reaching the runtime. A stub `bun` first on PATH records any launch.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const DAEMON = `${ROOT}/bin/gstack-ios-qa-daemon`;

describe('gstack-ios-qa-daemon --help', () => {
  for (const flag of ['--help', '-h']) {
    test(`${flag} prints usage and never starts the daemon`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-qa-daemon-help-'));
      try {
        const marker = path.join(dir, 'daemon-started');
        fs.writeFileSync(path.join(dir, 'bun'), `#!/usr/bin/env bash\necho started > "${marker}"\n`, { mode: 0o755 });
        const r = Bun.spawnSync(['bash', DAEMON, flag], {
          env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, HOME: dir },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 10_000,
        });
        expect(r.exitCode).toBe(0);
        const out = r.stdout.toString();
        expect(out).toContain('Usage:');
        expect(out).toContain('--tailnet');
        expect(out).toContain('GSTACK_IOS_DAEMON_PORT');
        expect(fs.existsSync(marker)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
