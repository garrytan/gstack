// gstack-ios-qa-daemon entrypoint.
//
// Two listeners:
//   - Loopback (127.0.0.1 + ::1): full command surface for the spawning agent.
//   - Tailnet (optional, --tailnet flag): capability-tier allowlist.
//
// The tailnet listener is opened ONLY if:
//   1. The user passed --tailnet at the CLI.
//   2. The tailscaled LocalAPI socket probe succeeds (fail-closed otherwise).
//
// All tailnet ingress is auth-gated against the SessionTokenStore. Identity
// validation uses tailscaled's WhoIs endpoint. Capability tiers come from
// types.ts. Audit + attempts logging is in audit.ts.

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse as parseUrl } from 'url';
import { tryClaim } from './single-instance';
import { probeTailscale, whoIs } from './tailscale-localapi';
import { SessionTokenStore } from './session-tokens';
import { mintForCaller } from './auth-mint';
import { classifyRoute, proxyToDevice, type DeviceTunnel } from './proxy';
import { writeAudit, writeAttempt, sanitizeReplacer } from './audit';
import { bootstrapTunnel } from './tunnel-bootstrap';
import { startTunnelKeepalive } from './devicectl';
import type { Capability } from './types';

interface DaemonOptions {
  loopbackPort: number;
  tailnetEnabled: boolean;
  tailnetSocketPath?: string;
  tailnetSessionTtlSeconds?: number;
  pidfilePath?: string;
  // Explicit security-log + allowlist paths. Default to the env-var-derived
  // locations (defaultAuditPath etc.) when omitted, but passing them lets
  // concurrent test instances stay isolated without racing on process.env.
  auditPath?: string;
  attemptsPath?: string;
  allowlistPath?: string;
  // Test injection
  tunnelProvider?: () => Promise<DeviceTunnel | null>;
  whoIsImpl?: (addr: string) => Promise<{ identity: string; raw: unknown }>;
  probeImpl?: () => Promise<{ ok: boolean; reason?: string; ownIdentity?: string }>;
}

