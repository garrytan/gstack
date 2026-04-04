/**
 * Team sync client — push/pull data to/from Supabase.
 *
 * All operations are non-fatal. Push failures queue to sync-queue.json.
 * Pull failures fall back to local data. Skills never block on sync.
 *
 * Uses raw fetch() instead of @supabase/supabase-js to avoid adding
 * a dependency. The Supabase REST API is just PostgREST over HTTPS.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveSyncConfig, getTeamConfig, getAuthTokens, saveAuthTokens, getSyncQueuePath, getTeamCacheDir, type SyncConfig, type AuthTokens } from './sync-config';
import { readJSON, atomicWriteJSON, getRemoteSlug } from './util';
import { isTokenExpired } from './auth';

const PUSH_TIMEOUT_MS = 5_000;
const PULL_TIMEOUT_MS = 3_000;
const QUEUE_DRAIN_CONCURRENCY = 10;

// --- Types ---

export interface QueueEntry {
  table: string;
  data: Record<string, unknown>;
  timestamp: string;
  retries: number;
}

interface CacheMeta {
  last_pull: string;
  tables: Record<string, { rows: number; latest: string }>;
}

// --- Token refresh ---

/**
 * Refresh an expired access token using the refresh token.
 * Returns new tokens on success, null on failure.
 */
async function refreshToken(supabaseUrl: string, refreshToken: string, anonKey: string, existingTeamId?: string): Promise<AuthTokens | null> {
  try {
    const res = await fetchWithTimeout(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }, PUSH_TIMEOUT_MS);

    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown>;
    return {
      access_token: data.access_token as string,
      refresh_token: data.refresh_token as string || refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + ((data.expires_in as number) || 3600),
      user_id: (data.user as any)?.id || '',
      team_id: existingTeamId || '',  // preserve existing team_id across refresh
      email: (data.user as any)?.email || '',
    };
  } catch {
    return null;
  }
}

/** Get a valid access token, refreshing if needed. */
export async function getValidToken(config: SyncConfig): Promise<string | null> {
  if (!isTokenExpired(config.auth)) {
    return config.auth.access_token;
  }

  if (!config.auth.refresh_token) return null;

  const newTokens = await refreshToken(
    config.team.supabase_url,
    config.auth.refresh_token,
    config.team.supabase_anon_key,
    config.auth.team_id,
  );

  if (!newTokens) return null;

  // Persist refreshed tokens
  saveAuthTokens(config.team.supabase_url, newTokens);
  config.auth = newTokens;
  return newTokens.access_token;
}

// --- HTTP helpers ---

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function restUrl(supabaseUrl: string, table: string): string {
  return `${supabaseUrl}/rest/v1/${table}`;
}

function authHeaders(anonKey: string, accessToken: string): Record<string, string> {
  return {
    'apikey': anonKey,
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
  };
}

// --- Push operations ---

/**
 * Push a row to a Supabase table. Non-fatal — queues on failure.
 * Uses upsert (Prefer: resolution=merge-duplicates) for idempotency.
 */
export async function pushRow(table: string, data: Record<string, unknown>): Promise<boolean> {
  try {
    const config = resolveSyncConfig();
    if (!config) return false;

    const token = await getValidToken(config);
    if (!token) {
      enqueue({ table, data, timestamp: new Date().toISOString(), retries: 0 });
      return false;
    }

    const res = await fetchWithTimeout(
      restUrl(config.team.supabase_url, table),
      {
        method: 'POST',
        headers: authHeaders(config.team.supabase_anon_key, token),
        body: JSON.stringify(data),
      },
      PUSH_TIMEOUT_MS,
    );

    if (res.ok || res.status === 201 || res.status === 409) {
      return true;
    }

    // Non-fatal: queue for retry
    enqueue({ table, data, timestamp: new Date().toISOString(), retries: 0 });
    return false;
  } catch {
    // Network error, timeout, etc — queue for retry
    enqueue({ table, data, timestamp: new Date().toISOString(), retries: 0 });
    return false;
  }
}

/**
 * Common push helper: resolves sync config, injects team/user/repo fields, and pushes.
 * Returns false (silently) if sync is not configured.
 */
function pushWithSync(
  table: string,
  data: Record<string, unknown>,
  opts?: { addRepoSlug?: boolean; addHostname?: boolean },
): Promise<boolean> {
  const config = resolveSyncConfig();
  if (!config) return Promise.resolve(false);
  const row: Record<string, unknown> = {
    team_id: config.auth.team_id,
    user_id: config.auth.user_id,
    ...data,
  };
  if (opts?.addRepoSlug !== false) row.repo_slug = getRemoteSlug();
  if (opts?.addHostname) row.hostname = os.hostname();
  return pushRow(table, row);
}

