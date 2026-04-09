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

// ─── Process ───────────────────────────────────────────────────

/** Send a signal to a process, ignoring ESRCH (already dead). Rethrows other errors. */
export function safeKill(pid: number, signal: NodeJS.Signals | number): void {
  try {
    process.kill(pid, signal);
  } catch (err: any) {
    if (err?.code !== 'ESRCH') throw err;
  }
}

/** Check if a PID is alive. Returns false for ESRCH, rethrows EPERM and others. */
export function isProcessAlive(pid: number): boolean {
  if (IS_WINDOWS) {
    // Bun's compiled binary can't signal Windows PIDs (always throws ESRCH).
    // Use tasklist as a fallback. Only for one-shot calls — too slow for polling loops.
    // Bun.spawnSync may throw if tasklist binary is missing (ENOENT)
    const result = Bun.spawnSync(
      ['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { stdout: 'pipe', stderr: 'pipe', timeout: 3000 }
    );
    return result.stdout.toString().includes(`"${pid}"`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === 'ESRCH') return false;
    throw err;
  }
}

// ─── HTTP ──────────────────────────────────────────────────────

/** JSON Response constructor shorthand for Bun.serve routes. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
