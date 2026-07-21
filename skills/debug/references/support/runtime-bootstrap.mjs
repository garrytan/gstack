#!/usr/bin/env node
// Dependency-free bootstrap copied into each standards-installed GStack skill.
// It installs only the optional local runtime; host skill placement remains the
// responsibility of the Agent Skills installer.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyBrowserProviderToComponents,
  assertBrowserChoiceSupportsCapabilities,
  browserChoiceRequired,
  detectInstalledBrowsers,
  resolveBrowserChoice,
} from "./browser-choice.mjs";

export const BOOTSTRAP_SCHEMA_VERSION = 2;
export const BOOTSTRAP_RUNTIME_VERSION = "2.0.0";
// Keep the runtime compatibility version separate from the immutable release
// channel. Release candidates carry the 2.0.0 runtime contract while letting
// fresh-machine production journeys run before the stable v2.0.0 tag exists.
export const BOOTSTRAP_RELEASE_TAG = "v2.0.0-rc.6";
export const OFFICIAL_MANIFEST_URL =
  `https://github.com/time-attack/gstack/releases/download/${BOOTSTRAP_RELEASE_TAG}/gstack-runtime-manifest.json`;
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
const OFFICIAL_RELEASE_PREFIX = `/time-attack/gstack/releases/download/${BOOTSTRAP_RELEASE_TAG}/`;
const OFFICIAL_CERTIFICATE_IDENTITY =
  `https://github.com/time-attack/gstack/.github/workflows/release-artifacts.yml@refs/tags/${BOOTSTRAP_RELEASE_TAG}`;
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
    if (!["options", "preview", "install"].includes(parsed.action)) {
      throw bootstrapError("Expected `options`, `preview`, or `install`", "BOOTSTRAP_USAGE");
    }

    const platform = options.platform ?? process.platform;
    if (parsed.capabilities.includes("ios") && platform !== "darwin") {
      throw bootstrapError("The physical-iOS capability is available only on macOS", "BOOTSTRAP_PLATFORM_UNSUPPORTED");
    }
    const requiresBrowser = browserChoiceRequired(parsed.capabilities);
    if (parsed.action === "options") {
      if (!requiresBrowser) {
        throw bootstrapError("Browser options apply only to browser-backed capabilities", "BOOTSTRAP_USAGE");
      }
      const detected = await detectInstalledBrowsers({
        platform,
        env: options.env,
        homeDir: options.homeDir,
        candidates: options.browserCandidates,
      });
      const installedSupported = !parsed.capabilities.includes("browser-visible");
      const installed = detected.map((browser) => ({
        ...browser,
        supported: installedSupported,
        ...(installedSupported ? {} : { reason: "Visible GStack Browser requires managed Chromium for extension loading" }),
      }));
      const result = {
        managed: {
          provider: "managed",
          description: "GStack-managed isolated Chromium; exact signed component bytes are shown by preview before consent",
        },
        installed,
        mutated: false,
        network: false,
      };
      if (parsed.json) io.stdout.write(`${JSON.stringify({ ok: true, action: "options", ...result }, null, 2)}\n`);
      else printBrowserOptions(io.stdout, result);
      return 0;
    }
    let browserChoice = null;
    if (requiresBrowser) {
      browserChoice = await resolveBrowserChoice({
        provider: parsed.browserProvider,
        executablePath: parsed.browserPath,
      }, { platform, env: options.env, homeDir: options.homeDir });
      assertBrowserChoiceSupportsCapabilities(browserChoice, parsed.capabilities);
    } else if (parsed.browserProvider || parsed.browserPath) {
      throw bootstrapError("Browser options require a browser-backed capability", "BOOTSTRAP_USAGE");
    }
    if (parsed.source) {
      const sourceHome = path.resolve(parsed.home ?? process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack"));
      const active = await inspectReusableRuntime(sourceHome, BOOTSTRAP_RUNTIME_VERSION).catch(() => null);
      if (!browserChoice && active?.browserChoice) {
        browserChoice = await resolveBrowserChoice(active.browserChoice, {
          platform,
          env: options.env,
          homeDir: options.homeDir,
        });
      }
      parsed.capabilities = mergeRetainedCapabilities(parsed.capabilities, active, browserChoice);
      if (browserChoiceRequired(parsed.capabilities) && !browserChoice) {
        throw bootstrapError(
          "The active browser capability does not record a reusable browser provider; choose a browser provider before changing this runtime.",
          "BOOTSTRAP_BROWSER_CHOICE_REQUIRED",
        );
      }
      if (browserChoice) assertBrowserChoiceSupportsCapabilities(browserChoice, parsed.capabilities);
      if (parsed.action === "preview") {
        io.stdout.write("Reviewed-source fallback has no signed compressed-byte manifest; the local installer can provide an on-disk preview only.\n");
        return 0;
      }
      if (!parsed.yes) throw bootstrapError("Installation requires explicit --yes after review", "BOOTSTRAP_CONSENT_REQUIRED");
      io.stderr.write("Developer-only source install: only continue with a checkout you reviewed and trust.\n");
      return await installFromSource(parsed.source, parsed, {
        ...options,
        ...io,
        prepared: false,
        replaceCapabilities: true,
        browserChoice,
      });
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
    const manifest = await fetchJson(fetch_, manifestUrl, {
      official: manifestUrl === OFFICIAL_MANIFEST_URL,
    });
    validateManifest(manifest, target);
    const home = path.resolve(parsed.home ?? process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack"));
    const active = await inspectReusableRuntime(home, manifest.version).catch(() => null);
    const reusable = active?.releaseMatches ? active : null;
    if (!browserChoice && active?.browserChoice) {
      browserChoice = await resolveBrowserChoice(active.browserChoice, {
        platform,
        env: options.env,
        homeDir: options.homeDir,
      });
    }
    parsed.capabilities = mergeRetainedCapabilities(parsed.capabilities, active, browserChoice);
    if (browserChoiceRequired(parsed.capabilities) && !browserChoice) {
      throw bootstrapError(
        "The active browser capability does not record a reusable browser provider; preview browser setup options before changing this runtime.",
        "BOOTSTRAP_BROWSER_CHOICE_REQUIRED",
      );
    }
    if (browserChoice) assertBrowserChoiceSupportsCapabilities(browserChoice, parsed.capabilities);
    const plan = buildComponentPlan(manifest, target, parsed.capabilities, reusable, browserChoice);
    if (parsed.json) io.stdout.write(`${JSON.stringify({ ok: true, action: parsed.action, ...plan }, null, 2)}\n`);
    else printComponentPlan(io.stdout, plan);
    if (parsed.action === "preview") return 0;
    if (!parsed.yes) throw bootstrapError("Installation requires explicit --yes after reviewing this exact component plan", "BOOTSTRAP_CONSENT_REQUIRED");
    const temporary = await fs.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), "gstack-bootstrap-"));
    try {
      const root = path.join(temporary, "merged", "gstack");
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const claimedFiles = new Set();
      if (reusable) await seedReusableRuntime(reusable, root, claimedFiles);
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
      return await installFromSource(root, parsed, { ...options, ...io, prepared: true, version: manifest.version, browserChoice });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    io.stderr.write(`gstack bootstrap: ${error?.message ?? error}\n`);
    return 1;
  }
}

