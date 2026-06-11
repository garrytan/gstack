/**
 * Shared error-handling utilities for browse server and CLI.
 *
 * Each wrapper uses selective catches (checks err.code) to avoid masking
 * unexpected errors. Empty catches would be flagged by slop-scan.
 */

import * as fs from 'fs';

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

/**
 * Check if a PID is alive. Pure boolean probe — never throws.
 *
 * Uses signal-0 on every platform. Node/Bun implement `process.kill(pid, 0)`
 * on Windows via `OpenProcess` — a pure existence check that spawns no child
 * process and opens no console window. The old Windows branch shelled out to
 * `tasklist`, which Windows gives its own console window; on the terminal-agent
 * watchdog's per-tick existence check that flashed a `conhost.exe` window every
 * 60s for the whole session (#1952). The parent watchdog already uses signal-0
 * directly; this unifies on it.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH → gone (false); EPERM → exists but not signallable → still alive.
    // The old Unix branch collapsed every error to false, missing the EPERM edge.
    return err?.code === 'EPERM';
  }
}
