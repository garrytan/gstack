// Tailnet → USB proxy. When an authenticated request hits the tailnet
// listener and clears capability + allowlist checks, the daemon forwards it
// to the iOS StateServer over the device's CoreDevice IPv6 tunnel, injecting
// the rotated boot token in Authorization: Bearer and preserving the
// X-Session-Id from the caller.

import { request as httpRequest } from 'http';
import type { ServerResponse, IncomingMessage } from 'http';
import { sanitizeReplacer } from './audit';
import { tierForRoute } from './types';

const MAX_BODY = 1_048_576; // 1MB hard cap on tailnet ingress

export interface DeviceTunnel {
  udid: string;
  bundleId?: string;
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
  if (tunnel.bundleId && isCoordinateMutation(inbound.method, inbound.url)) {
    headers['x-gstack-expected-bundle-id'] = tunnel.bundleId;
  }

  // Bracket IPv6 literals; pass IPv4 + hostnames bare. The CoreDevice tunnel
  // is always IPv6 in production, but tests inject 127.0.0.1 to talk to a
  // local stub. Detect by `:` count (IPv6 has multiple colons) or `:` absence
  // (IPv4/hostname).
  const isIPv6 = (tunnel.ipv6Addr.match(/:/g)?.length ?? 0) >= 2;
  const hostPart = isIPv6 ? `[${tunnel.ipv6Addr}]` : tunnel.ipv6Addr;
  const url = `http://${hostPart}:${tunnel.port}${inbound.url ?? '/'}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { status: number; headers: Record<string, string>; body: Buffer }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = httpRequest(url, {
      method: inbound.method,
      headers,
      timeout: opts.timeoutMs ?? 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') respHeaders[k] = v;
        }
        finish({
          status: res.statusCode ?? 502,
          headers: respHeaders,
          body: Buffer.concat(chunks),
        });
      });
      res.on('aborted', () => finish(makeError(503, 'device_disconnected')));
    });
    req.on('timeout', () => {
      // Node's request timeout is advisory: without destroying the socket it
      // can hang forever while a suspended app keeps the CoreDevice route but
      // stops servicing HTTP. Resolve first, then destroy; the resulting error
      // event is ignored by the settled guard.
      finish(makeError(504, 'upstream_timeout'));
      req.destroy();
    });
    req.on('error', (err) => {
      const e = err as { code?: string };
      if (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH') {
        finish(makeError(503, 'device_disconnected'));
      } else if (e.code === 'ETIMEDOUT') {
        finish(makeError(504, 'upstream_timeout'));
      } else {
        finish(makeError(502, 'upstream_error'));
      }
    });
    req.write(body);
    req.end();
  });
}

function isCoordinateMutation(method: string | undefined, path: string | undefined): boolean {
  return method === 'POST' && path !== undefined && ['/tap', '/swipe', '/type'].includes(path.split('?')[0]!);
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
