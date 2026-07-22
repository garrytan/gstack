/**
 * code-intelligence/contract — the OPTIONAL, repo-oriented provider contract.
 *
 * gstack does not maintain a home-grown indexer. It defines this small contract
 * and external providers (GBrain, Sourcebot, Graphify) implement it. The whole
 * contract is OPTIONAL: when no provider is available/consented,
 * `resolveCodeProvider()` returns null and callers degrade to grep / the
 * file-only decision store. Never a dependency, always an enhancement — the same
 * reliability contract as lib/gstack-decision-semantic.ts.
 *
 * Repo-oriented, not document-store (settled): register_source / refresh /
 * search / status are required; add / delete / export are optional capabilities
 * a provider MAY advertise. A document-CRUD-required contract would misrepresent
 * whole-repo code-search and code-graph tools. See
 * docs/designs/CODE_INTELLIGENCE_PROVIDER_CONTRACT.md.
 */

export type CodeProviderId = "gbrain" | "sourcebot" | "graphify";

export type CodeProviderCapability =
  | "register_source"
  | "refresh"
  | "search"
  | "status"
  | "add"
  | "delete"
  | "export";

export const REQUIRED_CAPABILITIES: readonly CodeProviderCapability[] = [
  "register_source",
  "refresh",
  "search",
  "status",
] as const;

export const OPTIONAL_CAPABILITIES: readonly CodeProviderCapability[] = [
  "add",
  "delete",
  "export",
] as const;

export interface RepoRef {
  /** Source id the provider registers this repo under. */
  id: string;
  /** Local worktree path. */
  path: string;
  /** Remote URL, when the provider clones/manages it. */
  remoteUrl?: string;
}

export interface SourceRef {
  id: string;
}

export interface SourceStatus {
  id: string;
  state: "registered" | "indexing" | "ready" | "absent" | "unknown";
  /** Pages / files / graph nodes, when the provider reports a count. */
  itemCount?: number;
  detail?: string;
  /** True when the provider only implements a partial status probe. */
  partial?: boolean;
}

export interface CodeSearchHit {
  /** Slug, file path, or symbol id — whatever the provider keys results on. */
  ref: string;
  score?: number;
  snippet?: string;
  kind?: "document" | "file" | "symbol" | "graph-node";
}

export interface OpOptions {
  /**
   * Env override for spawned processes. Production callers leave this unset;
   * tests inject a synthetic env (fake CLI on PATH). Matches the existing
   * gbrain helpers.
   */
  env?: NodeJS.ProcessEnv;
  /** Timeout in ms for the underlying op. */
  timeout?: number;
  /**
   * Explicit per-repo consent that repo content may leave the machine. Required
   * for non-local providers on register_source / refresh / add.
   */
  consented?: boolean;
}

export interface SearchOptions extends OpOptions {
  /** Restrict to a registered source. */
  source?: string;
  limit?: number;
  minScore?: number;
}

export interface CodeProvider {
  readonly id: CodeProviderId;
  readonly label: string;
  readonly capabilities: ReadonlySet<CodeProviderCapability>;
  /** True when no repo content leaves the machine (Graphify). */
  readonly local: boolean;

  has(capability: CodeProviderCapability): boolean;

  registerSource(repo: RepoRef, opts?: OpOptions): Promise<SourceStatus>;
  refresh(source: SourceRef, opts?: OpOptions): Promise<SourceStatus>;
  search(query: string, opts?: SearchOptions): Promise<CodeSearchHit[]>;
  status(source?: SourceRef, opts?: OpOptions): Promise<SourceStatus>;

  add?(doc: { slug: string; body: string }, opts?: OpOptions): Promise<SourceStatus>;
  delete?(slug: string, opts?: OpOptions): Promise<SourceStatus>;
  export?(source: SourceRef, opts?: OpOptions): Promise<string>;
}

export const CODE_PROVIDER_FAILURES = Object.freeze([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_NOT_CONSENTED",
  "CAPABILITY_UNSUPPORTED",
  "SOURCE_NOT_REGISTERED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_ERROR",
] as const);

export type CodeProviderFailure = (typeof CODE_PROVIDER_FAILURES)[number];

const FAILURE_SET = new Set<string>(CODE_PROVIDER_FAILURES);

/**
 * Typed provider failure. Mirrors runtime/context.js ContextError discipline:
 * the code set is closed and the constructor throws on an unknown code, so a
 * typo can never mint an untyped failure.
 */
export class CodeProviderError extends Error {
  readonly code: CodeProviderFailure;
  readonly providerId?: CodeProviderId;

  constructor(code: CodeProviderFailure, message: string, providerId?: CodeProviderId) {
    if (!FAILURE_SET.has(code)) throw new TypeError(`Unknown code-provider failure code: ${code}`);
    super(message);
    this.name = "CodeProviderError";
    this.code = code;
    this.providerId = providerId;
  }
}

/**
 * Enforce that a provider advertises every required capability. Called by each
 * adapter constructor so an incomplete provider fails fast, not at first search.
 */
export function assertRequiredCapabilities(
  id: CodeProviderId,
  capabilities: ReadonlySet<CodeProviderCapability>,
): void {
  const missing = REQUIRED_CAPABILITIES.filter((cap) => !capabilities.has(cap));
  if (missing.length) {
    throw new TypeError(`Code provider ${id} is missing required capabilities: ${missing.join(", ")}`);
  }
}

/**
 * Guard for optional ops: throw CAPABILITY_UNSUPPORTED (never a silent no-op)
 * when a provider is asked for a capability it does not advertise.
 */
export function assertCapability(provider: CodeProvider, capability: CodeProviderCapability): void {
  if (!provider.has(capability)) {
    throw new CodeProviderError(
      "CAPABILITY_UNSUPPORTED",
      `${provider.label} does not support "${capability}"`,
      provider.id,
    );
  }
}

/**
 * Repo-scoped egress consent gate. Non-local providers must not move repo
 * content off the machine without explicit per-repo consent. Local providers
 * (nothing leaves the machine) are exempt.
 */
export function assertEgressConsent(provider: CodeProvider, opts?: OpOptions): void {
  if (provider.local) return;
  if (opts?.consented === true) return;
  throw new CodeProviderError(
    "PROVIDER_NOT_CONSENTED",
    `${provider.label} would send repo content off this machine; per-repo indexing consent is required`,
    provider.id,
  );
}
