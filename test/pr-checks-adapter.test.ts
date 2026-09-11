import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyRequiredChecks, parseRequiredChecks } from '../lib/provider-access';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function digest(file: string): string {
  return new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex');
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe('exact-PR required-check adapter', () => {
  test('accepts only the supported gh field grammar and classifies required states', () => {
    const rows = parseRequiredChecks(JSON.stringify([
      { name: 'unit', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/1', workflow: 'CI' },
      { name: 'lint', state: 'FAILURE', bucket: 'fail', link: 'https://ci/2', workflow: 'CI' },
      { name: 'e2e', state: 'PENDING', bucket: 'pending', link: 'https://ci/3', workflow: 'CI' },
    ]));
    expect(classifyRequiredChecks(rows)).toEqual({
      status: 'blocked', blockerCount: 1, pendingCount: 1, passedCount: 1,
      blockerIds: ['lint'], pendingIds: ['e2e'],
    });
  });

  test('rejects nonexistent or extra status/conclusion/targetUrl fields', () => {
    for (const forbidden of ['status', 'conclusion', 'targetUrl']) {
      const row = { name: 'unit', state: 'SUCCESS', bucket: 'pass', link: '', workflow: 'CI', [forbidden]: 'x' };
      expect(() => parseRequiredChecks(JSON.stringify([row]))).toThrow('checks_field_invalid');
    }
  });

  test('represents an expired required-check wait as a typed blocker', () => {
    expect(classifyRequiredChecks([
      { name: 'unit', state: 'PENDING', bucket: 'pending', link: '', workflow: 'CI' },
    ], { timedOut: true })).toEqual({
      status: 'blocked', blockerCount: 1, pendingCount: 1, passedCount: 0,
      blockerIds: ['required_checks_timeout'], pendingIds: ['unit'],
    });
  });

  // The integration fixture attests executable POSIX shell scripts and owner
  // UIDs. Native Windows authority mutation is fail-closed and has no getuid;
  // keep the pure parser/classifier contract above active on that platform.
  test.skipIf(process.platform === 'win32')('rejects repository identity before spawning the checks child', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-pr-checks-')));
    roots.push(root);
    const log = path.join(root, 'calls.log');
    const git = path.join(root, 'git');
    const gh = path.join(root, 'gh');
    fs.writeFileSync(git, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nif [ "$1" = "--version" ]; then echo 'git version fixture'; else echo 'git@github.com:Konghak/PortfolioOps.git'; fi\n`);
    fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nif [ "$1" = "--version" ]; then echo 'gh version fixture'; else echo '{"data":{"repository":{"id":"R_other","nameWithOwner":"Other/PortfolioOps","viewerPermission":"READ","pullRequest":{"number":123,"state":"OPEN"}}}}'; fi\n`);
    fs.chmodSync(git, 0o755);
    fs.chmodSync(gh, 0o755);
    const manifest = path.join(root, 'runtime.json');
    fs.writeFileSync(manifest, JSON.stringify({
      schema: 'ecpe.gstack-runtime.v1',
      tools: {
        git: { realpath: git, owner_uid: process.getuid!(), mode: 0o755, sha256: digest(git), version: 'git version fixture' },
        gh: { realpath: gh, owner_uid: process.getuid!(), mode: 0o755, sha256: digest(gh), version: 'gh version fixture' },
      },
    }));
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../bin/gstack-pr-checks'), 'snapshot', '--pr', '123'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: '/usr/bin:/bin', ECPE_TESTING: '1', ECPE_TEST_RUNTIME_MANIFEST: manifest },
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(stderr).toContain('provider_auth_mismatch');
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toContain('api graphql');
    expect(calls).not.toContain('pr checks');
  });
});
