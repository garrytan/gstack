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
import { readGstackConfigYamlKey } from './config';

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
/**
 * Is telemetry disabled for this process? Telemetry is OPT-IN: the consent
 * prompt writes a granted tier ('community' | 'anonymous') to
 * ~/.gstack/config.yaml, and only a granted tier enables emission. Tiers,
 * checked in order:
 *
 *   1. Env hint GSTACK_TELEMETRY_OFF=1 (set by preambles and test
 *      harnesses): always disabled, even over a granted config tier.
 *   2. Persistent tier via the shared flat-YAML helper in config.ts (same
 *      parser as the pair-agent gate, so the two consent gates never drift):
 *      explicit `telemetry: off` disables; 'community'/'anonymous' enable.
 *   3. Default: DISABLED. An absent key, absent file, or unrecognized value
 *      means consent was never granted — matching bin/gstack-config's
 *      DEFAULTS table, which reports 'off' for an unset telemetry key.
 *      Anything else would be a split-brain where `gstack-config get
 *      telemetry` tells the user 'off' while a direct-$B daemon emits.
 *      One escape hatch: GSTACK_TELEMETRY_OFF=0 is a harness-side consent
 *      assertion that flips this DEFAULT only (test harnesses exercising the
 *      write path against a scratch GSTACK_HOME) — it never overrides an
 *      explicit `telemetry: off` the user wrote.
 *
 * Exported so tests can pin the consent gate directly; the cached verdict
 * resets via _resetTelemetryCache.
 */
export function isTelemetryDisabled(): boolean {
  if (telemetryDisabled !== null) return telemetryDisabled;
  // Env kill switch (set by preamble or test harnesses): beats everything.
  if (process.env.GSTACK_TELEMETRY_OFF === '1') {
    telemetryDisabled = true;
    return true;
  }
  // Persistent tier: an explicit user-written value always wins next.
  const tier = readGstackConfigYamlKey('telemetry');
  if (tier === 'off') {
    telemetryDisabled = true;
    return true;
  }
  if (tier === 'community' || tier === 'anonymous') {
    telemetryDisabled = false;
    return false;
  }
  // No granted consent on record (absent key/file, unrecognized value):
  // disabled — unless the harness asserted consent via the env seam.
  telemetryDisabled = process.env.GSTACK_TELEMETRY_OFF !== '0';
  return telemetryDisabled;
}

export interface TelemetryEvent {
  event: string;
  [key: string]: unknown;
}

/** Fire-and-forget log. Never throws. */
export function logTelemetry(payload: TelemetryEvent): void {
  if (isTelemetryDisabled()) return;
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
