import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const EXPORT = path.join(ROOT, 'bin', 'gstack-companies-export.ts');

let tmpHome: string;
let tmpOut: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-export-home-'));
  tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-export-out-'));
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpOut, { recursive: true, force: true });
});

interface RunResult { stdout: string; stderr: string; exitCode: number }

function run(args: string[]): RunResult {
  const r = spawnSync('bun', ['run', EXPORT, ...args], {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpHome },
    encoding: 'utf-8',
    timeout: 30000,
  });
  return { stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '', exitCode: r.status ?? 1 };
}

function seedCompany(builder: string, company: string, files: Record<string, string> = {}): string {
  const cd = path.join(tmpHome, 'builders', builder, 'companies', company);
  fs.mkdirSync(cd, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(cd, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return cd;
}

function listArchive(archivePath: string): string[] {
  const r = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' });
  return (r.stdout ?? '').split('\n').filter((l) => l.length > 0).sort();
}

const RUN_ID = '4c107dc2-f68e-4b6e-8acc-2fc57c009002';

// ---------------------------------------------------------------------------

describe('gstack-companies-export', () => {
  test('case 1: happy path → archive contains every artifact subtree', () => {
    seedCompany('alice', 'co-a', {
      'timeline.jsonl': '{"skill":"build","event":"started"}\n',
      'decisions.jsonl': '{"gate":"start","choice":"proceed"}\n',
      'costs.jsonl': '{"stage":"autoplan","cost_usd":0.05}\n',
      'learnings.jsonl': '',
      [`runs/${RUN_ID}/autoplan-result.json`]: '{"schema_version":1,"status":"ok"}',
      'designs/2026-04-27.md': '# Design v0',
      'plans/locked-2026-04-27.md': '# Locked plan',
    });

    const outFile = path.join(tmpOut, 'co-a.tar.gz');
    const r = run(['co-a', '--out', outFile]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(outFile);
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.statSync(outFile).size).toBeGreaterThan(0);

    const entries = listArchive(outFile);
    expect(entries.some((e) => e === 'co-a/' || e === 'co-a')).toBe(true);
    expect(entries).toContain('co-a/timeline.jsonl');
    expect(entries).toContain('co-a/decisions.jsonl');
    expect(entries).toContain('co-a/costs.jsonl');
    expect(entries).toContain(`co-a/runs/${RUN_ID}/autoplan-result.json`);
    expect(entries).toContain('co-a/designs/2026-04-27.md');
    expect(entries).toContain('co-a/plans/locked-2026-04-27.md');
  });

  test('case 2: rejects path-traversal slug', () => {
    const r = run(['../evil', '--out', path.join(tmpOut, 'x.tar.gz')]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/invalid company-slug/);
  });

  test('case 3: multi-builder ambiguity errors with "pass --builder"', () => {
    seedCompany('alice', 'shared', { 'timeline.jsonl': '{}' });
    seedCompany('bob', 'shared', { 'timeline.jsonl': '{}' });

    const r = run(['shared', '--out', path.join(tmpOut, 'x.tar.gz')]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/exists under multiple builders/);
  });

  test('case 3b: explicit --builder resolves the multi-builder case', () => {
    seedCompany('alice', 'shared', { 'timeline.jsonl': '{"who":"alice"}\n' });
    seedCompany('bob', 'shared', { 'timeline.jsonl': '{"who":"bob"}\n' });

    const outFile = path.join(tmpOut, 'shared-from-bob.tar.gz');
    const r = run(['shared', '--builder', 'bob', '--out', outFile]);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);

    // Verify content is bob's, not alice's
    const extractDir = path.join(tmpOut, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    spawnSync('tar', ['-xzf', outFile, '-C', extractDir]);
    const tl = fs.readFileSync(path.join(extractDir, 'shared', 'timeline.jsonl'), 'utf-8');
    expect(tl).toContain('bob');
    expect(tl).not.toContain('alice');
  });

  test('case 4: --out custom path is honored', () => {
    seedCompany('alice', 'co-a', { 'timeline.jsonl': '{}' });

    const customDir = path.join(tmpOut, 'nested', 'sub');
    const customOut = path.join(customDir, 'custom-name.tgz');
    const r = run(['co-a', '--out', customOut]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(customOut);
    expect(fs.existsSync(customOut)).toBe(true);
  });

  test('case 5: non-existent company → clean error, no partial archive', () => {
    const outFile = path.join(tmpOut, 'never-exists.tar.gz');
    const r = run(['no-such-company', '--out', outFile]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not found under any builder/);
    expect(fs.existsSync(outFile)).toBe(false);
  });

  test('case 6: empty company tree (no runs yet) → still produces a valid archive', () => {
    seedCompany('alice', 'fresh-co', { 'timeline.jsonl': '' });
    const outFile = path.join(tmpOut, 'fresh-co.tar.gz');
    const r = run(['fresh-co', '--out', outFile]);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);

    const entries = listArchive(outFile);
    expect(entries.some((e) => e.includes('fresh-co'))).toBe(true);
    expect(entries).toContain('fresh-co/timeline.jsonl');
  });

  test('case 7: default --out lands in cwd with date-stamped filename', () => {
    seedCompany('alice', 'datey-co', { 'timeline.jsonl': '{}' });

    // Use a working directory we control + clean up afterwards
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-export-cwd-'));
    try {
      const r = spawnSync('bun', ['run', EXPORT, 'datey-co'], {
        cwd,
        env: { ...process.env, GSTACK_HOME: tmpHome },
        encoding: 'utf-8',
        timeout: 30000,
      });
      expect(r.status).toBe(0);
      const reportedPath = (r.stdout ?? '').toString().trim();
      expect(reportedPath).toMatch(/datey-co-export-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
      // macOS aliases /var → /private/var via symlink; normalize both via realpath.
      expect(fs.realpathSync(path.dirname(reportedPath))).toBe(fs.realpathSync(cwd));
      expect(fs.existsSync(reportedPath)).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('case 8: invalid --builder slug rejected', () => {
    const r = run(['co-a', '--builder', '../etc', '--out', path.join(tmpOut, 'x.tar.gz')]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/invalid builder/);
  });
});
