#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const [
  directory,
  repository = process.env.GITHUB_REPOSITORY,
  version = "2.0.0",
  releaseTag = `v${version}`,
] = process.argv.slice(2);
if (!directory || !repository) {
  console.error("Usage: create-runtime-release-manifest.mjs <artifact-dir> <owner/repo> [version] [release-tag]");
  process.exit(2);
}
if (!/^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(releaseTag)) {
  throw new Error(`Invalid runtime release tag: ${releaseTag}`);
}

const targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-arm64",
  "windows-x64",
];
const componentDependencies = {
  core: [],
  "browser-code": ["core"],
  "browser-headless": ["browser-code"],
  "browser-visible": ["browser-code"],
  design: ["core"],
  diagram: ["browser-headless"],
  pdf: ["diagram"],
  ios: ["core"],
};
const capabilityComponents = {
  browser: ["browser-code", "browser-headless"],
  "browser-visible": ["browser-code", "browser-visible"],
  design: ["design"],
  diagram: ["diagram"],
  pdf: ["pdf"],
  ios: ["ios"],
};
const commonComponents = ["core", "browser-code", "browser-headless", "browser-visible", "design", "diagram", "pdf"];
const release = `https://github.com/${repository}/releases/download/${releaseTag}`;
const certificateIdentity = `https://github.com/${repository}/.github/workflows/release-artifacts.yml@refs/tags/${releaseTag}`;
const targetRecords = {};

for (const target of targets) {
  const ids = [...commonComponents, ...(target.startsWith("darwin-") ? ["ios"] : [])];
  const components = {};
  for (const component of ids) {
    const name = `gstack-runtime-${version}-${target}-${component}.tar.gz`;
    const archive = path.join(directory, name);
    const bundle = `${archive}.sigstore.json`;
    const digestFile = `${archive}.sha256`;
    const [stat, digest, bundleStat] = await Promise.all([
      fs.stat(archive),
      fs.readFile(digestFile, "utf8"),
      fs.stat(bundle),
    ]);
    const sha256 = digest.trim().split(/\s+/)[0];
    if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024 * 1024) {
      throw new Error(`Invalid artifact size for ${name}: ${stat.size}`);
    }
    if (!bundleStat.isFile() || bundleStat.size <= 0) throw new Error(`Missing Sigstore bundle for ${name}`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Invalid SHA-256 for ${name}`);
    components[component] = {
      url: `${release}/${name}`,
      sha256,
      bytes: stat.size,
      format: "tar.gz",
      root: "gstack",
      cosignBundleUrl: `${release}/${name}.sigstore.json`,
      certificateIdentity,
      certificateOidcIssuer: "https://token.actions.githubusercontent.com",
    };
  }
  targetRecords[target] = { components };
}

const manifest = {
  schemaVersion: 2,
  version,
  skillApi: "2.0",
  capabilityComponents,
  componentDependencies,
  targets: targetRecords,
};
await fs.writeFile(
  path.join(directory, "gstack-runtime-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { flag: "wx", mode: 0o644 },
);
