/**
 * lib/spawn-sync.ts (GST-3086): a spawnSync whose output passed maxBuffer never
 * reads as a finished command. Bun can return status 0 together with error
 * ENOBUFS and cut-off stdout when the child exits before the overflow kill
 * lands (GSTA-618, seen on Bun 1.4.2 and 1.4.4). A child that ignores SIGTERM
 * reproduces that every time, so these tests do not depend on timing.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync as rawSpawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RESULT_CODES } from '../lib/result-codes';
import { spawnSync } from '../lib/spawn-sync';
import { gitEnv } from './helpers/git-env';

const OVERFLOW = "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(200000)); setTimeout(() => {}, 300);";
const overflowArgs = ['-e', OVERFLOW];

describe('spawnSync (lib/spawn-sync.ts)', () => {
  test.skipIf(process.platform === 'win32')('raw Bun spawnSync reports status 0 with ENOBUFS for a child that outlives the overflow kill', () => {
    const r = rawSpawnSync(process.execPath, overflowArgs, { encoding: 'utf8', maxBuffer: 1024, timeout: 20_000 });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOBUFS');
    expect(r.status).toBe(0);
  });

  test('an overflowing read returns status null and names SPAWN_OUTPUT_INCOMPLETE', () => {
    const r = spawnSync(process.execPath, overflowArgs, { encoding: 'utf8', maxBuffer: 1024, timeout: 20_000 });
    expect(r.status).toBeNull();
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOBUFS');
    expect(r.error?.message).toEndWith('(SPAWN_OUTPUT_INCOMPLETE)');
    const line = r.stderr.trimEnd().split('\n').pop() ?? '';
    expect(line).toEndWith('(SPAWN_OUTPUT_INCOMPLETE)');
    expect(line).toContain(`docs/troubleshooting.md#${RESULT_CODES.SPAWN_OUTPUT_INCOMPLETE.anchor} `);
  });

  test('a Buffer-mode read gets the same line on its stderr Buffer', () => {
    const r = spawnSync(process.execPath, overflowArgs, { maxBuffer: 1024, timeout: 20_000 });
    expect(r.status).toBeNull();
    expect(Buffer.isBuffer(r.stderr)).toBe(true);
    expect(r.stderr.toString('utf8')).toContain('(SPAWN_OUTPUT_INCOMPLETE)');
  });

  test('a clean read and a plain non-zero exit pass through unchanged', () => {
    const ok = spawnSync(process.execPath, ['-e', "process.stdout.write('hi')"], { encoding: 'utf8', timeout: 20_000 });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('hi');
    expect(ok.error).toBeUndefined();
    const bad = spawnSync(process.execPath, ['-e', "process.stderr.write('no'); process.exit(3)"], { encoding: 'utf8', timeout: 20_000 });
    expect(bad.status).toBe(3);
    expect(bad.stderr).toBe('no');
  });
});

describe('the pre-push credential scan with a cut-off diff', () => {
  const PREPUSH = path.resolve(import.meta.dir, '..', 'bin', 'gstack-redact-prepush');
  const FAKE_AWS_KEY = ['AKIA', '1234567890ABCDEF'].join('');

  // POSIX only: the stub is a #!/bin/sh file named git, which Windows does not run.
  test.skipIf(process.platform === 'win32')('a diff git finishes with status 0 after passing the 64 MiB buffer BLOCKS the push', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-sync-prepush-'));
    const repo = path.join(root, 'repo');
    const stubDir = path.join(root, 'stub');
    const git = (args: string[]) => {
      const r = rawSpawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
      if (r.status !== 0 || r.error) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    try {
      fs.mkdirSync(repo);
      fs.mkdirSync(stubDir);
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 't@example.com']);
      git(['config', 'user.name', 'T']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
      git(['add', 'README.md']);
      git(['commit', '-q', '-m', 'base']);
      const base = git(['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(repo, 'config.txt'), `aws_access_key_id = ${FAKE_AWS_KEY}\n`);
      git(['add', 'config.txt']);
      git(['commit', '-q', '-m', 'add config']);
      const head = git(['rev-parse', 'HEAD']);
      // The diff call prints about 90 MB of context lines first, so the real diff (and its key) lands past the
      // hook's 64 MiB maxBuffer; it ignores SIGTERM and exits 0, which is what Bun then reports as the status.
      const realGit = Bun.which('git') || '/usr/bin/git';
      const stub = [
        '#!/bin/sh',
        'if [ "$1" = "diff" ]; then',
        "  trap '' TERM",
        "  printf 'diff --git a/pad.txt b/pad.txt\\n--- a/pad.txt\\n+++ b/pad.txt\\n@@ -1,2000000 +1,2000000 @@\\n'",
        "  yes ' padding line that only fills the read buffer of the scanner' | head -n 2000000",
        `  "${realGit}" "$@"`,
        '  exit 0',
        'fi',
        `exec "${realGit}" "$@"`,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(stubDir, 'git'), stub, { mode: 0o755 });
      const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
      const r = rawSpawnSync('bun', [PREPUSH], {
        cwd: repo,
        input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
        encoding: 'utf8',
        env: gitEnv({ [pathKey]: `${stubDir}${path.delimiter}${process.env[pathKey] || ''}` }),
        timeout: 60_000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('could not compute the pushed diff');
      expect(r.stderr).toContain('SPAWN_OUTPUT_INCOMPLETE');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
