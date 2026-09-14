// tailscaled LocalAPI client. Reads the unix socket at /var/run/tailscale.sock
// (or wherever tailscaled is listening), calls WhoIs, returns a canonicalized
// identity string.
//
// **Fail-closed semantics:** every error path here MUST be surfaced as a
// reason the tailnet listener should refuse to open. Daemon caller must
// distinguish "socket missing" (Tailscale not installed) from "WhoIs returned
// unparseable response" (Tailscale broken) so the user knows what to fix.

import { request as httpRequest } from 'http';
import type { WhoIsResult } from './types';

export interface TailscaleProbe {
  ok: boolean;
  reason?: 'socket_missing' | 'permission_denied' | 'whois_unparseable' | 'unreachable';
  ownIdentity?: string;
}

/**
 * Probe whether tailscaled LocalAPI is usable. Called before opening the
 * tailnet listener. Returns ok=true only if WhoIs against the daemon's own
 * identity returns a parseable result.
 */
export async function probeTailscale(socketPath: string = '/var/run/tailscale.sock'): Promise<TailscaleProbe> {
  try {
    const result = await whoIs('127.0.0.1:9999', socketPath);
    return { ok: true, ownIdentity: result.identity };
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'ENOENT' || (e.message ?? '').includes('ENOENT')) {
      return { ok: false, reason: 'socket_missing' };
    }
    if (e.code === 'EACCES' || (e.message ?? '').includes('EACCES')) {
      return { ok: false, reason: 'permission_denied' };
    }
    if ((e.message ?? '').includes('unparseable') || (e.message ?? '').includes('JSON')) {
      return { ok: false, reason: 'whois_unparseable' };
    }
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * Call /localapi/v0/whois?addr=<addr:port>. Returns canonicalized identity.
 *
 * Canonicalization rules (matches Tailscale convention):
 * - User OAuth: `user@example.com` (no acct: prefix, lowercase email)
 * - Tagged nodes: `tag:<name>` (lowercased)
 * - Node keys: `node:<hex>` (rare, prefer tags)
 */
export async function whoIs(addr: string, socketPath: string = '/var/run/tailscale.sock'): Promise<WhoIsResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      path: `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`,
      method: 'GET',
      headers: { Host: 'local-tailscaled.sock' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`whois http ${res.statusCode}`));
          return;
        }
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const obj = JSON.parse(raw) as Record<string, unknown>;
          const identity = canonicalize(obj);
          if (!identity) {
            reject(new Error('whois response unparseable'));
            return;
          }
          resolve({ identity, raw: obj });
        } catch (e) {
          reject(new Error(`whois response unparseable: ${(e as Error).message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Reduce a WhoIs response object to a canonical identity string.
 *
 * Expected response shape (Tailscale LocalAPI v0):
 * {
 *   "Node": { "ComputedName": "...", "Tags": ["tag:ci"], ... },
 *   "UserProfile": { "LoginName": "user@example.com", ... },
 * }
 */
export function canonicalize(obj: Record<string, unknown>): string | null {
  // Tagged node — tag is more specific than user identity for ACL purposes.
  const node = obj.Node as Record<string, unknown> | undefined;
  if (node) {
    const tags = node.Tags as string[] | undefined;
    if (Array.isArray(tags) && tags.length > 0 && typeof tags[0] === 'string') {
      const tag = tags[0].toLowerCase();
      // Tags from Tailscale are already in `tag:foo` form.
      return tag.startsWith('tag:') ? tag : `tag:${tag}`;
    }
  }
  const profile = obj.UserProfile as Record<string, unknown> | undefined;
  if (profile) {
    const loginName = profile.LoginName as string | undefined;
    if (typeof loginName === 'string' && loginName.includes('@')) {
      return loginName.toLowerCase();
    }
  }
  // Fallback to node key — rare but possible.
  if (node) {
    const key = node.Key as string | undefined;
    if (typeof key === 'string' && key.startsWith('nodekey:')) {
      return `node:${key.replace('nodekey:', '')}`;
    }
  }
  return null;
}
