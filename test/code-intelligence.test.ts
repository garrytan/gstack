/**
 * Tests for lib/code-intelligence — the OPTIONAL, repo-oriented provider contract
 * with three REAL adapters (GBrain CLI, Graphify CLI, Sourcebot HTTP) plus the
 * selection store the `gstack-code-intelligence` CLI drives.
 *
 * Load-bearing properties:
 *  - Capability matrix: every provider advertises the four required ops; only
 *    GBrain advertises the document ops (add/delete/export).
 *  - Consent: non-local providers refuse to index without per-repo consent; a
 *    localhost Sourcebot and Graphify are local and need none.
 *  - GBrain search + status work end-to-end against a fake `gbrain` shim.
 *  - Graphify index/search/status work end-to-end against a fake `graphify` shim.
 *  - Sourcebot register (config.json edit) + search work against an injected fetch.
 *  - Selection persists to $GSTACK_HOME; no selection = provider-OFF (null).
 *  - Every adapter degrades to PROVIDER_UNAVAILABLE when its tool/server is absent.
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
    expect(RECOMMENDED_ORDER[0]).toBe("gbrain");
    expect([...RECOMMENDED_ORDER]).toEqual(["gbrain", "sourcebot", "graphify"]);
  });
});

describe("parsers", () => {
  test("parseGbrainSearch (text surface)", () => {
    const hits = parseGbrainSearch("[0.91] slug/a -- one\nbanner\n[0.05] slug/b -- low", 0.1, 10);
    expect(hits).toEqual([{ ref: "slug/a", score: 0.91, snippet: "one", kind: "document" }]);
  });

  test("parseGraphifyQuery maps path-like lines to refs", () => {
    const hits = parseGraphifyQuery("src/a.ts calls foo()\njust prose here", 10);
    expect(hits[0]).toMatchObject({ ref: "src/a.ts", kind: "graph-node" });
    expect(hits[1]).toMatchObject({ ref: "graphify" });
  });

  test("parseSourcebotSearch maps files to file:line hits, tolerates garbage", () => {
    const payload = {
      files: [{ fileName: { text: "src/x.ts" }, chunks: [{ content: "hit", matchRanges: [{ start: { lineNumber: 12 } }] }] }],
    };
    expect(parseSourcebotSearch(payload, 10)).toEqual([{ ref: "src/x.ts:12", snippet: "hit", kind: "file" }]);
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
});

describe("egress consent gate", () => {
  test("GBrain (non-local) registerSource without consent → PROVIDER_NOT_CONSENTED", async () => {
    await expect(new GbrainProvider().registerSource({ id: "code", path: "/repo" })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
  });

  test("Graphify (local) is exempt from the egress gate", async () => {
    // Local → no consent needed; it reaches the CLI (absent here → UNAVAILABLE),
    // NOT a consent rejection.
    await expect(
      new GraphifyProvider({ env: { PATH: "/nonexistent" } }).registerSource({ id: "r", path: os.tmpdir() }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("Graphify adapter (fake graphify shim on PATH)", () => {
  let binDir: string;
  let repo: string;
  function env(): NodeJS.ProcessEnv {
    return { PATH: `${binDir}:${process.env.PATH}` };
  }
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gf-bin-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gf-repo-"));
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("index builds a graph and status reports ready + node count", async () => {
    // Shim: `graphify .` writes graphify-out/graph.json in cwd; `graphify query` prints a hit line.
    fs.writeFileSync(
      path.join(binDir, "graphify"),
      `#!/usr/bin/env bash
if [ "$1" = "query" ]; then echo "src/a.ts -> src/b.ts (calls)"; exit 0; fi
mkdir -p "$PWD/graphify-out"
echo '{"nodes":[1,2,3]}' > "$PWD/graphify-out/graph.json"
exit 0
`,
      { mode: 0o755 },
    );
    const gf = new GraphifyProvider({ root: repo, env: env() });
    const reg = await gf.registerSource({ id: "r", path: repo });
    expect(reg.state).toBe("ready");
    expect(reg.itemCount).toBe(3);

    const hits = await gf.search("what calls b", { source: repo });
    expect(hits[0].ref).toBe("src/a.ts");
  });

  test("missing graphify CLI degrades to PROVIDER_UNAVAILABLE", async () => {
    await expect(
      new GraphifyProvider({ root: repo, env: { PATH: binDir } }).search("q"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("Sourcebot adapter (injected fetch + temp config)", () => {
  test("registerSource writes a local git connection to config.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-sb-"));
    const configPath = path.join(dir, "config.json");
    const sb = new SourcebotProvider({ baseUrl: "http://localhost:3000", configPath });
    await sb.registerSource({ id: "myrepo", path: "/abs/repo" });
    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written.connections.myrepo).toEqual({ type: "git", url: "file:///abs/repo" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("search POSTs /api/search and maps files to hits", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ files: [{ fileName: { text: "a.ts" }, chunks: [{ content: "x", matchRanges: [{ start: { lineNumber: 3 } }] }] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const sb = new SourcebotProvider({ baseUrl: "http://localhost:3000", fetch: fetchStub });
    const hits = await sb.search("foo", { limit: 5 });
    expect(calls[0].url).toBe("http://localhost:3000/api/search");
    expect((calls[0].body as { isRegexEnabled: boolean }).isRegexEnabled).toBe(true);
    expect(hits).toEqual([{ ref: "a.ts:3", snippet: "x", kind: "file" }]);
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
    const sb = new SourcebotProvider({ baseUrl: "http://localhost:3000", env: {} });
    await expect(sb.registerSource({ id: "r", path: "/x" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("GBrain adapter end-to-end (fake gbrain shim on PATH)", () => {
  let binDir: string;
  let homeDir: string;
  function env(): NodeJS.ProcessEnv {
    return { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir };
  }
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-bin-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-home-"));
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test("search scopes to source and parses hits", async () => {
    fs.writeFileSync(
      path.join(binDir, "gbrain"),
      `#!/usr/bin/env bash
if [ "$1" = "search" ]; then
  if printf '%s ' "$@" | grep -q -- "--source code"; then echo "[0.88] src/x.ts -- match"; else echo "[0.10] wrong -- unscoped"; fi
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );
    const hits = await new GbrainProvider().search("where", { env: env(), source: "code" });
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toBe("src/x.ts");
  });

  test("missing CLI degrades to PROVIDER_UNAVAILABLE", async () => {
    await expect(
      new GbrainProvider().search("q", { env: { PATH: binDir, HOME: homeDir } }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
