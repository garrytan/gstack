/**
 * Graphify adapter — real CLI integration (github.com/Graphify-Labs/graphify).
 *
 * Graphify is a LOCAL tree-sitter knowledge graph. The genuinely local, no-LLM
 * build is `graphify update <dir>` — it writes `<dir>/graphify-out/graph.json`
 * with NO embeddings and NO network (verified against graphify 0.9.23). NOTE:
 * the bare `graphify <dir>` build instead runs LLM semantic extraction (a gemini
 * backend needing an API key + network), so this adapter deliberately uses
 * `graphify update`, which keeps the "local, no egress consent" invariant true.
 *
 * Query is `graphify query "<q>" --graph <dir>/graphify-out/graph.json`; the
 * `--graph` flag points at the built graph so search never depends on cwd.
 *
 * Never auto-installed: install is `pip install graphifyy && graphify install`
 * (needs Python >= 3.10), a user action the picker surfaces. When the CLI is
 * absent every op throws PROVIDER_UNAVAILABLE and callers degrade to file-only.
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

  /** Build the graph over repo.path locally (no LLM, no egress consent needed). */
  async registerSource(repo: RepoRef, opts: OpOptions = {}): Promise<SourceStatus> {
    this.#assertOk(this.#run(["update", repo.path], repo.path, opts.timeout ?? DEFAULT_TIMEOUT_MS));
    return this.status({ id: repo.path }, opts);
  }

  /** Re-parse and rebuild the graph (same local `graphify update` path). */
  async refresh(source: SourceRef, opts: OpOptions = {}): Promise<SourceStatus> {
    this.#assertOk(this.#run(["update", source.id], source.id, opts.timeout ?? DEFAULT_TIMEOUT_MS));
    return this.status(source, opts);
  }

  /**
   * `graphify query "<q>" --graph <graph.json>` traces the graph and prints
   * `NODE ...` / `EDGE ...` lines (plus a `Traversal:` header). We pass `--graph`
   * explicitly so the query reads the indexed repo's graph regardless of cwd.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<CodeSearchHit[]> {
    if (!query.trim()) return [];
    const root = opts.source ?? this.#root;
    const graphPath = join(root, OUT_DIR, GRAPH_JSON);
    const r = this.#run(["query", query, "--graph", graphPath], root, opts.timeout ?? DEFAULT_TIMEOUT_MS);
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
 * Parse real `graphify query` output into hits. The format (graphify 0.9.23):
 *   Traversal: BFS depth=2 | Start: ['query()'] | ... | 4 nodes found
 *   NODE query() [src=db.py loc=L4 community=login]
 *   EDGE query() --calls [EXTRACTED context=call]--> login() at=auth.py:L8
 * The file lives mid-line (`src=<file> loc=L<n>` on NODE, `at=<file>:L<n>` on
 * EDGE), so the ref is `<file>:L<n>`. The `Traversal:` header and any other line
 * are skipped. Exported for deterministic unit testing against the real format.
 */
export function parseGraphifyQuery(stdout: string, limit: number): CodeSearchHit[] {
  const hits: CodeSearchHit[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    let ref: string | undefined;
    const node = line.match(/^NODE\b.*?\[src=(\S+)\s+loc=(L\d+)/);
    const edge = line.match(/^EDGE\b.*?\bat=(\S+?):(L\d+)\b/);
    if (node) ref = `${node[1]}:${node[2]}`;
    else if (edge) ref = `${edge[1]}:${edge[2]}`;
    else continue; // skip the Traversal header and anything non-NODE/EDGE
    hits.push({ ref, snippet: line, kind: "graph-node" });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Whether the `graphify` CLI is installed (for the picker's availability probe). */
export function graphifyInstalled(env?: NodeJS.ProcessEnv): boolean {
  const r = spawnSync("graphify", ["--version"], {
    encoding: "utf-8",
    timeout: 5_000,
    stdio: ["ignore", "ignore", "ignore"],
    env,
    shell: NEEDS_SHELL_ON_WINDOWS,
  });
  return r.status === 0;
}
