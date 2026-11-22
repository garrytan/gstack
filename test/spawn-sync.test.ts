/**
 * lib/spawn-sync.ts (GST-3086): a spawnSync whose output passed maxBuffer never
 * reads as a finished command. Bun can return status 0 together with error
 * ENOBUFS and cut-off stdout when the child exits before the overflow kill
 * lands (GSTA-618, seen on Bun 1.4.2 and 1.4.4). A child that ignores SIGTERM
 * reproduces that every time, so these tests do not depend on timing, as long as
 * its one write fits the Unix socket send buffer (212,992 bytes on Linux): a write
 * that does not fit takes EPIPE when Bun closes its end, and the child exits 1
 * within about 10 ms. 200,000 bytes sat 13 KB under that buffer and flaked on CI
 * (GSTA-712), so the child writes 32 KiB, still far past maxBuffer.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync as rawSpawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RESULT_CODES } from '../lib/result-codes';
import { spawnSync } from '../lib/spawn-sync';
import { listRepoFiles } from '../lib/pregate/import-graph';
import { gitEnv } from './helpers/git-env';

/**
 * The git binary itself, from `git --exec-path`, so a stub named git cannot be reached again through
 * a PATH-resolving git wrapper (Bun.which('git') can return the wrapper). Falls back to Bun.which.
 */
function realGit(env: NodeJS.ProcessEnv = process.env): string {
  const r = rawSpawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 10_000, env });
  const bin = path.join((r.stdout ?? '').trim(), process.platform === 'win32' ? 'git.exe' : 'git');
  if (r.status === 0 && fs.existsSync(bin)) return bin;
  return Bun.which('git', { PATH: env.PATH }) || '/usr/bin/git';
}