export interface RunningDaemon {
  loopbackPort: number;
  tailnetPort: number | null;
  tokenStore: SessionTokenStore;
  close: () => Promise<void>;
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon | { error: string; reason?: string }> {
  // 1. Single-instance enforcement.
  const claim = await tryClaim({ port: opts.loopbackPort, path: opts.pidfilePath });
  if (!claim.claimed) {
    // Existing daemon — print READY with the existing port and exit.
    // The spawnAndWaitReady caller will receive this and connect to the
    // existing port instead.
    process.stdout.write(`READY: port=${claim.existing.port} pid=${claim.existing.pid}\n`);
    return { error: 'already_running', reason: `existing daemon pid=${claim.existing.pid}` };
  }

  const tokenStore = new SessionTokenStore();
  let tunnel: DeviceTunnel | null = null;
  let tunnelInFlight: Promise<DeviceTunnel | null> | null = null;

  const getTunnel = async (): Promise<DeviceTunnel | null> => {
    // A successful bootstrap consumes and deletes the app's one-shot boot
    // token. Keep that rotated tunnel for this daemon's lifetime instead of
    // trying to bootstrap it again on a timer. Failed attempts are not cached.
    if (tunnel) return tunnel;
    if (!opts.tunnelProvider) return null;

    // Multiple first requests can arrive before bootstrap completes. Share
    // one provider call so they cannot race through independent rotations.
    if (!tunnelInFlight) {
      tunnelInFlight = Promise.resolve()
        .then(() => opts.tunnelProvider!())
        .then((candidate) => {
          if (candidate) tunnel = candidate;
          return candidate;
        })
        .finally(() => {
          tunnelInFlight = null;
        });
    }
    return tunnelInFlight;
  };

  const invalidateTunnel = (failedTunnel: DeviceTunnel): void => {
    // A late response from the old app must not evict a tunnel that another
    // request has already refreshed. Object identity gives each bootstrap a
    // cheap generation token without exposing generation state elsewhere.
    if (tunnel === failedTunnel) tunnel = null;
  };

  // 2. Tailnet probe (fail-closed).
  const probe = opts.tailnetEnabled
    ? (opts.probeImpl ? await opts.probeImpl() : await probeTailscale(opts.tailnetSocketPath))
    : null;

  if (opts.tailnetEnabled && (!probe || !probe.ok)) {
    process.stderr.write(`tailnet binding refused: ${probe?.reason ?? 'probe_failed'}\n`);
    // Loopback still runs.
  }

  // 3. Loopback listener (full surface).
  const loopbackServer = createServer(async (req, res) => {
    await handleLoopback({ req, res, tokenStore, getTunnel, invalidateTunnel });
  });
  // Use port 0 for OS-assigned port when test/random port collisions are a risk.
  const requestedPort = opts.loopbackPort;
  await listenAsync(loopbackServer, requestedPort, '127.0.0.1');
  const actualPort = (loopbackServer.address() as { port: number }).port;

  // ipv6 — bind a SECOND server to ::1 on the same actualPort. In test (port 0)
  // mode this can collide; we try the actualPort first and skip ipv6 if it
  // fails (tests don't exercise ::1 explicitly).
  const loopbackServerV6 = createServer(async (req, res) => {
    await handleLoopback({ req, res, tokenStore, getTunnel, invalidateTunnel });
  });
  let v6Bound = false;
  try {
    await listenAsync(loopbackServerV6, actualPort, '::1');
    v6Bound = true;
  } catch {
    // IPv6 loopback bind failed (port collision or no v6 on host). Loopback
    // IPv4 already serves the spawning agent. Continue.
  }

  // 4. Tailnet listener (if probe succeeded).
  let tailnetServer: ReturnType<typeof createServer> | null = null;
  let tailnetPort: number | null = null;
  if (opts.tailnetEnabled && probe?.ok) {
    tailnetServer = createServer(async (req, res) => {
      await handleTailnet({
        req,
        res,
        tokenStore,
        getTunnel,
        invalidateTunnel,
        auditPath: opts.auditPath,
        attemptsPath: opts.attemptsPath,
        allowlistPath: opts.allowlistPath,
        whoIsImpl: opts.whoIsImpl ?? ((addr) => whoIs(addr, opts.tailnetSocketPath)),
      });
    });
    const tailnetBindAddr = process.env.GSTACK_IOS_TAILNET_BIND ?? '127.0.0.1';
    // For tailnet port: actualPort + 1 if specified, else port 0 (OS-assigned).
    const requestedTailnetPort = requestedPort === 0 ? 0 : actualPort + 1;
    await listenAsync(tailnetServer, requestedTailnetPort, tailnetBindAddr);
    tailnetPort = (tailnetServer.address() as { port: number }).port;
  }

  // 5. READY line.
  process.stdout.write(`READY: port=${actualPort} pid=${process.pid}\n`);

  return {
    loopbackPort: actualPort,
    tailnetPort,
    tokenStore,
    close: async () => {
      // Force-close any open connections (keep-alive sockets) before waiting
      // for the listening socket itself. Otherwise close() hangs forever on
      // idle clients.
      const closeAll = (s: ReturnType<typeof createServer> | null | undefined) => {
        if (!s) return Promise.resolve();
        (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        (s as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
        return new Promise<void>((resolve) => s.close(() => resolve()));
      };
      await Promise.all([
        closeAll(loopbackServer),
        v6Bound ? closeAll(loopbackServerV6) : Promise.resolve(),
        closeAll(tailnetServer),
      ]);
      await claim.release();
    },
  };
}

function listenAsync(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// ───────── Handlers ─────────

interface HandlerCtx {
  req: IncomingMessage;
  res: ServerResponse;
  tokenStore: SessionTokenStore;
  getTunnel: () => Promise<DeviceTunnel | null>;
  invalidateTunnel: (failedTunnel: DeviceTunnel) => void;
  // Explicit security-log + allowlist paths (default to env-derived when undefined).
  auditPath?: string;
  attemptsPath?: string;
  allowlistPath?: string;
}

type DeviceProxyResponse = Awaited<ReturnType<typeof proxyToDevice>>;
const RECOVERABLE_SOCKET_ERRORS = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

function localProxyError(status: number, error: string): DeviceProxyResponse {
  const body = Buffer.from(JSON.stringify({ error }, sanitizeReplacer));
  return {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  };
}

async function proxyAttempt(opts: Parameters<typeof proxyToDevice>[0]): Promise<DeviceProxyResponse> {
  try {
    return await proxyToDevice(opts);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // CoreDevice can surface the same stale route as several different socket
    // failures while an app is being relaunched or replaced. Normalize those
    // failures so the cache recovery path below can handle all of them.
    if (code && RECOVERABLE_SOCKET_ERRORS.has(code)) {
      return localProxyError(503, 'device_disconnected');
    }
    throw err;
  }
}

function shouldRefreshTunnel(upstream: DeviceProxyResponse): boolean {
  // A relaunched app has a new in-memory bearer and rejects the daemon's old
  // rotated token. A redeploy can instead leave the old CoreDevice route
  // refusing connections or timing out. Both cases require a fresh bootstrap.
  if (upstream.status === 401) return true;
  if (upstream.status !== 503 && upstream.status !== 504) return false;
  try {
    const body = JSON.parse(upstream.body.toString('utf-8')) as { error?: string };
    return body.error === 'device_disconnected' || body.error === 'upstream_timeout';
  } catch {
    return false;
  }
}

function canReplayAfterRefresh(inbound: IncomingMessage, upstream: DeviceProxyResponse): boolean {
  // A 401 proves the stale bearer was rejected before StateServer dispatched
  // the operation, so retrying is safe even for a mutation. Connection loss
  // is ambiguous: the app may have applied a tap/write before its response was
  // lost. Replay only read-only requests in that case to prevent double taps.
  if (upstream.status === 401) return true;
  const method = inbound.method ?? 'GET';
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

async function proxyWithTunnelRecovery(opts: {
  inbound: IncomingMessage;
  body: Buffer;
  sessionId: string | null;
  agentIdentity?: string;
  getTunnel: HandlerCtx['getTunnel'];
  invalidateTunnel: HandlerCtx['invalidateTunnel'];
}): Promise<{ tunnel: DeviceTunnel; upstream: DeviceProxyResponse } | null> {
  let tunnel = await opts.getTunnel();
  if (!tunnel) return null;

  const makeAttempt = (candidate: DeviceTunnel) => proxyAttempt({
    inbound: opts.inbound,
    body: opts.body,
    tunnel: candidate,
    sessionId: opts.sessionId,
    agentIdentity: opts.agentIdentity,
  });

  let upstream = await makeAttempt(tunnel);
  if (!shouldRefreshTunnel(upstream)) return { tunnel, upstream };

  const failedTunnel = tunnel;
  const replaySafe = canReplayAfterRefresh(opts.inbound, upstream);
  opts.invalidateTunnel(tunnel);
  const refreshed = await opts.getTunnel();
  if (!refreshed) return replaySafe ? null : { tunnel: failedTunnel, upstream };

  // The replacement is now cached for the next request, but never replay an
  // ambiguous mutation whose response was lost: doing so could double-tap or
  // apply a state transition twice.
  if (!replaySafe) return { tunnel: failedTunnel, upstream };

  tunnel = refreshed;
  upstream = await makeAttempt(tunnel);
  // Do not loop forever if the replacement app is itself unavailable. Leave
  // the cache empty so the next independent request can bootstrap again.
  if (shouldRefreshTunnel(upstream)) opts.invalidateTunnel(tunnel);
  return { tunnel, upstream };
}

function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<Buffer | { error: 'body_too_large' }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes && !overLimit) {
        overLimit = true;
      }
      if (!overLimit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) {
        resolve({ error: 'body_too_large' });
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      // Resolve with empty body if upstream cut us off after limit hit.
      if (overLimit) resolve({ error: 'body_too_large' });
      else reject(err);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, sanitizeReplacer);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Loopback handler — full surface for the spawning agent. No auth (the
 * loopback bind itself is the boundary).
 */
async function handleLoopback(ctx: HandlerCtx): Promise<void> {
  const { req, res, tokenStore, getTunnel, invalidateTunnel } = ctx;
  const url = parseUrl(req.url ?? '/');
  const path = url.pathname ?? '/';
  const method = req.method ?? 'GET';

  try {
    // /healthz — public on loopback.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { version: '1.0.0', mode: 'loopback' });
      return;
    }

    // /auth/sessions — list active sessions (owner only).
    if (method === 'GET' && path === '/auth/sessions') {
      sendJson(res, 200, { sessions: tokenStore.list() });
      return;
    }

    // /auth/revoke — revoke a token.
    if (method === 'POST' && path === '/auth/revoke') {
      const body = await readBody(req);
      if ('error' in body) { sendJson(res, 413, body); return; }
      const parsed = JSON.parse(body.toString('utf-8') || '{}') as { token?: string; identity?: string };
      let count = 0;
      if (parsed.token) {
        count = tokenStore.revoke(parsed.token) ? 1 : 0;
      } else if (parsed.identity) {
        count = tokenStore.revokeByIdentity(parsed.identity);
      }
      sendJson(res, 200, { revoked: count });
      return;
    }

    // Other endpoints — proxy to the device.
    const body = await readBody(req);
    if ('error' in body) { sendJson(res, 413, body); return; }
    const sessionId = (req.headers['x-session-id'] as string | undefined) ?? null;
    const agentIdentity = (req.headers['x-agent-identity'] as string | undefined) ?? undefined;
    const proxied = await proxyWithTunnelRecovery({
      inbound: req,
      body,
      sessionId,
      agentIdentity,
      getTunnel,
      invalidateTunnel,
    });
    if (!proxied) {
      sendJson(res, 503, { error: 'device_not_connected' });
      return;
    }
    const { upstream } = proxied;
    res.writeHead(upstream.status, upstream.headers);
    res.end(upstream.body);
  } catch (err) {
    sendJson(res, 500, { error: 'internal_error', detail: (err as Error).message });
  }
}

interface TailnetCtx extends HandlerCtx {
  whoIsImpl: (addr: string) => Promise<{ identity: string; raw: unknown }>;
}

/**
 * Tailnet handler — locked allowlist + capability tiers.
 */
async function handleTailnet(ctx: TailnetCtx): Promise<void> {
  const { req, res, tokenStore, getTunnel, invalidateTunnel, whoIsImpl, auditPath, attemptsPath, allowlistPath } = ctx;
  const url = parseUrl(req.url ?? '/');
  const path = url.pathname ?? '/';
  const method = req.method ?? 'GET';
  const route = `${method} ${path}`;

  try {
    // Classify the route.
    const classification = classifyRoute(method, path);
    if (!classification.allowed) {
      sendJson(res, 404, { error: 'endpoint_not_in_tailnet_allowlist', path });
      return;
    }
    const requiredCapability = classification.requiredCapability as Capability;

    // /healthz on tailnet requires auth (codex catch).
    // No special-case; treated like every other observe-tier endpoint.

    // /auth/mint — special path. No bearer required; uses WhoIs.
    if (method === 'POST' && path === '/auth/mint') {
      const peerAddr = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
      let callerIdentity: string;
      try {
        const who = await whoIsImpl(peerAddr);
        callerIdentity = who.identity;
      } catch (err) {
        await writeAttempt({
          rawIdentity: peerAddr,
          endpoint: route,
          reason: 'whois_unparseable',
          path: attemptsPath,
        });
        sendJson(res, 502, { error: 'whois_failed', detail: (err as Error).message });
        return;
      }

      const body = await readBody(req);
      if ('error' in body) { sendJson(res, 413, body); return; }
      const parsed = JSON.parse(body.toString('utf-8') || '{}') as { capability?: Capability; device_udid?: string };

      const result = await mintForCaller({
        callerIdentity,
        request: parsed,
        tokenStore,
        endpoint: route,
        allowlistPath,
        attemptsPath,
      });

      if ('error' in result) {
        const status = result.error === 'rate_limited' ? 429 : 403;
        sendJson(res, status, result);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    // All other endpoints: bearer auth + capability check.
    const auth = req.headers['authorization'] as string | undefined;
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    const validation = tokenStore.validate(token, requiredCapability);
    if (!validation.ok) {
      await writeAttempt({
        rawIdentity: token ? 'token:' + token.slice(0, 8) : 'no_token',
        endpoint: route,
        reason: validation.reason,
        path: attemptsPath,
      });
      const status = validation.reason === 'capability_insufficient' ? 403 : 401;
      sendJson(res, status, { error: validation.reason });
      return;
    }

    const session = validation.session;

    // Read body once + enforce limit.
    const body = await readBody(req);
    if ('error' in body) { sendJson(res, 413, body); return; }

    // Tailnet-only own-session revoke.
    if (method === 'POST' && path === '/auth/revoke') {
      tokenStore.revoke(session.token);
      sendJson(res, 200, { revoked: 1 });
      return;
    }

    // Proxy to device.
    const sessionId = (req.headers['x-session-id'] as string | undefined) ?? null;
    const proxied = await proxyWithTunnelRecovery({
      inbound: req,
      body,
      sessionId,
      agentIdentity: session.identity,
      getTunnel,
      invalidateTunnel,
    });
    if (!proxied) {
      sendJson(res, 503, { error: 'device_not_connected' });
      return;
    }
    const { tunnel, upstream } = proxied;

    // Audit the action (mutating endpoints only).
    if (requiredCapability !== 'observe') {
      await writeAudit({
        ts: new Date().toISOString(),
        identity: session.identity,
        device_udid: tunnel.udid,
        endpoint: route,
        session_id: sessionId ?? '-',
        capability: session.capability,
        request_id: req.headers['x-request-id']?.toString() ?? '-',
        status: upstream.status,
      }, auditPath);
    }

    res.writeHead(upstream.status, upstream.headers);
    res.end(upstream.body);
  } catch (err) {
    sendJson(res, 500, { error: 'internal_error', detail: (err as Error).message });
  }
}

// CLI entry — runs when this file is executed directly, not when imported.
if (import.meta.main) {
  const port = parseInt(process.env.GSTACK_IOS_DAEMON_PORT ?? '9099', 10);
  const tailnet = process.argv.includes('--tailnet');
  const targetUDID = process.env.GSTACK_IOS_TARGET_UDID;
  const bundleId = process.env.GSTACK_IOS_TARGET_BUNDLE_ID ?? 'com.gstack.iosqa.fixture';

  // Default tunnelProvider: when GSTACK_IOS_TARGET_UDID (or a default with
  // any connected paired device) is set, bootstrap a real CoreDevice tunnel.
  // Otherwise return null (proxy will return 503 device_not_connected).
  //
  // After a successful bootstrap we spawn a periodic devicectl `info details`
  // call to keep the CoreDevice tunnel session alive — Xcode 26's CoreDevice
  // only holds the tunnel up while a devicectl command is in-flight, so
  // without a poke every few seconds the IPv6 becomes unroutable.
  let keepalive: { stop: () => void } | null = null;
  const realTunnelProvider = async () => {
    const result = await bootstrapTunnel({
      udid: targetUDID,
      bundleId,
    });
    if (!result.ok) {
      process.stderr.write(`bootstrap error: ${result.error}${result.detail ? ' — ' + result.detail : ''}\n`);
      return null;
    }
    if (keepalive) keepalive.stop();
    keepalive = startTunnelKeepalive(result.tunnel.udid);
    return result.tunnel;
  };

  const shutdown = () => {
    if (keepalive) { keepalive.stop(); keepalive = null; }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);

  startDaemon({
    loopbackPort: port,
    tailnetEnabled: tailnet,
    tunnelProvider: realTunnelProvider,
  }).then((d) => {
    if ('error' in d) {
      process.stderr.write(`daemon error: ${d.error}\n`);
      process.exit(0); // exit 0 because READY was already printed
    }
  }).catch((err) => {
    process.stderr.write(`daemon fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
