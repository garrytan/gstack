/**
 * Token registry — per-agent scoped tokens for multi-agent browser access.
 *
 * Architecture:
 *   Root token (from server startup) → POST /token → scoped sub-tokens
 *   POST /connect (setup key exchange) → session token
 *
 *   Token lifecycle:
 *     createSetupKey() → exchangeSetupKey() → session token (24h default)
 *     createToken()    → direct session token (for CLI/local use)
 *     revokeToken()    → immediate invalidation
 *     rotateRoot()     → new root, all scoped tokens invalidated
 *
 *   Scope categories (derived from commands.ts READ/WRITE/META sets):
 *     read  — snapshot, text, html, links, forms, console, etc.
 *     write — goto, click, fill, scroll, newtab, etc.
 *     admin — eval, js, cookies, storage, useragent, state (destructive)
 *     meta  — tab, diff, chain, frame, responsive
 *
 *   Security invariants:
 *     1. Only root token can mint sub-tokens (POST /token, POST /connect)
 *     2. control scope denied by default — must be explicitly flagged.
 *        Registry API defaults (createToken/createSetupKey with no scopes)
 *        stay ['read','write']; the /pair ceremony explicitly grants
 *        DEFAULT_PAIR_SCOPES (read+write+admin+meta — the pairing ceremony
 *        is the trust boundary; --restrict narrows, --control must be
 *        explicit and never rides in via a scopes list)
 *     3. chain command scope-checks each subcommand individually
 *     4. Root token never in connection strings or pasted instructions
 *
 * Zero side effects on import. Safe to import from tests.
 */

import * as crypto from 'crypto';
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from './commands';

// ─── Scope Definitions ─────────────────────────────────────────
// Derived from commands.ts, but reclassified by actual side effects.
// The key insight (from Codex adversarial review): commands.ts READ_COMMANDS
// includes js/eval/cookies/storage which are actually dangerous. The scope
// model here overrides the commands.ts classification.

/** Commands safe for read-only agents */
export const SCOPE_READ = new Set([
  'snapshot', 'text', 'html', 'links', 'forms', 'accessibility',
  'console', 'network', 'perf', 'dialog', 'is', 'inspect',
  'url', 'tabs', 'status', 'screenshot', 'pdf', 'css', 'attrs',
  'media', 'data',
]);

/** Commands that modify page state or navigate */
export const SCOPE_WRITE = new Set([
  'goto', 'back', 'forward', 'reload',
  'load-html',
  'click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait',
  'upload', 'viewport', 'newtab', 'closetab',
  'dialog-accept', 'dialog-dismiss',
  'download', 'scrape', 'archive',
]);

/** Page-level power tools — JS execution, credential access, page mutations */
export const SCOPE_ADMIN = new Set([
  'eval', 'js', 'cookies', 'storage',
  'cookie', 'cookie-import', 'cookie-import-browser',
  'header', 'useragent',
  'style', 'cleanup', 'prettyscreenshot',
]);

/** Browser-wide destructive commands — can kill the server, disconnect headed mode */
export const SCOPE_CONTROL = new Set([
  'state', 'handoff', 'resume', 'stop', 'restart', 'connect', 'disconnect',
]);

/** Meta commands — generally safe but some need scope checking */
export const SCOPE_META = new Set([
  'tab', 'diff', 'frame', 'responsive', 'snapshot',
  'watch', 'inbox', 'focus',
]);

export type ScopeCategory = 'read' | 'write' | 'admin' | 'meta' | 'control';

const SCOPE_MAP: Record<ScopeCategory, Set<string>> = {
  read: SCOPE_READ,
  write: SCOPE_WRITE,
  admin: SCOPE_ADMIN,
  control: SCOPE_CONTROL,
  meta: SCOPE_META,
};

/**
 * Scopes granted by POST /pair when nothing narrower is requested.
 * Deliberately full page access (b73f3644 / #907): the trust boundary is the
 * pairing ceremony, not the scope. 'control' (browser-wide destructive ops)
 * is the only scope that stays opt-in via the control flag. Referenced by
 * BOTH server.ts (/pair default) and cli.ts (explicit send) so the two
 * defaults cannot silently drift apart again.
 */