const OVERFLOW = "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(32768)); setTimeout(() => {}, 300);";
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
      const gitBin = realGit();
      const stub = [
        '#!/bin/sh',
        'if [ "$1" = "diff" ]; then',
        "  trap '' TERM",
        "  printf 'diff --git a/pad.txt b/pad.txt\\n--- a/pad.txt\\n+++ b/pad.txt\\n@@ -1,2000000 +1,2000000 @@\\n'",
        "  yes ' padding line that only fills the read buffer of the scanner' | head -n 2000000",
        `  "${gitBin}" "$@"`,
        '  exit 0',
        'fi',
        `exec "${gitBin}" "$@"`,
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

describe('the stub git finds the real git binary', () => {
  // POSIX only: the wrapper is a #!/bin/sh file named git.
  test.skipIf(process.platform === 'win32')('a PATH-resolving git wrapper first on PATH does not become the stub\'s real git', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-sync-wrapper-'));
    try {
      fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nPATH=${process.env.PATH}\nexec git "$@"\n`, { mode: 0o755 });
      const PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
      expect(Bun.which('git', { PATH })).toBe(path.join(dir, 'git'));
      const git = realGit({ ...process.env, PATH });
      expect(path.dirname(git)).not.toBe(dir);
      expect(fs.readFileSync(git).subarray(0, 2).toString()).not.toBe('#!');
      expect(rawSpawnSync(git, ['--version'], { encoding: 'utf8', timeout: 10_000 }).stdout).toStartWith('git version');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('listRepoFiles (lib/pregate/import-graph.ts) refuses an unfinished git ls-files', () => {
  test('a git that cannot start throws instead of returning no files', () => {
    expect(() => listRepoFiles(path.join(os.tmpdir(), 'spawn-sync-no-such-repo', String(process.pid)))).toThrow('git ls-files did not finish');
  });

  // POSIX only: the stub is a #!/bin/sh file named git, which Windows does not run.
  test.skipIf(process.platform === 'win32')('a file list cut off past 64 MiB that exits 0 throws SPAWN_OUTPUT_INCOMPLETE', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-sync-ls-files-'));
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
    const saved = process.env[pathKey];
    try {
      fs.writeFileSync(path.join(dir, 'git'), "#!/bin/sh\ntrap '' TERM\nyes 'lib/a-file-name-that-fills-the-list.ts' | head -n 2000000\nexit 0\n", { mode: 0o755 });
      process.env[pathKey] = `${dir}${path.delimiter}${saved ?? ''}`;
      expect(() => listRepoFiles(dir)).toThrow('SPAWN_OUTPUT_INCOMPLETE');
    } finally {
      process.env[pathKey] = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * GST-3104: product code takes spawnSync from lib/spawn-sync.ts. The files that still import it from
 * node:child_process are listed in test/fixtures/spawn-sync-raw-importers.json, and that list may only
 * shrink. Only code files and bin/ scripts are listed and read.
 */
const ROOT = path.resolve(import.meta.dir, '..');
const BASELINE_PATH = 'test/fixtures/spawn-sync-raw-importers.json';
const OWNER = 'lib/spawn-sync.ts';

const CODE = /\.(?:[cm]?[jt]s|tsx)$/;
const BIN = /(?:^|\/)bin\/[^/.]+$/;
const CODE_PATHSPECS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs', 'bin/*', '*/bin/*'];
const isTest = (f: string) => /(^|\/)(test|tests|__tests__|fixtures)\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f) || f === 'test-setup.ts';
const CHILD_PROCESS = String.raw`['"](?:node:)?child_process['"]`;

/** Whether this source takes spawnSync from node:child_process (named, aliased, namespace, default or require). */
export function importsRawSpawnSync(text: string): boolean {
  for (const m of text.matchAll(new RegExp(String.raw`import\s*(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*${CHILD_PROCESS}`, 'g'))) {
    if (/(?:^|[,{\s])spawnSync\b/.test(m[1].replace(/\btype\s+spawnSync\b/g, ''))) return true;
  }
  for (const m of text.matchAll(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+(\w+)))?\s+from\s*${CHILD_PROCESS}`, 'g'))) {
    if (m.slice(1).some(name => name && new RegExp(String.raw`\b${name}\.spawnSync\b`).test(text))) return true;
  }
  return new RegExp(String.raw`require\(\s*${CHILD_PROCESS}\s*\)`).test(text) && /\bspawnSync\b/.test(text);
}

function productSources(): Map<string, string> {
  const r = rawSpawnSync('git', ['ls-files', '-z', '--', ...CODE_PATHSPECS], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 || r.error) throw new Error(`git ls-files failed: ${r.error?.message ?? r.stderr}`);
  const out = new Map<string, string>();
  for (const f of r.stdout.split('\0').filter(Boolean)) {
    if (isTest(f) || f === OWNER) continue;
    const bin = BIN.test(f);
    if (!CODE.test(f) && !bin) continue;
    let text: string;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (bin && !/^#!.*\b(?:bun|node|tsx)\b/.test(text)) continue;
    out.set(f, text);
  }
  return out;
}

describe('raw spawnSync import ratchet', () => {
  const baseline = (JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE_PATH), 'utf8')) as { files: string[] }).files;
  const raw = [...productSources()].filter(([, text]) => importsRawSpawnSync(text)).map(([f]) => f).sort();

  test('no product file outside the baseline imports spawnSync from node:child_process', () => {
    const added = raw.filter(f => !baseline.includes(f));
    expect(added, `import spawnSync from ${OWNER} instead (it fails closed on cut-off output, GST-3086)`).toEqual([]);
  });

  test('the baseline only shrinks: a file that no longer imports it raw leaves the list', () => {
    const stale = baseline.filter(f => !raw.includes(f));
    expect(stale, `remove these from ${BASELINE_PATH}`).toEqual([]);
    expect([...baseline].sort(), `keep ${BASELINE_PATH} sorted`).toEqual(baseline);
  });

  test('the scanner sees every import form and ignores type-only and other imports', () => {
    expect(importsRawSpawnSync("import { spawnSync } from 'node:child_process';")).toBe(true);
    expect(importsRawSpawnSync('import { execSync, spawnSync as run } from "child_process";')).toBe(true);
    expect(importsRawSpawnSync("import {\n  spawn,\n  spawnSync,\n} from 'node:child_process';")).toBe(true);
    expect(importsRawSpawnSync("import * as cp from 'node:child_process';\ncp.spawnSync('git', [], { timeout: 1000 });")).toBe(true);
    expect(importsRawSpawnSync("const { spawnSync } = require('child_process');")).toBe(true);
    expect(importsRawSpawnSync("import cp, { spawnSync } from 'node:child_process';")).toBe(true);
    expect(importsRawSpawnSync("import cp, { spawn } from 'node:child_process';\ncp.spawnSync('git', [], { timeout: 1000 });")).toBe(true);
    expect(importsRawSpawnSync("import cp, * as all from 'node:child_process';\nall.spawnSync('git', [], { timeout: 1000 });")).toBe(true);
    expect(importsRawSpawnSync("import cp, { spawn } from 'node:child_process';\ncp.spawn('git', []);")).toBe(false);
    expect(importsRawSpawnSync("import type { SpawnSyncReturns } from 'node:child_process';")).toBe(false);
    expect(importsRawSpawnSync("import { spawn, type spawnSync } from 'node:child_process';")).toBe(false);
    expect(importsRawSpawnSync("import * as cp from 'node:child_process';\ncp.spawn('git', []);")).toBe(false);
    expect(importsRawSpawnSync("import { spawnSync } from './spawn-sync';")).toBe(false);
  });
});
