/**
 * Regression tests for #1611 — /sync-gbrain --full SIGTERM at hardcoded 35min,
 * no resume from gbrain's import-checkpoint.
 *
 * Tests cover three surfaces:
 *   - resolveStageTimeoutMs (gstack-gbrain-sync.ts) — env parsing + bounds
 *   - decideResume          (gstack-gbrain-sync.ts) — checkpoint+staging detection
 *   - SIGTERM staging preservation invariants in gstack-memory-ingest.ts
 *
 * The resolveStageTimeoutMs + decideResume helpers are exported from the
 * source file so we can call them directly. The SIGTERM behavior is pinned
 * via static-invariant checks against the source body — the signal handler
 * is hard to exercise in a unit test without forking, and the static check
 * is the durable guarantee.
 *
 * Branches under test (9 total):
 *   1. parseTimeoutEnv default (env unset → 2_100_000)
 *   2. parseTimeoutEnv non-numeric → warn + default
 *   3. parseTimeoutEnv below floor (<60_000) → warn + default
 *   4. parseTimeoutEnv above ceiling (>86_400_000) → warn + default
 *   5. parseTimeoutEnv valid mid-range → returns value
 *   6. decideResume: no checkpoint → no-checkpoint verdict
 *   7. decideResume: checkpoint + staging exists → resume verdict
 *   8. decideResume: checkpoint + staging missing → stale-staging-missing
 *   9. SIGTERM preserves staging dir when gbrain checkpoint points at it
 *      (static invariant on memory-ingest source)
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  resolveStageTimeoutMs,
  readGbrainCheckpoint,
  decideResume,
} from "../bin/gstack-gbrain-sync";
import { checkOwnedStagingDir, STAGING_MARKER } from "../lib/staging-guard";

const ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_MS = 35 * 60 * 1000;
const MIN_MS = 60_000;
const MAX_MS = 86_400_000;

describe("#1611 resolveStageTimeoutMs — env parsing + bounds", () => {
  test("undefined env → default 2_100_000ms (unchanged from prior behavior)", () => {
    expect(resolveStageTimeoutMs(undefined, "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(DEFAULT_MS);
  });

  test("empty string env → default", () => {
    expect(resolveStageTimeoutMs("", "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(DEFAULT_MS);
  });

  test("non-numeric env → warn + default", () => {
    expect(resolveStageTimeoutMs("not-a-number", "GSTACK_SYNC_CODE_TIMEOUT_MS")).toBe(DEFAULT_MS);
  });

  test("zero env → warn + default (not positive)", () => {
    expect(resolveStageTimeoutMs("0", "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(DEFAULT_MS);
  });

  test("negative env → warn + default", () => {
    expect(resolveStageTimeoutMs("-1000", "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(DEFAULT_MS);
  });

  test("below 60_000ms floor (1min) → warn + default", () => {
    expect(resolveStageTimeoutMs("30000", "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(DEFAULT_MS);
    expect(resolveStageTimeoutMs(`${MIN_MS - 1}`, "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(DEFAULT_MS);
  });

  test("above 86_400_000ms ceiling (24h) → warn + default", () => {
    expect(resolveStageTimeoutMs(`${MAX_MS + 1}`, "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(DEFAULT_MS);
    expect(resolveStageTimeoutMs("999999999999", "GSTACK_SYNC_CODE_TIMEOUT_MS")).toBe(DEFAULT_MS);
  });

  test("at floor (60_000ms exactly) → accepted", () => {
    expect(resolveStageTimeoutMs(`${MIN_MS}`, "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(MIN_MS);
  });

  test("at ceiling (86_400_000ms exactly) → accepted", () => {
    expect(resolveStageTimeoutMs(`${MAX_MS}`, "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(MAX_MS);
  });

  test("valid mid-range (2h = 7_200_000ms) → returns value", () => {
    expect(resolveStageTimeoutMs("7200000", "GSTACK_SYNC_MEMORY_TIMEOUT_MS")).toBe(7_200_000);
  });
});

// decideResume + readGbrainCheckpoint exercise ~/.gbrain/import-checkpoint.json
// and the staging dir on disk. We point HOME at a tmp dir, write fake state,
// and assert verdicts.

describe("#1611 decideResume — checkpoint + staging detection", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let cpDir: string;
  let cpPath: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-1611-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    cpDir = path.join(tmpHome, ".gbrain");
    cpPath = path.join(cpDir, "import-checkpoint.json");
    stagingDir = path.join(tmpHome, ".staging-ingest-99-99");
    fs.mkdirSync(cpDir, { recursive: true });
  });

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("no checkpoint file → no-checkpoint verdict", () => {
    // cpPath does not exist
    expect(fs.existsSync(cpPath)).toBe(false);
    expect(readGbrainCheckpoint()).toBeNull();
    expect(decideResume().kind).toBe("no-checkpoint");
  });

  test("corrupt JSON checkpoint → no-checkpoint verdict", () => {
    fs.writeFileSync(cpPath, "{not valid json", "utf-8");
    expect(readGbrainCheckpoint()).toBeNull();
    expect(decideResume().kind).toBe("no-checkpoint");
  });

  test("checkpoint + minted staging dir exists → resume verdict", () => {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(stagingDir + "/page1.md", "content", "utf-8");
    // #1802: a real staging dir carries the ownership marker minted by makeStagingDir.
    fs.writeFileSync(path.join(stagingDir, STAGING_MARKER), "99\n99\n", "utf-8");
    fs.writeFileSync(cpPath, JSON.stringify({
      dir: stagingDir,
      totalFiles: 1989,
      processedIndex: 1000,
      completedFiles: 1000,
      timestamp: "2026-05-19T19:30:05.008Z",
    }), "utf-8");

    // gstackHome is injected so the ownership check anchors on the test home.
    const v = decideResume(tmpHome);
    expect(v.kind).toBe("resume");
    if (v.kind === "resume") {
      expect(v.stagingDir).toBe(stagingDir);
      expect(v.processedIndex).toBe(1000);
      expect(v.totalFiles).toBe(1989);
    }
  });

  test("checkpoint references missing staging dir → stale-staging-missing", () => {
    // Note: stagingDir is NOT created on disk for this test
    fs.writeFileSync(cpPath, JSON.stringify({
      dir: stagingDir,
      totalFiles: 1989,
      processedIndex: 1000,
    }), "utf-8");

    const v = decideResume(tmpHome);
    expect(v.kind).toBe("stale-staging-missing");
    if (v.kind === "stale-staging-missing") {
      expect(v.stagingDir).toBe(stagingDir);
    }
  });

  // ── #1802 regression: poisoned checkpoint must never be adopted/deleted ────

  test("#1802 checkpoint.dir = repo root with .git → stale-staging-missing (not resumed)", () => {
    // Reproduces the exact poison: an interrupted import wrote checkpoint.dir =
    // the repo working tree. It exists and is a directory, so the pre-#1802
    // code resumed (and cleanup later rm -rf'd it). It must now be refused.
    const repoRoot = path.join(tmpHome, "my-repo");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "important.py"), "# real work\n", "utf-8");
    fs.writeFileSync(cpPath, JSON.stringify({ dir: repoRoot, totalFiles: 10, processedIndex: 3 }), "utf-8");

    const v = decideResume(tmpHome);
    expect(v.kind).toBe("stale-staging-missing");
    // decideResume never deletes, but prove the repo is untouched by the verdict.
    expect(fs.existsSync(path.join(repoRoot, "important.py"))).toBe(true);
  });

  test("#1802 staging-named dir WITHOUT marker → stale-staging-missing (not minted by us)", () => {
    fs.mkdirSync(stagingDir, { recursive: true }); // .staging-ingest-99-99, but no marker
    fs.writeFileSync(cpPath, JSON.stringify({ dir: stagingDir, totalFiles: 1, processedIndex: 0 }), "utf-8");
    expect(decideResume(tmpHome).kind).toBe("stale-staging-missing");
  });

  test("#1802 checkpoint.dir = '/' → stale-staging-missing", () => {
    fs.writeFileSync(cpPath, JSON.stringify({ dir: "/", totalFiles: 1, processedIndex: 0 }), "utf-8");
    expect(decideResume(tmpHome).kind).toBe("stale-staging-missing");
  });

  test("checkpoint with no dir field → no-checkpoint verdict", () => {
    fs.writeFileSync(cpPath, JSON.stringify({
      totalFiles: 1989,
      processedIndex: 1000,
    }), "utf-8");

    expect(decideResume().kind).toBe("no-checkpoint");
  });

  test("checkpoint with empty dir string → no-checkpoint verdict", () => {
    fs.writeFileSync(cpPath, JSON.stringify({
      dir: "",
    }), "utf-8");

    expect(decideResume().kind).toBe("no-checkpoint");
  });
});

describe("#1611 SIGTERM staging preservation — static invariants", () => {
  test("memory-ingest signal handler checks stagingDirIsCheckpointed before cleanup", () => {
    const body = fs.readFileSync(
      path.join(ROOT, "bin", "gstack-memory-ingest.ts"),
      "utf-8",
    );
    // The forward handler must read the checkpoint before deciding whether
    // to clean up. Locks in the "preserve when checkpointed" branch.
    expect(body).toMatch(/stagingDirIsCheckpointed/);
    expect(body).toMatch(/preserving staging dir for resume/);
    // The branch order must be: checkpointed → preserve, else → cleanup
    const handlerStart = body.indexOf("if (_activeStagingDir)");
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerSlice = body.slice(handlerStart, handlerStart + 1000);
    const preserveAt = handlerSlice.indexOf("preserving staging dir for resume");
    const cleanupAt = handlerSlice.indexOf("cleanupStagingDir");
    expect(preserveAt).toBeGreaterThan(-1);
    expect(cleanupAt).toBeGreaterThan(-1);
    expect(preserveAt).toBeLessThan(cleanupAt);
  });

  test("memory-ingest reads GSTACK_INGEST_RESUME_DIR env to reuse staging dir", () => {
    const body = fs.readFileSync(
      path.join(ROOT, "bin", "gstack-memory-ingest.ts"),
      "utf-8",
    );
    expect(body).toMatch(/process\.env\.GSTACK_INGEST_RESUME_DIR/);
    expect(body).toMatch(/skipping prepare phase/);
  });

  test("gbrain-sync orchestrator passes GSTACK_INGEST_RESUME_DIR to grandchild on resume", () => {
    const body = fs.readFileSync(
      path.join(ROOT, "bin", "gstack-gbrain-sync.ts"),
      "utf-8",
    );
    expect(body).toMatch(/GSTACK_INGEST_RESUME_DIR/);
    expect(body).toMatch(/resuming from gbrain checkpoint/);
    expect(body).toMatch(/previous checkpoint stale/);
    expect(body).toMatch(/restaging from scratch/);
    // #1802: the caller distinguishes "refused as unowned" from "actually gone".
    expect(body).toMatch(/staging dir not usable/);
  });
});

// ── #1802 checkOwnedStagingDir — fail-closed ownership matrix ───────────────
// The single predicate guarding both the resume gate (decideResume) and the
// deletion chokepoint (cleanupStagingDir). Every branch is fail-closed: any
// case it cannot prove is owned must return ok:false.
describe("#1802 checkOwnedStagingDir — ownership matrix", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-1802-"));
  });
  afterEach(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function mintStaging(name = ".staging-ingest-1-1"): string {
    const d = path.join(home, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, STAGING_MARKER), "1\n1\n", "utf-8");
    return d;
  }

  test("minted staging dir → ok", () => {
    expect(checkOwnedStagingDir(mintStaging(), home).ok).toBe(true);
  });

  test("repo root (direct child, has .git, no marker) → refused", () => {
    const repo = path.join(home, "my-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(checkOwnedStagingDir(repo, home).ok).toBe(false);
  });

  test("staging-named dir containing .git → refused by tripwire even with marker", () => {
    const d = mintStaging(".staging-ingest-9-9");
    fs.mkdirSync(path.join(d, ".git"), { recursive: true });
    const v = checkOwnedStagingDir(d, home);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/\.git/);
  });

  test("staging-named dir without marker → refused (not minted)", () => {
    const d = path.join(home, ".staging-ingest-2-2");
    fs.mkdirSync(d, { recursive: true });
    expect(checkOwnedStagingDir(d, home).ok).toBe(false);
  });

  test("right name but NOT a direct child of home → refused", () => {
    const nested = path.join(home, "sub", ".staging-ingest-3-3");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, STAGING_MARKER), "x", "utf-8");
    expect(checkOwnedStagingDir(nested, home).ok).toBe(false);
  });

  test("direct child of home but wrong name → refused", () => {
    const d = path.join(home, "notstaging");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, STAGING_MARKER), "x", "utf-8");
    expect(checkOwnedStagingDir(d, home).ok).toBe(false);
  });

  test("missing path → refused (unresolvable)", () => {
    expect(checkOwnedStagingDir(path.join(home, ".staging-ingest-gone"), home).ok).toBe(false);
  });

  test("'/' and '' → refused", () => {
    expect(checkOwnedStagingDir("/", home).ok).toBe(false);
    expect(checkOwnedStagingDir("", home).ok).toBe(false);
  });

  test("symlink whose target escapes home → refused (realpath resolves first)", () => {
    const outside = path.join(home, "..", path.basename(home) + "-outside");
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(home, ".staging-ingest-link");
    fs.symlinkSync(outside, link);
    try {
      // realpathSync resolves the link to `outside`, whose parent is not `home`.
      expect(checkOwnedStagingDir(link, home).ok).toBe(false);
    } finally {
      try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test("cleanupStagingDir + decideResume both call the guard (static invariant)", () => {
    const ingest = fs.readFileSync(path.join(ROOT, "bin", "gstack-memory-ingest.ts"), "utf-8");
    const sync = fs.readFileSync(path.join(ROOT, "bin", "gstack-gbrain-sync.ts"), "utf-8");
    expect(ingest).toMatch(/checkOwnedStagingDir\(dir, GSTACK_HOME\)/);
    expect(ingest).toMatch(/staging cleanup REFUSED/);
    expect(sync).toMatch(/checkOwnedStagingDir\(stagingDir, gstackHome\)/);
  });
});
