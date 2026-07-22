/**
 * GBrain adapter — full contract fit over the existing gbrain CLI chokepoint.
 *
 * Reuses lib/gbrain-exec.ts (spawnGbrain, seeded DATABASE_URL) and
 * lib/gbrain-sources.ts (ensureSourceRegistered, probeSource, sourcePageCount)
 * rather than re-issuing raw commands, so the DATABASE_URL / GBRAIN_HOME /
 * Windows-shim guarantees carry over unchanged. GBrain's native primitive is
 * document-by-slug (put/delete/get/export) PLUS a repo axis (sources add/sync),
 * so it advertises all seven capabilities.
 */

import { spawnGbrain } from "../gbrain-exec";
import { ensureSourceRegistered, probeSource, sourcePageCount } from "../gbrain-sources";
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

const CAPABILITIES: CodeProviderCapability[] = [
  "register_source",
  "refresh",
  "search",
  "status",
  "add",
  "delete",
  "export",
];

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Parse `gbrain search` text output (`[score] slug -- snippet`) into hits.
 * gbrain's search prints text, not JSON (verified in
 * lib/gstack-decision-semantic.ts). Exported for deterministic unit testing.
 */
export function parseGbrainSearch(stdout: string, minScore: number, limit: number): CodeSearchHit[] {
  const hits: CodeSearchHit[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\[([\d.]+)\]\s+(\S+)\s+--\s+(.*)$/);
    if (!m) continue;
    const score = parseFloat(m[1]);
    if (!Number.isFinite(score) || score < minScore) continue;
    hits.push({ ref: m[2], score, snippet: m[3].trim(), kind: "document" });
  }
  return hits.slice(0, limit);
}

export class GbrainProvider implements CodeProvider {
  readonly id = "gbrain" as const;
  readonly label = "GBrain";
  readonly capabilities = new Set<CodeProviderCapability>(CAPABILITIES);
  /** GBrain federates into a (possibly remote) DB, so content can leave the machine. */
  readonly local = false;

  constructor() {
    assertRequiredCapabilities(this.id, this.capabilities);
  }

  has(capability: CodeProviderCapability): boolean {
    return this.capabilities.has(capability);
  }

  async registerSource(repo: RepoRef, opts: OpOptions = {}): Promise<SourceStatus> {
    assertEgressConsent(this, opts);
    try {
      const result = await ensureSourceRegistered(repo.id, repo.path, {
        federated: true,
        env: opts.env,
      });
      return {
        id: repo.id,
        state: result.state.status === "match" ? "registered" : "unknown",
        detail: result.changed ? "registered" : "already registered",
      };
    } catch (err) {
      throw this.#wrap(err);
    }
  }

  async refresh(source: SourceRef, opts: OpOptions = {}): Promise<SourceStatus> {
    assertEgressConsent(this, opts);
    this.#assertOk(spawnGbrain(["sync", "--strategy", "code", "--source", source.id], {
      baseEnv: opts.env,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    }));
    return this.status(source, opts);
  }

  async search(query: string, opts: SearchOptions = {}): Promise<CodeSearchHit[]> {
    if (!query.trim()) return [];
    const args = ["search", query];
    if (opts.source) args.push("--source", opts.source);
    const r = spawnGbrain(args, { baseEnv: opts.env, timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS });
    this.#assertOk(r);
    return parseGbrainSearch(r.stdout || "", opts.minScore ?? 0.1, opts.limit ?? 10);
  }

  async status(source?: SourceRef, opts: OpOptions = {}): Promise<SourceStatus> {
    if (!source) {
      // No source given: liveness probe. `sources list` reachable = ready.
      this.#assertOk(spawnGbrain(["sources", "list", "--json"], {
        baseEnv: opts.env,
        timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      }));
      return { id: "*", state: "ready" };
    }
    try {
      const probed = probeSource(source.id, opts.env);
      if (probed.status === "absent") return { id: source.id, state: "absent" };
      const count = sourcePageCount(source.id, opts.env);
      return {
        id: source.id,
        state: "ready",
        itemCount: count ?? undefined,
        detail: probed.registered_path,
      };
    } catch (err) {
      throw this.#wrap(err);
    }
  }

  async add(doc: { slug: string; body: string }, opts: OpOptions = {}): Promise<SourceStatus> {
    assertCapability(this, "add");
    assertEgressConsent(this, opts);
    const r = spawnGbrain(["put", doc.slug, "--body", doc.body], {
      baseEnv: opts.env,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    });
    this.#assertOk(r);
    return { id: doc.slug, state: "ready" };
  }

  async delete(slug: string, opts: OpOptions = {}): Promise<SourceStatus> {
    assertCapability(this, "delete");
    this.#assertOk(spawnGbrain(["delete", slug, "--yes"], {
      baseEnv: opts.env,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    }));
    return { id: slug, state: "absent" };
  }

  async export(source: SourceRef, opts: OpOptions = {}): Promise<string> {
    assertCapability(this, "export");
    const r = spawnGbrain(["export", "--source", source.id], {
      baseEnv: opts.env,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    });
    this.#assertOk(r);
    return r.stdout || "";
  }

  /**
   * Throw a typed failure unless the spawn succeeded. Distinguishes a missing
   * CLI (ENOENT → PROVIDER_UNAVAILABLE, the degrade signal) from a timeout
   * (ETIMEDOUT/SIGTERM, status=null) and a real non-zero exit.
   */
  #assertOk(r: {
    status: number | null;
    stderr?: string;
    error?: Error & { code?: string };
    signal?: NodeJS.Signals | null;
  }): void {
    if (r.status === 0) return;
    const stderr = (r.stderr || "").trim();
    if (r.error?.code === "ENOENT" || /command not found/.test(stderr)) {
      throw new CodeProviderError("PROVIDER_UNAVAILABLE", "gbrain CLI not on PATH", this.id);
    }
    if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM") {
      throw new CodeProviderError("PROVIDER_TIMEOUT", "gbrain timed out", this.id);
    }
    if (/not configured|Cannot connect to database|config\.json/.test(stderr)) {
      throw new CodeProviderError("PROVIDER_UNAVAILABLE", stderr || "gbrain not configured", this.id);
    }
    throw new CodeProviderError("PROVIDER_ERROR", stderr || `gbrain exited ${r.status}`, this.id);
  }

  #wrap(err: unknown): CodeProviderError {
    if (err instanceof CodeProviderError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (/not on PATH|command not found/.test(message)) {
      return new CodeProviderError("PROVIDER_UNAVAILABLE", message, this.id);
    }
    if (/not configured/.test(message)) {
      return new CodeProviderError("PROVIDER_UNAVAILABLE", message, this.id);
    }
    return new CodeProviderError("PROVIDER_ERROR", message, this.id);
  }
}