function parseArgs(argv) {
  const result = {
    action: null,
    capabilities: [],
    source: null,
    home: null,
    browserProvider: null,
    browserPath: null,
    yes: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["-h", "--help"].includes(arg)) result.help = true;
    else if (arg === "--yes") result.yes = true;
    else if (arg === "--json") result.json = true;
    else if (!result.action && !arg.startsWith("-")) result.action = arg;
    else if (["--capability", "--source", "--home", "--browser", "--browser-path"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw bootstrapError(`${arg} requires a value`, "BOOTSTRAP_USAGE");
      if (arg === "--capability") result.capabilities.push(value);
      else if (arg === "--source") result.source = value;
      else if (arg === "--home") result.home = value;
      else if (arg === "--browser") result.browserProvider = value;
      else result.browserPath = value;
    } else throw bootstrapError(`Unknown option: ${arg}`, "BOOTSTRAP_USAGE");
  }
  if (result.help) return result;
  if (result.action === "preview" && result.yes) throw bootstrapError("preview cannot be combined with --yes", "BOOTSTRAP_USAGE");
  if (result.action === "options" && (result.yes || result.source || result.browserProvider || result.browserPath)) {
    throw bootstrapError("options cannot be combined with install or browser-selection flags", "BOOTSTRAP_USAGE");
  }
  if (result.browserProvider != null && !["managed", "installed"].includes(result.browserProvider)) {
    throw bootstrapError("--browser must be `managed` or `installed`", "BOOTSTRAP_USAGE");
  }
  if (result.browserProvider === "managed" && result.browserPath != null) {
    throw bootstrapError("--browser-path is valid only with `--browser installed`", "BOOTSTRAP_USAGE");
  }
  if (result.browserPath != null && result.browserProvider !== "installed") {
    throw bootstrapError("--browser-path requires `--browser installed`", "BOOTSTRAP_USAGE");
  }
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

function selectedComponents(capabilities, browserChoice) {
  const selected = new Set(["core"]);
  for (const capability of capabilities) {
    for (const component of CAPABILITY_COMPONENTS[capability] ?? []) selected.add(component);
  }
  const pending = [...selected];
  while (pending.length) {
    for (const dependency of COMPONENT_DEPENDENCIES[pending.pop()] ?? []) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return applyBrowserProviderToComponents([...selected], browserChoice);
}

function mergeRetainedCapabilities(requested, reusable, browserChoice) {
  const selected = new Set([
    ...(Array.isArray(reusable?.selectedCapabilities) ? reusable.selectedCapabilities : []),
    ...requested,
  ]);
  if (browserChoice?.provider === "installed") selected.delete("browser-visible");
  const pending = [...selected];
  while (pending.length) {
    for (const dependency of CAPABILITY_DEPENDENCIES[pending.pop()] ?? []) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return [...selected].sort();
}

function buildComponentPlan(manifest, target, capabilities, reusable, browserChoice) {
  const components = selectedComponents(capabilities, browserChoice);
  const retained = new Set(reusable?.components ?? []);
  const downloads = components
    .filter((component) => !retained.has(component))
    .map((component) => ({ component, artifact: manifest.targets[target].components[component] }));
  const downloadBytes = downloads.reduce((total, item) => total + item.artifact.bytes, 0);
  return {
    target,
    version: manifest.version,
    capabilities,
    browser: browserChoice,
    components,
    reusedComponents: components.filter((component) => retained.has(component)),
    downloads,
    downloadBytes,
  };
}

function printComponentPlan(stdout, plan) {
  stdout.write(`GStack optional runtime ${plan.version} for ${plan.target}\n`);
  stdout.write(`Capabilities: ${plan.capabilities.join(", ")}\n`);
  if (plan.browser?.provider === "installed") {
    stdout.write(`Browser: installed Chromium at ${plan.browser.executablePath}; isolated automation profile, no Chromium download\n`);
  } else if (plan.browser?.provider === "managed") {
    stdout.write("Browser: managed isolated Chromium\n");
  }
  stdout.write(`Components: ${plan.components.join(", ")}\n`);
  if (plan.reusedComponents.length) stdout.write(`Reusing: ${plan.reusedComponents.join(", ")}\n`);
  stdout.write(`Download: ${plan.downloadBytes} bytes across ${plan.downloads.length} component(s)\n`);
}

async function inspectReusableRuntime(home, version) {
  const versions = path.join(home, "versions");
  const pointer = JSON.parse(await fs.readFile(path.join(versions, "current.json"), "utf8"));
  if (pointer?.schemaVersion !== 2 || pointer?.status !== "active" ||
      typeof pointer.current !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(pointer.current)) return null;
  const root = path.join(versions, pointer.current);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const bundle = JSON.parse(await fs.readFile(path.join(root, ".gstack-bundle.json"), "utf8"));
  const releaseMatches = bundle?.version === version ||
    (typeof bundle?.version === "string" && bundle.version.startsWith(`${version}-caps-`));
  if (bundle?.schemaVersion !== 2 || typeof bundle.version !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bundle.version) || !Array.isArray(bundle.runtimeComponents) ||
      !Array.isArray(bundle.files)) return null;
  const components = [...new Set(bundle.runtimeComponents)];
  if (!components.length || components.some((component) => !Object.hasOwn(COMPONENT_DEPENDENCIES, component))) return null;
  const selectedCapabilities = Array.isArray(bundle.selectedCapabilities)
    ? [...new Set(bundle.selectedCapabilities)]
    : [];
  if (selectedCapabilities.some((capability) => !CAPABILITIES.has(capability))) return null;
  let browserChoice = null;
  if (browserChoiceRequired(selectedCapabilities)) {
    const explicit = bundle.browserChoice;
    if (!explicit || !["managed", "installed"].includes(explicit.provider)) return null;
    if (explicit.provider === "installed") {
      if (selectedCapabilities.includes("browser-visible") ||
          typeof explicit.executablePath !== "string" || !path.isAbsolute(explicit.executablePath) ||
          components.includes("browser-headless") || components.includes("browser-visible")) return null;
      browserChoice = { provider: "installed", executablePath: explicit.executablePath };
    } else {
      if (!components.includes("browser-headless") && !components.includes("browser-visible")) return null;
      browserChoice = { provider: "managed", executablePath: null };
    }
  }
  await assertNoLinks(root);
  const files = [];
  const seen = new Set();
  for (const entry of bundle.files) {
    const relative = entry?.path;
    if (typeof relative !== "string" || !relative || relative.includes("\\") || path.posix.isAbsolute(relative) ||
        path.posix.normalize(relative) !== relative || relative.split("/").includes("..") || seen.has(relative) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) return null;
    seen.add(relative);
    const file = path.join(root, ...relative.split("/"));
    const fileStat = await fs.lstat(file).catch(() => null);
    if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.size !== entry.size ||
        await sha256File(file) !== entry.sha256) return null;
    files.push(relative);
  }
  return { root, components, files, selectedCapabilities, browserChoice, releaseMatches };
}

async function seedReusableRuntime(reusable, destination, claimedFiles) {
  for (const relative of reusable.files) {
    if (claimedFiles.has(relative)) throw bootstrapError(`Runtime components overlap at ${relative}`, "BOOTSTRAP_MANIFEST_INVALID");
    claimedFiles.add(relative);
    const target = path.join(destination, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(reusable.root, ...relative.split("/")), target, fsConstants.COPYFILE_EXCL);
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fetchJson(fetch_, url, options = {}) {
  const response = await fetch_(url, { headers: { Accept: "application/json" }, redirect: "follow" });
  assertFinalDownloadUrl(response.url || url);
  if (!response.ok) {
    if (options.official && response.status === 404) {
      throw bootstrapError(
        `Official runtime release ${BOOTSTRAP_RELEASE_TAG} is not published at ${url}. No files were downloaded or installed.`,
        "BOOTSTRAP_RELEASE_UNAVAILABLE",
      );
    }
    throw bootstrapError(`Manifest download failed with HTTP ${response.status} from ${url}. No files were downloaded or installed.`, "BOOTSTRAP_DOWNLOAD_FAILED");
  }
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
  if (options.browserChoice) {
    args.push("--browser", options.browserChoice.provider);
    if (options.browserChoice.executablePath) args.push("--browser-path", options.browserChoice.executablePath);
  }
  if (parsed.home) args.push("--home", path.resolve(parsed.home));
  if (options.version) args.push("--version", options.version);
  if (options.prepared) args.push("--prepared");
  if (options.prepared || options.replaceCapabilities) args.push("--replace-capabilities");
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

async function mergeComponentRoot(source, destination, claimedFiles, component) {
  async function visit(relative = "") {
    for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const from = path.join(source, ...child.split("/"));
      const to = path.join(destination, ...child.split("/"));
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw bootstrapError(`Runtime component ${component} contains a link or special file`, "BOOTSTRAP_ARCHIVE_UNSAFE");
      }
      if (entry.isDirectory()) {
        await fs.mkdir(to, { recursive: true, mode: 0o700 });
        await visit(child);
      } else {
        if (claimedFiles.has(child)) {
          throw bootstrapError(`Runtime components overlap at ${child}`, "BOOTSTRAP_MANIFEST_INVALID");
        }
        claimedFiles.add(child);
        await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
      }
    }
  }
  await visit();
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
  return "Usage: node runtime-bootstrap.mjs options --capability <browser-backed-name>\n" +
    "       node runtime-bootstrap.mjs preview|install --capability <name> [--capability <name>...]\n" +
    "              --browser managed|installed [--browser-path <absolute-path>] [--yes]\n" +
    "       node runtime-bootstrap.mjs install --source <reviewed-checkout> --capability <name> --browser <choice>\n\n" +
    "Downloads only a versioned official GStack runtime release and never enrolls a coding host.\n" +
    "--source is a developer-only fallback for a checkout you have reviewed and trust.\n";
}

function printBrowserOptions(stdout, result) {
  stdout.write("GStack browser setup options (no network access and no changes made)\n");
  stdout.write(`managed: ${result.managed.description}\n`);
  if (!result.installed.length) stdout.write("installed: no supported Chromium executable detected; an absolute path may be supplied explicitly\n");
  for (const browser of result.installed) stdout.write(browser.supported
    ? `installed: ${browser.name} — ${browser.executablePath}\n`
    : `installed (unavailable for this capability): ${browser.name} — ${browser.executablePath}; ${browser.reason}\n`);
  stdout.write("No provider is selected until the user chooses one and separately approves the previewed install.\n");
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
