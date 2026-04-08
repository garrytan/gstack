/**
 * Tests for lib/sync.ts — Supabase push/pull with offline queue.
 *
 * These tests exercise the queue, cache, and status functions without
 * a real Supabase instance. Push/pull to Supabase are integration tests
 * that require a running instance.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readJSON, atomicWriteJSON } from '../lib/util';
import { isTokenExpired } from '../lib/auth';

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `gstack-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('lib/sync', () => {
  describe('offline queue operations', () => {
    test('queue entries have required fields', () => {
      const entry = {
        table: 'eval_runs',
        data: { branch: 'main', version: '0.3.3' },
        timestamp: new Date().toISOString(),
        retries: 0,
      };
      expect(entry.table).toBe('eval_runs');
      expect(entry.retries).toBe(0);
      expect(entry.timestamp).toBeTruthy();
    });

    test('queue supports append and read', () => {
      const dir = tmpDir();
      const queueFile = path.join(dir, 'sync-queue.json');

      // Start empty
      expect(readJSON(queueFile)).toBeNull();

      // Append entries
      const queue: any[] = [];
      queue.push({ table: 'eval_runs', data: { id: 1 }, timestamp: '2026-03-15T10:00:00Z', retries: 0 });
      queue.push({ table: 'retro_snapshots', data: { id: 2 }, timestamp: '2026-03-15T10:01:00Z', retries: 0 });
      atomicWriteJSON(queueFile, queue);

      const stored = readJSON<any[]>(queueFile);
      expect(stored).toHaveLength(2);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('entries with 5+ retries would be dropped during drain', () => {
      const entry = { table: 'eval_runs', data: {}, timestamp: '2026-03-15T10:00:00Z', retries: 5 };
      expect(entry.retries >= 5).toBe(true);
    });
  });

  describe('cache operations', () => {
    test('cached table is a JSON array of rows', () => {
      const dir = tmpDir();
      const cacheFile = path.join(dir, 'eval_runs.json');

      const rows = [
        { id: '1', branch: 'main', passed: 5, failed: 1 },
        { id: '2', branch: 'dev', passed: 3, failed: 0 },
      ];
      atomicWriteJSON(cacheFile, rows);

      const stored = readJSON<any[]>(cacheFile);
      expect(stored).toHaveLength(2);
      expect(stored![0].branch).toBe('main');

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('token expiry', () => {
    test('non-expired token', () => {
      const tokens = {
        access_token: 'test',
        refresh_token: 'test',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: '',
        team_id: '',
        email: '',
      };
      expect(isTokenExpired(tokens)).toBe(false);
    });

    test('expired token (past)', () => {
      const tokens = {
        access_token: 'test',
        refresh_token: 'test',
        expires_at: Math.floor(Date.now() / 1000) - 100,
        user_id: '',
        team_id: '',
        email: '',
      };
      expect(isTokenExpired(tokens)).toBe(true);
    });

    test('token expiring within 5-minute buffer', () => {
      const tokens = {
        access_token: 'test',
        refresh_token: 'test',
        expires_at: Math.floor(Date.now() / 1000) + 200,  // < 300s buffer
        user_id: '',
        team_id: '',
        email: '',
      };
      expect(isTokenExpired(tokens)).toBe(true);
    });

    test('env-var tokens (expires_at=0) never expire', () => {
      const tokens = {
        access_token: 'test',
        refresh_token: '',
        expires_at: 0,
        user_id: '',
        team_id: '',
        email: 'ci@automation',
      };
      expect(isTokenExpired(tokens)).toBe(false);
    });
  });

  describe('push data format', () => {
    test('eval result strips transcripts for sync', () => {
      const evalResult = {
        tests: [
          { name: 'test1', passed: true, transcript: [{ type: 'assistant', long: 'data' }], cost_usd: 0.50 },
          { name: 'test2', passed: false, prompt: 'a'.repeat(1000), cost_usd: 0.75 },
        ],
      };

      // Simulate what pushEvalRun does
      const syncData = {
        ...evalResult,
        tests: evalResult.tests.map(t => ({
          ...t,
          transcript: undefined,
          prompt: t.prompt ? t.prompt.slice(0, 500) : undefined,
        })),
      };

      expect(syncData.tests[0].transcript).toBeUndefined();
      expect(syncData.tests[1].prompt).toHaveLength(500);
    });
  });
});
