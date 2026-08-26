/**
 * GBrain adapter — full contract fit over the existing gbrain CLI chokepoint.
 *
 * Portions copyright (c) 2026 Sina Matian, time-attack/gstack (GStack 2), MIT.
 *
 * Reuses lib/gbrain-exec.ts (spawnGbrain, seeded DATABASE_URL) and
 * lib/gbrain-sources.ts (ensureSourceRegistered, probeSource, sourcePageCount)
 * rather than re-issuing raw commands, so the DATABASE_URL / GBRAIN_HOME /
 * Windows-shim guarantees carry over unchanged. GBrain's native primitive is
 * document-by-slug (put/delete/get/export) PLUS a repo axis (sources add/sync),
 * so it advertises all seven capabilities.
 */

import { spawnSync } from "child_process";
import { sha256Hex, writeReceipt } from "../egress-receipt.js";
import { spawnGbrain, buildGbrainEnv, NEEDS_SHELL_ON_WINDOWS } from "../gbrain-exec";
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
 * refresh() default. Full code indexing on the 1000+-tracked-file repos this
 * feature targets routinely outruns the 30s op default; GraphifyProvider uses
 * the same 120s ceiling for the same indexing work. Query/status stay at 30s.
 */
const REFRESH_TIMEOUT_MS = 120_000;

/**
 * Environmental (engine / DB / config) failure shapes, shared by #assertOk and
 * #wrap so the two paths can never drift. These degrade to
 * PROVIDER_UNAVAILABLE (caller falls back to grep / file-only), not a hard
 * PROVIDER_ERROR with a raw dump. Covers the real case where gbrain's pglite
 * engine fails to init its WASM runtime (garrytan/gbrain#223) as well as
 * unreachable/unconfigured databases and a missing CLI.
 */