export const DEFAULT_PAIR_SCOPES: readonly ScopeCategory[] = ['read', 'write', 'admin', 'meta'];

/**
 * Typed error for caller-supplied token options (unknown scope, negative
 * rateLimit). HTTP handlers catch it to 400 with the message at the endpoint
 * where the typo happened — pre-fix, a bad scope sailed through /pair into a
 * poisoned setup key and surfaced as a misleading "Invalid request body" to
 * the remote agent at /connect.
 */
export class InvalidScopeError extends Error {}

export function assertValidTokenOptions(scopes: readonly string[], rateLimit: number): void {
  const validScopes: ScopeCategory[] = ['read', 'write', 'admin', 'meta', 'control'];
  for (const s of scopes) {
    if (!validScopes.includes(s as ScopeCategory)) {
      throw new InvalidScopeError(`Invalid scope: ${s}. Valid: ${validScopes.join(', ')}`);
    }
  }
  if (rateLimit < 0) throw new InvalidScopeError('rateLimit must be >= 0');
}

/**
 * Typed error for a reserved or malformed clientId. `root` is the sentinel that
 * checkScope/checkDomain/checkRate and the server command gate use to mean "the
 * omnipotent root caller" (validateToken:360), so a scoped token carrying it
 * would bypass every enforcement path. Empty/non-string ids collapse distinct
 * agents together and break revoke-by-clientId. Request-path writers throw;
 * restoreRegistry skips-and-logs so one bad state-file entry can't drop later
 * sessions or brick boot.
 */
export class ReservedClientIdError extends Error {}

export function assertValidClientId(clientId: unknown): asserts clientId is string {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new ReservedClientIdError('clientId must be a non-empty string');
  }
  if (clientId.trim().toLowerCase() === 'root') {
    throw new ReservedClientIdError("clientId 'root' is reserved");
  }
}

// ─── Types ──────────────────────────────────────────────────────

export interface TokenInfo {
  token: string;
  clientId: string;
  type: 'session' | 'setup';
  scopes: ScopeCategory[];
  domains?: string[];          // glob patterns, e.g. ['*.myapp.com']
  tabPolicy: 'own-only' | 'shared';
  rateLimit: number;           // requests per second (0 = unlimited)
  expiresAt: string | null;    // ISO8601, null = never
  createdAt: string;
  usesRemaining?: number;      // for setup keys only
  issuedSessionToken?: string; // for setup keys: the session token that was issued
  commandCount: number;        // how many commands have been executed
}

export interface CreateTokenOptions {
  clientId: string;
  scopes?: ScopeCategory[];
  domains?: string[];
  tabPolicy?: 'own-only' | 'shared';
  rateLimit?: number;
  expiresSeconds?: number | null; // null = never, default = 86400 (24h)
}

export interface TokenRegistryState {
  agents: Record<string, Omit<TokenInfo, 'commandCount'>>;
}

// ─── Rate Limiter ───────────────────────────────────────────────

interface RateBucket {
  count: number;
  windowStart: number;
}

const rateBuckets = new Map<string, RateBucket>();

function checkRateLimit(clientId: string, limit: number): { allowed: boolean; retryAfterMs?: number } {
  if (limit <= 0) return { allowed: true };

  const now = Date.now();
  const bucket = rateBuckets.get(clientId);

  if (!bucket || now - bucket.windowStart >= 1000) {
    rateBuckets.set(clientId, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (bucket.count >= limit) {
    const retryAfterMs = 1000 - (now - bucket.windowStart);
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 100) };
  }

  bucket.count++;
  return { allowed: true };
}

// ─── Token Registry ─────────────────────────────────────────────

const tokens = new Map<string, TokenInfo>();
let rootToken: string = '';

export function initRegistry(root: string): void {
  // Idempotent re-init: same token is a no-op so embedders can call this
  // alongside any prior call without fighting. Different token after init
  // means a misconfigured caller — throw clearly rather than silently
  // invalidate every scoped token already issued.
  if (rootToken !== '' && rootToken !== root) {
    throw new Error(
      'token-registry already initialized with a different token; ' +
      'embedders must call buildFetchHandler before any registry-mutating code path'
    );
  }
  rootToken = root;
}

export function getRootToken(): string {
  return rootToken;
}

