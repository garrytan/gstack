/**
 * Token manager — acquire a bearer token via a frontend adapter's HTTP auth
 * state machine, then cache it keyed by (realm, userName) so repeat sessions and
 * realm-sharing envs skip re-acquisition until expiry.
 *
 * The engine is frontend-agnostic: it drives the adapter's request builders and
 * response classifiers (frontend-adapter.ts) and never hardcodes an app's auth
 * shape. Credentials and TOTP are pulled through injectable providers so the
 * state machine is unit-testable without live calls or real secrets.
 *
 * SECURITY: password / OTP / bearer are never logged. Callers get the validated
 * auth object back; what they print is their responsibility.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type {
  Creds,
  EnvConfig,
  FrontendAdapter,
  OpItemRef,
} from './frontend-adapter';
import { resolveEnv } from './frontend-adapter';

export interface AcquiredToken {
  /** The adapter-validated auth object (e.g. { bearerToken, roles }). */
  auth: unknown;
  realm: string;
  appOrigin: string;
  env: string;
  userName: string;
  /** Epoch ms. Prefer the JWT `exp` claim; fall back to acquiredAt + defaultTtlMs. */
  acquiredAt: number;
  expiresAt: number;
}

/** Resolve username/password for an env. Default impl reads 1Password via `op`. */
export type CredsProvider = (
  env: EnvConfig & { name: string; realm: string },
) => Promise<Creds> | Creds;

/** Resolve a fresh TOTP for an env. Called late to maximize the 30s window. */
export type TotpProvider = (
  env: EnvConfig & { name: string; realm: string },
) => Promise<string> | string;

