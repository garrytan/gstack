/**
 * Sourcebot adapter — real HTTP + config integration
 * (github.com/sourcebot-dev/sourcebot, YC F2025).
 *
 * Sourcebot is a self-hosted server that indexes repos declared in its
 * config.json and serves regex code search over `POST /api/search` (zoekt). So
 * the runtime drives it with plain HTTP + a config-file edit — no MCP:
 *   - register_source: add `{ "type": "git", "url": "file:///abs/path" }` to the
 *     server's config.json (it re-indexes automatically on config change).
 *   - refresh: Sourcebot re-indexes on config change and on reindexIntervalMs;
 *     there is no per-source trigger endpoint, so refresh reports current status.
 *   - search: POST /api/search with a regex query, map files[] to hits.
 *   - status: liveness GET against the base URL.
 * Declines the document ops (add/delete/export) — it is a whole-repo search index.
 *
 * Egress: a loopback base URL means the index runs on this machine, so no repo
 * content leaves it (local=true). A non-loopback base URL means content reaches
 * another host, so egress consent is required (local=false).
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import {
  assertCapability,
  assertEgressConsent,
  assertRequiredCapabilities,
  CodeProviderError,
  type CodeProvider,
  type CodeProviderCapability,
  type CodeSearchHit,
  type OpOptions,
  type RepoRef,
  type SearchOptions,
  type SourceRef,
  type SourceStatus,
} from "./contract";

const CAPABILITIES: CodeProviderCapability[] = ["register_source", "refresh", "search", "status"];
const DEFAULT_URL = "http://localhost:3000";
const DEFAULT_TIMEOUT_MS = 30_000;

type FetchLike = typeof globalThis.fetch;

export interface SourcebotOptions {
  /** Base URL of the Sourcebot server. Defaults to SOURCEBOT_URL or http://localhost:3000. */
  baseUrl?: string;
  /** Path to the server's config.json (for register_source). Defaults to SOURCEBOT_CONFIG. */
  configPath?: string;
  /**
   * API key for the Sourcebot REST API. Defaults to SOURCEBOT_API_KEY. Sourcebot
   * v5 gates `/api/search` behind auth (`Authorization: Bearer <key>`); without
   * it, `search` gets HTTP 401. Generate one in Settings -> API Keys.
   */
  apiKey?: string;
  /** Injectable fetch for tests. */
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

export class SourcebotProvider implements CodeProvider {
  readonly id = "sourcebot" as const;
  readonly label = "Sourcebot";
  readonly capabilities = new Set<CodeProviderCapability>(CAPABILITIES);
  readonly local: boolean;
  readonly #baseUrl: string;
  readonly #configPath?: string;
  readonly #apiKey?: string;
  readonly #fetch: FetchLike;

  constructor(opts: SourcebotOptions = {}) {
    const env = opts.env ?? process.env;
    this.#baseUrl = (opts.baseUrl ?? env.SOURCEBOT_URL ?? DEFAULT_URL).replace(/\/$/, "");
    this.#configPath = opts.configPath ?? env.SOURCEBOT_CONFIG;
    this.#apiKey = opts.apiKey ?? env.SOURCEBOT_API_KEY;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.local = isLoopback(this.#baseUrl);
    assertRequiredCapabilities(this.id, this.capabilities);
  }

