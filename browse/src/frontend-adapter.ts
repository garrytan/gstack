/**
 * Frontend adapter loader + validator (engine-side, frontend-agnostic).
 *
 * Each consuming frontend repo ships a `.agent-browser.config.mjs` (symlinked
 * from agent-tools/consumers/<repo>/agent-browser.config.mjs). It declares that
 * frontend's environments, realm groupings, auth HTTP state machine, and token
 * localStorage contract. The engine (token-manager, injection, entrypoint) reads
 * ONLY through this adapter — no xplor-specific knowledge lives in the engine.
 *
 * Adding a new frontend = author one config; zero engine change (R7).
 *
 * Schema (see docs/agent-browser-adapter.md for the authoring guide):
 *
 *   export default {
 *     envs: { <name>: { appOrigin, apiOrigin, opItem: { vault, item } } },
 *     realm(envName) -> realmId,
 *     auth: {
 *       endpoint(apiOrigin) -> url,
 *       firstStep(creds) -> requestBody,
 *       afterFirstStep(data) -> { need: 'totp' } | { done: authObj } | { error: msg },
 *       secondStep?(creds, totp) -> requestBody,
 *       afterSecondStep?(data) -> { done: authObj } | { error: msg },
 *     },
 *     token: {
 *       storageKey,               // localStorage key the SPA reads on boot
 *       validate(obj) -> void,    // throws if the auth object is unusable
 *       bearer(obj) -> string,    // extract the JWT for expiry decoding
 *     },
 *     defaultTtlMs?: number,      // fallback lifetime if the JWT has no exp claim
 *   }
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

export interface OpItemRef {
  vault: string;
  item: string;
}

export interface EnvConfig {
  appOrigin: string;
  apiOrigin: string;
  opItem?: OpItemRef;
}

export interface Creds {
  userName: string;
  password: string;
}

export type FirstStepOutcome =
  | { need: 'totp' }
  | { done: unknown }
  | { error: string };

export type SecondStepOutcome = { done: unknown } | { error: string };

export interface AuthContract {
  endpoint(apiOrigin: string): string;
  firstStep(creds: Creds): unknown;
  afterFirstStep(data: unknown): FirstStepOutcome;
  secondStep?(creds: Creds, totp: string): unknown;
  afterSecondStep?(data: unknown): SecondStepOutcome;
}

export interface TokenContract {
  storageKey: string;
  validate(obj: unknown): void;
  bearer(obj: unknown): string;
}

export interface FrontendAdapter {
  envs: Record<string, EnvConfig>;
  /**
   * Optional fallback for pattern-based env names the static `envs` map cannot
   * enumerate (e.g. xplor's open-ended `release-X-Y-Z` branches). Consulted only
   * when the name is absent from `envs`. Return null for an unknown name.
   */
  resolveEnvConfig?(envName: string): EnvConfig | null;
  realm(envName: string): string;
  auth: AuthContract;
  token: TokenContract;
  defaultTtlMs?: number;
}

export const ADAPTER_FILENAME = '.agent-browser.config.mjs';

class AdapterError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AdapterError(message);
}

/**
 * Validate a loaded module's default export against the adapter contract.
 * Fails fast with an actionable message rather than crashing later mid-flow.
 */
export function validateAdapter(mod: unknown, source: string): FrontendAdapter {
  const where = `adapter ${source}`;
  assert(mod && typeof mod === 'object', `${where}: config has no default export object`);
  const adapter = mod as Record<string, unknown>;

  assert(
    adapter.envs && typeof adapter.envs === 'object',
    `${where}: missing \`envs\` map (name -> { appOrigin, apiOrigin, opItem })`,
  );
  for (const [name, raw] of Object.entries(adapter.envs as Record<string, unknown>)) {
    const env = raw as Record<string, unknown>;
    assert(
      env && typeof env.appOrigin === 'string' && env.appOrigin.length > 0,
      `${where}: env "${name}" missing \`appOrigin\``,
    );
    assert(
      typeof env.apiOrigin === 'string' && env.apiOrigin.length > 0,
      `${where}: env "${name}" missing \`apiOrigin\``,
    );
  }

  assert(typeof adapter.realm === 'function', `${where}: missing \`realm(envName)\` function`);
  assert(
    adapter.resolveEnvConfig === undefined || typeof adapter.resolveEnvConfig === 'function',
    `${where}: \`resolveEnvConfig\` must be a function when present`,
  );

  const auth = adapter.auth as Record<string, unknown> | undefined;
  assert(auth && typeof auth === 'object', `${where}: missing \`auth\` block`);
  assert(typeof auth.endpoint === 'function', `${where}: missing \`auth.endpoint(apiOrigin)\``);
  assert(typeof auth.firstStep === 'function', `${where}: missing \`auth.firstStep(creds)\``);
  assert(
    typeof auth.afterFirstStep === 'function',
    `${where}: missing \`auth.afterFirstStep(data)\``,
  );

  const token = adapter.token as Record<string, unknown> | undefined;
  assert(token && typeof token === 'object', `${where}: missing \`token\` block`);
  assert(
    typeof token.storageKey === 'string' && token.storageKey.length > 0,
    `${where}: missing \`token.storageKey\``,
  );
  assert(typeof token.validate === 'function', `${where}: missing \`token.validate(obj)\``);
  assert(typeof token.bearer === 'function', `${where}: missing \`token.bearer(obj)\``);

  return adapter as unknown as FrontendAdapter;
}

/** Resolve the adapter file path for a frontend repo root. */
export function adapterPath(frontendRoot: string): string {
  return path.join(frontendRoot, ADAPTER_FILENAME);
}

/**
 * Load + validate a frontend's adapter config from its repo root.
 * `frontendRoot` defaults to the current working directory (the daemon runs
 * from the frontend's worktree). Throws an actionable error naming the expected
 * path when the file is missing.
 */
export async function loadAdapter(frontendRoot: string = process.cwd()): Promise<FrontendAdapter> {
  const file = adapterPath(frontendRoot);
  if (!fs.existsSync(file)) {
    throw new AdapterError(
      `No agent-browser adapter found at ${file}. ` +
        `Author one at agent-tools/consumers/<repo>/agent-browser.config.mjs ` +
        `(symlinked here as ${ADAPTER_FILENAME}). See docs/agent-browser-adapter.md.`,
    );
  }
  const mod = await import(pathToFileURL(file).href);
  return validateAdapter(mod.default ?? mod, file);
}

/** Resolve an env by name from an adapter, attaching its computed realm. */
export function resolveEnv(
  adapter: FrontendAdapter,
  envName: string,
): EnvConfig & { name: string; realm: string } {
  const env = adapter.envs[envName] ?? adapter.resolveEnvConfig?.(envName) ?? null;
  if (!env) {
    const valid = Object.keys(adapter.envs).join(', ');
    throw new AdapterError(`Unknown env "${envName}". Valid envs: ${valid}`);
  }
  return { ...env, name: envName, realm: adapter.realm(envName) };
}
