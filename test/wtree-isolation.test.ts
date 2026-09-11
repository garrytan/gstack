import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const run = (args: string[], cwd: string) => Bun.spawnSync(args, { timeout: 30_000, cwd, stdout: 'pipe', stderr: 'pipe' });
const inventory = (root: string) => fs.readdirSync(path.join(root, '.git/objects'), { recursive: true }).map(String).sort();

describe('working tree fingerprint isolation', () => {
  test('hashes untracked bytes without persisting objects in the source repository', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-wtree-')); roots.push(repo);
    run(['git', 'init', '-q'], repo); run(['git', 'config', 'user.email', 'test@example.invalid'], repo); run(['git', 'config', 'user.name', 'Test'], repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n'); run(['git', 'add', 'tracked.txt'], repo); run(['git', 'commit', '-qm', 'base'], repo);
    fs.writeFileSync(path.join(repo, 'secret-untracked.txt'), 'secret-like-byte-sequence\n');
    const before = inventory(repo);
    const result = run([path.resolve(import.meta.dir, '../bin/gstack-wtree')], repo);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(inventory(repo)).toEqual(before);
  });
});
