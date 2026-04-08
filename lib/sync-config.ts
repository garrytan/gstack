/**
 * Team sync configuration resolution.
 *
 * Reads project-level config (.gstack-sync.json) and user-level auth
 * (~/.gstack/auth.json). All functions return null/defaults when sync
 * is not configured — zero impact on non-sync users.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GSTACK_STATE_DIR, getGitRoot, readJSON, atomicWriteJSON } from './util';

// --- Interfaces ---

export interface TeamConfig {
  supabase_url: string;
  supabase_anon_key: string;
  team_slug: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;  // epoch seconds
  user_id: string;
  team_id: string;
  email: string;
}

export interface SyncConfig {
  team: TeamConfig;
  auth: AuthTokens;
  syncEnabled: boolean;
  syncTranscripts: boolean;
}

// --- Paths ---

const AUTH_FILE = path.join(GSTACK_STATE_DIR, 'auth.json');
const SYNC_CONFIG_FILENAME = '.gstack-sync.json';

/** Resolve path to .gstack-sync.json in the project root. */
export function getSyncConfigPath(): string | null {
  const root = getGitRoot();
  if (!root) return null;
  const configPath = path.join(root, SYNC_CONFIG_FILENAME);
  return fs.existsSync(configPath) ? configPath : null;
}

// --- Team config ---

/** Read .gstack-sync.json from the project root. Returns null if not found. */
export function getTeamConfig(): TeamConfig | null {
  const configPath = getSyncConfigPath();
  if (!configPath) return null;

  const config = readJSON<Record<string, unknown>>(configPath);
  if (!config) return null;

  const { supabase_url, supabase_anon_key, team_slug } = config;
  if (typeof supabase_url !== 'string' || !supabase_url) return null;
  if (typeof supabase_anon_key !== 'string' || !supabase_anon_key) return null;
  if (typeof team_slug !== 'string' || !team_slug) return null;

  return { supabase_url, supabase_anon_key, team_slug };
}

// --- Auth tokens ---

/**
 * Read auth tokens for a specific Supabase URL.
 * Auth file is keyed by URL so multiple teams/projects work.
 */
export function getAuthTokens(supabaseUrl: string): AuthTokens | null {
  // CI/automation: env var overrides file-based auth
  const envToken = process.env.GSTACK_SUPABASE_ACCESS_TOKEN;
  if (envToken) {
    return {
      access_token: envToken,
      refresh_token: '',
      expires_at: 0,  // no expiry for env tokens
      user_id: '',
      team_id: '',
      email: 'ci@automation',
    };
  }

  const allTokens = readJSON<Record<string, AuthTokens>>(AUTH_FILE);
  if (!allTokens) return null;

  const tokens = allTokens[supabaseUrl];
  if (!tokens || !tokens.access_token) return null;

  return tokens;
}

/** Save auth tokens for a Supabase URL. Creates file with mode 0o600. */
export function saveAuthTokens(supabaseUrl: string, tokens: AuthTokens): void {
  const allTokens = readJSON<Record<string, AuthTokens>>(AUTH_FILE) || {};
  allTokens[supabaseUrl] = tokens;
  atomicWriteJSON(AUTH_FILE, allTokens, 0o600);
}

/** Remove auth tokens for a Supabase URL. */
export function clearAuthTokens(supabaseUrl: string): void {
  const allTokens = readJSON<Record<string, AuthTokens>>(AUTH_FILE);
  if (!allTokens || !allTokens[supabaseUrl]) return;
  delete allTokens[supabaseUrl];
  atomicWriteJSON(AUTH_FILE, allTokens, 0o600);
}

// --- User settings (via gstack-config) ---

/** Read a user setting from ~/.gstack/config.yaml. */
function getUserSetting(key: string): string {
  try {
    // Use gstack-config if available
    const gstackDir = process.env.GSTACK_DIR || path.resolve(__dirname, '..');
    const configScript = path.join(gstackDir, 'bin', 'gstack-config');
    if (fs.existsSync(configScript)) {
      const { spawnSync } = require('child_process');
      const result = spawnSync(configScript, ['get', key], {
        stdio: 'pipe',
        timeout: 2_000,
        env: { ...process.env, GSTACK_STATE_DIR },
      });
      return result.stdout?.toString().trim() || '';
    }
    return '';
  } catch {
    return '';
  }
}

// --- Full config resolution ---

/**
 * Resolve the complete sync config. Returns null if sync is not configured
 * (no .gstack-sync.json) or disabled (sync_enabled=false).
 */
export function resolveSyncConfig(): SyncConfig | null {
  const team = getTeamConfig();
  if (!team) return null;

  const syncEnabled = getUserSetting('sync_enabled') !== 'false';
  if (!syncEnabled) return null;

  const auth = getAuthTokens(team.supabase_url);
  if (!auth) return null;

  const syncTranscripts = getUserSetting('sync_transcripts') === 'true';

  return { team, auth, syncEnabled, syncTranscripts };
}

/**
 * Check if sync is configured (team config exists and auth is present).
 * Lighter than resolveSyncConfig — doesn't check user settings.
 */
export function isSyncConfigured(): boolean {
  const team = getTeamConfig();
  if (!team) return false;
  const auth = getAuthTokens(team.supabase_url);
  return auth !== null;
}

// --- Cache paths ---

/** Get the team cache directory (.gstack/team-cache/ in project root). */
export function getTeamCacheDir(): string | null {
  const root = getGitRoot();
  if (!root) return null;
  return path.join(root, '.gstack', 'team-cache');
}

/** Get the sync queue file path (~/.gstack/sync-queue.json). */
export function getSyncQueuePath(): string {
  return path.join(GSTACK_STATE_DIR, 'sync-queue.json');
}
