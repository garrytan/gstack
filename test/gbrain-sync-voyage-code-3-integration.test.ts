/**
 * Real integration: gbrain PGLite + voyage-code-3 end-to-end.
 *
 * Inits a sandboxed PGLite engine with voyage-code-3 embeddings, registers a
 * tiny code fixture as a source, syncs it (which triggers Voyage embedding
 * generation), and queries it back. The whole point is to catch the failure
 * modes that hit us in real life:
 *
 *   - dimension mismatch between the configured embedding column and the
 *     model's actual output dim (the 1280-vs-1536 trap that gbrain doctor
 *     surfaces but `gbrain init` silently sets up)
 *   - voyage-code-3 unavailable via gbrain's openai-compat adapter
 *   - sync completes but embedding generation silently fails (0 chunks)
 *
 * We intentionally do NOT call `gbrain query` here — it produces correct
 * output but doesn't exit cleanly on a fresh PGLite (~2 min hang after
 * results print). The smoking-gun assertion for "embeddings worked" is the
 * "N pages embedded" line from sync output: if that's >= 1, voyage-code-3
 * returned 1024-dim vectors and gbrain persisted them. Symbol-aware
 * functionality is covered separately by the code-def test.
 *
 * Skips when:
 *   - `gbrain` is not on PATH (dev machine without it installed)
 *   - VOYAGE_API_KEY is unset (the test makes real Voyage API calls)
 *
 * Cost: ~$0.001 per run. The fixture is 3 tiny files, ~500 tokens total.
 * Not gated on EVALS=1 because it's not an LLM eval — it's a deterministic
 * integration test of the embedding pipeline. Always runs when the env
 * supports it.
 *
 * Runtime: ~30-60s (gbrain init schema migrations + sync + Voyage round-trip).
 * Long enough that `bun test` runs it serially with a per-test 120s timeout.
 */

import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const gbrainPath = spawnSync("which", ["gbrain"], { encoding: "utf-8" }).stdout.trim();
const gbrainAvailable = gbrainPath.length > 0;
const voyageKey = process.env.VOYAGE_API_KEY?.trim() ?? "";
const voyageKeyPresent = voyageKey.length > 0;

const shouldRun = gbrainAvailable && voyageKeyPresent;
const skipReason = !gbrainAvailable
  ? "gbrain not on PATH"
  : !voyageKeyPresent
    ? "VOYAGE_API_KEY not set (real Voyage API calls required)"
    : "";

if (!shouldRun) {
  console.log(`[gbrain-sync-voyage-code-3-integration] SKIP: ${skipReason}`);
}

interface SandboxEnv {
  root: string;
  gbrainHome: string;
  fixtureDir: string;
  cleanup: () => void;
}

function makeSandbox(): SandboxEnv {
  const root = mkdtempSync(join(tmpdir(), "gbrain-voyage-int-"));
  // GBRAIN_HOME points at the PARENT of .gbrain (per gbrain's configDir());
  // setting GBRAIN_HOME=/x means gbrain looks at /x/.gbrain/.
  const gbrainHome = root;
  const fixtureDir = join(root, "fixture-repo");
  mkdirSync(fixtureDir, { recursive: true });

  // Tiny realistic fixture: three files exercising different file types so
  // gbrain's code stage has something to extract symbols + embeddings from.
  writeFileSync(
    join(fixtureDir, "math.ts"),
    `export function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

export function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false;
  }
  return true;
}
`,
  );
  writeFileSync(
    join(fixtureDir, "queue.ts"),
    `export class JobQueue<T> {
  private items: T[] = [];
  enqueue(item: T): void { this.items.push(item); }
  dequeue(): T | undefined { return this.items.shift(); }
  size(): number { return this.items.length; }
}
`,
  );
  writeFileSync(
    join(fixtureDir, "README.md"),
    `# Fixture repo

Sample code for testing the voyage-code-3 embedding pipeline.
The math module exposes fibonacci and primality helpers.
The queue module is a simple FIFO job queue.
`,
  );

  // Make it a git repo because gbrain's code-sync strategy expects one.
  const gitInit = spawnSync("git", ["init", "-q"], { cwd: fixtureDir, encoding: "utf-8" });
  if (gitInit.status !== 0) {
    throw new Error(`git init failed: ${gitInit.stderr}`);
  }
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixtureDir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: fixtureDir });
  spawnSync("git", ["add", "."], { cwd: fixtureDir });
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: fixtureDir });

  return {
    root,
    gbrainHome,
    fixtureDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function gbrainEnv(s: SandboxEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GBRAIN_HOME: s.gbrainHome,
    VOYAGE_API_KEY: voyageKey,
  };
}

function runGbrain(s: SandboxEnv, args: string[], opts: { timeout?: number } = {}) {
  // cwd MUST be the sandbox root, not the test's parent CWD. If gbrain runs
  // from inside the gstack worktree, it picks up the worktree's
  // `.gbrain-source` pin and tries to sync that source too — which won't
  // exist in the sandbox PGLite, and the resulting "not found" exits 1.
  return spawnSync("gbrain", args, {
    encoding: "utf-8",
    env: gbrainEnv(s),
    cwd: s.root,
    timeout: opts.timeout ?? 120_000,
  });
}