export function isRootToken(token: string): boolean {
  // Constant-time compare so a tunnel-reachable caller who can provoke an
  // isRootToken() call (e.g., via the 403 "root over tunnel" rejection path)
  // can't measure byte-by-byte string-compare timing to recover the token.
  // Compare UTF-8 byte lengths (not JS string length) before timingSafeEqual,
  // which throws on length-mismatched buffers. A multibyte input whose JS
  // string length matches rootToken but whose UTF-8 byte length differs must
  // return false on the auth path, not error out.
  if (!rootToken) return false;
  const tokenBytes = Buffer.byteLength(token, 'utf8');
  const rootBytes = Buffer.byteLength(rootToken, 'utf8');
  if (tokenBytes !== rootBytes) return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(rootToken, 'utf8');
  return crypto.timingSafeEqual(a, b);
}

function generateToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Create a scoped session token (for direct minting via CLI or /token endpoint).
 * Only callable by root token holder.
 */
export function createToken(opts: CreateTokenOptions): TokenInfo {
  const {
    clientId,
    scopes = ['read', 'write'],
    domains,
    tabPolicy = 'own-only',
    rateLimit = 10,
    expiresSeconds = 86400, // 24h default
  } = opts;

  // Validate inputs
  assertValidClientId(clientId);
  assertValidTokenOptions(scopes, rateLimit);
  if (expiresSeconds !== null && expiresSeconds !== undefined && expiresSeconds < 0) {
    throw new Error('expiresSeconds must be >= 0 or null');
  }

  const token = generateToken('gsk_sess_');
  const now = new Date();
  const expiresAt = expiresSeconds === null
    ? null
    : new Date(now.getTime() + expiresSeconds * 1000).toISOString();

  const info: TokenInfo = {
    token,
    clientId,
    type: 'session',
    scopes,
    domains,
    tabPolicy,
    rateLimit,
    expiresAt,
    createdAt: now.toISOString(),
    commandCount: 0,
  };

  // Overwrite if clientId already exists (re-pairing)
  // First revoke the old session token (but NOT setup keys — they track their issued session)
  for (const [t, existing] of tokens) {
    if (existing.clientId === clientId && existing.type === 'session') {
      tokens.delete(t);
      break;
    }
  }

  tokens.set(token, info);
  return info;
}

/**
 * Create a one-time setup key for the /pair-agent ceremony.
 * Setup keys expire in 5 minutes and can only be exchanged once.
 */
export function createSetupKey(opts: Omit<CreateTokenOptions, 'clientId'> & { clientId?: string }): TokenInfo {
  // Only validate when a clientId is supplied; an omitted one gets a safe
  // generated `remote-<ts>` default below.
  if (opts.clientId !== undefined) assertValidClientId(opts.clientId);
  const scopes = opts.scopes || ['read', 'write'];
  // ?? not ||: rateLimit 0 is documented as "unlimited" and must survive.
  const rateLimit = opts.rateLimit ?? 10;
  // Validate HERE, not only at exchange time in createToken — otherwise a
  // typo mints a poisoned setup key whose failure surfaces to the wrong
  // party (the remote agent, at /connect, as "Invalid request body").
  assertValidTokenOptions(scopes, rateLimit);
  const token = generateToken('gsk_setup_');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString(); // 5 min

  const info: TokenInfo = {
    token,
    clientId: opts.clientId || `remote-${Date.now()}`,
    type: 'setup',
    scopes,
    domains: opts.domains,
    tabPolicy: opts.tabPolicy || 'own-only',
    rateLimit,
    expiresAt,
    createdAt: now.toISOString(),
    usesRemaining: 1,
    commandCount: 0,
  };

  tokens.set(token, info);
  return info;
}

/**
 * Exchange a setup key for a session token.
 * Idempotent: if the same key is presented again and the prior session
 * has 0 commands, returns the same session token (handles tunnel drops).
 */
