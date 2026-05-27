import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  planRoundArtifacts,
  resolveImagePaths,
} from "../src/cli";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

function writePng(filePath: string): void {
  fs.writeFileSync(filePath, PNG_BYTES);
}

function writeManifest(tmpDir: string, entries: Record<string, any[]>): void {
  fs.writeFileSync(
    path.join(tmpDir, ".gstack-design-rounds.json"),
    JSON.stringify(entries, null, 2),
  );
}

describe("plan-design-review round variant preservation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "variant-preservation-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("recommended round allocates sequence-stable suffixed paths", () => {
    const alias = path.join(tmpDir, "variant-recommended.png");
    const first = planRoundArtifacts(alias);

    expect(first?.primaryOutput).toBe(path.join(tmpDir, "variant-recommended-A.png"));
    expect(first?.aliasOutput).toBe(alias);

    writeManifest(tmpDir, {
      [path.join(tmpDir, "variant-recommended")]: [
        { label: "A", path: first!.primaryOutput, success: true },
      ],
    });

    const second = planRoundArtifacts(alias);
    expect(second?.primaryOutput).toBe(path.join(tmpDir, "variant-recommended-B.png"));
  });

  test("recommended round alias expands to every successful generated candidate", async () => {
    const alias = path.join(tmpDir, "variant-recommended.png");
    const variantA = path.join(tmpDir, "variant-recommended-A.png");
    const variantB = path.join(tmpDir, "variant-recommended-B.png");
    writePng(variantA);
    writePng(variantB);
    writePng(alias);
    writeManifest(tmpDir, {
      [path.join(tmpDir, "variant-recommended")]: [
        { label: "A", path: variantA, success: true },
        { label: "B", path: variantB, success: true },
      ],
    });

    await expect(resolveImagePaths(alias)).resolves.toEqual([variantA, variantB]);
  });

  test("iteration round discovers A/B/C candidates without collapsing onto the alias", async () => {
    const alias = path.join(tmpDir, "variant-iteration-01.png");
    const variantA = path.join(tmpDir, "variant-iteration-01-A.png");
    const variantB = path.join(tmpDir, "variant-iteration-01-B.png");
    const variantC = path.join(tmpDir, "variant-iteration-01-C.png");
    writePng(variantA);
    writePng(variantB);
    writePng(variantC);
    writePng(alias);

    await expect(resolveImagePaths(alias)).resolves.toEqual([variantA, variantB, variantC]);
  });

  test("single recommended generation preserves the suffixed candidate and ignores alias copy", async () => {
    const alias = path.join(tmpDir, "variant-recommended.png");
    const variantA = path.join(tmpDir, "variant-recommended-A.png");
    writePng(variantA);
    writePng(alias);
    writeManifest(tmpDir, {
      [path.join(tmpDir, "variant-recommended")]: [
        { label: "A", path: variantA, success: true },
      ],
    });

    await expect(resolveImagePaths(alias)).resolves.toEqual([variantA]);
  });

  test("failed sibling leaves successful candidate in place and reports missing index", async () => {
    const alias = path.join(tmpDir, "variant-recommended.png");
    const variantA = path.join(tmpDir, "variant-recommended-A.png");
    const variantB = path.join(tmpDir, "variant-recommended-B.png");
    writePng(variantA);
    writeManifest(tmpDir, {
      [path.join(tmpDir, "variant-recommended")]: [
        { label: "A", path: variantA, success: true },
        { label: "B", path: variantB, success: false, error: "API error" },
      ],
    });

    await expect(resolveImagePaths(alias)).rejects.toThrow("variant-recommended-B.png");
    expect(fs.existsSync(variantA)).toBe(true);
  });

  test("initial 3-option board paths are unchanged", async () => {
    const variantA = path.join(tmpDir, "variant-A.png");
    const variantB = path.join(tmpDir, "variant-B.png");
    const variantC = path.join(tmpDir, "variant-C.png");
    writePng(variantA);
    writePng(variantB);
    writePng(variantC);

    const input = `${variantA},${variantB},${variantC}`;
    await expect(resolveImagePaths(input)).resolves.toEqual([variantA, variantB, variantC]);
  });
});
