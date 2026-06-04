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

  test("checkpoint + staging dir exists → resume verdict", () => {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(stagingDir + "/page1.md", "content", "utf-8");
    fs.writeFileSync(cpPath, JSON.stringify({
      dir: stagingDir,
      totalFiles: 1989,
      processedIndex: 1000,
      completedFiles: 1000,
      timestamp: "2026-05-19T19:30:05.008Z",
    }), "utf-8");

    const v = decideResume();
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

    const v = decideResume();
    expect(v.kind).toBe("stale-staging-missing");
    if (v.kind === "stale-staging-missing") {
      expect(v.stagingDir).toBe(stagingDir);
    }
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
    expect(body).toMatch(/previous checkpoint stale.*staging dir.*gone.*restaging from scratch/);
  });
});