export interface AcquireDeps {
  credsProvider?: CredsProvider;
  totpProvider?: TotpProvider;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

class TokenError extends Error {}

function op(args: string[]): string {
  return execFileSync('op', args, { encoding: 'utf8' }).trim();
}

function requireOpItem(env: EnvConfig & { name: string }): OpItemRef {
  if (!env.opItem) {
    throw new TokenError(
      `env "${env.name}" declares no \`opItem\` and no credsProvider was supplied; ` +
        `cannot resolve credentials`,
    );
  }
  return env.opItem;
}

/** Default 1Password-backed credential provider. */
export const defaultCredsProvider: CredsProvider = (env) => {
  const item = requireOpItem(env);
  const field = (label: string) =>
    op(['item', 'get', item.item, '--vault', item.vault, '--fields', `label=${label}`, '--reveal']);
  return { userName: field('username'), password: field('password') };
};

/** Default 1Password-backed TOTP provider. */
export const defaultTotpProvider: TotpProvider = (env) => {
  const item = requireOpItem(env);
  return op(['item', 'get', item.item, '--vault', item.vault, '--otp']);
};

/**
 * Decode the `exp` claim (epoch ms) from a JWT, or null if absent/undecodable.
 * Best-effort: a token without a parseable exp is not an error — callers fall
 * back to a configured TTL (KTD6: do not assume a JWT exp claim exists).
 */
export function decodeJwtExpMs(bearer: string): number | null {
  const parts = bearer.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (res.status >= 500) {
    throw new TokenError(`auth endpoint returned ${res.status}`);
  }
  return data;
}

/**
 * Run the adapter's auth state machine and return a validated, expiry-stamped
 * token. Does NOT touch the cache — see acquireOrLoad (U2) for the cached path.
 */
export async function acquireToken(
  adapter: FrontendAdapter,
  envName: string,
  deps: AcquireDeps = {},
): Promise<AcquiredToken> {
  const credsProvider = deps.credsProvider ?? defaultCredsProvider;
  const totpProvider = deps.totpProvider ?? defaultTotpProvider;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  const env = resolveEnv(adapter, envName);
  const creds = await credsProvider(env);
  const url = adapter.auth.endpoint(env.apiOrigin);

  const first = await postJson(fetchImpl, url, adapter.auth.firstStep(creds));
  const firstOutcome = adapter.auth.afterFirstStep(first);

  let authObj: unknown;
  if ('error' in firstOutcome) {
    throw new TokenError(`auth failed at step 1 for "${envName}": ${firstOutcome.error}`);
  } else if ('done' in firstOutcome) {
    authObj = firstOutcome.done;
  } else {
    // need a second factor
    if (!adapter.auth.secondStep || !adapter.auth.afterSecondStep) {
      throw new TokenError(
        `adapter requires a second factor but defines no secondStep/afterSecondStep`,
      );
    }
    const totp = await totpProvider(env);
    const second = await postJson(fetchImpl, url, adapter.auth.secondStep(creds, totp));
    const secondOutcome = adapter.auth.afterSecondStep(second);
    if ('error' in secondOutcome) {
      throw new TokenError(`auth failed at step 2 for "${envName}": ${secondOutcome.error}`);
    }
    authObj = secondOutcome.done;
  }

  adapter.token.validate(authObj);

  const acquiredAt = now();
  const bearer = adapter.token.bearer(authObj);
  const jwtExp = decodeJwtExpMs(bearer);
  const ttl = adapter.defaultTtlMs ?? 8 * 60 * 60 * 1000;
  const expiresAt = jwtExp ?? acquiredAt + ttl;

  return {
    auth: authObj,
    realm: env.realm,
    appOrigin: env.appOrigin,
    env: envName,
    userName: creds.userName,
    acquiredAt,
    expiresAt,
  };
}

// ─── Cache (U2): keyed by (realm, userName), stored per-frontend-repo ─────────

export const CACHE_DIRNAME = '.auth';

/** Clock skew: treat a token expiring within this window as already stale. */
const EXPIRY_SKEW_MS = 60_000;

export interface CacheOptions {
  /** Frontend repo root; cache lives at <root>/.auth/. Defaults to cwd. */
  frontendRoot?: string;
  now?: () => number;
}

/** Filesystem-safe fragment (no separators / traversal). */
function safeFragment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function cacheDir(opts: CacheOptions): string {
  return path.join(opts.frontendRoot ?? process.cwd(), CACHE_DIRNAME);
}

export function cacheFilePath(opts: CacheOptions, realm: string, userName: string): string {
  return path.join(cacheDir(opts), `${safeFragment(realm)}-${safeFragment(userName)}.json`);
}

function isFresh(token: AcquiredToken, now: number): boolean {
  return typeof token.expiresAt === 'number' && now < token.expiresAt - EXPIRY_SKEW_MS;
}

/**
 * Return the freshest non-expired cached token for a realm WITHOUT resolving
 * credentials (so the cached path triggers zero interactive prompts). Files are
 * namespaced by userName; a single dev identity per realm yields one match.
 * Returns null on miss / all-expired / unreadable.
 */
export function readCachedToken(opts: CacheOptions, realm: string): AcquiredToken | null {
  const now = (opts.now ?? Date.now)();
  const dir = cacheDir(opts);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = `${safeFragment(realm)}-`;
  const candidates: AcquiredToken[] = [];
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    try {
      const token = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as AcquiredToken;
      if (token.realm === realm && isFresh(token, now)) candidates.push(token);
    } catch {
      // ignore corrupt / partially written entries
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.expiresAt - a.expiresAt);
  return candidates[0];
}

/** Persist a token as chmod-600 JSON under the frontend repo's .auth/ dir. */
export function writeCachedToken(opts: CacheOptions, token: AcquiredToken): string {
  const dir = cacheDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  const file = cacheFilePath(opts, token.realm, token.userName);
  fs.writeFileSync(file, JSON.stringify(token, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export interface AcquireOrLoadDeps extends AcquireDeps, CacheOptions {
  /** Force re-acquisition even on a cache hit (e.g. after a 401). */
  forceRefresh?: boolean;
}

/**
 * Return a cached-or-freshly-acquired token for an env. On a warm cache this
 * path performs no network call and no credential prompt (R1/R3). A cold cache,
 * expired entry, or `forceRefresh` acquires and rewrites the cache.
 */
export async function acquireOrLoad(
  adapter: FrontendAdapter,
  envName: string,
  deps: AcquireOrLoadDeps = {},
): Promise<{ token: AcquiredToken; cached: boolean }> {
  const realm = adapter.realm(envName);
  if (!deps.forceRefresh) {
    const hit = readCachedToken(deps, realm);
    if (hit) return { token: hit, cached: true };
  }
  const token = await acquireToken(adapter, envName, deps);
  writeCachedToken(deps, token);
  return { token, cached: false };
}
