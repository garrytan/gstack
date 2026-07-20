import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "create-runtime-release-manifest.mjs");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "release-artifacts.yml");
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"];
const COMMON = ["core", "browser-code", "browser-headless", "browser-visible", "design", "diagram", "pdf"];

async function stageFixture(directory: string) {
  for (const target of TARGETS) {
    const components = [...COMMON, ...(target.startsWith("darwin-") ? ["ios"] : [])];
    for (const component of components) {
      const name = `gstack-runtime-2.0.0-${target}-${component}.tar.gz`;
      await fs.writeFile(path.join(directory, name), "fixture\n");
      await fs.writeFile(path.join(directory, `${name}.sha256`), `${"a".repeat(64)}  ${name}\n`);
      await fs.writeFile(path.join(directory, `${name}.sigstore.json`), "{}\n");
    }
  }
}

describe("GStack runtime release channel", () => {
  test("release candidates retain runtime compatibility while binding URLs and signatures to the RC tag", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-runtime-release-channel-"));
    try {
      await stageFixture(directory);
      const result = spawnSync(process.execPath, [SCRIPT, directory, "time-attack/gstack", "2.0.0", "v2.0.0-rc.1"], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "gstack-runtime-manifest.json"), "utf8"));
      expect(manifest.version).toBe("2.0.0");
      expect(manifest.targets["darwin-arm64"].components["browser-visible"]).toMatchObject({
        url: "https://github.com/time-attack/gstack/releases/download/v2.0.0-rc.1/gstack-runtime-2.0.0-darwin-arm64-browser-visible.tar.gz",
        certificateIdentity: "https://github.com/time-attack/gstack/.github/workflows/release-artifacts.yml@refs/tags/v2.0.0-rc.1",
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("release manifest generation rejects non-runtime tags before reading artifacts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-runtime-invalid-tag-"));
    try {
      const result = spawnSync(process.execPath, [SCRIPT, directory, "time-attack/gstack", "2.0.0", "main"], {
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("Invalid runtime release tag");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("release workflow publishes both RC and stable tags through the same signed manifest path", async () => {
    const workflow = await fs.readFile(WORKFLOW, "utf8");
    const buildSection = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("\n  manifest:"));
    const manifestSection = workflow.slice(workflow.indexOf("\n  manifest:"));
    expect(workflow).toContain("v2.0.0-rc.*");
    expect(workflow).toContain('2.0.0 "$GITHUB_REF_NAME"');
    expect(workflow).toContain("PRERELEASE_FLAG:");
    expect(workflow).toContain("--prerelease");
    expect(workflow).toContain('gh release create "$GITHUB_REF_NAME"');
    expect(workflow).toContain("pathToFileURL(p).href");
    expect(workflow).not.toContain("goto about:blank");
    expect(buildSection).not.toContain("sigstore/cosign-installer");
    expect(manifestSection).toContain("sigstore/cosign-installer");
    expect(manifestSection.indexOf("Keyless-sign component archives"))
      .toBeLessThan(manifestSection.indexOf("Create strict six-target manifest"));
  });
});
