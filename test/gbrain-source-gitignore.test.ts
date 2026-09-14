/**
 * Unit tests for the `.gbrain-source` gitignore append done by
 * `runCodeImport` after a successful `gbrain sources attach`.
 *
 * Covers #1384: v1.29.0.0 changelog promised the per-worktree pin would be
 * ignored in the consuming repo, but the change actually only added
 * `.gbrain-source` to gstack's own `.gitignore`. Without the consumer-side
 * entry, Conductor sibling worktrees commit the pin and clobber each other.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ensureGbrainSourceGitignored } from "../bin/gstack-gbrain-sync";

describe("ensureGbrainSourceGitignored", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gstack-gbrain-gitignore-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates .gitignore with the pin entry when none exists", () => {
    const gitignorePath = join(root, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(false);

    ensureGbrainSourceGitignored(root);

    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf-8")).toBe(".gbrain-source\n");
  });

  it("appends the pin entry to an existing .gitignore without trailing newline", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n.env");

    ensureGbrainSourceGitignored(root);

    expect(readFileSync(gitignorePath, "utf-8")).toBe(
      "node_modules\n.env\n.gbrain-source\n",
    );
  });

  it("appends the pin entry to an existing .gitignore with trailing newline", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n.env\n");

    ensureGbrainSourceGitignored(root);

    expect(readFileSync(gitignorePath, "utf-8")).toBe(
      "node_modules\n.env\n.gbrain-source\n",
    );
  });

  it("is idempotent: does not duplicate the pin entry on a second call", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n.gbrain-source\n.env\n");

    ensureGbrainSourceGitignored(root);
    ensureGbrainSourceGitignored(root);

    const lines = readFileSync(gitignorePath, "utf-8").split("\n");
    const hits = lines.filter((line) => line.trim() === ".gbrain-source");
    expect(hits.length).toBe(1);
  });

  it("recognizes the entry even when it has surrounding whitespace", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n  .gbrain-source  \n");

    ensureGbrainSourceGitignored(root);

    const lines = readFileSync(gitignorePath, "utf-8").split("\n");
    const hits = lines.filter((line) => line.trim() === ".gbrain-source");
    expect(hits.length).toBe(1);
  });

  it("does not throw when the .gitignore is read-only", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n");
    const originalMode = statSync(gitignorePath).mode;
    chmodSync(gitignorePath, 0o444);
    try {
      // Must not throw — sync stage continues on write failure.
      expect(() => ensureGbrainSourceGitignored(root)).not.toThrow();
    } finally {
      chmodSync(gitignorePath, originalMode);
    }
  });
});
