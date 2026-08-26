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
import { execFileSync, spawnSync } from "child_process";
import { sha256Hex } from "../lib/egress-receipt.js";
import {
  REQUIRED_CAPABILITIES,
  detectAvailable,
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
  shouldOfferIndexing,
  trackedFileCount,
  LARGE_REPO_FILE_THRESHOLD,
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

  test("select none records the decline; selecting a provider clears it", () => {
    setProvider(null, env);
    expect(readSelection(env).declined).toBe(true);
    setProvider("graphify", env);
    expect(readSelection(env).declined).toBe(false);
  });
});

describe("session-start indexing offer (suggest)", () => {
  let home: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-home-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-repo-"));
    env = { ...process.env, GSTACK_HOME: home };
    Bun.spawnSync(["git", "init", "-q", repo]);
    for (const name of ["a.ts", "b.ts", "c.ts"]) fs.writeFileSync(path.join(repo, name), "x\n");
    Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("offers exactly once: large repo with no prior decision", () => {
    const s = shouldOfferIndexing(repo, { env, threshold: 3 });
    expect(s).toEqual({ offer: true, reason: "large-repo", fileCount: 3, threshold: 3 });
  });

  test("small repo → no offer", () => {
    expect(shouldOfferIndexing(repo, { env, threshold: 4 }).reason).toBe("small-repo");
  });

  test("not a git repo → no offer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-plain-"));
    try {
      expect(shouldOfferIndexing(dir, { env, threshold: 0 }).reason).toBe("not-a-repo");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider already selected → no offer", () => {
    setProvider("graphify", env);
    expect(shouldOfferIndexing(repo, { env, threshold: 3 }).reason).toBe("provider-selected");
  });

  test("explicit decline → never asked again", () => {
    setProvider(null, env);
    expect(shouldOfferIndexing(repo, { env, threshold: 3 }).reason).toBe("declined");
  });

  test("trackedFileCount counts git-tracked files only", () => {
    fs.writeFileSync(path.join(repo, "untracked.ts"), "x\n");
    expect(trackedFileCount(repo)).toBe(3);
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

  test("status skips parsing a huge graph.json (heap guard): size in detail, no itemCount", async () => {
    const outDir = path.join(repo, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    // 6MB of spaces — over the 5MB parse threshold, so the content is never
    // parsed (on real target repos graph.json can run to hundreds of MB).
    fs.writeFileSync(path.join(outDir, "graph.json"), Buffer.alloc(6 * 1024 * 1024, 0x20));
    const s = await new GraphifyProvider({ root: repo, env: env() }).status();
    expect(s.state).toBe("ready");
    expect(s.itemCount).toBeUndefined();
    expect(s.detail).toContain("node count skipped");
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
    const hits = await new GbrainProvider().search("where", { env: env(), consented: true });
    expect(hits).toEqual([{ ref: "src/x.ts", score: 0.88, snippet: "match", kind: "document" }]);
  });

  test("refresh runs the code-indexing pass (`sync --strategy code --full`)", async () => {
    // Real gbrain only indexes code when `sync --strategy code` runs; without it
    // code-def stays not_built. Pin that the adapter issues that pass.
    const marker = path.join(homeDir, "sync-calls.log");
    writeShim(`#!/usr/bin/env bash
if [ "$1" = "sync" ]; then printf '%s\\n' "$*" >> "${marker}"; exit 0; fi
if [ "$1" = "sources" ]; then echo '{"sources":[{"id":"code","local_path":"/r","page_count":1}]}'; exit 0; fi
exit 1
`);
    await new GbrainProvider().refresh({ id: "code" }, { env: env(), consented: true });
    const log = fs.readFileSync(marker, "utf-8");
    expect(log).toContain("--strategy code");
    expect(log).toContain("--full");
  });

  test("engine-down (pglite WASM) degrades to PROVIDER_UNAVAILABLE, not PROVIDER_ERROR", async () => {
    // Reproduces garrytan/gbrain#223: engine fails to init; must degrade cleanly.
    writeShim(`#!/usr/bin/env bash
echo "PGLite failed to initialize its WASM runtime." >&2
echo "  Original error: Aborted()." >&2
exit 1
`);
    await expect(new GbrainProvider().search("q", { env: env(), consented: true })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  test("missing CLI degrades to PROVIDER_UNAVAILABLE", async () => {
    await expect(
      new GbrainProvider().search("q", { env: { PATH: binDir, HOME: homeDir }, consented: true }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

// ── R1: the repo-policy deny tier vetoes recorded consent ───────────────────
// Two consent stores must never disagree about whether code may leave a repo:
// gstack-gbrain-repo-policy (per-remote trust tiers) is the single authority.
describe("consent unification — deny tier wins (R1)", () => {
  function makeRepo(dir: string, url: string): string {
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    git("init", "-q", ".");
    git("remote", "add", "origin", url);
    return repo;
  }
  const POLICY_BIN = path.join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy");
  const URL = "https://github.com/acme/veto-widget.git";

  test("recorded consent survives when no policy store exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      expect(hasConsent(repo, env)).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("deny tier vetoes recorded consent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "deny"], { env, encoding: "utf-8" });
      expect(hasConsent(repo, env)).toBe(false);
      // Flipping the tier back restores the recorded consent — the veto is
      // live policy, not a destructive rewrite of the consent store.
      execFileSync(POLICY_BIN, ["set", URL, "read-write"], { env, encoding: "utf-8" });
      expect(hasConsent(repo, env)).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("unreadable policy store fails closed (consent vetoed) for BOTH op classes", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod semantics differ
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "read-write"], { env, encoding: "utf-8" });
      fs.chmodSync(path.join(home, "gbrain-repo-policy.json"), 0o000);
      try {
        expect(hasConsent(repo, env)).toBe(false);
        expect(hasConsent(repo, env, "read")).toBe(false);
      } finally {
        fs.chmodSync(path.join(home, "gbrain-repo-policy.json"), 0o600);
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  // ── R2: read-only is a WRITE veto, not a total one ─────────────────────────
  // gstack-gbrain-sync semantics: "search allowed, page writes never". The
  // code-intelligence veto must match: index/register/refresh (write-class)
  // are refused on read-only; search (read-class) still works.
  test("read-only tier vetoes write-class consent but allows read-class (R2)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "read-only"], { env, encoding: "utf-8" });
      // Default op class is write — a caller that doesn't say gets fail-closed.
      expect(hasConsent(repo, env)).toBe(false);
      expect(hasConsent(repo, env, "write")).toBe(false);
      // Read-class (search/export/status) survives read-only.
      expect(hasConsent(repo, env, "read")).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("deny beats consent for BOTH op classes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "deny"], { env, encoding: "utf-8" });
      expect(hasConsent(repo, env, "write")).toBe(false);
      expect(hasConsent(repo, env, "read")).toBe(false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

// ── R2 at the CLI: `index` is write-class, so read-only refuses it ──────────
describe("read-only repo policy blocks write-class CLI index (R2)", () => {
  const CLI = path.join(import.meta.dir, "..", "bin", "gstack-code-intelligence");
  const POLICY_BIN = path.join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy");
  const URL = "https://github.com/acme/readonly-widget.git";

  test("index refuses on read-only even with recorded consent (gbrain provider)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-ro-"));
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-ro-bin-"));
    try {
      // Shim shadows any real gbrain on PATH: even if a regression lets the
      // index proceed, this test can never touch a real brain.
      fs.writeFileSync(path.join(shimDir, "gbrain"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
      const env = { ...process.env, GSTACK_HOME: home, PATH: `${shimDir}:${process.env.PATH}` };
      const repo = path.join(home, "repo");
      fs.mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "-q", "."], { cwd: repo });
      execFileSync("git", ["remote", "add", "origin", URL], { cwd: repo });
      setProvider("gbrain", env);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "read-only"], { env, encoding: "utf-8" });
      const res = spawnSync("bun", [CLI, "index", repo], {
        encoding: "utf-8",
        timeout: 30_000,
        env: env as Record<string, string>,
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("repo trust policy");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

// ── receipt truthfulness: the tamper-evident ledger must never claim a consent
// that was never checked (red-team finding 1). Non-loopback Sourcebot only —
// loopback sends nothing off-machine and writes no receipt at all.
describe("Sourcebot egress receipts record the TRUE consent state", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-sb-egress-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function ledgerLines(): Array<Record<string, unknown>> {
    const p = path.join(home, "security", "egress.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  const okFetch = (async () =>
    new Response(JSON.stringify({ files: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

  test("status probe: allowed without consent, receipt says consent=unchecked (never consented=true)", async () => {
    const sb = new SourcebotProvider({ baseUrl: "http://sb.example.com:3000", fetch: okFetch });
    const s = await sb.status(undefined, { env: { GSTACK_HOME: home } });
    expect(s.state).toBe("ready");
    const lines = ledgerLines();
    expect(lines.length).toBe(1);
    expect(lines[0].sink).toBe("sourcebot");
    expect(String(lines[0].consent)).toContain("consent=unchecked");
    expect(String(lines[0].consent)).not.toContain("consented=true");
    expect(String(lines[0].payload_class)).toContain("liveness-probe");
  });

  test("non-loopback search without consent is refused BEFORE any bytes leave (fail-closed)", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const sb = new SourcebotProvider({ baseUrl: "http://sb.example.com:3000", fetch: spyFetch });
    await expect(sb.search("internalSecretFn", { env: { GSTACK_HOME: home } })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
    expect(calls).toBe(0); // the query never left the machine
    expect(ledgerLines()).toEqual([]); // nothing sent → nothing receipted
  });

  test("non-loopback refresh without consent → PROVIDER_NOT_CONSENTED (write-class)", async () => {
    const sb = new SourcebotProvider({ baseUrl: "http://sb.example.com:3000", fetch: okFetch });
    await expect(sb.refresh({ id: "r" }, { env: { GSTACK_HOME: home } })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
    expect(ledgerLines()).toEqual([]);
  });

  test("consented non-loopback search sends, and the receipt truthfully records consented=true", async () => {
    const sb = new SourcebotProvider({ baseUrl: "http://sb.example.com:3000", fetch: okFetch });
    const hits = await sb.search("foo", { consented: true, env: { GSTACK_HOME: home } });
    expect(hits).toEqual([]);
    const lines = ledgerLines();
    expect(lines.length).toBe(1);
    expect(String(lines[0].consent)).toContain("consented=true");
    expect(lines[0].payload_class).toBe("code-search-request");
  });

  test("loopback search stays consent-free and writes no receipt (no egress)", async () => {
    const sb = new SourcebotProvider({ baseUrl: "http://localhost:3000", fetch: okFetch });
    await sb.search("foo", { env: { GSTACK_HOME: home } });
    expect(ledgerLines()).toEqual([]);
  });
});

// ── GBrain consent + receipts: gbrain federates into a possibly-remote
// DATABASE_URL and (unlike Sourcebot) has no cheap loopback check — the URL is
// resolved inside the gbrain CLI's own config — so EVERY content-bearing send
// is consent-gated and receipted: search's query text and the export request
// included, not just register/refresh/add.
describe("GBrain search/export consent gate + egress receipts", () => {
  let binDir: string;
  let home: string;
  let marker: string;
  function env(): NodeJS.ProcessEnv {
    return { PATH: `${binDir}:${process.env.PATH}`, HOME: home, GSTACK_HOME: home };
  }
  function ledgerLines(): Array<Record<string, unknown>> {
    const p = path.join(home, "security", "egress.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-egress-bin-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-egress-home-"));
    marker = path.join(home, "gbrain-invocations.log");
    // Shim logs every invocation, so "refused BEFORE the subprocess runs" is
    // provable: an unconsented op must leave the marker file nonexistent.
    fs.writeFileSync(
      path.join(binDir, "gbrain"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${marker}"
if [ "$1" = "search" ]; then echo "[0.88] src/x.ts -- match"; exit 0; fi
if [ "$1" = "export" ]; then echo "exported-brain-body"; exit 0; fi
exit 1
`,
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("unconsented search is refused BEFORE the subprocess runs (fail-closed) and writes no receipt", async () => {
    await expect(new GbrainProvider().search("internalSecretFn", { env: env() })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
    expect(fs.existsSync(marker)).toBe(false); // the query never left the machine
    expect(ledgerLines()).toEqual([]); // nothing sent → nothing receipted
  });

  test("consented search sends, and the receipt truthfully records consented=true + the query hash", async () => {
    const hits = await new GbrainProvider().search("where is auth", { env: env(), consented: true });
    expect(hits).toEqual([{ ref: "src/x.ts", score: 0.88, snippet: "match", kind: "document" }]);
    const lines = ledgerLines();
    expect(lines.length).toBe(1);
    expect(lines[0].sink).toBe("gbrain");
    expect(String(lines[0].consent)).toContain("consented=true");
    expect(String(lines[0].payload_class)).toContain("code-search-query");
    expect(lines[0].sha256).toBe(sha256Hex("where is auth"));
    expect(lines[0].bytes).toBe(Buffer.byteLength("where is auth"));
  });

  test("unconsented export is refused (no loopback exemption exists for gbrain) and writes no receipt", async () => {
    await expect(new GbrainProvider().export({ id: "code" }, { env: env() })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(ledgerLines()).toEqual([]);
  });

  test("consented export sends and writes a truthful receipt", async () => {
    const body = await new GbrainProvider().export({ id: "code" }, { env: env(), consented: true });
    expect(body).toContain("exported-brain-body");
    const lines = ledgerLines();
    expect(lines.length).toBe(1);
    expect(lines[0].sink).toBe("gbrain");
    expect(String(lines[0].consent)).toContain("consented=true");
    expect(String(lines[0].payload_class)).toContain("brain-export-request");
  });
});

// ── the CLI names WHY a gbrain search is refused (missing consent vs a deny
// repo trust policy) instead of surfacing a generic provider error, and the
// refusal happens before any subprocess spawn or receipt.
describe("CLI search consent gate (gbrain provider, honest refusal message)", () => {
  const CLI = path.join(import.meta.dir, "..", "bin", "gstack-code-intelligence");
  const POLICY_BIN = path.join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy");
  const URL = "https://github.com/acme/search-widget.git";
  let home: string;
  let shimDir: string;
  let marker: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-cli-search-"));
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-cli-search-bin-"));
    marker = path.join(home, "gbrain-invocations.log");
    fs.writeFileSync(
      path.join(shimDir, "gbrain"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${marker}"\necho "[0.90] slug -- hit"; exit 0\n`,
      { mode: 0o755 },
    );
    repo = path.join(home, "repo");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "."], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", URL], { cwd: repo });
    env = { ...process.env, GSTACK_HOME: home, PATH: `${shimDir}:${process.env.PATH}` };
    setProvider("gbrain", env);
    setRoot("gbrain", repo, env);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  function runSearch() {
    return spawnSync("bun", [CLI, "search", "internalSecretFn"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: env as Record<string, string>,
    });
  }

  test("no recorded consent → refused with the consent instruction; nothing spawned, nothing receipted", () => {
    const res = runSearch();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("consent");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(home, "security", "egress.jsonl"))).toBe(false);
  });

  test("deny repo trust policy → refused with the trust-policy explanation even with recorded consent", () => {
    setConsent(repo, true, env);
    execFileSync(POLICY_BIN, ["set", URL, "deny"], { env, encoding: "utf-8" });
    const res = runSearch();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("repo trust policy");
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("recorded consent + no deny → search runs against the provider", () => {
    setConsent(repo, true, env);
    const res = runSearch();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("slug");
    expect(fs.existsSync(marker)).toBe(true);
  });
});

// ── consent CLI polarity — a recorded "no" must persist DENIED, never granted ─
describe("consent CLI requires an explicit yes|no (never defaults to granted)", () => {
  const CLI = path.join(import.meta.dir, "..", "bin", "gstack-code-intelligence");
  let home: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  function runConsent(...args: string[]) {
    const res = spawnSync("bun", [CLI, "consent", ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      env: env as Record<string, string>,
    });
    return { status: res.status ?? -1, stdout: res.stdout || "", stderr: res.stderr || "" };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-consent-home-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-consent-repo-"));
    env = { ...process.env, GSTACK_HOME: home };
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("consent <repo> no records FALSE, and the deny-check honors it", () => {
    const r = runConsent(repo, "no");
    expect(r.status).toBe(0);
    expect(readSelection(env).consents[path.resolve(repo)]).toBe(false);
    expect(hasConsent(repo, env)).toBe(false);
  });

  test("consent <repo> yes records true; a later no overrides it", () => {
    expect(runConsent(repo, "yes").status).toBe(0);
    expect(hasConsent(repo, env)).toBe(true);
    expect(runConsent(repo, "no").status).toBe(0);
    expect(readSelection(env).consents[path.resolve(repo)]).toBe(false);
    expect(hasConsent(repo, env)).toBe(false);
  });

  test("true/false are accepted as aliases", () => {
    expect(runConsent(repo, "false").status).toBe(0);
    expect(readSelection(env).consents[path.resolve(repo)]).toBe(false);
    expect(runConsent(repo, "true").status).toBe(0);
    expect(readSelection(env).consents[path.resolve(repo)]).toBe(true);
  });

  test("missing value exits nonzero and records NOTHING (never defaults to yes)", () => {
    const r = runConsent(repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("yes|no");
    expect(readSelection(env).consents).toEqual({});
    expect(hasConsent(repo, env)).toBe(false);
  });

  test("garbage value exits nonzero and records NOTHING", () => {
    const r = runConsent(repo, "maybe");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("yes|no");
    expect(readSelection(env).consents).toEqual({});
  });
});

// ── GBrain document ops (add/delete/export) — behavioral pins over the same
// fake-gbrain shim harness. add() must pipe the body to `put <slug>` on stdin
// and receipt the body's sha256 BEFORE the send; delete() must survive a
// confirmation prompt via the stdin-EOF guard; export() must return the CLI's
// stdout verbatim; and each must degrade to PROVIDER_UNAVAILABLE (not a hard
// error) when the CLI is absent.
describe("GBrain document ops (add/delete/export) via fake gbrain shim", () => {
  let binDir: string;
  let home: string;
  let argvLog: string;
  let stdinLog: string;
  function env(): NodeJS.ProcessEnv {
    return { PATH: `${binDir}:${process.env.PATH}`, HOME: home, GSTACK_HOME: home };
  }
  function ledgerLines(): Array<Record<string, unknown>> {
    const p = path.join(home, "security", "egress.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-docops-bin-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-docops-home-"));
    argvLog = path.join(home, "gbrain-argv.log");
    stdinLog = path.join(home, "gbrain-stdin.log");
    // Shim logs every argv (so "refused BEFORE the subprocess" is provable),
    // captures put's stdin byte-for-byte, and blocks delete on a confirmation
    // read the way a real prompt would — the adapter's stdin-EOF guard is the
    // only thing keeping that from hanging until the op timeout.
    fs.writeFileSync(
      path.join(binDir, "gbrain"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${argvLog}"
case "$1" in
  put) cat > "${stdinLog}"; echo "stored $2"; exit 0;;
  delete) read -r _confirm; echo "deleted $2"; exit 0;;
  export) printf 'line-one\\nline-two\\n'; exit 0;;
esac
exit 1
`,
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("add() pipes the document body to `put <slug>` on stdin and receipts the body's sha256", async () => {
    const body = "# curated memory\nthe exact body bytes\n";
    const s = await new GbrainProvider().add({ slug: "my-doc", body }, { env: env(), consented: true });
    expect(s).toEqual({ id: "my-doc", state: "ready" });
    expect(fs.readFileSync(argvLog, "utf-8").trim()).toBe("put my-doc");
    // The body reached gbrain via stdin, byte-for-byte (not argv, not a temp file).
    expect(fs.readFileSync(stdinLog, "utf-8")).toBe(body);
    const lines = ledgerLines();
    expect(lines.length).toBe(1);
    expect(lines[0].sink).toBe("gbrain");
    expect(String(lines[0].payload_class)).toContain("document-body");
    expect(String(lines[0].consent)).toContain("consented=true");
    expect(lines[0].sha256).toBe(sha256Hex(body));
    expect(lines[0].bytes).toBe(Buffer.byteLength(body));
  });

  test("add() asserts consent: unconsented add is refused BEFORE the subprocess runs, no receipt", async () => {
    await expect(new GbrainProvider().add({ slug: "s", body: "secret body" }, { env: env() })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
    expect(fs.existsSync(argvLog)).toBe(false); // the body never left the machine
    expect(ledgerLines()).toEqual([]);
  });

  test("delete() survives a confirmation prompt via the stdin-EOF guard (never hangs)", async () => {
    // Shim blocks on `read` — with the adapter's input:"" the read gets EOF
    // instantly. A regression to inherited/open stdin fails here at the 5s
    // op timeout (PROVIDER_TIMEOUT) instead of returning state=absent.
    const s = await new GbrainProvider().delete("stale-doc", { env: env(), timeout: 5_000 });
    expect(s).toEqual({ id: "stale-doc", state: "absent" });
    expect(fs.readFileSync(argvLog, "utf-8").trim()).toBe("delete stale-doc");
  });

  test("export() returns the CLI's stdout verbatim (multi-line, unparsed)", async () => {
    const body = await new GbrainProvider().export({ id: "code" }, { env: env(), consented: true });
    expect(body).toBe("line-one\nline-two\n");
    expect(fs.readFileSync(argvLog, "utf-8").trim()).toBe("export");
  });

  test("add/delete/export each degrade to PROVIDER_UNAVAILABLE when the CLI is absent", async () => {
    const missing = { PATH: os.tmpdir(), HOME: home, GSTACK_HOME: home };
    const g = new GbrainProvider();
    await expect(g.add({ slug: "s", body: "b" }, { env: missing, consented: true })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    await expect(g.delete("s", { env: missing })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(g.export({ id: "code" }, { env: missing, consented: true })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});

// ── CLI rendering surfaces: options / status / suggest --json ───────────────
// The human/agent-facing renderers had zero reach: pin that `options` lists
// the three providers with availability rows (GBrain first), `status` renders
// the persisted selection + per-provider availability, and `suggest --json`
// emits the machine-readable offer/reason contract.
describe("CLI rendering (options / status / suggest --json)", () => {
  const CLI = path.join(import.meta.dir, "..", "bin", "gstack-code-intelligence");
  let home: string;
  let shimDir: string;
  let env: NodeJS.ProcessEnv;

  function runCli(...args: string[]) {
    return spawnSync("bun", [CLI, ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      env: env as Record<string, string>,
    });
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-cli-render-"));
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-cli-render-bin-"));
    // Fake gbrain satisfies the FULL localEngineStatus probe chain (--version
    // resolution + `sources list --json` liveness) so the GBrain row is
    // deterministically available; config.json lives in the temp GBRAIN_HOME
    // so the operator's real ~/.gbrain is never read.
    fs.writeFileSync(
      path.join(shimDir, "gbrain"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "gbrain 0.42.0"; exit 0; fi
if [ "$1" = "sources" ]; then echo '{"sources":[]}'; exit 0; fi
exit 1
`,
      { mode: 0o755 },
    );
    const gbrainHome = path.join(home, ".gbrain");
    fs.mkdirSync(gbrainHome, { recursive: true });
    fs.writeFileSync(path.join(gbrainHome, "config.json"), JSON.stringify({ engine: "pglite" }));
    env = {
      ...process.env,
      GSTACK_HOME: home,
      HOME: home,
      // #2521: GBRAIN_HOME is the PARENT of .gbrain per gbrain's configDir()
      // contract — pointing it at `home` resolves to home/.gbrain/config.json.
      GBRAIN_HOME: home,
      PATH: `${shimDir}:${process.env.PATH}`,
      // Dead loopback port → the Sourcebot probe fails fast + deterministically
      // (connection refused) instead of poking whatever operator dev server
      // happens to sit on localhost:3000.
      SOURCEBOT_URL: "http://127.0.0.1:1",
    };
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  function makeRepoWithFiles(count: number): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-cli-suggest-"));
    Bun.spawnSync(["git", "init", "-q", repo]);
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(repo, `f${i}.ts`), "x\n");
    Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
    return repo;
  }

  test("options lists the three providers with availability rows, GBrain first", () => {
    const res = runCli("options");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Code-intelligence providers");
    // GBrain row: recommended marker + deterministically available via the shim.
    expect(res.stdout).toMatch(/\* GBrain\s+\[available\]/);
    expect(res.stdout).toContain("gbrain engine: ok");
    // Sourcebot row: dead loopback port → not available, probe detail rendered.
    expect(res.stdout).toMatch(/Sourcebot\s+\[not available\]/);
    expect(res.stdout).toContain("unreachable at http://127.0.0.1:1");
    // Graphify row renders an availability mark either way (the operator
    // machine may or may not have graphify installed).
    expect(res.stdout).toMatch(/Graphify\s+\[(available|not available)\]/);
    // Rows come out in recommendation order (GBrain → Sourcebot → Graphify).
    const at = ["GBrain", "Sourcebot", "Graphify"].map((s) => res.stdout.indexOf(s));
    expect(at[0]).toBeGreaterThan(-1);
    expect(at[0]).toBeLessThan(at[1]);
    expect(at[1]).toBeLessThan(at[2]);
    expect(res.stdout).toContain("select <provider>");
  });

  test("status renders the provider-OFF selection and per-provider availability", () => {
    const res = runCli("status");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("selected: none (grep / file-only fallback)");
    expect(res.stdout).toContain("GBrain: available (gbrain engine: ok)");
    expect(res.stdout).toContain("Sourcebot: unavailable (unreachable at http://127.0.0.1:1)");
    expect(res.stdout).toMatch(/Graphify: (available|unavailable)/);
  });

  test("status renders a persisted selection", () => {
    setProvider("gbrain", env);
    const res = runCli("status");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("selected: gbrain");
  });

  test("suggest --json: small repo → machine-readable offer:false / reason:small-repo", () => {
    const repo = makeRepoWithFiles(3);
    try {
      const res = runCli("suggest", repo, "--json");
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(parsed).toEqual({
        offer: false,
        reason: "small-repo",
        fileCount: 3,
        threshold: LARGE_REPO_FILE_THRESHOLD,
        repoPath: repo,
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("suggest --json: large repo → offer:true with self-contained provider options", () => {
    const repo = makeRepoWithFiles(LARGE_REPO_FILE_THRESHOLD);
    try {
      const res = runCli("suggest", repo, "--json");
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout) as {
        offer: boolean;
        reason: string;
        fileCount: number;
        options: Array<{ id: string; label: string; reason: string; local: boolean; available: boolean; detail: string }>;
      };
      expect(parsed.offer).toBe(true);
      expect(parsed.reason).toBe("large-repo");
      expect(parsed.fileCount).toBe(LARGE_REPO_FILE_THRESHOLD);
      // The offer is self-contained: every provider option carries the fields
      // an agent needs to render the question without a second CLI call.
      expect(parsed.options.map((o) => o.id)).toEqual(["gbrain", "sourcebot", "graphify"]);
      for (const o of parsed.options) {
        expect(typeof o.label).toBe("string");
        expect(typeof o.reason).toBe("string");
        expect(typeof o.local).toBe("boolean");
        expect(typeof o.available).toBe("boolean");
        expect(typeof o.detail).toBe("string");
      }
      const gbrain = parsed.options[0];
      expect(gbrain.label).toBe("GBrain");
      expect(gbrain.local).toBe(false);
      expect(gbrain.available).toBe(true);
      expect(gbrain.detail).toContain("gbrain engine:");
      const sourcebot = parsed.options[1];
      expect(sourcebot.local).toBe(true); // loopback SOURCEBOT_URL
      expect(sourcebot.available).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── picker probes: concurrent, short-timeout, never a 30s CLI stall ─────────
describe("detectAvailable probes fast even when Sourcebot is a dead non-loopback host", () => {
  test("rows come back in recommendation order, well under the old 30s stall", async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pick-bin-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pick-home-"));
    // localEngineStatus writes its probe cache via process.env.GSTACK_HOME —
    // point it at the temp home for the duration so nothing touches ~/.gstack.
    const prevGstackHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = homeDir;
    try {
      // PATH-scoped fake gbrain; graphify deliberately absent from that PATH.
      fs.writeFileSync(
        path.join(binDir, "gbrain"),
        `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "gbrain 0.42.0"; exit 0; fi
if [ "$1" = "sources" ]; then echo '{"sources":[]}'; exit 0; fi
exit 1
`,
        { mode: 0o755 },
      );
      const env: NodeJS.ProcessEnv = { PATH: binDir, HOME: homeDir, GSTACK_HOME: homeDir };
      // A hanging fetch that only settles on abort — the 3s probe cap must cut
      // it off; with the adapters' 30s default this test would blow its budget.
      const hangingFetch = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        })) as unknown as typeof fetch;
      const t0 = Date.now();
      const rows = await detectAvailable({
        env,
        sourcebot: { baseUrl: "http://sb.internal.example:3000", fetch: hangingFetch },
      });
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(rows.map((r) => r.id)).toEqual(["gbrain", "sourcebot", "graphify"]);
      const gbrain = rows.find((r) => r.id === "gbrain")!;
      expect(gbrain.detail).toContain("gbrain engine:");
      const sourcebot = rows.find((r) => r.id === "sourcebot")!;
      expect(sourcebot.available).toBe(false);
      const graphify = rows.find((r) => r.id === "graphify")!;
      expect(graphify.available).toBe(false); // not on the scoped PATH
      expect(graphify.detail).toContain("not installed");
    } finally {
      if (prevGstackHome === undefined) delete process.env.GSTACK_HOME;
      else process.env.GSTACK_HOME = prevGstackHome;
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20_000);
});
