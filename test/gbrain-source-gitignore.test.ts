/**
 * Unit tests for the `.gbrain-source` gitignore append done by
 * `runCodeImport` after a successful local `.gbrain-source` pin.
 *
 * Covers #1384: v1.29.0.0 changelog promised the per-worktree pin would be
 * ignored in the consuming repo, but the change actually only added
 * `.gbrain-source` to gstack's own `.gitignore`. Without the consumer-side
 * entry, Conductor sibling worktrees commit the pin and clobber each other.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  chmodSync,
  statSync,
  lstatSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ensureGbrainSourceGitignored,
  writeGbrainSourcePin,
} from "../bin/gstack-gbrain-sync";

function metadataTemps(root: string): string[] {
  return readdirSync(root).filter((name) =>
    name.startsWith(".gstack-metadata-"),
  );
}

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

  it("refuses a .gitignore symlink without changing its target", () => {
    const outside = join(root, "outside-ignore");
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(outside, "keep-me\n");
    symlinkSync(outside, gitignorePath);

    expect(() => ensureGbrainSourceGitignored(root)).not.toThrow();

    expect(readFileSync(outside, "utf-8")).toBe("keep-me\n");
    expect(lstatSync(gitignorePath).isSymbolicLink()).toBe(true);
  });

  it("preserves the mode of an atomically updated .gitignore", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n");
    chmodSync(gitignorePath, 0o600);

    ensureGbrainSourceGitignored(root);

    expect(statSync(gitignorePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(gitignorePath, "utf-8")).toBe(
      "node_modules\n.gbrain-source\n",
    );
    expect(metadataTemps(root)).toEqual([]);
  });
});

describe("writeGbrainSourcePin", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gstack-gbrain-pin-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("atomically replaces a pin symlink without writing through it", () => {
    const outside = join(root, "outside-pin");
    const pinPath = join(root, ".gbrain-source");
    writeFileSync(outside, "do-not-change\n");
    symlinkSync(outside, pinPath);

    writeGbrainSourcePin(root, "gstack-code-safe-1234");

    expect(readFileSync(outside, "utf-8")).toBe("do-not-change\n");
    expect(lstatSync(pinPath).isFile()).toBe(true);
    expect(readFileSync(pinPath, "utf-8")).toBe("gstack-code-safe-1234\n");
  });

  it("rejects an invalid source id before writing", () => {
    expect(() => writeGbrainSourcePin(root, "../escape")).toThrow(
      /invalid GBrain source id/,
    );
    expect(existsSync(join(root, ".gbrain-source"))).toBe(false);
  });

  it("preserves the mode of an atomically replaced regular pin", () => {
    const pinPath = join(root, ".gbrain-source");
    writeFileSync(pinPath, "gstack-code-old-1234\n");
    chmodSync(pinPath, 0o600);

    writeGbrainSourcePin(root, "gstack-code-new-1234");

    expect(statSync(pinPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(pinPath, "utf-8")).toBe("gstack-code-new-1234\n");
    expect(metadataTemps(root)).toEqual([]);
  });

});
