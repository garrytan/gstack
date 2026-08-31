/**
 * Shared loopback port allocation (#2314, decision 8).
 *
 * One fixed scan range (10000-49151) for EVERY long-lived gstack listener:
 * the main browse daemon and the terminal-agent. Binding `port: 0` instead
 * hands out a port from the OS EPHEMERAL range (49152-65535 on macOS) — the
 * same pool every short-lived test server draws from — so a daemon that
 * lives for weeks ends up squatting ports that `app.listen(0)` test servers
 * expect to receive, silently absorbing their traffic as phantom 404s. The
 * range therefore ends AT 49151: a max above it would put a fraction of
 * picks back inside the pool this module exists to avoid (the original
 * 60000 cap left ~22% of allocations in 49152-59999).
 *
 * Extracted from server.ts (which had this logic since #486) so
 * terminal-agent.ts can reuse it without importing the whole server module.
 */

import * as net from 'net';

export type PortCheckResult =
  | { available: true }
  | { available: false; code?: string; message: string };

export type FailedPortAttempt = {
  port: number;
  result: Extract<PortCheckResult, { available: false }>;
};

export const RANDOM_PORT_MIN = 10000;
export const RANDOM_PORT_MAX = 49151; // last port BELOW the macOS ephemeral pool (49152-65535)
export const RANDOM_PORT_RETRIES = 5;

export function normalizePortError(err: unknown): Extract<PortCheckResult, { available: false }> {
  const maybeNodeError = err as NodeJS.ErrnoException | undefined;
  return {
    available: false,
    code: maybeNodeError?.code,
    message: maybeNodeError?.message || String(err),
  };
}

export function isOccupiedPort(result: Extract<PortCheckResult, { available: false }>): boolean {
  return result.code === 'EADDRINUSE';
}

export function formatPortFailureDetail(attempt: FailedPortAttempt): string {
  const { code, message } = attempt.result;
  return code ? `${attempt.port} (${code}: ${message})` : `${attempt.port} (${message})`;
}

export function formatExplicitPortUnavailableError(
  port: number,
  result: Extract<PortCheckResult, { available: false }>
): Error {
  if (isOccupiedPort(result)) {
    return new Error(`[browse] Port ${port} (from BROWSE_PORT env) is in use`);
  }

  const detail = result.code ? `${result.code}: ${result.message}` : result.message;
  return new Error(
    `[browse] Cannot bind BROWSE_PORT=${port} on 127.0.0.1 (${detail}). ` +
    `This usually means localhost port binding is blocked by the current sandbox or OS permissions, ` +
    `not that the port is occupied. Allow localhost binding, or run browse from an unrestricted terminal.`
  );
}

export function formatRandomPortUnavailableError(attempts: FailedPortAttempt[]): Error {
  const blockingAttempts = attempts.filter((attempt) => !isOccupiedPort(attempt.result));

  if (blockingAttempts.length > 0) {
    const last = blockingAttempts[blockingAttempts.length - 1];
    return new Error(
      `[browse] Cannot bind localhost ports after ${attempts.length} attempts in range ` +
      `${RANDOM_PORT_MIN}-${RANDOM_PORT_MAX}. Last error: ${formatPortFailureDetail(last)}. ` +
      `This usually means the current sandbox or OS permissions are blocking localhost port binding, ` +
      `not that every sampled port is occupied. Allow localhost binding, set BROWSE_PORT to an approved ` +
      `port, or run browse from an unrestricted terminal.`
    );
  }

  return new Error(
    `[browse] No available port after ${RANDOM_PORT_RETRIES} attempts in range ` +
    `${RANDOM_PORT_MIN}-${RANDOM_PORT_MAX}; every sampled port was already in use`
  );
}

// Test if a port is available by binding and immediately releasing.
// Uses net.createServer instead of Bun.serve to avoid a race condition
// in the Node.js polyfill where listen/close are async but the caller
// expects synchronous bind semantics. See: #486
export function checkPortAvailable(port: number, hostname: string = '127.0.0.1'): Promise<PortCheckResult> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const finish = (result: PortCheckResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    srv.once('error', (err) => finish(normalizePortError(err)));
    try {
      srv.listen(port, hostname, () => {
        srv.close(() => finish({ available: true }));
      });
    } catch (err) {
      finish(normalizePortError(err));
    }
  });
}

export function isPortAvailable(port: number, hostname: string = '127.0.0.1'): Promise<boolean> {
  return checkPortAvailable(port, hostname).then((result) => result.available);
}

/**
 * Find a port: the explicit override when given, otherwise a random port in
 * the fixed 10000-49151 scan range with bounded retries. NEVER `port: 0` —
 * see the module header for why the ephemeral range is off-limits.
 */
export async function findAvailablePort(explicitPort?: number | null): Promise<number> {
  if (explicitPort) {
    const result = await checkPortAvailable(explicitPort);
    if (result.available) {
      return explicitPort;
    }
    throw formatExplicitPortUnavailableError(explicitPort, result);
  }

  const attempts: FailedPortAttempt[] = [];
  for (let attempt = 0; attempt < RANDOM_PORT_RETRIES; attempt++) {
    const port = RANDOM_PORT_MIN + Math.floor(Math.random() * (RANDOM_PORT_MAX - RANDOM_PORT_MIN));
    const result = await checkPortAvailable(port);
    if (result.available) {
      return port;
    }
    attempts.push({ port, result });
  }
  throw formatRandomPortUnavailableError(attempts);
}