describe.skipIf(!shouldRun)(
  "gbrain PGLite + voyage-code-3 end-to-end (real Voyage API)",
  () => {
    test(
      "init with voyage-code-3 produces a 1024-dim-aligned PGLite config",
      () => {
        const s = makeSandbox();
        try {
          const init = runGbrain(s, [
            "init",
            "--pglite",
            "--json",
            "--embedding-model",
            "voyage:voyage-code-3",
            "--embedding-dimensions",
            "1024",
          ]);
          expect(init.status).toBe(0);
          // init prints JSON status line at the end; just sniff for success.
          const out = (init.stdout || "") + (init.stderr || "");
          expect(out).toContain('"status":"success"');
          expect(out).toContain('"engine":"pglite"');

          // doctor must agree the column width matches the live probe dim.
          const doctor = runGbrain(s, ["doctor"]);
          const dout = (doctor.stdout || "") + (doctor.stderr || "");
          // Doctor exits non-zero on error rows; warnings are OK. The
          // critical assertion is no dimension mismatch.
          expect(dout).not.toContain("DB dimension mismatch");
          // Should explicitly mention voyage-code-3 as the live provider.
          expect(dout).toMatch(/voyage-code-3/);
          // Width consistency check should be green for 1024d.
          expect(dout).toMatch(/Schema width \(1024d\)/);
        } finally {
          s.cleanup();
        }
      },
      120_000,
    );

    test(
      "sync --strategy code generates Voyage embeddings and registers pages + chunks",
      () => {
        const s = makeSandbox();
        try {
          // 1. init voyage-code-3 PGLite
          const init = runGbrain(s, [
            "init",
            "--pglite",
            "--json",
            "--embedding-model",
            "voyage:voyage-code-3",
            "--embedding-dimensions",
            "1024",
          ]);
          expect(init.status).toBe(0);

          // 2. register the fixture as a code source
          const add = runGbrain(s, [
            "sources",
            "add",
            "fixture-code",
            "--path",
            s.fixtureDir,
          ]);
          expect(add.status).toBe(0);

          // 3. sync with code strategy — this is where Voyage embeddings get
          // generated. Use --skip-failed so a single oversized file (which
          // can happen in real repos) doesn't block the assertion.
          const sync = runGbrain(
            s,
            [
              "sync",
              "--source",
              "fixture-code",
              "--strategy",
              "code",
              "--skip-failed",
            ],
            { timeout: 180_000 },
          );
          if (sync.status !== 0) {
            console.error(`[sync FAILED exit=${sync.status}]`);
            console.error(`STDOUT:\n${sync.stdout}`);
            console.error(`STDERR:\n${sync.stderr}`);
          }
          expect(sync.status).toBe(0);
          const sout = (sync.stdout || "") + (sync.stderr || "");
          // The fixture has 3 files; gbrain should import at least the 2 .ts
          // files (README.md may or may not be picked up by --strategy code
          // depending on gbrain's file-type heuristics).
          expect(sout).toMatch(/imported=[1-9]/);
          // The "pages embedded" line is the smoking gun: if it's 0,
          // embedding generation silently failed (voyage adapter broken,
          // dimension mismatch, etc). Anything > 0 means voyage-code-3
          // returned 1024-dim vectors and gbrain wrote them.
          expect(sout).toMatch(/[1-9]\d* pages embedded/);

          // 4. verify the source has pages and chunks
          const list = runGbrain(s, ["sources", "list", "--json"]);
          expect(list.status).toBe(0);
          const sources = JSON.parse(list.stdout) as {
            sources: Array<{ id: string; page_count: number }>;
          };
          const fixture = sources.sources.find((x) => x.id === "fixture-code");
          expect(fixture).toBeDefined();
          expect(fixture!.page_count).toBeGreaterThanOrEqual(2);
        } finally {
          s.cleanup();
        }
      },
      300_000,
    );

    test(
      "code-def finds symbols defined in the embedded fixture",
      () => {
        const s = makeSandbox();
        try {
          runGbrain(s, [
            "init",
            "--pglite",
            "--json",
            "--embedding-model",
            "voyage:voyage-code-3",
            "--embedding-dimensions",
            "1024",
          ]);
          runGbrain(s, ["sources", "add", "fixture-code", "--path", s.fixtureDir]);
          runGbrain(
            s,
            ["sync", "--source", "fixture-code", "--strategy", "code", "--skip-failed"],
            { timeout: 180_000 },
          );

          // code-def is the symbol-aware path. It doesn't strictly need
          // embeddings (symbols are extracted by tree-sitter), but the JSON
          // shape it returns is the contract gstack's CLAUDE.md guidance
          // points the agent at. Verify it works against our PGLite + Voyage
          // setup.
          const result = runGbrain(s, ["code-def", "fibonacci"]);
          expect(result.status).toBe(0);
          const parsed = JSON.parse(result.stdout) as {
            symbol: string;
            count: number;
            results: Array<{ file: string; symbol_type: string }>;
          };
          expect(parsed.symbol).toBe("fibonacci");
          expect(parsed.count).toBeGreaterThanOrEqual(1);
          expect(parsed.results[0].file).toContain("math.ts");
        } finally {
          s.cleanup();
        }
      },
      300_000,
    );
  },
);

// Lightweight always-on guard: even without the integration test running, we
// can still assert that the test file's `describe.skipIf` gate is correctly
// formed. This catches a future edit that accidentally inverts the gate.
test("integration test gate uses the correct skip predicate", () => {
  // shouldRun must be the boolean AND of the two pre-checks. If a refactor
  // makes it true when either piece is missing, the test below would attempt
  // real API calls without a key — undefined behavior.
  expect(shouldRun).toBe(gbrainAvailable && voyageKeyPresent);
  // When skipping, we logged a reason — basic sanity that the reason string
  // matches what shouldRun says.
  if (!shouldRun) {
    expect(skipReason.length).toBeGreaterThan(0);
  }
});
