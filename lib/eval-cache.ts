/**
 * SHA-based eval caching.
 *
 * Cache path: ~/.gstack/eval-cache/{suite}/{sha}.json
 *
 * Caches eval results keyed by a SHA256 hash of source files + test input.
 * Supports EVAL_CACHE=0 to skip reads (always re-run).
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJSON, readJSON } from './util';

const CACHE_VERSION = 1;

/** Resolve cache dir lazily so GSTACK_STATE_DIR env overrides work in tests. */
function getCacheDir(): string {
  const stateDir = process.env.GSTACK_STATE_DIR || require('path').join(require('os').homedir(), '.gstack');
  return path.join(stateDir, 'eval-cache');
}

// --- Cache key ---

/**
 * Compute a cache key from source file contents + test input.
 * Returns first 16 hex chars of SHA256.
 */
export function computeCacheKey(sourceFiles: string[], testInput: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const file of sourceFiles.sort()) {
    try {
      hasher.update(fs.readFileSync(file));
    } catch (err: any) {
      throw new Error(`Cache key: cannot read source file "${file}": ${err.message}`);
    }
  }
  hasher.update(testInput);
  return hasher.digest('hex').slice(0, 16);
}

// --- Read / Write ---

function cachePath(suite: string, key: string): string {
  return path.join(getCacheDir(), suite, `${key}.json`);
}

/**
 * Read a cached value. Returns null on miss, corrupt data, or if EVAL_CACHE=0.
 */
export function cacheRead(suite: string, key: string): unknown | null {
  if (process.env.EVAL_CACHE === '0') return null;
  const filePath = cachePath(suite, key);
  const envelope = readJSON<{ _cache_version: number; data: unknown }>(filePath);
  if (!envelope || envelope._cache_version !== CACHE_VERSION) return null;
  return envelope.data;
}

/**
 * Write a value to cache. Atomic write with metadata envelope.
 */
export function cacheWrite(
  suite: string,
  key: string,
  data: unknown,
  meta?: Record<string, unknown>,
): void {
  const filePath = cachePath(suite, key);
  const envelope = {
    _cache_version: CACHE_VERSION,
    _cached_at: new Date().toISOString(),
    _suite: suite,
    ...meta,
    data,
  };
  try {
    atomicWriteJSON(filePath, envelope);
  } catch (err: any) {
    throw new Error(`Cache write failed for "${filePath}": ${err.message}`);
  }
}

// --- Management ---

interface SuiteStats {
  name: string;
  entries: number;
  size_bytes: number;
  oldest: string;
  newest: string;
}

/**
 * Get cache statistics. If suite is provided, stats for that suite only.
 */
export function cacheStats(suite?: string): { suites: SuiteStats[] } {
  const suites: SuiteStats[] = [];

  let dirNames: string[];
  try {
    dirNames = suite ? [suite] : fs.readdirSync(getCacheDir());
  } catch {
    return { suites: [] };
  }

  for (const name of dirNames) {
    const suiteDir = path.join(getCacheDir(), name);
    try {
      const stat = fs.statSync(suiteDir);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    let files: string[];
    try {
      files = fs.readdirSync(suiteDir).filter(f => f.endsWith('.json'));
    } catch { continue; }

    if (files.length === 0) {
      suites.push({ name, entries: 0, size_bytes: 0, oldest: '', newest: '' });
      continue;
    }

    let totalSize = 0;
    let oldest = '';
    let newest = '';

    for (const file of files) {
      try {
        const fileStat = fs.statSync(path.join(suiteDir, file));
        totalSize += fileStat.size;
        const mtime = fileStat.mtime.toISOString();
        if (!oldest || mtime < oldest) oldest = mtime;
        if (!newest || mtime > newest) newest = mtime;
      } catch { continue; }
    }

    suites.push({ name, entries: files.length, size_bytes: totalSize, oldest, newest });
  }

  return { suites };
}

/**
 * Clear cache entries. If suite is provided, clears only that suite.
 * Returns count of deleted files.
 */
export function cacheClear(suite?: string): { deleted: number } {
  let deleted = 0;

  let dirNames: string[];
  try {
    dirNames = suite ? [suite] : fs.readdirSync(getCacheDir());
  } catch {
    return { deleted: 0 };
  }

  for (const name of dirNames) {
    const suiteDir = path.join(getCacheDir(), name);
    try {
      const files = fs.readdirSync(suiteDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        fs.unlinkSync(path.join(suiteDir, file));
        deleted++;
      }
      // Remove empty directory
      try { fs.rmdirSync(suiteDir); } catch { /* not empty or doesn't exist */ }
    } catch { continue; }
  }

  return { deleted };
}

/**
 * Verify cache integrity. Checks that all cache files are valid JSON
 * with the correct cache version.
 */
export function cacheVerify(suite?: string): { valid: number; invalid: number; errors: string[] } {
  let valid = 0;
  let invalid = 0;
  const errors: string[] = [];

  let dirNames: string[];
  try {
    dirNames = suite ? [suite] : fs.readdirSync(getCacheDir());
  } catch {
    return { valid: 0, invalid: 0, errors: [] };
  }

  for (const name of dirNames) {
    const suiteDir = path.join(getCacheDir(), name);
    let files: string[];
    try {
      files = fs.readdirSync(suiteDir).filter(f => f.endsWith('.json'));
    } catch { continue; }

    for (const file of files) {
      const filePath = path.join(suiteDir, file);
      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (content._cache_version !== CACHE_VERSION) {
          invalid++;
          errors.push(`${name}/${file}: wrong cache version (${content._cache_version})`);
        } else {
          valid++;
        }
      } catch (err: any) {
        invalid++;
        errors.push(`${name}/${file}: ${err.message}`);
      }
    }
  }

  return { valid, invalid, errors };
}