export function exchangeSetupKey(setupKey: string, sessionExpiresSeconds?: number | null): TokenInfo | null {
  const setup = tokens.get(setupKey);
  if (!setup) return null;
  if (setup.type !== 'setup') return null;

  // Check expiry
  if (setup.expiresAt && new Date(setup.expiresAt) < new Date()) {
    tokens.delete(setupKey);
    return null;
  }

  // Idempotent: if already exchanged but session has 0 commands, return existing
  if (setup.usesRemaining === 0) {
    if (setup.issuedSessionToken) {
      const existing = tokens.get(setup.issuedSessionToken);
      if (existing && existing.commandCount === 0) {
        return existing;
      }
    }
    return null; // Session used or gone — can't re-issue
  }

  // Consume the setup key
  setup.usesRemaining = 0;

  // Create the session token
  const session = createToken({
    clientId: setup.clientId,
    scopes: setup.scopes,
    domains: setup.domains,
    tabPolicy: setup.tabPolicy,
    rateLimit: setup.rateLimit,
    expiresSeconds: sessionExpiresSeconds ?? 86400,
  });

  // Track which session token was issued from this setup key
  setup.issuedSessionToken = session.token;

  return session;
}

/**
 * Validate a token and return its info if valid.
 * Returns null for expired, revoked, or unknown tokens.
 * Root token returns a special root info object.
 */
export function validateToken(token: string): TokenInfo | null {
  if (isRootToken(token)) {
    return {
      token: rootToken,
      clientId: 'root',
      type: 'session',
      scopes: ['read', 'write', 'admin', 'meta', 'control'],
      tabPolicy: 'shared',
      rateLimit: 0, // unlimited
      expiresAt: null,
      createdAt: '',
      commandCount: 0,
    };
  }

  const info = tokens.get(token);
  if (!info) return null;

  // Check expiry
  if (info.expiresAt && new Date(info.expiresAt) < new Date()) {
    tokens.delete(token);
    return null;
  }

  return info;
}

/**
 * Check if a command is allowed by the token's scopes.
 * The `chain` command is special: it's allowed if the token has meta scope,
 * but each subcommand within chain must be individually scope-checked.
 */
export function checkScope(info: TokenInfo, command: string): boolean {
  if (info.clientId === 'root') return true;

  // Special case: chain is in SCOPE_META but requires that the caller
  // has scopes covering ALL subcommands. The actual subcommand check
  // happens at dispatch time, not here.
  if (command === 'chain' && info.scopes.includes('meta')) return true;

  for (const scope of info.scopes) {
    if (SCOPE_MAP[scope]?.has(command)) return true;
  }

  return false;
}

/**
 * Check if a URL is allowed by the token's domain restrictions.
 * Returns true if no domain restrictions, or if the URL matches any glob.
 */
export function checkDomain(info: TokenInfo, url: string): boolean {
  if (info.clientId === 'root') return true;
  if (!info.domains || info.domains.length === 0) return true;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    for (const pattern of info.domains) {
      if (matchDomainGlob(hostname, pattern)) return true;
    }

    return false;
  } catch {
    return false; // Invalid URL — deny
  }
}

function matchDomainGlob(hostname: string, pattern: string): boolean {
  // Simple glob: *.example.com matches sub.example.com
  // Exact: example.com matches example.com only
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // .example.com
    return hostname.endsWith(suffix) || hostname === pattern.slice(2);
  }
  return hostname === pattern;
}

/**
 * Check rate limit for a client. Returns { allowed, retryAfterMs? }.
 */
export function checkRate(info: TokenInfo): { allowed: boolean; retryAfterMs?: number } {
  if (info.clientId === 'root') return { allowed: true };
  return checkRateLimit(info.clientId, info.rateLimit);
}

/**
 * Record that a command was executed by this token.
 */
export function recordCommand(token: string): void {
  const info = tokens.get(token);
  if (info) info.commandCount++;
}

/**
 * Revoke ALL tokens for a client ID — the session token and every setup key,
 * spent or unspent. Deleting only the first match left two holes: a spent
 * setup key (kept for idempotent re-exchange) shadowed the session token, so
 * revoke reported success while the live session survived; and an unspent
 * setup key surviving revoke let a "revoked" agent POST /connect into a
 * fresh session. Returns the number of tokens deleted (0 = nothing found).
 */
export function revokeToken(clientId: string): number {
  let deleted = 0;
  for (const [token, info] of tokens) {
    if (info.clientId === clientId) {
      tokens.delete(token); // Map tolerates delete during for...of iteration
      deleted++;
    }
  }
  if (deleted > 0) rateBuckets.delete(clientId);
  return deleted;
}

