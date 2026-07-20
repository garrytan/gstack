#!/usr/bin/env node
// Dependency-free bootstrap copied into each standards-installed GStack skill.
// It installs only the optional local runtime; host skill placement remains the
// responsibility of the Agent Skills installer.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BOOTSTRAP_SCHEMA_VERSION = 2;
export const BOOTSTRAP_RUNTIME_VERSION = "2.0.0";
export const OFFICIAL_MANIFEST_URL =
  `https://github.com/time-attack/gstack/releases/download/v${BOOTSTRAP_RUNTIME_VERSION}/gstack-runtime-manifest.json`;
const CAPABILITIES = new Set(["browser", "browser-visible", "design", "pdf", "diagram", "ios"]);
const CAPABILITY_DEPENDENCIES = Object.freeze({
  browser: Object.freeze([]),
  "browser-visible": Object.freeze([]),
  design: Object.freeze([]),
  pdf: Object.freeze(["browser", "diagram"]),
  diagram: Object.freeze(["browser"]),
  ios: Object.freeze([]),
});
export const COMPONENT_DEPENDENCIES = Object.freeze({
  core: Object.freeze([]),
  "browser-code": Object.freeze(["core"]),
  "browser-headless": Object.freeze(["browser-code"]),
  "browser-visible": Object.freeze(["browser-code"]),
  design: Object.freeze(["core"]),
  diagram: Object.freeze(["browser-headless"]),
  pdf: Object.freeze(["diagram"]),
  ios: Object.freeze(["core"]),
});
export const CAPABILITY_COMPONENTS = Object.freeze({
  browser: Object.freeze(["browser-code", "browser-headless"]),
  "browser-visible": Object.freeze(["browser-code", "browser-visible"]),
  design: Object.freeze(["design"]),
  diagram: Object.freeze(["diagram"]),
  pdf: Object.freeze(["pdf"]),
  ios: Object.freeze(["ios"]),
});
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const OFFICIAL_RELEASE_PREFIX = `/time-attack/gstack/releases/download/v${BOOTSTRAP_RUNTIME_VERSION}/`;
const OFFICIAL_CERTIFICATE_IDENTITY =
  `https://github.com/time-attack/gstack/.github/workflows/release-artifacts.yml@refs/tags/v${BOOTSTRAP_RUNTIME_VERSION}`;
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export async function main(argv = process.argv.slice(2), options = {}) {
  const io = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      io.stdout.write(usage());
      return 0;
    }
    if (!["preview", "install"].includes(parsed.action)) {
      throw bootstrapError("Expected `preview` or `install`", "BOOTSTRAP_USAGE");
    }

    const platform = options.platform ?? process.platform;
    if (parsed.capabilities.includes("ios") && platform !== "darwin") {
      throw bootstrapError("The physical-iOS capability is available only on macOS", "BOOTSTRAP_PLATFORM_UNSUPPORTED");
    }
    if (parsed.source) {
      if (parsed.action === "preview") {
        io.stdout.write("Reviewed-source fallback has no signed compressed-byte manifest; the local installer can provide an on-disk preview only.\n");
        return 0;
      }
      if (!parsed.yes) throw bootstrapError("Installation requires explicit --yes after review", "BOOTSTRAP_CONSENT_REQUIRED");
      io.stderr.write("Developer-only source install: only continue with a checkout you reviewed and trust.\n");
      return await installFromSource(parsed.source, parsed, { ...options, ...io, prepared: false });
    }

    const fetch_ = options.fetch ?? globalThis.fetch;
    if (typeof fetch_ !== "function") throw bootstrapError("Node 18+ with fetch is required", "BOOTSTRAP_NODE_UNSUPPORTED");
    const target = platformTarget(
      platform,
      options.arch ?? process.arch,
      options.libc ?? detectLinuxLibc(platform),
    );
    const manifestUrl = options.manifestUrl ?? OFFICIAL_MANIFEST_URL;
    assertOfficialUrl(manifestUrl, { manifest: true });
    const manifest = await fetchJson(fetch_, manifestUrl);
    validateManifest(manifest, target);
    const home = path.resolve(parsed.home ?? process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack"));
    const reusable = await inspectReusableRuntime(home, manifest.version).catch(() => null);
    const plan = buildComponentPlan(manifest, target, parsed.capabilities, reusable);
    if (parsed.json) io.stdout.write(`${JSON.stringify({ ok: true, action: parsed.action, ...plan }, null, 2)}\n`);
    else printComponentPlan(io.stdout, plan);
    if (parsed.action === "preview") return 0;
    if (!parsed.yes) throw bootstrapError("Installation requires explicit --yes after reviewing this exact component plan", "BOOTSTRAP_CONSENT_REQUIRED");
    const temporary = await fs.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), "gstack-bootstrap-"));
    try {
      const root = path.join(temporary, "merged", "gstack");
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const claimedFiles = new Set();
      if (reusable) await seedReusableRuntime(reusable.root, root, claimedFiles);
      for (const item of plan.downloads) {
        const archive = path.join(temporary, `${item.component}.tar.gz`);
        await downloadVerified(fetch_, item.artifact.url, archive, item.artifact.sha256, item.artifact.bytes);
        io.stdout.write(`Verified SHA-256 for ${item.component} (${target}).\n`);
        await verifyCosignWhenAvailable(archive, item.artifact, path.join(temporary, item.component), { ...options, fetch: fetch_, ...io });
        const extracted = path.join(temporary, "extracted", item.component);
        await fs.mkdir(extracted, { recursive: true, mode: 0o700 });
        await extractTarSafely(archive, extracted, options);
        const componentRoot = safeArtifactRoot(extracted, item.artifact.root ?? "gstack");
        await assertNoLinks(componentRoot);
        await mergeComponentRoot(componentRoot, root, claimedFiles, item.component);
      }
      return await installFromSource(root, parsed, { ...options, ...io, prepared: true, version: manifest.version });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    io.stderr.write(`gstack bootstrap: ${error?.message ?? error}\n`);
    return 1;
  }
}