/** Push an eval run result to Supabase. Strips transcripts to keep payload small. */
export async function pushEvalRun(evalResult: Record<string, unknown>): Promise<boolean> {
  return pushWithSync('eval_runs', {
    hostname: os.hostname(),
    ...evalResult,
    tests: (evalResult.tests as any[])?.map(t => ({
      ...t,
      transcript: undefined,
      prompt: t.prompt ? t.prompt.slice(0, 500) : undefined,
    })),
  });
}

/** Push a retro snapshot to Supabase. */
export function pushRetro(retroData: Record<string, unknown>): Promise<boolean> {
  return pushWithSync('retro_snapshots', retroData);
}

/** Push a QA report to Supabase. */
export function pushQAReport(qaData: Record<string, unknown>): Promise<boolean> {
  return pushWithSync('qa_reports', qaData);
}

/** Push a ship log to Supabase. */
export function pushShipLog(shipData: Record<string, unknown>): Promise<boolean> {
  return pushWithSync('ship_logs', shipData);
}

/** Push a Greptile triage entry to Supabase. */
export function pushGreptileTriage(triageData: Record<string, unknown>): Promise<boolean> {
  return pushWithSync('greptile_triage', triageData, { addRepoSlug: false });
}

/** Push a sync heartbeat (for connectivity testing). */
export function pushHeartbeat(): Promise<boolean> {
  return pushWithSync('sync_heartbeats', { hostname: os.hostname() }, { addRepoSlug: false });
}

/** Push a session transcript to Supabase. repo_slug is in the data (from getRemoteSlugForPath). */
export function pushTranscript(data: Record<string, unknown>): Promise<boolean> {
  return pushWithSync('session_transcripts', data, { addRepoSlug: false });
}

// --- Pull operations ---

/**
 * Pull rows from a Supabase table. Returns empty array on failure.
 * Writes results to .gstack/team-cache/{table}.json for offline access.
 */
export async function pullTable(table: string, query?: string): Promise<Record<string, unknown>[]> {
  try {
    const config = resolveSyncConfig();
    if (!config) return [];

    const token = await getValidToken(config);
    if (!token) return readCachedTable(table);

    const url = query
      ? `${restUrl(config.team.supabase_url, table)}?${query}`
      : `${restUrl(config.team.supabase_url, table)}?team_id=eq.${config.auth.team_id}&limit=500`;

    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'apikey': config.team.supabase_anon_key,
        'Authorization': `Bearer ${token}`,
      },
    }, PULL_TIMEOUT_MS);

    if (!res.ok) return readCachedTable(table);

    const rows = await res.json() as Record<string, unknown>[];

    // Cache locally
    writeCachedTable(table, rows);

    return rows;
  } catch {
    return readCachedTable(table);
  }
}

/** Pull team eval runs, optionally filtered by branch or repo. */
export async function pullEvalRuns(opts?: { branch?: string; repoSlug?: string; limit?: number }): Promise<Record<string, unknown>[]> {
  const config = resolveSyncConfig();
  if (!config) return [];

  const parts = [`team_id=eq.${config.auth.team_id}`, 'order=timestamp.desc'];
  if (opts?.branch) parts.push(`branch=eq.${opts.branch}`);
  if (opts?.repoSlug) parts.push(`repo_slug=eq.${opts.repoSlug}`);
  parts.push(`limit=${opts?.limit || 100}`);

  return pullTable('eval_runs', parts.join('&'));
}

/** Pull team retro snapshots. */
export async function pullRetros(opts?: { repoSlug?: string; limit?: number }): Promise<Record<string, unknown>[]> {
  const config = resolveSyncConfig();
  if (!config) return [];

  const parts = [`team_id=eq.${config.auth.team_id}`, 'order=date.desc'];
  if (opts?.repoSlug) parts.push(`repo_slug=eq.${opts.repoSlug}`);
  parts.push(`limit=${opts?.limit || 50}`);

  return pullTable('retro_snapshots', parts.join('&'));
}

/** Pull team session transcripts. */
export async function pullTranscripts(opts?: { repoSlug?: string; limit?: number }): Promise<Record<string, unknown>[]> {
  const config = resolveSyncConfig();
  if (!config) return [];

  const parts = [`team_id=eq.${config.auth.team_id}`, 'order=started_at.desc'];
  if (opts?.repoSlug) parts.push(`repo_slug=eq.${opts.repoSlug}`);
  parts.push(`limit=${opts?.limit || 50}`);

  return pullTable('session_transcripts', parts.join('&'));
}

// --- Offline queue ---

