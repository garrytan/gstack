import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { generateCompareHtml } from "../src/compare";
import { writeLocalFallbackManifest, writeLocalFallbackMockup } from "../src/local-fallback";

let tmpDirs: string[] = [];

function tmpDir(name: string): string {
  const dir = path.join("/tmp", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("local design fallback", () => {
  test("writes SVG content to the requested path and a .svg sibling", () => {
    const dir = tmpDir("gstack-local-fallback");
    const outputPath = path.join(dir, "variant-A.png");

    const result = writeLocalFallbackMockup("Hula Na prediction market app", outputPath, 0, "1024x768");

    expect(result.outputPath).toBe(outputPath);
    expect(result.bytes).toBeGreaterThan(1000);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(path.join(dir, "variant-A.svg"))).toBe(true);
    expect(fs.readFileSync(outputPath, "utf8")).toContain("<svg");
  });

  test("writes a fallback manifest for downstream review flows", () => {
    const dir = tmpDir("gstack-local-fallback-manifest");
    const manifestPath = writeLocalFallbackManifest(dir, {
      mode: "style-variants",
      count: 3,
      paths: ["variant-A.png", "variant-B.png", "variant-C.png"],
    });

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.generatedBy).toBe("gstack-design-local-fallback");
    expect(manifest.mode).toBe("style-variants");
    expect(manifest.count).toBe(3);
    expect(manifest.paths).toHaveLength(3);
  });

  test("comparison board embeds SVG fallback files with the correct MIME type", () => {
    const dir = tmpDir("gstack-local-fallback-compare");
    const outputPath = path.join(dir, "variant-A.png");
    writeLocalFallbackMockup("Hula Na prediction market app", outputPath, 0, "1024x768");

    const html = generateCompareHtml([outputPath]);

    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain("Option A");
  });
});