function parseArgs(argv) {
  const result = { action: null, capabilities: [], source: null, home: null, yes: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["-h", "--help"].includes(arg)) result.help = true;
    else if (arg === "--yes") result.yes = true;
    else if (arg === "--json") result.json = true;
    else if (!result.action && !arg.startsWith("-")) result.action = arg;
    else if (["--capability", "--source", "--home"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw bootstrapError(`${arg} requires a value`, "BOOTSTRAP_USAGE");
      if (arg === "--capability") result.capabilities.push(value);
      else if (arg === "--source") result.source = value;
      else result.home = value;
    } else throw bootstrapError(`Unknown option: ${arg}`, "BOOTSTRAP_USAGE");
  }
  if (result.help) return result;
  if (result.action === "preview" && result.yes) throw bootstrapError("preview cannot be combined with --yes", "BOOTSTRAP_USAGE");
  if (!result.capabilities.length) throw bootstrapError("At least one --capability is required", "BOOTSTRAP_USAGE");
  result.capabilities = [...new Set(result.capabilities)].sort();
  for (const capability of result.capabilities) {
    if (!CAPABILITIES.has(capability)) throw bootstrapError(`Unknown capability: ${capability}`, "BOOTSTRAP_USAGE");
  }
  const expanded = new Set(result.capabilities);
  const pending = [...expanded];
  while (pending.length) {
    for (const dependency of CAPABILITY_DEPENDENCIES[pending.pop()] ?? []) {
      if (!expanded.has(dependency)) {
        expanded.add(dependency);
        pending.push(dependency);
      }
    }
  }
  result.capabilities = [...expanded].sort();
  return result;
}

function validateManifest(manifest, target) {
  if (manifest?.schemaVersion !== BOOTSTRAP_SCHEMA_VERSION || manifest?.version !== BOOTSTRAP_RUNTIME_VERSION ||
      manifest?.skillApi !== "2.0" || typeof manifest?.targets !== "object" ||
      !sameGraph(manifest.capabilityComponents, CAPABILITY_COMPONENTS) ||
      !sameGraph(manifest.componentDependencies, COMPONENT_DEPENDENCIES)) {
    throw bootstrapError("Official runtime manifest is incompatible", "BOOTSTRAP_MANIFEST_INVALID");
  }
  const targetRecord = manifest.targets[target];
  const expected = Object.keys(COMPONENT_DEPENDENCIES)
    .filter((component) => component !== "ios" || target.startsWith("darwin-"))
    .sort();
  if (!targetRecord || typeof targetRecord.components !== "object" ||
      JSON.stringify(Object.keys(targetRecord.components).sort()) !== JSON.stringify(expected)) {
    throw bootstrapError(`No valid official runtime artifact for ${target}`, "BOOTSTRAP_ARTIFACT_UNAVAILABLE");
  }
  for (const [component, artifact] of Object.entries(targetRecord.components)) {
    if (!artifact || artifact.format !== "tar.gz" || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 2 * 1024 * 1024 * 1024) {
      throw bootstrapError(`Invalid ${component} artifact for ${target}`, "BOOTSTRAP_ARTIFACT_UNAVAILABLE");
    }
    assertOfficialReleaseAssetUrl(artifact.url);
    if (artifact.cosignBundleUrl) {
      assertOfficialReleaseAssetUrl(artifact.cosignBundleUrl);
      if (artifact.certificateIdentity !== OFFICIAL_CERTIFICATE_IDENTITY ||
          artifact.certificateOidcIssuer !== GITHUB_OIDC_ISSUER) {
        throw bootstrapError("Cosign metadata does not bind the official GStack release workflow", "BOOTSTRAP_MANIFEST_INVALID");
      }
    } else if (artifact.certificateIdentity || artifact.certificateOidcIssuer) {
      throw bootstrapError("Cosign certificate metadata requires a bundle URL", "BOOTSTRAP_MANIFEST_INVALID");
    }
  }
  return targetRecord;
}

