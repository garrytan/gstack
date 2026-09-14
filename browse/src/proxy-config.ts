/**
 * Parse + validate proxy config from CLI flags and environment.
 *
 * Used by:
 *   cli.ts    — to detect cred-mixing, daemon-mismatch, and forward to server
 *   server.ts — to spawn the bridge and pass proxy to chromium.launch
 *
 * Cred policy (D9): if BOTH the URL embeds creds AND the env vars
 * BROWSE_PROXY_USER/PASS are set, refuse with a clear error. No silent
 * override — debugging confusion is worse than a one-time setup error.
 */

import { createHash } from 'crypto';
import type { UpstreamConfig } from './socks-bridge';

export interface ParsedProxyConfig {
  /** Original scheme: 'socks5' | 'http' | 'https' */
  scheme: 'socks5' | 'http' | 'https';
  host: string;
  port: number;
  userId?: string;
  password?: string;
  /** True if creds are present (from URL or env). */
  hasAuth: boolean;
}

export class ProxyConfigError extends Error {
  constructor(public readonly hint: string, message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

/**
 * Parse the BROWSE_PROXY_URL string and merge env-supplied creds.
 *
 * @throws ProxyConfigError on malformed URL, unsupported scheme, or
 *   ambiguous credentials (set in both URL and env).
 */
export function parseProxyConfig(opts: {
  proxyUrl: string;
  envUser?: string;
  envPass?: string;
}): ParsedProxyConfig {
  let url: URL;
  try {
    url = new URL(opts.proxyUrl);
  } catch {
    throw new ProxyConfigError(
      'expected scheme://[user:pass@]host:port',
      `invalid proxy URL — could not parse`,
    );
  }

  const scheme = url.protocol.replace(':', '');
  if (scheme !== 'socks5' && scheme !== 'http' && scheme !== 'https') {
    throw new ProxyConfigError(
      'use socks5://, http://, or https://',
      `unsupported proxy scheme '${scheme}'`,
    );
  }

  if (!url.hostname) {
    throw new ProxyConfigError(
      'expected scheme://[user:pass@]host:port',
      `invalid proxy URL — missing host`,
    );
  }

  const port = url.port
    ? parseInt(url.port, 10)
    : (scheme === 'http' ? 80 : scheme === 'https' ? 443 : 1080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ProxyConfigError(
      'expected scheme://[user:pass@]host:port',
      `invalid proxy URL — bad port`,
    );
  }

  const urlHasUser = !!url.username;
  const urlHasPass = !!url.password;
  const envHasUser = !!opts.envUser;
  const envHasPass = !!opts.envPass;
  const urlHasCreds = urlHasUser || urlHasPass;
  const envHasCreds = envHasUser || envHasPass;

  // D9 (codex correction): refuse on mixed sources. Silent override is a
  // debugging trap — when a stale BROWSE_PROXY_USER from a prior session
  // wins over a fresh --proxy URL, the user can't tell why.
  if (urlHasCreds && envHasCreds) {
    throw new ProxyConfigError(
      'unset BROWSE_PROXY_USER/PASS or remove user:pass@ from --proxy',
      `proxy creds set in both env (BROWSE_PROXY_USER) and URL — pick one source`,
    );
  }

  let userId: string | undefined;
  let password: string | undefined;
  if (urlHasCreds) {
    userId = decodeURIComponent(url.username);
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } else if (envHasCreds) {
    userId = opts.envUser;
    password = opts.envPass;
  }

  return {
    scheme: scheme as 'socks5' | 'http' | 'https',
    host: url.hostname,
    port,
    ...(userId ? { userId } : {}),
    ...(password ? { password } : {}),
    hasAuth: !!(userId || password),
  };
}

/** Convert a ParsedProxyConfig to the UpstreamConfig shape socks-bridge wants. */
export function toUpstreamConfig(cfg: ParsedProxyConfig): UpstreamConfig {
  return {
    host: cfg.host,
    port: cfg.port,
    ...(cfg.userId ? { userId: cfg.userId } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
  };
}

/**
 * Compute a stable hash of (proxyUrl + headed flag) for daemon-mismatch
 * detection (D2). The hash is deterministic across CLI invocations on the
 * same machine and survives daemon restarts via the state file.
 *
 * NEVER include resolved creds — the hash compares config intent, not
 * specific credential values, and we don't want creds in any persisted form.
 */
export function computeConfigHash(opts: {
  proxyUrl: string | null | undefined;
  headed: boolean;
}): string {
  const proxyKey = canonicalizeProxyUrl(opts.proxyUrl);
  const input = JSON.stringify({ proxy: proxyKey, headed: opts.headed });
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Strip creds from a proxy URL for hashing. Returns null for empty input. */
function canonicalizeProxyUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const u = new URL(input);
    u.username = '';
    u.password = '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<unparseable>';
  }
}
