/**
 * Tests for lib/gstack-decision-semantic.ts — the OPTIONAL gbrain enhancement.
 *
 * The load-bearing contract is DEGRADE-TO-NULL: when gbrain is absent/errors, every
 * entry point returns null (caller shows reliable file results), never throws, never
 * hangs. We also pin the text-surface parser deterministically and prove the
 * end-to-end scope+search path with a fake `gbrain` shim on PATH (no live gbrain).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseSearchHits,
  resolveMemorySourceId,
  semanticRecall,
} from "../lib/gstack-decision-semantic";

describe("parseSearchHits (text surface)", () => {
  const sample = [
    "[0.91] decisions/foo -- We chose PGLite for the local engine",
    "a banner line that is not a hit",
    "",
    "[0.42] docs/bar -- Some other relevant snippet",
    "[0.05] noise/baz -- below the threshold",
  ].join("\n");

  test("parses scored lines, skips non-hit lines", () => {
    const hits = parseSearchHits(sample, 0.1, 10);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ score: 0.91, slug: "decisions/foo", snippet: "We chose PGLite for the local engine" });
    expect(hits[1].slug).toBe("docs/bar");
  });

  test("applies minScore floor", () => {
    expect(parseSearchHits(sample, 0.5, 10)).toHaveLength(1);
  });

  test("applies limit", () => {
    expect(parseSearchHits(sample, 0.0, 1)).toHaveLength(1);
  });

  test("empty / garbage input yields no hits (no throw)", () => {
    expect(parseSearchHits("", 0.1, 10)).toEqual([]);
    expect(parseSearchHits("not a hit at all\n???", 0.1, 10)).toEqual([]);
  });
});

describe("degrade-to-null contract (gbrain absent)", () => {
  // HOME without ~/.gbrain so buildGbrainEnv doesn't seed a DB; PATH without gbrain.
  const absentEnv = { PATH: "/nonexistent-bin-dir", HOME: os.tmpdir() };

  test("semanticRecall returns null on empty query (no spawn)", () => {
    expect(semanticRecall("   ", absentEnv)).toBeNull();
  });

  test("semanticRecall returns null when gbrain is not on PATH", () => {
    expect(semanticRecall("pglite", absentEnv)).toBeNull();
  });

  test("resolveMemorySourceId returns null when gbrain is not on PATH", () => {
    expect(resolveMemorySourceId(absentEnv)).toBeNull();
  });
});

describe("end-to-end with a fake gbrain shim", () => {
  let binDir: string;
  let homeDir: string;

  function writeShim(body: string): void {
    const p = path.join(binDir, "gbrain");
    fs.writeFileSync(p, body, { mode: 0o755 });
    fs.chmodSync(p, 0o755);
  }
  function env(): NodeJS.ProcessEnv {
    // Keep the real PATH so /usr/bin/env + bash resolve; prepend the shim dir.
    return { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir };
  }

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-shim-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-home-"));
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test("resolves the worktree-backed source and scopes search to it", () => {
    writeShim(
      `#!/usr/bin/env bash
if [ "$1" = "sources" ]; then
  echo '{"sources":[{"id":"code","local_path":"/repo","page_count":100},{"id":"default","local_path":"/u/.gstack-brain-worktree","page_count":3}]}'
  exit 0
fi
if [ "$1" = "search" ]; then
  if printf '%s ' "$@" | grep -q -- "--source default"; then
    echo "[0.91] decisions/foo -- We chose PGLite for the local engine"
  else
    echo "[0.91] WRONG-SOURCE -- unscoped fallback"
  fi
  echo "[0.05] noise/baz -- below threshold"
  exit 0
fi
exit 1
`,
    );
    expect(resolveMemorySourceId(env())).toBe("default");
    const hits = semanticRecall("pglite", env());
    expect(hits).not.toBeNull();
    expect(hits).toHaveLength(1);
    expect(hits![0].slug).toBe("decisions/foo"); // proves --source default was forwarded
  });

  test("degrades to null when no curated-memory source (no unscoped fallback)", () => {
    writeShim(
      `#!/usr/bin/env bash
if [ "$1" = "sources" ]; then echo '{"sources":[{"id":"code","local_path":"/repo"}]}'; exit 0; fi
if [ "$1" = "search" ]; then echo "[0.50] code/x -- unscoped hit"; exit 0; fi
exit 1
`,
    );
    expect(resolveMemorySourceId(env())).toBeNull();
    // no worktree-backed source → null, NOT an unscoped search that would pull code/doc hits
    expect(semanticRecall("anything", env())).toBeNull();
  });

  test("degrades to null when gbrain search exits non-zero", () => {
    writeShim(
      `#!/usr/bin/env bash
if [ "$1" = "sources" ]; then echo '{"sources":[{"id":"default","local_path":"/u/.gstack-brain-worktree"}]}'; exit 0; fi
exit 1
`,
    );
    expect(semanticRecall("pglite", env())).toBeNull();
  });
});