function sameGraph(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const normalize = (graph) => Object.fromEntries(Object.entries(graph)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, Array.isArray(values) ? [...values].sort() : values]));
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

async function fetchJson(fetch_, url) {
  const response = await fetch_(url, { headers: { Accept: "application/json" }, redirect: "follow" });
  assertFinalDownloadUrl(response.url || url);
  if (!response.ok) throw bootstrapError(`Download failed with HTTP ${response.status}`, "BOOTSTRAP_DOWNLOAD_FAILED");
  const value = await response.json();
  if (!value || typeof value !== "object") throw bootstrapError("Manifest returned invalid JSON", "BOOTSTRAP_MANIFEST_INVALID");
  return value;
}

async function downloadVerified(fetch_, url, destination, expectedSha256, expectedBytes) {
  const response = await fetch_(url, { redirect: "follow" });
  assertFinalDownloadUrl(response.url || url);
  if (!response.ok) throw bootstrapError(`Artifact download failed with HTTP ${response.status}`, "BOOTSTRAP_DOWNLOAD_FAILED");
  const hash = createHash("sha256");
  const file = await fs.open(destination, "wx", 0o600);
  let total = 0;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 2 * 1024 * 1024 * 1024) throw bootstrapError("Runtime artifact exceeds the 2 GiB safety limit", "BOOTSTRAP_DOWNLOAD_FAILED");
        hash.update(value);
        await file.write(value);
      }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      total = bytes.byteLength;
      hash.update(bytes);
      await file.write(bytes);
    }
  } catch (error) {
    await file.close();
    await fs.rm(destination, { force: true });
    throw error;
  }
  await file.close();
  if (total !== expectedBytes) {
    await fs.rm(destination, { force: true });
    throw bootstrapError(`Runtime artifact size mismatch (expected ${expectedBytes}, received ${total})`, "BOOTSTRAP_INTEGRITY_FAILED");
  }
  const actual = hash.digest("hex");
  if (actual !== expectedSha256) {
    await fs.rm(destination, { force: true });
    throw bootstrapError("Runtime artifact SHA-256 mismatch", "BOOTSTRAP_INTEGRITY_FAILED");
  }
}

async function verifyCosignWhenAvailable(archive, artifact, temporary, options) {
  if (!artifact.cosignBundleUrl) {
    options.stdout.write("No Cosign bundle declared; continuing with verified release-manifest SHA-256.\n");
    return;
  }
  const available = await run(options.cosignCommand ?? "cosign", ["version"], { capture: true }).then(() => true, () => false);
  if (!available) {
    options.stdout.write("Cosign metadata is available but Cosign is not installed; SHA-256 verification succeeded.\n");
    return;
  }
  const bundle = path.join(temporary, "cosign.bundle");
  const response = await options.fetch(artifact.cosignBundleUrl, { redirect: "follow" });
  assertFinalDownloadUrl(response.url || artifact.cosignBundleUrl);
  if (!response.ok) throw bootstrapError("Cosign bundle download failed", "BOOTSTRAP_ATTESTATION_FAILED");
  await fs.writeFile(bundle, new Uint8Array(await response.arrayBuffer()), { mode: 0o600, flag: "wx" });
  const args = ["verify-blob", "--bundle", bundle];
  if (artifact.certificateIdentity) args.push("--certificate-identity", artifact.certificateIdentity);
  if (artifact.certificateOidcIssuer) args.push("--certificate-oidc-issuer", artifact.certificateOidcIssuer);
  args.push(archive);
  await run(options.cosignCommand ?? "cosign", args);
  options.stdout.write("Verified Cosign release attestation.\n");
}

