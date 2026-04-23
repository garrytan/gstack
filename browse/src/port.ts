import * as net from 'net';

export type PortCheckResult =
  | { ok: true }
  | { ok: false; code?: string; message?: string };

type CheckPortFn = (port: number, hostname: string) => Promise<PortCheckResult>;

export interface FindPortOptions {
  requestedPort?: number;
  hostname?: string;
  minPort?: number;
  maxPort?: number;
  maxRetries?: number;
  randomInt?: (minPort: number, maxPort: number) => number;
  checkPort?: CheckPortFn;
}

export function checkPortAvailability(port: number, hostname: string = '127.0.0.1'): Promise<PortCheckResult> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        code: err.code,
        message: err.message,
      });
    });
    srv.listen(port, hostname, () => {
      srv.close(() => resolve({ ok: true }));
    });
  });
}

function isPermissionError(code?: string): boolean {
  return code === 'EPERM' || code === 'EACCES';
}

function formatPermissionError(port: number, code?: string, explicit: boolean = false): Error {
  const detail = code ? ` (${code})` : '';
  if (explicit) {
    return new Error(
      `[browse] Port ${port} (from BROWSE_PORT env) was blocked by the environment${detail}. ` +
      `Re-run with escalated permissions or outside the sandbox.`,
    );
  }

  return new Error(
    `[browse] Local port bind was blocked by the environment${detail} while probing port ${port}. ` +
    `Re-run with escalated permissions or outside the sandbox.`,
  );
}

function formatUnexpectedBindError(port: number, message?: string, explicit: boolean = false): Error {
  if (explicit) {
    return new Error(
      `[browse] Port ${port} (from BROWSE_PORT env) could not be bound: ${message || 'unknown error'}`,
    );
  }

  return new Error(
    `[browse] Unexpected error while probing port ${port}: ${message || 'unknown error'}`,
  );
}

export async function findPort(options: FindPortOptions = {}): Promise<number> {
  const hostname = options.hostname || '127.0.0.1';
  const minPort = options.minPort ?? 10000;
  const maxPort = options.maxPort ?? 60000;
  const maxRetries = options.maxRetries ?? 5;
  const requestedPort = options.requestedPort ?? 0;
  const randomInt = options.randomInt || ((min: number, max: number) => min + Math.floor(Math.random() * (max - min)));
  const checkPort = options.checkPort || checkPortAvailability;

  if (requestedPort) {
    const result = await checkPort(requestedPort, hostname);
    if (result.ok) {
      return requestedPort;
    }
    if (isPermissionError(result.code)) {
      throw formatPermissionError(requestedPort, result.code, true);
    }
    if (result.code === 'EADDRINUSE') {
      throw new Error(`[browse] Port ${requestedPort} (from BROWSE_PORT env) is in use`);
    }
    throw formatUnexpectedBindError(requestedPort, result.message, true);
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const port = randomInt(minPort, maxPort);
    const result = await checkPort(port, hostname);
    if (result.ok) {
      return port;
    }
    if (isPermissionError(result.code)) {
      throw formatPermissionError(port, result.code);
    }
    if (result.code !== 'EADDRINUSE') {
      throw formatUnexpectedBindError(port, result.message);
    }
  }

  throw new Error(`[browse] No available port after ${maxRetries} attempts in range ${minPort}-${maxPort}`);
}
