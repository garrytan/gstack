/**
 * Security sidecar client — IPC layer for the Node L4 classifier subprocess.
 *
 * Spawn model: lazy. First call to scan() spawns the sidecar, warms it (the
 * sidecar's loadTestsavant call on first scan-page-content), and reuses
 * the same process for every subsequent scan. The process dies when the
 * browse server exits (Node's stdin-close behavior).
 *
 * Reliability:
 *   - 5s default timeout per scan. Caller can override per-call.
 *   - 64KB request cap. Larger payloads short-circuit with `payload-too-large`.
 *   - Respawn capped at 3 failures within 10 minutes; further failures
 *     trip a circuit breaker that returns `available: false` until reset.
 *   - Parent-exit cleanup: process.on('exit') sends SIGTERM to the child.
 *
 * Failure semantics:
 *   - Node not on PATH → available() returns false; caller (the
 *     /pty-inject-scan endpoint) returns l4: { available: false } and the
 *     extension degrades to WARN + user confirm.
 *   - Scan throws or times out → caller treats as L4-unavailable for that
 *     request and falls through to L1-L3-only verdict.
 *
 * Single-process singleton. Multiple callers within the same browse
 * process share one sidecar.
 */

import { ChildProcessByStdio, spawn } from "child_process";
import { Readable, Writable } from "stream";
import { findSecuritySidecar } from "./find-security-sidecar";

const REQUEST_CAP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const RESPAWN_WINDOW_MS = 10 * 60 * 1000;
const RESPAWN_LIMIT = 3;

interface PendingRequest {
  resolve: (response: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SidecarState {
  child: ChildProcessByStdio<Writable, Readable, Readable> | null;
  pending: Map<string, PendingRequest>;
  buffer: string;
  failures: number[]; // timestamps of recent failures
  available: boolean;
  /** True after circuit-breaker tripped; stays true until reset() */
  brokenCircuit: boolean;
  nextId: number;
}

let state: SidecarState | null = null;

function getState(): SidecarState {
  if (!state) {
    state = {
      child: null,
      pending: new Map(),
      buffer: "",
      failures: [],
      available: true,
      brokenCircuit: false,
      nextId: 1,
    };
  }
  return state;
}

function recordFailure(): void {
  const s = getState();
  const now = Date.now();
  s.failures = s.failures.filter((t) => now - t < RESPAWN_WINDOW_MS);
  s.failures.push(now);
  if (s.failures.length >= RESPAWN_LIMIT) {
    s.brokenCircuit = true;
    s.available = false;
  }
}

function processBuffer(): void {
  const s = getState();
  let idx = s.buffer.indexOf("\n");
  while (idx !== -1) {
    const line = s.buffer.slice(0, idx).trim();
    s.buffer = s.buffer.slice(idx + 1);
    idx = s.buffer.indexOf("\n");
    if (!line) continue;
    let parsed: { id?: string; ok?: boolean; verdict?: unknown; status?: unknown; error?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed line — record as failure but don't reject any specific
      // pending request (we don't know which one this was meant for).
      recordFailure();
      continue;
    }
    const id = typeof parsed.id === "string" ? parsed.id : null;
    if (!id) continue;
    const pending = s.pending.get(id);
    if (!pending) continue;
    s.pending.delete(id);
    clearTimeout(pending.timer);
    if (parsed.ok) {
      pending.resolve(parsed);
    } else {
      recordFailure();
      pending.reject(new Error(parsed.error ?? "sidecar-error"));
    }
  }
}

function shutdownChild(): void {
  const s = getState();
  if (!s.child) return;
  try {
    s.child.kill("SIGTERM");
  } catch {
    // Already dead.
  }
  s.child = null;
  for (const [, p] of s.pending) {
    clearTimeout(p.timer);
    p.reject(new Error("sidecar-died"));
  }
  s.pending.clear();
}

function spawnSidecar(): boolean {
  const s = getState();
  if (s.brokenCircuit) return false;
  const location = findSecuritySidecar();
  if (!location) {
    s.available = false;
    return false;
  }
  try {
    const child = spawn(location.node, [location.entry], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    child.stdout.on("data", (chunk: Buffer) => {
      s.buffer += chunk.toString("utf-8");
      processBuffer();
    });
    child.on("exit", () => {
      shutdownChild();
    });
    child.on("error", () => {
      recordFailure();
      shutdownChild();
    });
    s.child = child;
    s.available = true;
    return true;
  } catch {
    recordFailure();
    return false;
  }
}

// Best-effort parent-exit cleanup. Node's "exit" event blocks async work, so
// we send SIGTERM synchronously and let the OS reap the child.
process.on("exit", () => shutdownChild());

export interface SidecarAvailability {
  available: boolean;
  reason?: string;
}

export function isSidecarAvailable(): SidecarAvailability {
  const s = getState();
  if (s.brokenCircuit) return { available: false, reason: "circuit-broken" };
  if (s.child) return { available: true };
  // Probe via findSecuritySidecar without spawning. If the resolver returns
  // null (no node on PATH, no entry on disk), we're permanently unavailable
  // until a setup re-run.
  const location = findSecuritySidecar();
  if (!location) return { available: false, reason: "no-node-or-entry" };
  return { available: true };
}

export async function scanWithSidecar(text: string, opts?: { timeoutMs?: number }): Promise<{ verdict: unknown }> {
  const s = getState();
  if (s.brokenCircuit) {
    throw new Error("sidecar-circuit-broken");
  }
  if (Buffer.byteLength(text, "utf-8") > REQUEST_CAP_BYTES) {
    throw new Error("payload-too-large");
  }
  if (!s.child) {
    if (!spawnSidecar()) {
      throw new Error("sidecar-spawn-failed");
    }
  }
  const id = String(s.nextId++);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      recordFailure();
      reject(new Error("sidecar-timeout"));
    }, timeoutMs);

    s.pending.set(id, {
      resolve: (response: unknown) => {
        const r = response as { verdict?: unknown };
        resolve({ verdict: r.verdict });
      },
      reject,
      timer,
    });

    const payload = JSON.stringify({ id, op: "scan-page-content", text }) + "\n";
    try {
      s.child!.stdin.write(payload);
    } catch (err) {
      clearTimeout(timer);
      s.pending.delete(id);
      recordFailure();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Reset the circuit breaker. Test-only escape hatch. */
export function resetSidecarForTests(): void {
  shutdownChild();
  state = null;
}
