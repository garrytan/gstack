/**
 * Graphify adapter — real CLI integration (github.com/Graphify-Labs/graphify).
 *
 * Graphify is a LOCAL tree-sitter knowledge graph: `graphify <dir>` builds a
 * `graphify-out/` (graph.json + report) in that dir, `graphify query "<q>"`
 * queries it, and nothing leaves the machine (no embeddings, no network). So it
 * needs no egress consent and no MCP — the runtime just shells out to the CLI,
 * the same shape as the GBrain adapter.
 *
 * Never auto-installed: install is `pip install graphifyy && graphify install`,
 * a user action the picker gates on. When the CLI is absent every op throws
 * PROVIDER_UNAVAILABLE and callers degrade to file-only.
 *
 * Path-based, not id-based: for Graphify a source "id" IS the absolute repo path
 * (that is where `graphify-out/` lives), unlike GBrain's short source ids.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  assertCapability,
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

const CAPABILITIES: CodeProviderCapability[] = ["register_source", "refresh", "search", "status", "export"];
const OUT_DIR = "graphify-out";
const GRAPH_JSON = "graph.json";
const DEFAULT_TIMEOUT_MS = 120_000; // indexing a repo can take a while
const NEEDS_SHELL_ON_WINDOWS = process.platform === "win32"; // graphify is a shim on Windows

export interface GraphifyOptions {
  /** Directory whose `graphify-out/` search/status/export read. Defaults to cwd. */
  root?: string;
  env?: NodeJS.ProcessEnv;
}

export class GraphifyProvider implements CodeProvider {
  readonly id = "graphify" as const;
  readonly label = "Graphify";
  readonly capabilities = new Set<CodeProviderCapability>(CAPABILITIES);
  /** Fully local — no repo content leaves the machine. */
  readonly local = true;
  readonly #root: string;
  readonly #env?: NodeJS.ProcessEnv;

  constructor(opts: GraphifyOptions = {}) {
    this.#root = opts.root ?? process.cwd();
    this.#env = opts.env;
    assertRequiredCapabilities(this.id, this.capabilities);
  }

  has(capability: CodeProviderCapability): boolean {
    return this.capabilities.has(capability);
  }

  #run(args: string[], cwd: string, timeout: number) {
    return spawnSync("graphify", args, {
      cwd,
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      env: this.#env,
      shell: NEEDS_SHELL_ON_WINDOWS,
    });
  }

  #assertOk(r: { status: number | null; stderr?: string; error?: Error & { code?: string }; signal?: NodeJS.Signals | null }): void {
    if (r.status === 0) return;
    const stderr = (r.stderr || "").trim();
    if (r.error?.code === "ENOENT" || /command not found/.test(stderr)) {
      throw new CodeProviderError("PROVIDER_UNAVAILABLE", "graphify CLI not on PATH (install: pip install graphifyy && graphify install)", this.id);
    }
    if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM") {
      throw new CodeProviderError("PROVIDER_TIMEOUT", "graphify timed out", this.id);
    }
    throw new CodeProviderError("PROVIDER_ERROR", stderr || `graphify exited ${r.status}`, this.id);
  }

  /** Build the graph over repo.path (local; no egress consent needed). */
  async registerSource(repo: RepoRef, opts: OpOptions = {}): Promise<SourceStatus> {
    this.#assertOk(this.#run(["."], repo.path, opts.timeout ?? DEFAULT_TIMEOUT_MS));
    return this.status({ id: repo.path }, opts);
  }

  /** Re-parse and merge changes into the existing graph. */
  async refresh(source: SourceRef, opts: OpOptions = {}): Promise<SourceStatus> {
    this.#assertOk(this.#run([".", "--update"], source.id, opts.timeout ?? DEFAULT_TIMEOUT_MS));
    return this.status(source, opts);
  }

  /**
   * `graphify query "<q>"` returns a traced answer over the graph. Its stdout is
   * an answer, not a fixed hit schema (the CLI reference documents the command
   * but not a machine format), so we map non-empty output lines to hits
   * tolerantly: a leading path-like token becomes the ref, the line the snippet.
   * Reconcile against a live graphify if a stricter schema is needed.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<CodeSearchHit[]> {
    if (!query.trim()) return [];
    const cwd = opts.source ?? this.#root;
    const r = this.#run(["query", query], cwd, opts.timeout ?? DEFAULT_TIMEOUT_MS);
    this.#assertOk(r);
    return parseGraphifyQuery(r.stdout || "", opts.limit ?? 10);
  }

  async status(source?: SourceRef, _opts: OpOptions = {}): Promise<SourceStatus> {
    const dir = source?.id ?? this.#root;
    const graphPath = join(dir, OUT_DIR, GRAPH_JSON);
    if (!existsSync(graphPath)) return { id: dir, state: "absent" };
    let itemCount: number | undefined;
    try {
      const graph = JSON.parse(readFileSync(graphPath, "utf-8")) as { nodes?: unknown[] };
      if (Array.isArray(graph.nodes)) itemCount = graph.nodes.length;
    } catch {
      // graph.json present but unparseable — still ready, just no count.
    }
    return { id: dir, state: "ready", itemCount, detail: graphPath };
  }

  async export(source: SourceRef, _opts: OpOptions = {}): Promise<string> {
    assertCapability(this, "export");
    const graphPath = join(source.id, OUT_DIR, GRAPH_JSON);
    if (!existsSync(graphPath)) {
      throw new CodeProviderError("SOURCE_NOT_REGISTERED", `no graph at ${graphPath}; index it first`, this.id);
    }
    return readFileSync(graphPath, "utf-8");
  }
}

/**
 * Map `graphify query` stdout to hits. Tolerant: each non-empty line becomes a
 * hit; a leading `path` or `path:line` token becomes the ref, else the whole
 * line is the snippet. Exported for deterministic unit testing.
 */
export function parseGraphifyQuery(stdout: string, limit: number): CodeSearchHit[] {
  const hits: CodeSearchHit[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const token = line.split(/\s+/)[0];
    const looksPath = /[/\\.]/.test(token) && !token.includes(" ");
    hits.push({ ref: looksPath ? token : "graphify", snippet: line, kind: "graph-node" });
    if (hits.length >= limit) break;
  }
  return hits;
}