/**
 * Revoke the PENDING (unspent) setup keys for a client, leaving any live
 * session AND spent keys untouched. A re-pair always drops pending keys so a
 * superseded broad key can never be exchanged — this closes the shadow-key
 * hole (a reducing re-pair before the agent connects would otherwise leave the
 * old broad key live) without touching the spent key that #2646 keeps for
 * idempotent re-exchange on a tunnel drop. Returns the number deleted.
 */
export function revokeSetupKeys(clientId: string): number {
  let deleted = 0;
  for (const [token, info] of tokens) {
    // usesRemaining !== 0 = still exchangeable (pending). Spent keys (0) are
    // harmless: their session is either kept here or revoked on the reduce path.
    if (info.clientId === clientId && info.type === 'setup' && info.usesRemaining !== 0) {
      tokens.delete(token);
      deleted++;
    }
  }
  return deleted;
}

/** The live (non-expired) session token for a client, if any. */
export function getClientSession(clientId: string): TokenInfo | null {
  const now = new Date();
  for (const info of tokens.values()) {
    if (info.clientId !== clientId || info.type !== 'session') continue;
    if (info.expiresAt && new Date(info.expiresAt) < now) continue;
    return info;
  }
  return null;
}

/** The effective grant a re-pair is requesting, resolved to concrete values. */
export interface ResolvedGrant {
  scopes: ScopeCategory[];
  domains?: string[];
  rateLimit: number;
  tabPolicy: 'own-only' | 'shared';
}

/**
 * Does `grant` remove any capability the live `prior` session holds? Drives the
 * /pair supersede decision: a reducing re-pair revokes the old session
 * immediately (the narrowing must not wait for a reconnect that may never
 * happen); a broaden/refresh leaves it working (no outage). Fails toward
 * revocation on an unprovable domain superset — a spurious revoke costs one
 * reconnect, a missed one leaves wide access live.
 */
export function grantReducesAccess(prior: TokenInfo, grant: ResolvedGrant): boolean {
  return scopesReduced(prior.scopes, grant.scopes)
    || domainsReduced(prior.domains, grant.domains)
    || rateReduced(prior.rateLimit, grant.rateLimit)
    || tabPolicyReduced(prior.tabPolicy, grant.tabPolicy);
}

function scopesReduced(prior: ScopeCategory[], next: ScopeCategory[]): boolean {
  // Any scope the prior held that the new grant omits (also catches dropping 'control').
  return prior.some(s => !next.includes(s));
}

function domainsReduced(prior: string[] | undefined, next: string[] | undefined): boolean {
  const priorUnrestricted = !prior || prior.length === 0;
  const nextUnrestricted = !next || next.length === 0;
  if (priorUnrestricted) return !nextUnrestricted; // universe → restricted = reduce
  if (nextUnrestricted) return false;              // restricted → universe = broaden
  // Both restricted: reduced if any host the prior allowlist admits is no longer
  // admitted by the new one. Approximate over patterns — prior is covered iff
  // every prior pattern is covered by some next pattern; anything unprovable
  // counts as reduced (fail toward revocation).
  return prior!.some(p => !next!.some(n => domainGlobCovers(n, p)));
}

/** Does allowlist pattern `wide` admit every host that `narrow` admits? Mirrors
 * matchDomainGlob's suffix/exact rules. */
function domainGlobCovers(wide: string, narrow: string): boolean {
  if (wide === narrow) return true;
  const wideGlob = wide.startsWith('*.');
  if (wideGlob) {
    const wideSuffix = wide.slice(1); // ".example.com"
    const wideApex = wide.slice(2);   // "example.com"
    if (!narrow.startsWith('*.')) {
      // narrow is an exact host; covered iff the wide glob matches it.
      return narrow === wideApex || narrow.endsWith(wideSuffix);
    }
    // narrow is also a glob; its apex must fall under the wide suffix.
    const narrowApex = narrow.slice(2);
    return narrowApex === wideApex || narrowApex.endsWith(wideSuffix);
  }
  // wide is an exact host: covers only the identical host (handled by === above).
  return false;
}

