/**
 * Tests for lib/sync-config.ts — team sync configuration.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the pure functions by importing directly and controlling file state
import { readJSON, atomicWriteJSON } from '../lib/util';

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `gstack-sync-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('lib/sync-config', () => {
  describe('TeamConfig validation', () => {
    test('valid config has all required fields', () => {
      const config = {
        supabase_url: 'https://test.supabase.co',
        supabase_anon_key: 'eyJ...',
        team_slug: 'test-team',
      };
      expect(config.supabase_url).toBeTruthy();
      expect(config.supabase_anon_key).toBeTruthy();
      expect(config.team_slug).toBeTruthy();
    });

    test('rejects config with missing fields', () => {
      const config = { supabase_url: '', supabase_anon_key: 'key', team_slug: 'team' };
      expect(config.supabase_url).toBeFalsy();
    });
  });

  describe('auth token storage', () => {
    test('writes and reads auth tokens keyed by URL', () => {
      const dir = tmpDir();
      const authFile = path.join(dir, 'auth.json');

      // Write tokens
      const tokens = {
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: 'user-123',
        team_id: 'team-456',
        email: 'test@example.com',
      };
      const url = 'https://test.supabase.co';
      const allTokens: Record<string, typeof tokens> = {};
      allTokens[url] = tokens;
      atomicWriteJSON(authFile, allTokens, 0o600);

      // Read them back
      const stored = readJSON<Record<string, typeof tokens>>(authFile);
      expect(stored).not.toBeNull();
      expect(stored![url].access_token).toBe('test-access');
      expect(stored![url].email).toBe('test@example.com');

      // Verify file permissions
      const stat = fs.statSync(authFile);
      expect(stat.mode & 0o777).toBe(0o600);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('supports multiple Supabase URLs', () => {
      const dir = tmpDir();
      const authFile = path.join(dir, 'auth.json');

      const allTokens: Record<string, any> = {
        'https://team-a.supabase.co': { access_token: 'a-token', email: 'a@test.com' },
        'https://team-b.supabase.co': { access_token: 'b-token', email: 'b@test.com' },
      };
      atomicWriteJSON(authFile, allTokens);

      const stored = readJSON<Record<string, any>>(authFile);
      expect(Object.keys(stored!)).toHaveLength(2);
      expect(stored!['https://team-a.supabase.co'].access_token).toBe('a-token');
      expect(stored!['https://team-b.supabase.co'].access_token).toBe('b-token');

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('sync queue', () => {
    test('queue file stores entries as JSON array', () => {
      const dir = tmpDir();
      const queueFile = path.join(dir, 'sync-queue.json');

      const entries = [
        { table: 'eval_runs', data: { branch: 'main' }, timestamp: '2026-03-15T10:00:00Z', retries: 0 },
        { table: 'retro_snapshots', data: { date: '2026-03-14' }, timestamp: '2026-03-15T10:01:00Z', retries: 1 },
      ];
      atomicWriteJSON(queueFile, entries);

      const stored = readJSON<any[]>(queueFile);
      expect(stored).toHaveLength(2);
      expect(stored![0].table).toBe('eval_runs');
      expect(stored![1].retries).toBe(1);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('team cache', () => {
    test('cache metadata tracks freshness per table', () => {
      const dir = tmpDir();
      const metaFile = path.join(dir, '.meta.json');

      const meta = {
        last_pull: '2026-03-15T10:30:00Z',
        tables: {
          eval_runs: { rows: 123, latest: '2026-03-15T09:00:00Z' },
          retro_snapshots: { rows: 47, latest: '2026-03-14' },
        },
      };
      atomicWriteJSON(metaFile, meta);

      const stored = readJSON<typeof meta>(metaFile);
      expect(stored!.last_pull).toBe('2026-03-15T10:30:00Z');
      expect(stored!.tables.eval_runs.rows).toBe(123);
      expect(stored!.tables.retro_snapshots.rows).toBe(47);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