async function extractTarSafely(archive, destination, options) {
  const tar = options.tarCommand ?? "tar";
  const listing = await run(tar, ["-tzf", archive], { capture: true });
  for (const name of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = name.replaceAll("\\", "/");
    if (normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) ||
        normalized.split("/").includes("..")) {
      throw bootstrapError("Runtime archive contains an unsafe path", "BOOTSTRAP_ARCHIVE_UNSAFE");
    }
  }
  const verbose = await run(tar, ["-tvzf", archive], { capture: true });
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!/^[-d]/.test(line)) {
      throw bootstrapError("Runtime archive contains a link or special-file entry", "BOOTSTRAP_ARCHIVE_UNSAFE");
    }
  }
  await run(tar, ["-xzf", archive, "-C", destination]);
}

async function installFromSource(source, parsed, options) {
  const physical = await fs.realpath(path.resolve(source));
  const installer = path.join(physical, "runtime", "install.js");
  const stat = await fs.lstat(installer).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw bootstrapError("Source does not contain a safe runtime installer", "BOOTSTRAP_SOURCE_INVALID");
  const args = [installer, "--source", physical, "--install-now", "--yes", "--capabilities", parsed.capabilities.join(",")];
  if (parsed.home) args.push("--home", path.resolve(parsed.home));
  if (options.version) args.push("--version", options.version);
  if (options.prepared) args.push("--prepared");
  await run(options.nodeCommand ?? process.execPath, args);
  options.stdout.write(`Installed optional capabilities: ${parsed.capabilities.join(", ")}. No coding host was enrolled.\n`);
  return 0;
}

function platformTarget(platform, arch, libc) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw bootstrapError(`Unsupported platform: ${platform}-${arch}`, "BOOTSTRAP_PLATFORM_UNSUPPORTED");
  }
  if (platform === "linux" && libc !== "glibc") {
    throw bootstrapError(
      "Official GStack runtime artifacts currently require glibc Linux; pure Agent Skills remain portable and the reviewed-source fallback may be used explicitly",
      "BOOTSTRAP_PLATFORM_UNSUPPORTED",
    );
  }
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

function detectLinuxLibc(platform) {
  if (platform !== "linux") return null;
  const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function safeArtifactRoot(extracted, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw bootstrapError("Manifest contains an unsafe artifact root", "BOOTSTRAP_MANIFEST_INVALID");
  }
  const target = path.resolve(extracted, relative);
  if (path.relative(extracted, target).startsWith(`..${path.sep}`)) throw bootstrapError("Artifact root escaped extraction", "BOOTSTRAP_ARCHIVE_UNSAFE");
  return target;
}

async function assertNoLinks(root) {
  const pending = [root];
  while (pending.length) {
    const target = pending.pop();
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw bootstrapError("Runtime archive contains a symbolic link", "BOOTSTRAP_ARCHIVE_UNSAFE");
    if (stat.isDirectory()) for (const child of await fs.readdir(target)) pending.push(path.join(target, child));
  }
}

function assertOfficialUrl(value, options = {}) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw bootstrapError("Bootstrap downloads are restricted to official GitHub release hosts", "BOOTSTRAP_URL_BLOCKED");
  }
  if (options.manifest && url.hostname !== "github.com") throw bootstrapError("Manifest must come from the official GitHub release", "BOOTSTRAP_URL_BLOCKED");
}

function assertOfficialReleaseAssetUrl(value) {
  assertOfficialUrl(value);
  const url = new URL(value);
  if (url.hostname !== "github.com" || !url.pathname.startsWith(OFFICIAL_RELEASE_PREFIX)) {
    throw bootstrapError("Runtime assets must come from the official versioned GStack release", "BOOTSTRAP_URL_BLOCKED");
  }
}

function assertFinalDownloadUrl(value) {
  assertOfficialUrl(value);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(bootstrapError(`${command} failed (${code})`, "BOOTSTRAP_COMMAND_FAILED")));
  });
}

function bootstrapError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]} (${bytes} bytes)`;
}

function usage() {
  return "Usage: node runtime-bootstrap.mjs install --capability <name> [--capability <name>...]\n" +
    "       node runtime-bootstrap.mjs install --source <reviewed-checkout> --capability <name>\n\n" +
    "Downloads only a versioned official GStack runtime release and never enrolls a coding host.\n" +
    "--source is a developer-only fallback for a checkout you have reviewed and trust.\n";
}

async function isDirectExecution() {
  if (!process.argv[1]) return false;
  const [modulePath, invokedPath] = await Promise.all([
    fs.realpath(fileURLToPath(import.meta.url)),
    fs.realpath(path.resolve(process.argv[1])).catch(() => path.resolve(process.argv[1])),
  ]);
  return modulePath === invokedPath;
}

if (await isDirectExecution()) {
  process.exitCode = await main();
}
