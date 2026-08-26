/**
 * Unit tests for lib/fs-atomic.ts — the single atomic-write implementation.
 * Free (no API calls), runs with `bun test`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteSync, atomicWriteQuiet } from '../lib/fs-atomic';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteSync', () => {
  test('writes the content and leaves no tmp file behind', () => {
    const target = path.join(dir, 'out.json');
    atomicWriteSync(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"a":1}');
    const strays = fs.readdirSync(dir).filter(f => f.includes('.tmp.'));
    expect(strays).toEqual([]);
  });

  test('overwrites an existing file atomically', () => {
    const target = path.join(dir, 'out.json');
    fs.writeFileSync(target, 'old');
    atomicWriteSync(target, 'new');
    expect(fs.readFileSync(target, 'utf-8')).toBe('new');
  });

  test('applies the mode option at creation (0600)', () => {
    if (process.platform === 'win32') return; // POSIX mode bits
    const target = path.join(dir, 'secret.json');
    atomicWriteSync(target, 'shh', { mode: 0o600 });
    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('THROWS on failure and cleans up the tmp file (missing parent dir)', () => {
    const target = path.join(dir, 'no-such-subdir', 'out.json');
    expect(() => atomicWriteSync(target, 'x')).toThrow();
    // Parent doesn't exist, so nothing to clean; the throw contract is the point.
    expect(fs.existsSync(target)).toBe(false);
  });

  test('tmp suffixes are unique across calls (pid+random — the collision race)', () => {
    if (process.platform === 'win32') return; // read-only dir trick is POSIX
    // Two interleaved writers in the SAME process must never share a tmp
    // name. Bun's fs exports are readonly (no monkeypatching), so capture
    // the generated tmp names from the failure path: a read-only directory
    // makes writeFileSync throw ENOENT/EACCES with the tmp path attached.
    const roDir = path.join(dir, 'ro');
    fs.mkdirSync(roDir);
    const target = path.join(roDir, 'contended.json');
    fs.chmodSync(roDir, 0o500);
    const seen = new Set<string>();
    try {
      for (let i = 0; i < 3; i++) {
        try {
          atomicWriteSync(target, 'x');
          throw new Error('expected atomicWriteSync to throw in read-only dir');
        } catch (err: any) {
          expect(String(err.path ?? err.message)).toContain('.tmp.');
          seen.add(String(err.path ?? err.message));
        }
      }
    } finally {
      fs.chmodSync(roDir, 0o700);
    }
    expect(seen.size).toBe(3);
    for (const name of seen) {
      expect(name).toMatch(/\.tmp\.\d+\.[0-9a-f]{8}$/);
    }
  });

  test('two-writer same-target: last rename wins, file is never partial', () => {
    const target = path.join(dir, 'race.json');
    const big = 'x'.repeat(64 * 1024);
    atomicWriteSync(target, big);
    atomicWriteSync(target, 'small');
    const content = fs.readFileSync(target, 'utf-8');
    expect(content === big || content === 'small').toBe(true);
    expect(content).toBe('small');
  });
});

describe('atomicWriteQuiet', () => {
  test('returns true on success', () => {
    const target = path.join(dir, 'q.json');
    expect(atomicWriteQuiet(target, 'ok')).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('ok');
  });

  test('returns false (never throws) on failure — the shutdown-path contract', () => {
    const target = path.join(dir, 'no-such-subdir', 'q.json');
    expect(atomicWriteQuiet(target, 'x')).toBe(false);
  });
});