function rateReduced(prior: number, next: number): boolean {
  const priorUnlimited = prior <= 0; // 0 = unlimited
  const nextUnlimited = next <= 0;
  if (priorUnlimited) return !nextUnlimited; // unlimited → capped = reduce
  if (nextUnlimited) return false;           // capped → unlimited = broaden
  return next < prior;                       // both capped: a lower cap = reduce
}

function tabPolicyReduced(prior: 'own-only' | 'shared', next: 'own-only' | 'shared'): boolean {
  return prior === 'shared' && next === 'own-only';
}

/**
 * Rotate the root token. All scoped tokens are invalidated.
 * Returns the new root token.
 */
export function rotateRoot(): string {
  rootToken = crypto.randomUUID();
  tokens.clear();
  rateBuckets.clear();
  return rootToken;
}

/**
 * List all active (non-expired) scoped tokens.
 * With includeSetup, unexchanged ("pending") setup keys are listed too —
 * they are live grants an operator must be able to see and revoke. Spent
 * keys stay hidden: they are re-exchange bookkeeping for a session that is
 * already listed.
 */
export function listTokens(opts?: { includeSetup?: boolean }): TokenInfo[] {
  const now = new Date();
  const result: TokenInfo[] = [];

  for (const [token, info] of tokens) {
    if (info.expiresAt && new Date(info.expiresAt) < now) {
      tokens.delete(token);
      continue;
    }
    if (info.type === 'session') {
      result.push(info);
    } else if (opts?.includeSetup && info.type === 'setup' && info.usesRemaining !== 0) {
      result.push(info);
    }
  }

  return result;
}

/**
 * Serialize the token registry for state file persistence.
 */
export function serializeRegistry(): TokenRegistryState {
  const agents: TokenRegistryState['agents'] = {};

  for (const info of tokens.values()) {
    if (info.type === 'session') {
      const { commandCount, ...rest } = info;
      agents[info.clientId] = rest;
    }
  }

  return { agents };
}

/**
 * Restore the token registry from persisted state file data.
 */
export function restoreRegistry(state: TokenRegistryState): void {
  tokens.clear();
  const now = new Date();

  for (const [clientId, data] of Object.entries(state.agents)) {
    // Skip expired tokens
    if (data.expiresAt && new Date(data.expiresAt) < now) continue;

    // Skip-and-log rather than throw: a hand-edited or corrupt state file must
    // not brick boot or drop every later valid session. A persisted clientId
    // 'root' would otherwise inject a token that bypasses all scope checks.
    try {
      assertValidClientId(clientId);
    } catch (err) {
      console.warn(`[browse] restoreRegistry: skipping invalid clientId ${JSON.stringify(clientId)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    tokens.set(data.token, {
      ...data,
      clientId,
      commandCount: 0,
    });
  }
}

// ─── Connect endpoint rate limiter (flood protection) ─────
//
// Global-only cap. Setup keys are 24 random bytes (unbruteforceable), so
// rate limiting here is not about preventing key guessing. It caps
// bandwidth, CPU, and log-flood damage from someone who discovered the
// ngrok URL. A legitimate pair-agent session hits /connect once, so
// 300/min is 60x that pattern and never hit accidentally. Per-IP tracking
// was considered and rejected: adds a bounded Map + LRU for defense
// already adequate at the global layer.

let connectAttempts: { ts: number }[] = [];
const CONNECT_RATE_LIMIT = 300; // attempts per minute (~5/sec average)
const CONNECT_WINDOW_MS = 60000;

export function checkConnectRateLimit(): boolean {
  const now = Date.now();
  connectAttempts = connectAttempts.filter(a => now - a.ts < CONNECT_WINDOW_MS);
  if (connectAttempts.length >= CONNECT_RATE_LIMIT) return false;
  connectAttempts.push({ ts: now });
  return true;
}

// Test-only reset.
export function __resetConnectRateLimit(): void {
  connectAttempts = [];
}

// Test-only reset. Zeroes the registry so a subsequent initRegistry call
// always succeeds. Mirrors __resetConnectRateLimit. Needed by tests that
// follow the rotateRoot() pattern — rotateRoot leaves rootToken non-empty,
// which would otherwise trip the initRegistry mismatch guard.
export function __resetRegistry(): void {
  rootToken = '';
  tokens.clear();
  rateBuckets.clear();
}
