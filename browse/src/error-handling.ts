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
 * signal-0 on every platform: Node and Bun both implement
 * `process.kill(pid, 0)` on Windows via an OpenProcess existence check —
 * no child process, no console window. The previous Windows branch spawned
 * `tasklist`, which (a) flashed a visible console window from console-less
 * daemons on every call (#1952), and (b) silently returned false for LIVE
 * processes when tasklist exceeded its 3s timeout — node's spawnSync
 * reports timeout via `result.error` without throwing, so the empty-stdout
 * path read as "dead". A false "dead" makes the terminal-agent watchdog
 * respawn around a live agent and orphan it (split-brain, #2151).
 *
 * EPERM ⇒ alive: the process exists but can't be signalled by this user.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}
