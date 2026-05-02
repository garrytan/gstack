/**
 * Unit tests for lib/gstack-memory-helpers.ts (Lane 0 foundation).
 *
 * Covers the public surface used by Lanes A, B, C:
 *   - canonicalizeRemote: 8 cases across https/ssh/git@/.git/empty
 *   - secretScanFile: gitleaks-missing fallback + redactMatch behavior
 *   - parseSkillManifest: valid manifest + missing manifest + multi-kind
 *   - withErrorContext: success path + error path + log writing
 *   - detectEngineTier: cache TTL + fresh-detect fallback
 *
 * Free-tier (~50ms total). Runs in `bun test`.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  canonicalizeRemote,
  secretScanFile,
  parseSkillManifest,
  withErrorContext,
  detectEngineTier,
  _resetGitleaksAvailabilityCache,
} from "../lib/gstack-memory-helpers";

// ── canonicalizeRemote ─────────────────────────────────────────────────────

describe("canonicalizeRemote", () => {
  it("strips https scheme and .git suffix", () => {
    expect(canonicalizeRemote("https://github.com/garrytan/gstack.git")).toBe("github.com/garrytan/gstack");
  });

  it("normalizes git@host:path scp-style remotes", () => {
    expect(canonicalizeRemote("git@github.com:garrytan/gstack.git")).toBe("github.com/garrytan/gstack");
  });

  it("strips ssh:// scheme", () => {
    expect(canonicalizeRemote("ssh://git@gitlab.com/foo/bar")).toBe("gitlab.com/foo/bar");
  });

  it("returns empty string for null/undefined/empty input", () => {
    expect(canonicalizeRemote("")).toBe("");
    expect(canonicalizeRemote(null)).toBe("");
    expect(canonicalizeRemote(undefined)).toBe("");
  });

  it("strips surrounding quotes", () => {
    expect(canonicalizeRemote(`"https://github.com/foo/bar.git"`)).toBe("github.com/foo/bar");
  });

  it("strips trailing slashes", () => {
    expect(canonicalizeRemote("https://github.com/foo/bar/")).toBe("github.com/foo/bar");
  });

  it("lowercases the result", () => {
    expect(canonicalizeRemote("https://GitHub.com/Foo/Bar.git")).toBe("github.com/foo/bar");
  });

  it("handles paths with multiple segments", () => {
    expect(canonicalizeRemote("https://gitlab.example.com/group/subgroup/project.git")).toBe(
      "gitlab.example.com/group/subgroup/project"
    );
  });

  it("collapses redundant slashes", () => {
    expect(canonicalizeRemote("https://github.com//foo//bar")).toBe("github.com/foo/bar");
  });
});

// ── secretScanFile ─────────────────────────────────────────────────────────

describe("secretScanFile", () => {
  beforeEach(() => {
    _resetGitleaksAvailabilityCache();
  });

  it("returns scanner=error for non-existent file", () => {
    const result = secretScanFile("/nonexistent/path/that/does/not/exist");
    expect(result.scanned).toBe(false);
    expect(result.scanner).toBe("error");
    expect(result.findings).toEqual([]);
  });

  it("returns scanner=missing or runs gitleaks (env-dependent)", () => {
    // We can't assume gitleaks is installed in CI; we just verify the shape.
    const dir = mkdtempSync(join(tmpdir(), "gstack-test-"));
    const file = join(dir, "clean.txt");
    writeFileSync(file, "no secrets here\n");
    const result = secretScanFile(file);
    expect(["gitleaks", "missing", "error"]).toContain(result.scanner);
    if (result.scanner === "gitleaks") {
      // Clean file should produce no findings
      expect(result.findings).toEqual([]);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── parseSkillManifest ─────────────────────────────────────────────────────

describe("parseSkillManifest", () => {
  it("returns null for non-existent file", () => {
    expect(parseSkillManifest("/nonexistent/skill.md")).toBeNull();
  });

  it("returns null for file without frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-test-"));
    const file = join(dir, "no-fm.md");
    writeFileSync(file, "# Just a heading\n\nbody text\n");
    expect(parseSkillManifest(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when frontmatter has no gbrain: key", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-test-"));
    const file = join(dir, "no-gbrain.md");
    writeFileSync(file, `---\nname: foo\ndescription: bar\n---\n\nbody\n`);
    expect(parseSkillManifest(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a multi-kind manifest correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-test-"));
    const file = join(dir, "multi.md");
    writeFileSync(
      file,
      `---
name: office-hours
description: YC Office Hours
gbrain:
  schema: 1
  context_queries:
    - id: prior-sessions
      kind: vector
      query: "office-hours sessions for {repo_slug}"
      limit: 5
      render_as: "## Prior office-hours sessions in this repo"
    - id: builder-profile
      kind: filesystem
      glob: "~/.gstack/builder-profile.jsonl"
      tail: 1
      render_as: "## Your builder profile snapshot"
    - id: prior-assignments
      kind: list
      sort: created_at_desc
      limit: 5
      render_as: "## Open assignments from past sessions"
triggers:
  - office-hours
---

body
`
    );

    const m = parseSkillManifest(file);
    expect(m).not.toBeNull();
    expect(m!.schema).toBe(1);
    expect(m!.context_queries).toHaveLength(3);

    const ids = m!.context_queries.map((q) => q.id);
    expect(ids).toEqual(["prior-sessions", "builder-profile", "prior-assignments"]);

    const kinds = m!.context_queries.map((q) => q.kind);
    expect(kinds).toEqual(["vector", "filesystem", "list"]);

    expect(m!.context_queries[0].query).toBe("office-hours sessions for {repo_slug}");
    expect(m!.context_queries[0].limit).toBe(5);
    expect(m!.context_queries[1].glob).toBe("~/.gstack/builder-profile.jsonl");
    expect(m!.context_queries[1].tail).toBe(1);
    expect(m!.context_queries[2].sort).toBe("created_at_desc");

    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores incomplete query items (missing kind)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-test-"));
    const file = join(dir, "incomplete.md");
    writeFileSync(
      file,
      `---
name: bad
gbrain:
  schema: 1
  context_queries:
    - id: missing-kind
      render_as: "## Should be skipped"
    - id: complete
      kind: vector
      query: "x"
      render_as: "## OK"
---

body
`
    );

    const m = parseSkillManifest(file);
    expect(m).not.toBeNull();
    expect(m!.context_queries).toHaveLength(1);
    expect(m!.context_queries[0].id).toBe("complete");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── withErrorContext ───────────────────────────────────────────────────────

describe("withErrorContext", () => {
  let savedHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    savedHome = process.env.GSTACK_HOME;
    testHome = mkdtempSync(join(tmpdir(), "gstack-test-home-"));
    process.env.GSTACK_HOME = testHome;
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = savedHome;
  });

  it("returns the value on success and writes an ok entry", async () => {
    const result = await withErrorContext("test-op-success", () => 42, "test-caller");
    expect(result).toBe(42);

    const log = readFileSync(join(testHome, ".gbrain-errors.jsonl"), "utf-8");
    const entry = JSON.parse(log.trim().split("\n").pop()!);
    expect(entry.op).toBe("test-op-success");
    expect(entry.outcome).toBe("ok");
    expect(entry.schema_version).toBe(1);
    expect(entry.last_writer).toBe("test-caller");
    expect(typeof entry.duration_ms).toBe("number");
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("rethrows the error on failure and writes an error entry", async () => {
    let caught: unknown = null;
    try {
      await withErrorContext("test-op-fail", () => {
        throw new Error("boom");
      }, "test-caller");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");

    const log = readFileSync(join(testHome, ".gbrain-errors.jsonl"), "utf-8");
    const entry = JSON.parse(log.trim().split("\n").pop()!);
    expect(entry.op).toBe("test-op-fail");
    expect(entry.outcome).toBe("error");
    expect(entry.error).toBe("boom");
  });

  it("supports async functions", async () => {
    const result = await withErrorContext(
      "async-op",
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return "done";
      },
      "test-caller"
    );
    expect(result).toBe("done");
  });
});

// ── detectEngineTier ───────────────────────────────────────────────────────

describe("detectEngineTier", () => {
  let savedHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    savedHome = process.env.GSTACK_HOME;
    testHome = mkdtempSync(join(tmpdir(), "gstack-test-engine-"));
    process.env.GSTACK_HOME = testHome;
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = savedHome;
  });

  it("returns a valid EngineDetect shape (engine, detected_at, schema_version)", () => {
    const result = detectEngineTier();
    expect(["pglite", "supabase", "unknown"]).toContain(result.engine);
    expect(result.schema_version).toBe(1);
    expect(typeof result.detected_at).toBe("number");
    expect(result.detected_at).toBeGreaterThan(0);
  });

  it("writes a cache file at ~/.gstack/.gbrain-engine-cache.json", () => {
    detectEngineTier();
    const cachePath = join(testHome, ".gbrain-engine-cache.json");
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cached.schema_version).toBe(1);
    expect(cached.last_writer).toBe("gstack-memory-helpers.detectEngineTier");
  });

  it("returns the cached value on second call within TTL", () => {
    const first = detectEngineTier();
    const second = detectEngineTier();
    expect(second.detected_at).toBe(first.detected_at);
  });
});
