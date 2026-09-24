// Tailnet → USB proxy. When an authenticated request hits the tailnet
// listener and clears capability + allowlist checks, the daemon forwards it
// to the iOS StateServer over the device's CoreDevice IPv6 tunnel, injecting
// the rotated boot token in Authorization: Bearer and preserving the
// X-Session-Id from the caller.

import { request as httpRequest } from 'http';
import type { IncomingMessage } from 'http';
import { sanitizeReplacer } from './audit';
import { tierForRoute } from './types';

const MAX_BODY = 1_048_576; // 1MB hard cap on tailnet ingress

export interface DeviceTunnel {
  udid: string;
  ipv6Addr: string;
  port: number;
  bootTokenRotated: string; // the rotated bearer the daemon uses to talk to StateServer
}

export interface ProxyError {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Forward a parsed inbound request to the StateServer. Returns the upstream
 * response or a ProxyError. Caller writes to the ServerResponse.
 */
export async function proxyToDevice(opts: {
  inbound: IncomingMessage;
  body: Buffer;
  tunnel: DeviceTunnel;
  sessionId: string | null;
  agentIdentity?: string;
  timeoutMs?: number;
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const { inbound, body, tunnel, sessionId, agentIdentity } = opts;
  if (body.length > MAX_BODY) {
    return makeError(413, 'body_too_large');
  }

  const headers: Record<string, string> = {
    'authorization': `Bearer ${tunnel.bootTokenRotated}`,
    'content-type': inbound.headers['content-type'] || 'application/json',
    'content-length': String(body.length),
  };
  if (sessionId) headers['x-session-id'] = sessionId;
  if (agentIdentity) headers['x-agent-identity'] = agentIdentity;

  // Bracket IPv6 literals; pass IPv4 + hostnames bare. The CoreDevice tunnel
  // is always IPv6 in production, but tests inject 127.0.0.1 to talk to a
  // local stub. Detect by `:` count (IPv6 has multiple colons) or `:` absence
  // (IPv4/hostname).
  const isIPv6 = (tunnel.ipv6Addr.match(/:/g)?.length ?? 0) >= 2;
  const hostPart = isIPv6 ? `[${tunnel.ipv6Addr}]` : tunnel.ipv6Addr;
  const url = `http://${hostPart}:${tunnel.port}${inbound.url ?? '/'}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    const chunks: Buffer[] = [];
    const finish = (result: Awaited<ReturnType<typeof proxyToDevice>> | Error, destroy = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      response?.off('data', onData);
      response?.off('end', onEnd);
      response?.off('aborted', onAborted);
      chunks.length = 0;
      if (destroy) req.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onError = (err: Error) => {
      const e = err as { code?: string };
      if (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH') {
        finish(makeError(503, 'device_disconnected'), true);
      } else if (e.code === 'ETIMEDOUT') {
        finish(makeError(504, 'upstream_timeout'), true);
      } else {
        finish(err, true);
      }
    };
    const onAborted = () => onError(Object.assign(new Error('Upstream response aborted'), { code: 'ECONNRESET' }));
    const onData = (chunk: Buffer) => chunks.push(chunk);
    const onEnd = () => {
      const respHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(response!.headers)) {
        if (typeof v === 'string') respHeaders[k] = v;
      }
      finish({
        status: response!.statusCode ?? 502,
        headers: respHeaders,
        body: Buffer.concat(chunks),
      });
    };
    const req = httpRequest(url, { method: inbound.method, headers }, (res) => {
      response = res;
      res.on('error', onError);
      res.once('close', () => {
        if (!settled) onAborted();
        res.off('error', onError);
      });
      if (settled) {
        res.destroy();
        return;
      }
      res.on('data', onData);
      res.once('end', onEnd);
      res.once('aborted', onAborted);
    });
    const deadline = setTimeout(() => finish(makeError(504, 'upstream_timeout'), true), opts.timeoutMs ?? 30_000);
    req.on('error', onError);
    req.once('close', () => {
      if (!settled && !response) onAborted();
      req.off('error', onError);
    });
    req.write(body);
    req.end();
  });
}

function makeError(status: number, error: string): { status: number; headers: Record<string, string>; body: Buffer } {
  const body = Buffer.from(JSON.stringify({ error }, sanitizeReplacer));
  return {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  };
}

/**
 * Determine whether the endpoint is allowed on the tailnet listener AND what
 * capability tier it requires.
 */
export function classifyRoute(method: string, path: string): {
  allowed: boolean;
  requiredCapability: ReturnType<typeof tierForRoute>;
} {
  const tier = tierForRoute(method, path);
  return { allowed: tier !== null, requiredCapability: tier };
}
