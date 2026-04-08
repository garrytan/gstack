/**
 * Tests for lib/eval-cache.ts — SHA-based eval caching.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  computeCacheKey,
  cacheRead,
  cacheWrite,
  cacheStats,
  cacheClear,
  cacheVerify,
} from '../lib/eval-cache';

describe('lib/eval-cache', () => {
  let origStateDir: string | undefined;
  let testDir: string;

  beforeEach(() => {
    origStateDir = process.env.GSTACK_STATE_DIR;
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    testDir = path.join(os.tmpdir(), `gstack-cache-test-${unique}`);
    fs.mkdirSync(testDir, { recursive: true });
    process.env.GSTACK_STATE_DIR = testDir;
  });

  afterEach(() => {
    if (origStateDir === undefined) delete process.env.GSTACK_STATE_DIR;
    else process.env.GSTACK_STATE_DIR = origStateDir;
    fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.EVAL_CACHE;
  });

  describe('computeCacheKey', () => {
    test('produces deterministic 16-char hex key', () => {
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      const file = path.join(srcDir, 'test.ts');
      fs.writeFileSync(file, 'const x = 1;');

      const key1 = computeCacheKey([file], 'test input');
      const key2 = computeCacheKey([file], 'test input');
      expect(key1).toBe(key2);
      expect(key1.length).toBe(16);
      expect(key1).toMatch(/^[0-9a-f]+$/);
    });

    test('different inputs produce different keys', () => {
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      const file = path.join(srcDir, 'test.ts');
      fs.writeFileSync(file, 'const x = 1;');

      const key1 = computeCacheKey([file], 'input A');
      const key2 = computeCacheKey([file], 'input B');
      expect(key1).not.toBe(key2);
    });

    test('throws on missing source file', () => {
      expect(() => computeCacheKey(['/nonexistent/file.ts'], 'test'))
        .toThrow('cannot read source file');
    });
  });

  describe('cacheRead / cacheWrite', () => {
    test('write then read round-trips data', () => {
      const data = { result: 'ok', score: 42 };
      cacheWrite('test-suite', 'abc123', data);
      const read = cacheRead('test-suite', 'abc123');
      expect(read).toEqual(data);
    });

    test('read returns null on cache miss', () => {
      const read = cacheRead('test-suite', 'nonexistent');
      expect(read).toBeNull();
    });

    test('read returns null when EVAL_CACHE=0', () => {
      cacheWrite('test-suite', 'abc123', { data: 'cached' });
      process.env.EVAL_CACHE = '0';
      const read = cacheRead('test-suite', 'abc123');
      expect(read).toBeNull();
    });

    test('read returns null for corrupt JSON', () => {
      const cacheDir = path.join(testDir, 'eval-cache', 'test-suite');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'corrupt.json'), 'not valid json{{{');
      const read = cacheRead('test-suite', 'corrupt');
      expect(read).toBeNull();
    });

    test('read returns null for wrong cache version', () => {
      const cacheDir = path.join(testDir, 'eval-cache', 'test-suite');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'old.json'), JSON.stringify({
        _cache_version: 999,
        data: { stale: true },
      }));
      const read = cacheRead('test-suite', 'old');
      expect(read).toBeNull();
    });
  });

  describe('cacheStats', () => {
    test('returns empty for nonexistent cache', () => {
      const stats = cacheStats();
      expect(stats.suites).toEqual([]);
    });

    test('returns stats after writes', () => {
      cacheWrite('suite-a', 'key1', { a: 1 });
      cacheWrite('suite-a', 'key2', { a: 2 });
      cacheWrite('suite-b', 'key1', { b: 1 });

      const stats = cacheStats();
      expect(stats.suites.length).toBe(2);
      const suiteA = stats.suites.find(s => s.name === 'suite-a');
      expect(suiteA).toBeDefined();
      expect(suiteA!.entries).toBe(2);
      expect(suiteA!.size_bytes).toBeGreaterThan(0);
    });

    test('filters by suite name', () => {
      cacheWrite('suite-a', 'key1', { a: 1 });
      cacheWrite('suite-b', 'key1', { b: 1 });

      const stats = cacheStats('suite-a');
      expect(stats.suites.length).toBe(1);
      expect(stats.suites[0].name).toBe('suite-a');
    });
  });

  describe('cacheClear', () => {
    test('clears all entries', () => {
      cacheWrite('suite-a', 'key1', { a: 1 });
      cacheWrite('suite-b', 'key1', { b: 1 });

      const result = cacheClear();
      expect(result.deleted).toBe(2);

      const stats = cacheStats();
      expect(stats.suites.length).toBe(0);
    });

    test('clears specific suite', () => {
      cacheWrite('suite-a', 'key1', { a: 1 });
      cacheWrite('suite-b', 'key1', { b: 1 });

      cacheClear('suite-a');
      expect(cacheRead('suite-a', 'key1')).toBeNull();
      expect(cacheRead('suite-b', 'key1')).toEqual({ b: 1 });
    });
  });

  describe('cacheVerify', () => {
    test('reports valid entries', () => {
      cacheWrite('suite-a', 'key1', { a: 1 });

      const result = cacheVerify();
      expect(result.valid).toBe(1);
      expect(result.invalid).toBe(0);
      expect(result.errors).toEqual([]);
    });

    test('detects corrupt entries', () => {
      cacheWrite('suite-a', 'key1', { a: 1 });

      // Write corrupt file alongside valid one
      const cacheDir = path.join(testDir, 'eval-cache', 'suite-a');
      fs.writeFileSync(path.join(cacheDir, 'bad.json'), 'not json');

      const result = cacheVerify();
      expect(result.valid).toBe(1);
      expect(result.invalid).toBe(1);
      expect(result.errors.length).toBe(1);
    });

    test('detects wrong version', () => {
      const cacheDir = path.join(testDir, 'eval-cache', 'suite-a');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'old.json'), JSON.stringify({ _cache_version: 0 }));

      const result = cacheVerify();
      expect(result.invalid).toBe(1);
      expect(result.errors[0]).toContain('wrong cache version');
    });
  });
});
