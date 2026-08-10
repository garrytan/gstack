/**
 * Shared error-handling utilities for browse server and CLI.
 *
 * Each wrapper uses selective catches (checks err.code) to avoid masking
 * unexpected errors. Empty catches would be flagged by slop-scan.
 */

import * as fs from 'fs';

const IS_WINDOWS = process.platform === 'win32';

// ─── Filesystem ────────────────────────────────────────────────

/** Remove a file, ignoring ENOENT (already gone). Rethrows other errors. */
export function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/** Remove a file, ignoring ALL errors. Use only in best-effort cleanup (shutdown, emergency). */
export function safeUnlinkQuiet(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch {}
}

// ─── Process ───────────────────────────────────────────────────

/** Send a signal to a process, ignoring ESRCH (already dead). Rethrows other errors. */
export function safeKill(pid: number, signal: NodeJS.Signals | number): void {
  try {
    process.kill(pid, signal);
  } catch (err: any) {
    if (err?.code !== 'ESRCH') throw err;
  }
}

// ─── Diagnostics ───────────────────────────────────────────────

const warnedKeys = new Set<string>();

/**
 * Report a best-effort failure to stderr once per `key` per process.
 *
 * For operations that must not throw into the caller (audit writes, state-file
 * persistence, telemetry) but whose failure leaves the system degraded. A bare
 * `catch {}` makes those degradations invisible; `warnOnce` keeps the operation
 * non-fatal while leaving one diagnostic line behind. Deduped so a failure on a
 * hot path (every command, every tab poll) can't flood the log.
 */
export function warnOnce(key: string, message: string, err?: unknown): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  const detail = err === undefined ? '' : `: ${errText(err)}`;
  console.error(`${message}${detail}`);
}

/** Human-readable text for an unknown thrown value. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Test-only: forget which keys have already warned. */
export function _resetWarnOnce(): void {
  warnedKeys.clear();
}

/** Check if a PID is alive. Pure boolean probe — returns false for ALL errors. */
export function isProcessAlive(pid: number): boolean {
  if (IS_WINDOWS) {
    try {
      const result = Bun.spawnSync(
        ['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 3000 }
      );
      return result.stdout.toString().includes(`"${pid}"`);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