  #authHeaders(): Record<string, string> {
    return this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {};
  }

  has(capability: CodeProviderCapability): boolean {
    return this.capabilities.has(capability);
  }

  /** Add the repo as a local `git` connection in Sourcebot's config.json. */
  async registerSource(repo: RepoRef, opts: OpOptions = {}): Promise<SourceStatus> {
    assertEgressConsent(this, opts); // no-op when the server is loopback (local)
    if (!this.#configPath) {
      throw new CodeProviderError(
        "PROVIDER_UNAVAILABLE",
        "set SOURCEBOT_CONFIG to the server's config.json path to register sources",
        this.id,
      );
    }
    let config: { connections?: Record<string, unknown> };
    try {
      config = existsSync(this.#configPath)
        ? (JSON.parse(readFileSync(this.#configPath, "utf-8")) as typeof config)
        : {};
    } catch (err) {
      throw new CodeProviderError("PROVIDER_ERROR", `unreadable Sourcebot config: ${(err as Error).message}`, this.id);
    }
    config.connections = config.connections ?? {};
    config.connections[repo.id] = { type: "git", url: `file://${repo.path}` };
    // Atomic write so a running Sourcebot never reads a half-written config.
    const tmp = `${this.#configPath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
    renameSync(tmp, this.#configPath);
    return { id: repo.id, state: "registered", detail: "Sourcebot re-indexes on config change" };
  }

  /** Sourcebot re-indexes automatically; report current liveness. */
  async refresh(source: SourceRef, opts: OpOptions = {}): Promise<SourceStatus> {
    const live = await this.status(source, opts);
    return { ...live, detail: "Sourcebot re-indexes automatically (config change + reindexIntervalMs)" };
  }

  async search(query: string, opts: SearchOptions = {}): Promise<CodeSearchHit[]> {
    if (!query.trim()) return [];
    const body = {
      query: opts.source ? `repo:${opts.source} ${query}` : query,
      matches: opts.limit ?? 20,
      isRegexEnabled: true,
      isCaseSensitivityEnabled: false,
    };
    const payload = await this.#post("/api/search", body, opts.timeout ?? DEFAULT_TIMEOUT_MS);
    return parseSourcebotSearch(payload, opts.limit ?? 20);
  }

  async status(_source?: SourceRef, opts: OpOptions = {}): Promise<SourceStatus> {
    // `redirect: manual` so an auth-gated server (307 -> /login) reads as
    // not-usable instead of following to a 200 and falsely reporting "ready".
    try {
      const res = await this.#fetchWithTimeout(
        `${this.#baseUrl}/api/search`,
        { method: "POST", headers: { "Content-Type": "application/json", ...this.#authHeaders() }, body: JSON.stringify({ query: "sourcebot", matches: 1, isRegexEnabled: false }), redirect: "manual" },
        opts.timeout ?? DEFAULT_TIMEOUT_MS,
      );
      if (res.status === 401 || res.status === 403) {
        return { id: "*", state: "unknown", partial: true, detail: "reachable but not authenticated (set SOURCEBOT_API_KEY)" };
      }
      return { id: "*", state: res.ok ? "ready" : "unknown", partial: true, detail: `HTTP ${res.status}` };
    } catch {
      return { id: "*", state: "unknown", partial: true, detail: `unreachable at ${this.#baseUrl}` };
    }
  }

  async #post(path: string, body: unknown, timeout: number): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetchWithTimeout(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...this.#authHeaders() },
        body: JSON.stringify(body),
      }, timeout);
    } catch (err) {
      throw new CodeProviderError("PROVIDER_UNAVAILABLE", `Sourcebot unreachable at ${this.#baseUrl}: ${(err as Error).message}`, this.id);
    }
    if (res.status === 401 || res.status === 403) {
      throw new CodeProviderError("PROVIDER_UNAVAILABLE", `Sourcebot requires authentication; set SOURCEBOT_API_KEY (HTTP ${res.status})`, this.id);
    }
    if (!res.ok) throw new CodeProviderError("PROVIDER_ERROR", `Sourcebot ${path} returned HTTP ${res.status}`, this.id);
    try {
      return await res.json();
    } catch (err) {
      throw new CodeProviderError("PROVIDER_ERROR", `Sourcebot returned non-JSON: ${(err as Error).message}`, this.id);
    }
  }

  async #fetchWithTimeout(url: string, init: RequestInit, timeout: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw new CodeProviderError("PROVIDER_TIMEOUT", "Sourcebot request timed out", this.id);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface SourcebotMatchRange { start?: { lineNumber?: number } }
interface SourcebotChunk { content?: string; matchRanges?: SourcebotMatchRange[] }
interface SourcebotFile { fileName?: { text?: string }; repository?: string; chunks?: SourcebotChunk[] }

/**
 * Map a `POST /api/search` response `{ files: [...] }` to hits: one hit per file,
 * ref = file path, snippet = first matching chunk, kind = "file". Tolerant of a
 * missing/garbage payload (returns []). Exported for deterministic testing.
 */
export function parseSourcebotSearch(payload: unknown, limit: number): CodeSearchHit[] {
  const files = (payload as { files?: unknown })?.files;
  if (!Array.isArray(files)) return [];
  const hits: CodeSearchHit[] = [];
  for (const f of files as SourcebotFile[]) {
    const ref = f?.fileName?.text;
    if (typeof ref !== "string") continue;
    const chunk = f.chunks?.[0];
    const line = chunk?.matchRanges?.[0]?.start?.lineNumber;
    hits.push({
      ref: typeof line === "number" ? `${ref}:${line}` : ref,
      snippet: typeof chunk?.content === "string" ? chunk.content.trim() : undefined,
      kind: "file",
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