const ENVIRONMENTAL_ERROR_RE =
  /not on PATH|command not found|PGLite|WASM|failed to initialize|Aborted|Cannot connect to database|not configured|config\.json|database (is )?un(reachable|available)/i;

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

  /**
   * Fail-closed egress receipt, written BEFORE every content-bearing send
   * (register/refresh/add AND search/export). The gbrain subprocess owns the
   * wire bytes, so the receipt records destination + payload class; sha256 is
   * known when the exact payload text is (the `add` document body, the
   * `search` query). The consent field records the ACTUAL consent state from
   * opts — the tamper-evident ledger must never attest consented=true for a
   * send where nothing checked consent (every current caller asserts consent
   * first, so the unchecked branch is defense-in-depth, not a live path).
   */
  #receipt(payloadClass: string, opts: OpOptions, body?: string): void {
    writeReceipt({
      env: opts.env,
      sink: "gbrain",
      host: "gbrain-db (user-configured DATABASE_URL)",
      payloadClass,
      bytes: body == null ? 0 : Buffer.byteLength(body),
      sha256: body == null ? null : sha256Hex(body),
      consent: opts.consented === true
        ? "code-intelligence provider=gbrain + per-repo consented=true"
        : "code-intelligence provider=gbrain + consent=unchecked (content-bearing ops assert consent before sending)",
    });
  }

  async registerSource(repo: RepoRef, opts: OpOptions = {}): Promise<SourceStatus> {
    assertEgressConsent(this, opts);
    this.#receipt("repo-source-registration (sent by gbrain subprocess)", opts);
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
    this.#receipt("repo-code-index (sent by gbrain subprocess)", opts);
    const timeout = opts.timeout ?? REFRESH_TIMEOUT_MS;
    // Two passes, verified end-to-end against real Postgres-backed gbrain 0.42.56:
    //  1. default sync (markdown strategy) — indexes docs.
    //  2. `sync --strategy code` — the ACTUAL code-indexing pass. Without it code
    //     is never indexed (the whole point of a code provider); `code-def` stays
    //     "not_built" and search only finds incidental doc mentions. `--full`
    //     forces it past the per-source checkpoint the markdown pass advanced.
    this.#assertOk(spawnGbrain(["sync", "--source", source.id], { baseEnv: opts.env, timeout }));
    this.#assertOk(spawnGbrain(["sync", "--source", source.id, "--strategy", "code", "--full"], { baseEnv: opts.env, timeout }));
    return this.status(source, opts);
  }

  async search(query: string, opts: SearchOptions = {}): Promise<CodeSearchHit[]> {
    if (!query.trim()) return [];
    // The query text is repo-derived content and DATABASE_URL may point at a
    // remote DB. Unlike Sourcebot there is no cheap loopback check here — the
    // URL is resolved inside the gbrain CLI's own config, not by this adapter
    // — so EVERY send is treated as consent-requiring (fail closed, matching
    // the contract's OpOptions doc). The throw happens before any bytes (or
    // any receipt) exist; the receipt lands before the subprocess spawns.
    assertEgressConsent(this, opts);
    this.#receipt("code-search-query (sent by gbrain subprocess)", opts, query);
    // `gbrain search` is global and has no `--source` flag; `--limit` is real
    // (verified against gbrain 0.42.x --help).
    const args = ["search", query];
    if (opts.limit) args.push("--limit", String(opts.limit));
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

  // Document ops (add/delete/export) are GBrain-only and secondary; they match
  // gbrain's documented CLI surface (`put <slug>` reads stdin; `delete <slug>`;
  // `export`) but could not be exercised against a live engine on the test host
  // (pglite WASM broken, garrytan/gbrain#223), so treat them as best-effort.
  async add(doc: { slug: string; body: string }, opts: OpOptions = {}): Promise<SourceStatus> {
    assertCapability(this, "add");
    assertEgressConsent(this, opts);
    this.#receipt("document-body (sent by gbrain subprocess)", opts, doc.body);
    // `gbrain put <slug>` reads the document body from stdin.
    this.#assertOk(this.#runInput(["put", doc.slug], doc.body, opts));
    return { id: doc.slug, state: "ready" };
  }

  async delete(slug: string, opts: OpOptions = {}): Promise<SourceStatus> {
    assertCapability(this, "delete");
    // stdin closed ("") so any confirmation prompt gets EOF rather than hanging.
    this.#assertOk(this.#runInput(["delete", slug], "", opts));
    return { id: slug, state: "absent" };
  }

  async export(_source: SourceRef, opts: OpOptions = {}): Promise<string> {
    assertCapability(this, "export");
    // The export request federates into the same possibly-remote DB as
    // search — same fail-closed consent gate + receipt (no loopback
    // exemption exists for gbrain; see search()).
    assertEgressConsent(this, opts);
    this.#receipt("brain-export-request (sent by gbrain subprocess)", opts);
    // `gbrain export` is brain-wide (no per-source flag); returns whatever it prints.
    const r = spawnGbrain(["export"], {
      baseEnv: opts.env,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    });
    this.#assertOk(r);
    return r.stdout || "";
  }

  /** spawn gbrain with `input` on stdin, seeded env, Windows-shim aware. */
  #runInput(args: string[], input: string, opts: OpOptions) {
    return spawnSync("gbrain", args, {
      input,
      encoding: "utf-8",
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      env: buildGbrainEnv({ baseEnv: opts.env }),
      shell: NEEDS_SHELL_ON_WINDOWS,
    });
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
    // Engine / DB / config problems are ENVIRONMENTAL — degrade to UNAVAILABLE
    // (caller falls back to file-only). Shapes hoisted to ENVIRONMENTAL_ERROR_RE.
    if (ENVIRONMENTAL_ERROR_RE.test(stderr)) {
      throw new CodeProviderError("PROVIDER_UNAVAILABLE", firstLine(stderr) || "gbrain engine unavailable", this.id);
    }
    throw new CodeProviderError("PROVIDER_ERROR", firstLine(stderr) || `gbrain exited ${r.status}`, this.id);
  }

  #wrap(err: unknown): CodeProviderError {
    if (err instanceof CodeProviderError) return err;
    const message = err instanceof Error ? err.message : String(err);
    // Same environmental-vs-real split as #assertOk — literally the same
    // regex (ENVIRONMENTAL_ERROR_RE), so the two paths can never drift.
    if (ENVIRONMENTAL_ERROR_RE.test(message)) {
      return new CodeProviderError("PROVIDER_UNAVAILABLE", firstLine(message), this.id);
    }
    return new CodeProviderError("PROVIDER_ERROR", firstLine(message), this.id);
  }
}

/** First non-empty line, so a multi-line WASM/stack dump never reaches the user. */
function firstLine(text: string): string {
  return (text || "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
