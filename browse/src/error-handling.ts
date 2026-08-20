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
 * Signal 0 on EVERY platform (#1952). Node maps `process.kill(pid, 0)` to an
 * OpenProcess existence check on Windows — and on Windows the browse daemon
 * runs under Node (dist/server-node.mjs + bun-polyfill, the documented
 * fallback for oven-sh/bun#4253) — so the POSIX idiom is portable here.
 *
 * Windows used to shell out to `tasklist /FI "PID eq <pid>"` and
 * string-match the CSV. That was wrong in two ways, both hit in production:
 *
 *   1. FALSE NEGATIVES UNDER LOAD (#2414/#2295): tasklist takes ~700-1700ms
 *      on an idle box and far longer under memory pressure. A Bun.spawnSync
 *      that hits its `timeout` still RETURNS, carrying partial stdout — so
 *      the `.includes()` match came back false and a LIVE process was
 *      reported dead. Callers that validate liveness before killing
 *      (killAgentByRecord, the terminal-agent watchdog) then skipped the
 *      kill and respawned around the survivor — one leaked terminal-agent
 *      per tick, self-reinforcing (each orphan slows the next tasklist).
 *   2. A console window per probe (#1952): the watchdog blinked a conhost
 *      window into the foreground every 60s for the whole session.
 *
 * Signal 0 spawns nothing, cannot time out, and is orders of magnitude
 * faster (~0.004ms vs ~270ms measured in #2414).
 *
 * EPERM means the process EXISTS but we lack rights to signal it. That is
 * alive — returning false there would reintroduce failure mode 1.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}
