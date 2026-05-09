/**
 * Lightweight telemetry — DX D9 from /plan-devex-review.
 *
 * Piggybacks on ~/.gstack/analytics/skill-usage.jsonl pattern (existing
 * gstack telemetry). Hostname + aggregate counters only; no body content,
 * no agent text, no command args. Respects the user's telemetry tier
 * setting (off | anonymous | community) via gstack-config.
 *
 * Fire-and-forget: never blocks the calling path. Errors swallowed.
 *
 * Events:
 *   domain_skill_saved          {host, scope, state, bytes}
 *   domain_skill_state_changed  {host, from_state, to_state}
 *   domain_skill_save_blocked   {host, reason}
 *   domain_skill_fired          {host, source, version}
 *   cdp_method_called           {domain, method, allowed, scope}
 *   cdp_method_denied           {domain, method}    ← drives next allow-list growth
 *   cdp_method_lock_acquire_ms  {domain, method, ms}
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

function gstackHome(): string {
  return process.env.GSTACK_HOME || path.join(os.homedir(), '.gstack');
}

function analyticsDir(): string {
  return path.join(gstackHome(), 'analytics');
}

function telemetryFile(): string {
  return path.join(analyticsDir(), 'browse-telemetry.jsonl');
}

let lastEnsuredDir: string | null = null;
async function ensureDir(): Promise<void> {
  const dir = analyticsDir();
  if (lastEnsuredDir === dir) return;
  await fs.mkdir(dir, { recursive: true });
  lastEnsuredDir = dir;
}

let telemetryDisabled: boolean | null = null;
function isDisabled(): boolean {
  if (telemetryDisabled !== null) return telemetryDisabled;
  // Check env (set by preamble or test harnesses).
  if (process.env.GSTACK_TELEMETRY_OFF === '1') {
    telemetryDisabled = true;
    return true;
  }
  // Conservative default: telemetry ON unless explicitly off. Users opt out via
  // gstack-config set telemetry off (preamble reads this; we trust the env hint).
  telemetryDisabled = false;
  return false;
}

export interface TelemetryEvent {
  event: string;
  [key: string]: unknown;
}

/** Fire-and-forget log. Never throws. */
export function logTelemetry(payload: TelemetryEvent): void {
  if (isDisabled()) return;
  const enriched = { ...payload, ts: new Date().toISOString() };
  ensureDir()
    .then(() => fs.appendFile(telemetryFile(), JSON.stringify(enriched) + '\n', 'utf8'))
    .catch(() => {
      // Telemetry must never crash the caller. If the disk is full or perms
      // are wrong, swallow silently — there's nothing useful to do here.
    });
}

/** Test-only: reset cached state. */
export function _resetTelemetryCache(): void {
  telemetryDisabled = null;
  lastEnsuredDir = null;
}
