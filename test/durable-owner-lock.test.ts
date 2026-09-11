import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from '../lib/durable-owner-lock';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('durable owner lock', () => {
  test('never exposes a permissive first-create database during concurrent acquisition', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'durable-owner-lock-')); roots.push(root);
    const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'lib', 'durable-owner-lock.ts')).href;
    const results: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
    for (let round = 0; round < 5; round += 1) {
      const start = join(root, `start-${round}`);
      const children: Array<ReturnType<typeof Bun.spawn>> = [];
      for (let pair = 0; pair < 64; pair += 1) {
        const target = join(root, `owner-${round}-${pair}.json`);
        const code = `
          import { existsSync } from 'node:fs';
          import { acquireDurableOwnerLock, releaseDurableOwnerLock } from ${JSON.stringify(moduleUrl)};
          const waitCell = new Int32Array(new SharedArrayBuffer(4));
          while (!existsSync(${JSON.stringify(start)})) Atomics.wait(waitCell, 0, 0, 1);
          try { const owned = acquireDurableOwnerLock(${JSON.stringify(target)}, 'owner_busy', 25); releaseDurableOwnerLock(owned); console.log('acquired'); }
          catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
        `;
        children.push(Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' }));
        children.push(Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' }));
      }
      writeFileSync(start, 'start');
      results.push(...await Promise.all(children.map(async (child) => ({
        exitCode: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      }))));
    }

    expect(results.every((result) => result.exitCode === 0 && result.stderr === '')).toBe(true);
    const outcomes = results.map((result) => result.stdout.trim());
    expect(outcomes).not.toContain('owner_lock_invalid');
    expect(outcomes.every((value) => /^(?:acquired|owner_busy)$/.test(value))).toBe(true);
  });

  test('is exclusive and the OS releases ownership after a holder is killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-owner-lock-')); roots.push(root);
    const target = join(root, 'owner.json');
    const marker = join(root, 'ready');
    const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'lib', 'durable-owner-lock.ts')).href;
    const code = `import { writeFileSync } from 'node:fs'; import { acquireDurableOwnerLock } from ${JSON.stringify(moduleUrl)}; acquireDurableOwnerLock(${JSON.stringify(target)}, 'busy'); writeFileSync(${JSON.stringify(marker)}, 'ready'); await new Promise(() => {});`;
    const child = Bun.spawn([process.execPath, '-e', code], { stdout: 'ignore', stderr: 'pipe' });
    const deadline = Date.now() + 3_000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(marker)).toBe(true);
    expect(() => acquireDurableOwnerLock(target, 'owner_busy', 25)).toThrow('owner_busy');
    child.kill('SIGKILL');
    await child.exited;
    const recovered = acquireDurableOwnerLock(target, 'owner_busy', 250);
    releaseDurableOwnerLock(recovered);
  });

  test('acquires in an existing owner directory under bun-on-Windows EEXIST semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-owner-lock-')); roots.push(root);
    const target = join(root, 'owner.json');
    const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'lib', 'durable-owner-lock.ts')).href;
    const preload = join(import.meta.dir, 'helpers', 'emulate-bun-windows-eexist.ts');
    const code = `import { acquireDurableOwnerLock, releaseDurableOwnerLock } from ${JSON.stringify(moduleUrl)}; const owned = acquireDurableOwnerLock(${JSON.stringify(target)}, 'owner_busy'); releaseDurableOwnerLock(owned);`;
    const child = Bun.spawnSync([process.execPath, '--preload', preload, '-e', code], { timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe('');
  });

  test('creates a missing owner directory with private permissions', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'durable-owner-lock-')); roots.push(root);
    const directory = join(root, 'private');
    const owned = acquireDurableOwnerLock(join(directory, 'owner.json'), 'owner_busy');
    releaseDurableOwnerLock(owned);

    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  });

  test('rejects a symlinked database without changing its target', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-owner-lock-')); roots.push(root);
    const target = join(root, 'owner.json');
    const sentinel = join(root, 'sentinel');
    writeFileSync(sentinel, 'unchanged');
    symlinkSync(sentinel, `${target}.owner.sqlite`);

    expect(() => acquireDurableOwnerLock(target, 'owner_busy')).toThrow('owner_lock_invalid');
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(lstatSync(`${target}.owner.sqlite`).isSymbolicLink()).toBe(true);
  });

  test('rejects an owner database with unsafe mode without chmod repair', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-owner-lock-')); roots.push(root);
    const target = join(root, 'owner.json');
    const database = `${target}.owner.sqlite`;
    writeFileSync(database, 'foreign');
    chmodSync(database, 0o644);

    expect(() => acquireDurableOwnerLock(target, 'owner_busy')).toThrow('owner_lock_invalid');
    expect(lstatSync(database).mode & 0o777).toBe(0o644);
    expect(readFileSync(database, 'utf8')).toBe('foreign');
  });

  test('rejects a group-writable owner directory without modifying it', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-owner-lock-')); roots.push(root);
    const directory = join(root, 'unsafe');
    mkdirSync(directory, { mode: 0o770 });
    chmodSync(directory, 0o770);
    const target = join(directory, 'owner.json');

    expect(() => acquireDurableOwnerLock(target, 'owner_busy')).toThrow('owner_lock_invalid');
    expect(lstatSync(directory).mode & 0o777).toBe(0o770);
    expect(existsSync(`${target}.owner.sqlite`)).toBe(false);
  });
});
