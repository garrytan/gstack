// Shared types for the ios-qa daemon.

export type Capability = 'observe' | 'interact' | 'mutate' | 'restore';

export const CAPABILITY_ORDER: Record<Capability, number> = {
  observe: 0,
  interact: 1,
  mutate: 2,
  restore: 3,
};

export function capabilityCovers(have: Capability, need: Capability): boolean {
  return CAPABILITY_ORDER[have] >= CAPABILITY_ORDER[need];
}

export interface AllowlistEntry {
  identity: string;
  capabilities: Capability[];
  expires_at: string | null;
  note?: string;
}

export interface Allowlist {
  version: 1;
  entries: AllowlistEntry[];
}

export interface SessionToken {
  token: string;
  identity: string;
  capability: Capability;
  expires_at: number; // epoch ms
  device_udid: string | null;
  origin: 'self_service' | 'owner_granted';
}

export interface AuditRow {
  ts: string;
  identity: string;
  device_udid: string;
  endpoint: string;
  session_id: string;
  capability: Capability;
  request_id: string;
  status: number;
}

export interface AttemptRow {
  ts: string;
  identity_canon: string; // sha256 salted — never the raw identity
  endpoint: string;
  reason: 'no_token' | 'invalid_token' | 'expired_token' | 'identity_not_allowed' |
          'capability_insufficient' | 'rate_limited' | 'allowlist_violation' |
          'tailnet_socket_missing' | 'whois_unparseable';
}

export interface WhoIsResult {
  identity: string; // canonicalized: "user@example.com" or "tag:<name>" or "node:<key>"
  raw: unknown;
}

// Path allowlist for tailnet listener — by capability tier.
// Each endpoint is mapped to the MINIMUM tier required.
export const TAILNET_ENDPOINT_TIERS: Record<string, Capability> = {
  'GET /healthz': 'observe',
  'POST /auth/mint': 'observe', // any allowlisted caller can attempt; daemon then filters by tier
  'POST /auth/revoke': 'observe', // own-session revoke
  'GET /screenshot': 'observe',
  'GET /elements': 'observe',
  'GET /state/snapshot': 'observe',
  'GET /state/*': 'observe',
  'POST /session/acquire': 'interact',
  'POST /session/release': 'interact',
  'POST /session/heartbeat': 'interact',
  'POST /tap': 'interact',
  'POST /swipe': 'interact',
  'POST /type': 'interact',
  'POST /state/*': 'mutate',
  'POST /state/restore': 'restore',
};

export function tierForRoute(method: string, path: string): Capability | null {
  const exact = `${method} ${path}`;
  if (TAILNET_ENDPOINT_TIERS[exact]) return TAILNET_ENDPOINT_TIERS[exact];
  // Wildcard /state/*
  if (path.startsWith('/state/') && path !== '/state/snapshot' && path !== '/state/restore') {
    if (method === 'GET') return 'observe';
    if (method === 'POST') return 'mutate';
  }
  return null; // not allowlisted on tailnet
}
