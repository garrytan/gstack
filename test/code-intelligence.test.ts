/**
 * Tests for lib/code-intelligence — the OPTIONAL, repo-oriented provider contract
 * with three REAL adapters (GBrain CLI, Graphify CLI, Sourcebot HTTP) and the
 * selection store the `gstack-code-intelligence` CLI drives.
 *
 * The Graphify and Sourcebot expectations here are pinned to the REAL formats
 * captured from live tools (graphify 0.9.23 NODE/EDGE query output; Sourcebot v5
 * `/api/search` response + Bearer auth), not invented shapes.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  REQUIRED_CAPABILITIES,
  GbrainProvider,
  GraphifyProvider,
  SourcebotProvider,
  parseGbrainSearch,
  parseGraphifyQuery,
  parseSourcebotSearch,
  readSelection,
  setProvider,
  setConsent,
  hasConsent,
  setRoot,
  getRoot,
  resolveSelectedProvider,
  RECOMMENDED_ORDER,
} from "../lib/code-intelligence";

describe("capability matrix", () => {
  test("every provider advertises the four required capabilities", () => {
    for (const p of [new GbrainProvider(), new SourcebotProvider(), new GraphifyProvider()]) {
      for (const cap of REQUIRED_CAPABILITIES) expect(p.has(cap)).toBe(true);
    }
  });

  test("only GBrain advertises the document ops; local flags are right", () => {
    const g = new GbrainProvider();
    expect(g.local).toBe(false);
    for (const cap of ["add", "delete", "export"] as const) expect(g.has(cap)).toBe(true);

    const s = new SourcebotProvider({ baseUrl: "http://localhost:3000" });
    expect(s.local).toBe(true); // loopback → content stays on machine
    expect(s.has("add")).toBe(false);
    expect(new SourcebotProvider({ baseUrl: "https://sb.example.com" }).local).toBe(false);

    const gf = new GraphifyProvider();
    expect(gf.local).toBe(true);
    expect(gf.has("export")).toBe(true);
    expect(gf.has("add")).toBe(false);
  });

  test("RECOMMENDED_ORDER puts GBrain first", () => {
    expect([...RECOMMENDED_ORDER]).toEqual(["gbrain", "sourcebot", "graphify"]);
  });
});

describe("parsers (pinned to real tool output)", () => {
  test("parseGbrainSearch (text surface)", () => {
    const hits = parseGbrainSearch("[0.91] slug/a -- one\nbanner\n[0.05] slug/b -- low", 0.1, 10);
    expect(hits).toEqual([{ ref: "slug/a", score: 0.91, snippet: "one", kind: "document" }]);
  });

  test("parseGraphifyQuery reads file:line from real NODE/EDGE lines", () => {
    // Verbatim shape from graphify 0.9.23 `query ... --graph`.
    const real = [
      "Traversal: BFS depth=2 | Start: ['query()'] | Context: call (heuristic) | 4 nodes found",
      "",
      "NODE query() [src=db.py loc=L4 community=login]",
      "EDGE query() --calls [EXTRACTED context=call]--> login() at=auth.py:L8",
    ].join("\n");
    const hits = parseGraphifyQuery(real, 10);
    expect(hits.map((h) => h.ref)).toEqual(["db.py:L4", "auth.py:L8"]); // NOT "graphify"
    expect(hits.every((h) => h.kind === "graph-node")).toBe(true);
    // The Traversal header must NOT become a bogus hit.
    expect(hits.some((h) => h.snippet?.startsWith("Traversal:"))).toBe(false);
  });

  test("parseSourcebotSearch maps files to file:line hits (real v5 shape)", () => {
    const real = {
      files: [
        {
          fileName: { text: "src/checksum.ts", matchRanges: [] },
          repository: "github.com/example/sb-sample",
          chunks: [{ content: "export function computeChecksum(data: string): number {", matchRanges: [{ start: { byteOffset: 58, column: 17, lineNumber: 2 } }] }],
        },
      ],
    };
    expect(parseSourcebotSearch(real, 10)).toEqual([
      { ref: "src/checksum.ts:2", snippet: "export function computeChecksum(data: string): number {", kind: "file" },
    ]);
    expect(parseSourcebotSearch("nope", 10)).toEqual([]);
  });
});

describe("selection store + provider-OFF", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-home-"));
    env = { ...process.env, GSTACK_HOME: home };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  test("no selection = provider-OFF (null)", () => {
    expect(readSelection(env).provider).toBeNull();
    expect(resolveSelectedProvider({ env })).toBeNull();
  });

  test("select persists and resolves the provider", () => {
    setProvider("graphify", env);
    expect(readSelection(env).provider).toBe("graphify");
    expect(resolveSelectedProvider({ env })?.id).toBe("graphify");
  });

  test("consent is per-repo", () => {
    const repo = path.join(home, "repoA");
    expect(hasConsent(repo, env)).toBe(false);
    setConsent(repo, true, env);
    expect(hasConsent(repo, env)).toBe(true);
    expect(hasConsent(path.join(home, "repoB"), env)).toBe(false);
  });

  test("indexed root persists per provider (so search reads the same graph)", () => {
    expect(getRoot("graphify", env)).toBeUndefined();
    setRoot("graphify", "/tmp/some/repo", env);
    expect(getRoot("graphify", env)).toBe(path.resolve("/tmp/some/repo"));
  });
});

describe("egress consent gate", () => {
  test("GBrain (non-local) registerSource without consent → PROVIDER_NOT_CONSENTED", async () => {
    await expect(new GbrainProvider().registerSource({ id: "code", path: "/repo" })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
  });

  test("Graphify (local) is exempt from the egress gate", async () => {
    await expect(
      new GraphifyProvider({ env: { PATH: "/nonexistent" } }).registerSource({ id: "r", path: os.tmpdir() }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("Graphify adapter (fake graphify shim, real NODE/EDGE format)", () => {
  let binDir: string;
  let repo: string;
  function env(): NodeJS.ProcessEnv {
    return { PATH: `${binDir}:${process.env.PATH}` };
  }
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gf-bin-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gf-repo-"));
    // Shim emulates real graphify 0.9.23: `update <path>` writes graph.json (no LLM);
    // `query <q> --graph <path>` prints NODE/EDGE lines.
    fs.writeFileSync(
      path.join(binDir, "graphify"),
      `#!/usr/bin/env bash
case "$1" in
  --version) echo "graphify 0.9.23"; exit 0;;
  update) mkdir -p "$2/graphify-out"; echo '{"nodes":[1,2,3,4,5],"edges":[]}' > "$2/graphify-out/graph.json"; echo "Rebuilt: 5 nodes, 8 edges"; exit 0;;
  query)
    echo "Traversal: BFS depth=2 | Start: ['query()'] | 4 nodes found"
    echo ""
    echo "NODE query() [src=db.py loc=L4 community=login]"
    echo "EDGE query() --calls [EXTRACTED context=call]--> login() at=auth.py:L8"
    exit 0;;
esac
exit 1
`,
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("index builds a graph (via `graphify update`) and status counts nodes", async () => {
    const gf = new GraphifyProvider({ root: repo, env: env() });
    const reg = await gf.registerSource({ id: repo, path: repo });
    expect(reg.state).toBe("ready");
    expect(reg.itemCount).toBe(5);
    expect(fs.existsSync(path.join(repo, "graphify-out", "graph.json"))).toBe(true);
  });

  test("search reads file:line refs from real query output", async () => {
    const gf = new GraphifyProvider({ root: repo, env: env() });
    await gf.registerSource({ id: repo, path: repo });
    const hits = await gf.search("what calls db", { source: repo });
    expect(hits.map((h) => h.ref)).toEqual(["db.py:L4", "auth.py:L8"]);
  });

  test("missing graphify CLI degrades to PROVIDER_UNAVAILABLE", async () => {
    await expect(
      new GraphifyProvider({ root: repo, env: { PATH: os.tmpdir() } }).search("q"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("Sourcebot adapter (injected fetch, real v5 auth + shape)", () => {
  test("registerSource writes a local git connection to config.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-sb-"));
    const configPath = path.join(dir, "config.json");
    await new SourcebotProvider({ baseUrl: "http://localhost:3000", configPath }).registerSource({ id: "myrepo", path: "/abs/repo" });
    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written.connections.myrepo).toEqual({ type: "git", url: "file:///abs/repo" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("search sends Bearer auth and maps the real v5 response to hits", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), auth: (init.headers as Record<string, string>)?.Authorization ?? null });
      return new Response(
        JSON.stringify({ files: [{ fileName: { text: "a.ts" }, chunks: [{ content: "x", matchRanges: [{ start: { lineNumber: 3 } }] }] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const sb = new SourcebotProvider({ baseUrl: "http://localhost:3000", apiKey: "sbk_test", fetch: fetchStub });
    const hits = await sb.search("foo");
    expect(seen[0].url).toBe("http://localhost:3000/api/search");
    expect(seen[0].auth).toBe("Bearer sbk_test");
    expect(hits).toEqual([{ ref: "a.ts:3", snippet: "x", kind: "file" }]);
  });

  test("401 (no API key) degrades to PROVIDER_UNAVAILABLE, not PROVIDER_ERROR", async () => {
    const fetchStub = (async () =>
      new Response(JSON.stringify({ errorCode: "NOT_AUTHENTICATED" }), { status: 401 })) as unknown as typeof fetch;
    await expect(
      new SourcebotProvider({ baseUrl: "http://localhost:3000", fetch: fetchStub }).search("q"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("unreachable server degrades to PROVIDER_UNAVAILABLE", async () => {
    const fetchStub = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      new SourcebotProvider({ baseUrl: "http://localhost:3999", fetch: fetchStub }).search("q"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("registerSource without SOURCEBOT_CONFIG → PROVIDER_UNAVAILABLE", async () => {
    await expect(
      new SourcebotProvider({ baseUrl: "http://localhost:3000", env: {} }).registerSource({ id: "r", path: "/x" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("GBrain adapter (fake gbrain shim)", () => {
  let binDir: string;
  let homeDir: string;
  function env(): NodeJS.ProcessEnv {
    return { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir };
  }
  function writeShim(body: string): void {
    fs.writeFileSync(path.join(binDir, "gbrain"), body, { mode: 0o755 });
  }
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-bin-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-home-"));
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test("search parses hits (and sends no --source: gbrain search is global)", async () => {
    writeShim(`#!/usr/bin/env bash
if [ "$1" = "search" ]; then
  if printf '%s ' "$@" | grep -q -- "--source"; then echo "[0.0] ERR -- adapter sent phantom --source"; exit 0; fi
  echo "[0.88] src/x.ts -- match"; exit 0
fi
exit 1
`);
    const hits = await new GbrainProvider().search("where", { env: env() });
    expect(hits).toEqual([{ ref: "src/x.ts", score: 0.88, snippet: "match", kind: "document" }]);
  });

  test("engine-down (pglite WASM) degrades to PROVIDER_UNAVAILABLE, not PROVIDER_ERROR", async () => {
    // Reproduces garrytan/gbrain#223: engine fails to init; must degrade cleanly.
    writeShim(`#!/usr/bin/env bash
echo "PGLite failed to initialize its WASM runtime." >&2
echo "  Original error: Aborted()." >&2
exit 1
`);
    await expect(new GbrainProvider().search("q", { env: env() })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  test("missing CLI degrades to PROVIDER_UNAVAILABLE", async () => {
    await expect(
      new GbrainProvider().search("q", { env: { PATH: binDir, HOME: homeDir } }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