function enqueue(entry: QueueEntry): void {
  try {
    const queuePath = getSyncQueuePath();
    const queue = readJSON<QueueEntry[]>(queuePath) || [];
    queue.push(entry);
    atomicWriteJSON(queuePath, queue);
  } catch { /* non-fatal */ }
}

/** Drain the offline queue. Processes up to QUEUE_DRAIN_CONCURRENCY items in parallel. */
export async function drainQueue(): Promise<{ success: number; failed: number; remaining: number }> {
  const queuePath = getSyncQueuePath();
  const queue = readJSON<QueueEntry[]>(queuePath) || [];
  if (queue.length === 0) return { success: 0, failed: 0, remaining: 0 };

  let success = 0;
  let failed = 0;
  const remaining: QueueEntry[] = [];

  // Process in batches
  for (let i = 0; i < queue.length; i += QUEUE_DRAIN_CONCURRENCY) {
    const batch = queue.slice(i, i + QUEUE_DRAIN_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        const config = resolveSyncConfig();
        if (!config) throw new Error('not configured');

        const token = await getValidToken(config);
        if (!token) throw new Error('no valid token');

        const res = await fetchWithTimeout(
          restUrl(config.team.supabase_url, entry.table),
          {
            method: 'POST',
            headers: authHeaders(config.team.supabase_anon_key, token),
            body: JSON.stringify(entry.data),
          },
          PUSH_TIMEOUT_MS,
        );

        if (!res.ok && res.status !== 201 && res.status !== 409) {
          throw new Error(`HTTP ${res.status}`);
        }
        return true;
      }),
    );

    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        success++;
      } else {
        const entry = batch[idx];
        entry.retries++;
        if (entry.retries < 5) {
          remaining.push(entry);
        }
        failed++;
      }
    });
  }

  // Write remaining queue
  atomicWriteJSON(queuePath, remaining);

  return { success, failed, remaining: remaining.length };
}

// --- Cache ---

function readCachedTable(table: string): Record<string, unknown>[] {
  const cacheDir = getTeamCacheDir();
  if (!cacheDir) return [];
  const cached = readJSON<Record<string, unknown>[]>(path.join(cacheDir, `${table}.json`));
  return cached || [];
}

function writeCachedTable(table: string, rows: Record<string, unknown>[]): void {
  try {
    const cacheDir = getTeamCacheDir();
    if (!cacheDir) return;

    fs.mkdirSync(cacheDir, { recursive: true });
    atomicWriteJSON(path.join(cacheDir, `${table}.json`), rows);

    // Update metadata
    const metaPath = path.join(cacheDir, '.meta.json');
    const meta = readJSON<CacheMeta>(metaPath) || { last_pull: '', tables: {} };
    meta.last_pull = new Date().toISOString();
    meta.tables[table] = {
      rows: rows.length,
      latest: rows[0]?.created_at as string || new Date().toISOString(),
    };
    atomicWriteJSON(metaPath, meta);
  } catch { /* non-fatal */ }
}

// --- Status ---

/** Get sync status: queue size, cache freshness, connection health. */
export async function getSyncStatus(): Promise<{
  configured: boolean;
  authenticated: boolean;
  syncEnabled: boolean;
  queueSize: number;
  queueOldest: string | null;
  cacheLastPull: string | null;
  connectionOk: boolean;
}> {
  const team = getTeamConfig();
  const configured = team !== null;
  const auth = team ? getAuthTokens(team.supabase_url) : null;
  const authenticated = auth !== null;

  const config = resolveSyncConfig();
  const syncEnabled = config !== null;

  const queue = readJSON<QueueEntry[]>(getSyncQueuePath()) || [];
  const queueSize = queue.length;
  const queueOldest = queue.length > 0 ? queue[0].timestamp : null;

  const cacheDir = getTeamCacheDir();
  const meta = cacheDir ? readJSON<CacheMeta>(path.join(cacheDir, '.meta.json')) : null;
  const cacheLastPull = meta?.last_pull || null;

  // Quick connectivity check
  let connectionOk = false;
  if (config) {
    try {
      const token = await getValidToken(config);
      if (token) {
        const res = await fetchWithTimeout(
          `${config.team.supabase_url}/rest/v1/`,
          {
            method: 'HEAD',
            headers: {
              'apikey': config.team.supabase_anon_key,
              'Authorization': `Bearer ${token}`,
            },
          },
          PULL_TIMEOUT_MS,
        );
        connectionOk = res.ok;
      }
    } catch { /* connection failed */ }
  }

  return {
    configured,
    authenticated,
    syncEnabled,
    queueSize,
    queueOldest,
    cacheLastPull,
    connectionOk,
  };
}
