import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { familySync as detectLibcFamilySync, GLIBC, MUSL } from "detect-libc";
import { resolveGstackHome, resolveRuntimePaths, assertPathInside } from "./paths.js";
import { atomicWriteFile, atomicWriteJson, pathExists, readJson } from "./storage.js";
import { purgeManagedHomeUnlocked, stageUpgradeUnlocked } from "./upgrade.js";
import {
  assertManagedHome,
  assertSafeManagedHomePath,
  ensureManagedHome,
  recoverRuntimeTransactionUnlocked,
  RUNTIME_TRANSACTION_FILE,
  withRuntimeLifecycleLock,
} from "./managed-home.js";
import { errorWithCode as installError } from "./errors.js";
import { currentIsoTimestamp as isoNow } from "./time.js";

const INSTALL_SCHEMA_VERSION = 2;

/**
 * Audited stable helper surface used by retained specialist modules. Targets
 * live inside each immutable runtime; launchers under $GSTACK_HOME/bin resolve
 * the active version without embedding a checkout or host-specific path.
 *
 * `source` is the one shell library that must remain sourceable. `bun-proxy`
 * is used where preserved commands explicitly prefix the helper path with Bun.
 */
export const DEFAULT_RUNTIME_HELPERS = Object.freeze({
  "gstack-artifacts-init": helper("bin/gstack-artifacts-init"),
  "gstack-brain-cache": helper("bin/gstack-brain-cache"),
  "gstack-brain-sync": helper("bin/gstack-brain-sync"),
  "gstack-builder-profile": helper("bin/gstack-builder-profile"),
  "gstack-codex-probe": helper("bin/gstack-codex-probe"),
  "gstack-config": helper("bin/gstack-config"),
  "gstack-decision-log": helper("bin/gstack-decision-log"),
  "gstack-decision-search": helper("bin/gstack-decision-search"),
  "gstack-detach": helper("bin/gstack-detach"),
  "gstack-developer-profile": helper("bin/gstack-developer-profile"),
  "gstack-diff-scope": helper("bin/gstack-diff-scope"),
  "gstack-distill-apply": helper("bin/gstack-distill-apply"),
  "gstack-distill-free-text": helper("bin/gstack-distill-free-text"),
  "gstack-first-task-detect": helper("bin/gstack-first-task-detect"),
  "gstack-gbrain-detect": helper("bin/gstack-gbrain-detect"),
  "gstack-gbrain-install": helper("bin/gstack-gbrain-install"),
  "gstack-gbrain-lib.sh": helper("bin/gstack-gbrain-lib.sh", "source"),
  "gstack-gbrain-mcp-verify": helper("bin/gstack-gbrain-mcp-verify"),
  "gstack-gbrain-repo-policy": helper("bin/gstack-gbrain-repo-policy"),
  "gstack-gbrain-source-wireup": helper("bin/gstack-gbrain-source-wireup"),
  "gstack-gbrain-supabase-provision": helper("bin/gstack-gbrain-supabase-provision"),
  "gstack-gbrain-supabase-verify": helper("bin/gstack-gbrain-supabase-verify"),
  "gstack-gbrain-sync": helper("bin/gstack-gbrain-sync.ts"),
  "gstack-gbrain-sync.ts": helper("bin/gstack-gbrain-sync.ts", "bun-proxy"),
  "gstack-global-discover": helper("bin/gstack-global-discover.ts"),
  "gstack-learnings-log": helper("bin/gstack-learnings-log"),
  "gstack-learnings-search": helper("bin/gstack-learnings-search"),
  "gstack-memory-ingest": helper("bin/gstack-memory-ingest.ts"),
  "gstack-model-benchmark": helper("bin/gstack-model-benchmark"),
  "gstack-next-version": helper("bin/gstack-next-version"),
  "gstack-paths": helper("bin/gstack-paths"),
  "gstack-pr-title-rewrite.sh": helper("bin/gstack-pr-title-rewrite.sh"),
  "gstack-question-log": helper("bin/gstack-question-log"),
  "gstack-question-preference": helper("bin/gstack-question-preference"),
  "gstack-redact": helper("bin/gstack-redact"),
  "gstack-redact-audit-log": helper("bin/gstack-redact-audit-log"),
  "gstack-repo-mode": helper("bin/gstack-repo-mode"),
  "gstack-review-log": helper("bin/gstack-review-log"),
  "gstack-review-read": helper("bin/gstack-review-read"),
  "gstack-session-kind": helper("bin/gstack-session-kind"),
  "gstack-slug": helper("bin/gstack-slug"),
  "gstack-taste-update": helper("bin/gstack-taste-update"),
  "gstack-telemetry-log": helper("bin/gstack-telemetry-log"),
  "gstack-timeline-log": helper("bin/gstack-timeline-log"),
  "gstack-update-check": helper("bin/gstack-update-check"),
  "gstack-version-bump": helper("bin/gstack-version-bump"),
  "remote-slug": helper("browse/bin/remote-slug"),
});

const RUNTIME_HELPER_INTERNALS = Object.freeze([
  "bin/gstack-artifacts-url",
  "bin/gstack-brain-enqueue",
  "bin/gstack-jsonl-merge",
  "bin/gstack-patch-names",
  "bin/gstack-redact-prepush",
  "bin/gstack-telemetry-sync",
]);

const RUNTIME_HELPER_DEPENDENCIES = Object.freeze([
  "VERSION",
  "package.json",
  "lib/bin-context.ts",
  "lib/conductor-env-shim.ts",
  "lib/gbrain-exec.ts",
  "lib/gbrain-guards.ts",
  "lib/gbrain-local-status.ts",
  "lib/gbrain-sources.ts",
  "lib/gstack-decision-semantic.ts",
  "lib/gstack-decision.ts",
  "lib/gstack-memory-helpers.ts",
  "lib/jsonl-store.ts",
  "lib/model-benchmark",
  "lib/redact-audit-log.ts",
  "lib/redact-engine.ts",
  "lib/redact-patterns.ts",
  "lib/staging-guard.ts",
  "scripts/archetypes.ts",
  "scripts/brain-cache-spec.ts",
  "scripts/one-way-doors.ts",
  "scripts/psychographic-signals.ts",
  "scripts/question-registry.ts",
  "supabase/config.sh",
]);

const DEFAULT_HELPER_CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_RUNTIME_HELPERS)
    .filter(([, descriptor]) => descriptor.launcher === "exec")
    .map(([name, descriptor]) => [name, descriptor.target]),
));
const DEFAULT_STABLE_SOURCE_FILES = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_RUNTIME_HELPERS)
    .filter(([, descriptor]) => descriptor.launcher === "source")
    .map(([name, descriptor]) => [name, descriptor.target]),
));
const DEFAULT_BUN_PROXY_HELPERS = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_RUNTIME_HELPERS)
    .filter(([, descriptor]) => descriptor.launcher === "bun-proxy")
    .map(([name, descriptor]) => [name, descriptor.target]),
));

const RUNTIME_HELPER_TARGETS = Object.freeze([...new Set(
  Object.values(DEFAULT_RUNTIME_HELPERS).map((descriptor) => descriptor.target),
)]);

/**
 * Resolve only the native packages loaded on this host. Package managers may
 * leave optional binaries for several platforms in node_modules; copying an
 * entire scope would make the managed bundle depend on that incidental state.
 */
export function runtimeNativePackagePaths(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const supportedArch = ["x64", "arm64"].includes(arch);
  if (!["darwin", "linux", "win32"].includes(platform) || !supportedArch) {
    throw new TypeError(`Unsupported managed-runtime platform: ${platform}-${arch}`);
  }

  const paths = ["node_modules/@img/colour"];
  if (platform === "darwin") {
    paths.push(
      `node_modules/@img/sharp-darwin-${arch}`,
      `node_modules/@img/sharp-libvips-darwin-${arch}`,
      // The ngrok loader tries its universal macOS binary before the
      // architecture-specific fallback, so retain that single canonical copy.
      "node_modules/@ngrok/ngrok-darwin-universal",
    );
  } else if (platform === "win32") {
    paths.push(
      `node_modules/@img/sharp-win32-${arch}`,
      `node_modules/@ngrok/ngrok-win32-${arch}-msvc`,
    );
  } else {
    const libc = options.libc ?? detectLibcFamilySync();
    if (![GLIBC, MUSL].includes(libc)) {
      throw new TypeError(`Unsupported managed-runtime libc: ${String(libc)}`);
    }
    const sharpPlatform = libc === MUSL ? `linuxmusl-${arch}` : `linux-${arch}`;
    const ngrokLibc = libc === MUSL ? "musl" : "gnu";
    paths.push(
      `node_modules/@img/sharp-${sharpPlatform}`,
      `node_modules/@img/sharp-libvips-${sharpPlatform}`,
      `node_modules/@ngrok/ngrok-linux-${arch}-${ngrokLibc}`,
    );
  }
  paths.push("node_modules/@ngrok/ngrok");
  return Object.freeze(paths);
}

/**
 * The managed bundle is deliberately narrow. Skills remain installed by a
 * standards-based Agent Skills installer; this list contains only optional
 * local runtime capabilities.
 */
export const DEFAULT_RUNTIME_BUNDLE = Object.freeze([
  entry("runtime"),
  entry("bin/gstack"),
  ...RUNTIME_HELPER_TARGETS.map((target) => entry(
    target,
    undefined,
    !Object.values(DEFAULT_STABLE_SOURCE_FILES).includes(target) && !target.startsWith("lib/"),
  )),
  ...RUNTIME_HELPER_INTERNALS.map((target) => entry(target, undefined, true)),
  ...RUNTIME_HELPER_DEPENDENCIES.map((target) => entry(target)),
  entry(platformBinary("browse/dist/browse"), "core", true),
  entry(platformBinary("browse/dist/find-browse"), "core", true),
  entry("browse/dist/server-node.mjs", "core"),
  entry("browse/dist/bun-polyfill.cjs", "core"),
  entry("browse/dist/.version", "core"),
  // The compiled client deliberately spawns the existing Bun server source.
  // Keep its small, audited dependency closure explicit instead of copying all
  // node_modules or introducing a cloud browser.
  entry("browse/src"),
  entry("extension"),
  entry("node_modules/playwright"),
  entry("node_modules/playwright-core"),
  entry("node_modules/diff"),
  entry("node_modules/socks"),
  entry("node_modules/smart-buffer"),
  entry("node_modules/ip-address"),
  // Retained browser capabilities load these at runtime rather than through
  // the compiled CLI: Sharp powers full-page screenshot resizing, while
  // ngrok is an explicit opt-in tunnel for pair-agent (never a cloud browser).
  entry("node_modules/sharp"),
  ...runtimeNativePackagePaths().map((target) => entry(target)),
  entry("node_modules/detect-libc"),
  entry("node_modules/semver"),
  entry("node_modules/@anthropic-ai/sdk"),
  entry(platformBinary("design/dist/design"), "core", true),
  entry("design/dist/.version", "core"),
  entry(platformBinary("make-pdf/dist/pdf"), "core", true),
  entry("make-pdf/dist/.version", "core"),
  entry("lib/diagram-render/dist/diagram-render.html", "diagram"),
  entry("lib/diagram-render/dist/BUILD_INFO.json", "diagram"),
  ...(process.platform === "darwin" ? [
    entry("ios-qa/dist/gstack-ios-qa-daemon", "ios", true),
    entry("ios-qa/dist/gstack-ios-qa-mint", "ios", true),
    entry("ios-qa/templates"),
    entry("ios-qa/scripts/gen-accessors.ts"),
    entry("ios-qa/scripts/gen-accessors-tool"),
  ] : []),
]);

export const DEFAULT_CAPABILITY_LAUNCHERS = Object.freeze({
  browse: platformBinary("browse/dist/browse"),
  "gstack-design": platformBinary("design/dist/design"),
  "make-pdf": platformBinary("make-pdf/dist/pdf"),
  ...DEFAULT_HELPER_CAPABILITIES,
  ...(process.platform === "darwin" ? {
    "gstack-ios-qa-daemon": "ios-qa/dist/gstack-ios-qa-daemon",
    "gstack-ios-qa-mint": "ios-qa/dist/gstack-ios-qa-mint",
  } : {}),
});

/**
 * Install one immutable runtime bundle and atomically activate it.
 *
 * Inject `entries`, `builder`, `validate`, and `smokeTest` for offline tests or
 * embedders. The public CLI integration normally needs only sourceDir, home,
 * and version.
 */
export async function installManagedRuntime(options = {}) {
  if (!options.sourceDir) throw installError("sourceDir is required", "INSTALL_SOURCE_REQUIRED");

  const sourceDir = await resolvePhysicalSource(options.sourceDir, {
    rejectRootLink: options.rejectSourceRootLink === true,
  });
  const home = assertSafeManagedHomePath(
    path.resolve(options.home ?? resolveGstackHome(options)),
    options,
  );
  const packageMetadata = await readPackageMetadata(sourceDir);
  const version = options.version ?? packageMetadata.version;
  validateVersion(version);
  if (options.requirePackageIdentity) validatePackageIdentity(packageMetadata, version);

  const entries = normalizeEntries(options.entries ?? DEFAULT_RUNTIME_BUNDLE);
  const capabilities = normalizeCapabilities(options.capabilities ?? DEFAULT_CAPABILITY_LAUNCHERS, entries);
  const useDefaultHelperSurface = options.entries == null;
  const stableSourceFiles = normalizeCapabilities(
    options.stableSourceFiles ?? (useDefaultHelperSurface ? DEFAULT_STABLE_SOURCE_FILES : {}),
    entries,
  );
  const bunProxyHelpers = normalizeCapabilities(
    options.bunProxyHelpers ?? (useDefaultHelperSurface ? DEFAULT_BUN_PROXY_HELPERS : {}),
    entries,
  );
  const launcherSurface = Object.freeze({ capabilities, stableSourceFiles, bunProxyHelpers });
  const launcherFiles = launcherRelativePaths(launcherSurface);
  if (new Set(launcherFiles).size !== launcherFiles.length) {
    throw new TypeError("Stable launcher names collide");
  }

  let missing = await missingEntries(sourceDir, entries);
  if (missing.length > 0) {
    if (options.buildMissing === false) {
      throw installError(
        `Runtime source is incomplete: ${missing.map((item) => item.path).join(", ")}`,
        "INSTALL_SOURCE_INCOMPLETE",
      );
    }
    const builder = options.builder ?? defaultBunBuilder;
    try {
      await builder({
        sourceDir,
        missing: Object.freeze(missing.map((item) => Object.freeze({ ...item }))),
        bunCommand: options.bunCommand ?? process.env.BUN_CMD ?? "bun",
        run: options.runCommand ?? runCommand,
      });
    } catch (cause) {
      throw installError("Runtime capability build failed; the active version was not changed", "INSTALL_BUILD_FAILED", cause);
    }
    missing = await missingEntries(sourceDir, entries);
    if (missing.length > 0) {
      const names = missing.map((item) => item.path).join(", ");
      throw installError(`Runtime builder did not produce required components: ${names}`, "INSTALL_BUILD_INCOMPLETE");
    }
  }

  return withRuntimeLifecycleLock(home, async () => {
    await ensureManagedHome(home, options);
    await recoverRuntimeTransactionUnlocked(home);
    const paths = resolveRuntimePaths({ home });
    await fs.mkdir(paths.tmp, { recursive: true, mode: 0o700 });
    const scratch = assertPathInside(paths.tmp, path.join(paths.tmp, `install-${randomUUID()}`));
    try {
      await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
      const files = await copyAllowlistedBundle(sourceDir, scratch, entries);
      const bundleManifest = {
        schemaVersion: INSTALL_SCHEMA_VERSION,
        version,
        components: entries.map(({ path: component }) => component),
        capabilities,
        stableSourceFiles,
        bunProxyHelpers,
        files,
      };
      await atomicWriteJson(path.join(scratch, ".gstack-bundle.json"), bundleManifest, { mode: 0o644 });

      const validate = options.validate ?? validateRuntimeBundle;
      await validate(scratch, { version, entries, manifest: bundleManifest });
      await validateLauncherTargets(scratch, launcherSurface);

      const snapshot = await captureInstallSurface(paths, launcherSurface);
      let installManifest;
      const result = await stageUpgradeUnlocked({
        home,
        sourceDir: scratch,
        version,
        now: options.now,
        verify: async (candidate) => {
          await validate(candidate, { version, entries, manifest: bundleManifest });
          await validateLauncherTargets(candidate, launcherSurface);
        },
        healthCheck: async (candidate) => {
          const smokeTest = options.smokeTest ?? smokeRuntimeBundle;
          await smokeTest(candidate, {
            version,
            nodeCommand: options.nodeCommand ?? process.env.GSTACK_NODE ?? "node",
            run: options.runCommand ?? runCommand,
            commandTimeoutMs: options.commandTimeoutMs,
          });
        },
        beforeActivate: async ({ active, previous, previousExists, destination }) => {
          await writeRuntimeTransactionJournal(paths, snapshot, {
            version,
            previousPointer: previous,
            previousPointerExists: previousExists,
          });
          await installStableLaunchers(paths, launcherSurface, destination, options);
          await removeObsoleteLaunchers(paths, snapshot, launcherSurface);
          const manifestWriter = options.manifestWriter ?? writeInstallManifest;
          installManifest = await manifestWriter(paths, active, launcherSurface, options.now);
        },
        afterActivate: async () => fs.rm(path.join(home, RUNTIME_TRANSACTION_FILE), { force: true }),
        onRollback: async ({ pointerRollbackError }) => {
          await restoreInstallSurface(paths, snapshot);
          if (!pointerRollbackError) await fs.rm(path.join(home, RUNTIME_TRANSACTION_FILE), { force: true });
        },
      });

      return {
        home,
        version,
        path: result.path,
        pointer: result.pointer,
        staged: result.staged,
        manifest: installManifest,
        launchers: launcherPaths(paths.home, launcherSurface),
      };
    } finally {
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }, options);
}

/**
 * Remove only files recorded as managed by this installer. User config,
 * secrets, project state, and plans remain unless the existing purge contract
 * is explicitly requested.
 */
export async function uninstallManagedRuntime(home, options = {}) {
  const resolvedHome = assertSafeManagedHomePath(
    path.resolve(home ?? resolveGstackHome(options)),
    options,
  );
  return withRuntimeLifecycleLock(resolvedHome, async () => {
    await assertManagedHome(resolvedHome, options);
    await recoverRuntimeTransactionUnlocked(resolvedHome);
    if (options.purge) {
      return purgeManagedHomeUnlocked(resolvedHome);
    }

    const paths = resolveRuntimePaths({ home: resolvedHome });
    const manifestPath = path.join(resolvedHome, "runtime-install.json");
    const manifest = await readJson(manifestPath, null);
    const managedLaunchers = validateInstallManifestForUninstall(manifest);
    const quarantine = assertPathInside(paths.tmp, path.join(paths.tmp, `uninstall-${randomUUID()}`));
    await fs.mkdir(quarantine, { recursive: true, mode: 0o700 });
    const moved = [];
    try {
      const removals = [
        ...managedLaunchers,
        ...(manifest ? ["runtime-install.json"] : []),
        ...(await pathExists(paths.versions) ? ["versions"] : []),
      ];
      for (const relative of removals) {
        const target = assertPathInside(resolvedHome, path.join(resolvedHome, relative));
        const stat = await fs.lstat(target).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (!stat) continue;
        const isVersions = relative === "versions";
        if (stat.isSymbolicLink() || (isVersions ? !stat.isDirectory() : !stat.isFile())) {
          throw installError(`Refusing unexpected managed path type: ${relative}`, "INSTALL_MANIFEST_INVALID");
        }
        const destination = assertPathInside(quarantine, path.join(quarantine, relative));
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.rename(target, destination);
        moved.push({ target, destination });
      }
    } catch (error) {
      for (const item of moved.reverse()) {
        await fs.mkdir(path.dirname(item.target), { recursive: true, mode: 0o700 });
        await fs.rename(item.destination, item.target).catch(() => {});
      }
      throw error;
    }
    await fs.rm(quarantine, { recursive: true, force: true });
    await fs.rmdir(path.join(resolvedHome, "bin")).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
    });
    return {
      purged: false,
      preservedState: true,
      home: resolvedHome,
      launchersRemoved: managedLaunchers.length,
      manifestRemoved: manifest != null,
    };
  }, options);
}

/** Build only absent groups; existing artifacts are never rebuilt. */
export async function defaultBunBuilder({ sourceDir, missing, bunCommand = "bun", run = runCommand }) {
  const groups = new Set(missing.map((item) => item.build).filter(Boolean));
  const unbuildable = missing.filter((item) => !item.build);
  if (unbuildable.length > 0) {
    throw installError(
      `Source bundle is incomplete: ${unbuildable.map((item) => item.path).join(", ")}`,
      "INSTALL_SOURCE_INCOMPLETE",
    );
  }

  if (groups.has("core")) await run(bunCommand, ["run", "build:runtime"], { cwd: sourceDir });
  if (groups.has("diagram")) await run(bunCommand, ["run", "build:diagram-render"], { cwd: sourceDir });
  if (groups.has("ios")) {
    await fs.mkdir(path.join(sourceDir, "ios-qa", "dist"), { recursive: true });
    await run(bunCommand, [
      "build", "--compile", "ios-qa/daemon/src/index.ts",
      "--outfile", "ios-qa/dist/gstack-ios-qa-daemon",
    ], { cwd: sourceDir });
    await run(bunCommand, [
      "build", "--compile", "ios-qa/daemon/src/cli-mint.ts",
      "--outfile", "ios-qa/dist/gstack-ios-qa-mint",
    ], { cwd: sourceDir });
  }
}

export async function validateRuntimeBundle(directory, context = {}) {
  const manifestPath = path.join(directory, ".gstack-bundle.json");
  const manifest = await readJson(manifestPath, null);
  if (!manifest || manifest.schemaVersion !== INSTALL_SCHEMA_VERSION) {
    throw installError("Runtime bundle manifest is missing or unsupported", "INSTALL_VALIDATION_FAILED");
  }
  if (context.version && manifest.version !== context.version) {
    throw installError("Runtime bundle version does not match the requested version", "INSTALL_VALIDATION_FAILED");
  }
  if (!Array.isArray(manifest.components) || manifest.components.length === 0 ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw installError("Runtime bundle manifest must list non-empty components and files", "INSTALL_VALIDATION_FAILED");
  }
  const components = manifest.components.map((component) => {
    const normalized = normalizeRelativePath(component, "bundle component");
    if (component !== normalized) throw installError(`Runtime bundle component is not canonical: ${component}`, "INSTALL_VALIDATION_FAILED");
    return normalized;
  });
  if (new Set(components).size !== components.length) {
    throw installError("Runtime bundle manifest contains duplicate components", "INSTALL_VALIDATION_FAILED");
  }
  if (context.entries) {
    const expectedComponents = context.entries.map((item) => item.path);
    if (!sameStringArray(components, expectedComponents)) {
      throw installError("Runtime bundle components do not match the installer allowlist", "INSTALL_VALIDATION_FAILED");
    }
  }
  if (context.manifest && JSON.stringify(manifest) !== JSON.stringify(context.manifest)) {
    throw installError("Runtime bundle manifest changed after staging", "INSTALL_VALIDATION_FAILED");
  }

  await assertTreeContainsNoLinks(directory);
  const stageMetadataPath = path.join(directory, ".gstack-version.json");
  if (await pathExists(stageMetadataPath)) {
    const stageMetadata = await readJson(stageMetadataPath, null);
    if (stageMetadata?.schemaVersion !== INSTALL_SCHEMA_VERSION || stageMetadata?.version !== manifest.version) {
      throw installError("Runtime stage metadata is invalid", "INSTALL_VALIDATION_FAILED");
    }
  }
  const listed = new Set();
  for (const file of manifest.files) {
    const relative = normalizeRelativePath(file.path, "bundle manifest path");
    if (file.path !== relative || relative === ".gstack-bundle.json" || relative === ".gstack-version.json" || listed.has(relative) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 ||
        typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw installError(`Runtime bundle manifest entry is invalid: ${relative}`, "INSTALL_VALIDATION_FAILED");
    }
    listed.add(relative);
    const absolute = assertPathInside(directory, path.join(directory, relative));
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat?.isFile()) throw installError(`Runtime bundle file is missing: ${relative}`, "INSTALL_VALIDATION_FAILED");
    const digest = await sha256File(absolute);
    if (digest !== file.sha256 || stat.size !== file.size || (stat.mode & 0o777) !== file.mode) {
      throw installError(`Runtime bundle file failed integrity validation: ${relative}`, "INSTALL_VALIDATION_FAILED");
    }
  }
  const actual = await listBundlePayloadFiles(directory);
  if (!sameStringArray([...listed].sort(), actual)) {
    const extras = actual.filter((file) => !listed.has(file));
    const missing = [...listed].filter((file) => !actual.includes(file));
    throw installError(
      `Runtime bundle file inventory does not match its manifest (extra: ${extras.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
      "INSTALL_VALIDATION_FAILED",
    );
  }
  return true;
}

export async function smokeRuntimeBundle(directory, options = {}) {
  const command = options.nodeCommand ?? process.env.GSTACK_NODE ?? "node";
  const run = options.run ?? runCommand;
  const timeoutMs = options.commandTimeoutMs ?? 15_000;
  const version = await run(command, ["--version"], { capture: true, timeoutMs });
  const versionText = `${version?.stdout ?? ""}${version?.stderr ?? ""}`.trim();
  const nodeMajor = Number(versionText.match(/v?(\d+)\./)?.[1]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 18) {
    throw installError(`Node 18+ is required by managed launchers (found ${versionText || "unknown"})`, "INSTALL_NODE_REQUIRED");
  }
  const result = await run(command, [path.join(directory, "bin", "gstack"), "--version"], {
    cwd: directory,
    capture: true,
    timeoutMs,
  });
  if (!/gstack/i.test(`${result?.stdout ?? ""}${result?.stderr ?? ""}`)) {
    throw installError("Runtime launcher smoke test returned an unexpected response", "INSTALL_SMOKE_FAILED");
  }
  const nativeImports = [];
  for (const packageName of ["sharp", "@ngrok/ngrok"]) {
    if (await pathExists(path.join(directory, "node_modules", packageName, "package.json"))) {
      nativeImports.push(packageName);
    }
  }
  if (nativeImports.length > 0) {
    try {
      await run(command, [
        "--input-type=module",
        "--eval",
        `${nativeImports.map((packageName) => `await import(${JSON.stringify(packageName)});`).join(" ")} process.exit(0);`,
      ], { cwd: directory, capture: true, timeoutMs });
    } catch (cause) {
      throw installError("Runtime native dependency smoke test failed", "INSTALL_SMOKE_FAILED", cause);
    }
  }
}

export async function runInstallerCli(argv = process.argv.slice(2), options = {}) {
  let parsed = { json: argv.includes("--json"), quiet: false };
  try {
    parsed = parseInstallerArgs(argv);
    if (parsed.help) {
      (options.stdout ?? process.stdout).write(installerUsage());
      return 0;
    }
    const sourceDir = parsed.sourceDir ?? options.sourceDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const env = options.env ?? process.env;
    const home = parsed.home ?? resolveGstackHome({ env, homeDir: options.homeDir, cwd: options.cwd });
    const result = await installManagedRuntime({
      sourceDir,
      home,
      version: parsed.version,
      bunCommand: parsed.bunCommand,
      nodeCommand: env.GSTACK_NODE ?? "node",
      launcherNodeCommand: env.GSTACK_NODE ?? "node",
      ...options.installOptions,
    });
    const stdout = options.stdout ?? process.stdout;
    if (parsed.json) {
      stdout.write(`${JSON.stringify({ ok: true, home: result.home, version: result.version, path: result.path, launchers: result.launchers }, null, 2)}\n`);
    } else if (!parsed.quiet) {
      stdout.write(`Installed gstack runtime ${result.version}\n`);
      stdout.write(`Runtime home: ${result.home}\n`);
      stdout.write(`Launcher directory: ${path.join(result.home, "bin")}\n`);
      stdout.write("Skills are installed separately with: npx skills add time-attack/gstack\n");
    }
    return 0;
  } catch (error) {
    const stderr = options.stderr ?? process.stderr;
    if (parsed.json) stderr.write(`${JSON.stringify({ ok: false, error: error?.code ?? "INSTALL_ERROR", message: error?.message ?? String(error) })}\n`);
    else stderr.write(`gstack setup: ${error?.message ?? error}\n`);
    return 1;
  }
}

function entry(componentPath, build, executable = false) {
  return Object.freeze({ path: componentPath, build, executable });
}

function helper(target, launcher = "exec") {
  return Object.freeze({ target, launcher });
}

function platformBinary(componentPath) {
  return process.platform === "win32" ? `${componentPath}.exe` : componentPath;
}

async function resolvePhysicalSource(source, options = {}) {
  const absolute = path.resolve(source);
  const logicalStat = await fs.lstat(absolute).catch((error) => {
    throw installError(`Runtime source does not exist: ${absolute}`, "INSTALL_SOURCE_MISSING", error);
  });
  if (options.rejectRootLink && logicalStat.isSymbolicLink()) {
    throw installError(`Refusing a symlinked runtime source: ${absolute}`, "INSTALL_SOURCE_LINK");
  }
  const physical = await fs.realpath(absolute).catch((error) => {
    throw installError(`Runtime source does not exist: ${absolute}`, "INSTALL_SOURCE_MISSING", error);
  });
  const stat = await fs.stat(physical);
  if (!stat.isDirectory()) throw installError("Runtime source must be a directory", "INSTALL_SOURCE_INVALID");
  return physical;
}

function normalizeEntries(input) {
  if (!Array.isArray(input) || input.length === 0) throw new TypeError("entries must be a non-empty array");
  const seen = new Set();
  return Object.freeze(input.map((item) => {
    const value = typeof item === "string" ? { path: item } : item;
    const component = normalizeRelativePath(value?.path, "bundle entry");
    if ([...seen].some((existing) =>
      existing === component || existing.startsWith(`${component}/`) || component.startsWith(`${existing}/`))) {
      throw new TypeError(`Overlapping bundle entry: ${component}`);
    }
    seen.add(component);
    return Object.freeze({ path: component, build: value.build, executable: value.executable === true });
  }));
}

function normalizeCapabilities(input, entries) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("capabilities must be an object");
  const roots = entries.map((item) => item.path);
  const result = {};
  for (const [name, targetValue] of Object.entries(input)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new TypeError(`Invalid capability launcher name: ${name}`);
    const target = normalizeRelativePath(targetValue, `capability target for ${name}`);
    if (!roots.some((root) => target === root || target.startsWith(`${root}/`))) {
      throw new TypeError(`Capability target is outside the bundle allowlist: ${target}`);
    }
    result[name] = target;
  }
  return Object.freeze(result);
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || path.isAbsolute(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new TypeError(`Invalid ${label}: ${value}`);
  return normalized;
}

async function missingEntries(sourceDir, entries) {
  const missing = [];
  for (const item of entries) {
    const candidate = assertPathInside(sourceDir, path.join(sourceDir, item.path));
    if (!(await pathExists(candidate))) missing.push(item);
  }
  return missing;
}

async function copyAllowlistedBundle(sourceDir, destination, entries) {
  const files = [];
  for (const item of entries) {
    const source = assertPathInside(sourceDir, path.join(sourceDir, item.path));
    const target = assertPathInside(destination, path.join(destination, item.path));
    const physical = await fs.realpath(source);
    assertPathInside(sourceDir, physical);
    await copyNodeWithoutLinks(source, target, destination, files, item.executable);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function copyNodeWithoutLinks(source, destination, bundleRoot, files, forceExecutable = false) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    throw installError(`Refusing symlink in runtime source: ${source}`, "INSTALL_SOURCE_LINK");
  }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: stat.mode & 0o777 });
    const children = await fs.readdir(source);
    children.sort();
    for (const child of children) {
      await copyNodeWithoutLinks(
        path.join(source, child),
        path.join(destination, child),
        bundleRoot,
        files,
        false,
      );
    }
    return;
  }
  if (!stat.isFile()) throw installError(`Unsupported runtime source entry: ${source}`, "INSTALL_SOURCE_TYPE");
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination);
  const mode = forceExecutable ? (stat.mode | 0o111) & 0o777 : stat.mode & 0o777;
  await fs.chmod(destination, mode);
  files.push({
    path: path.relative(bundleRoot, destination).split(path.sep).join("/"),
    size: stat.size,
    mode,
    sha256: await sha256File(destination),
  });
}

async function assertTreeContainsNoLinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw installError(`Runtime bundle contains a symlink: ${current}`, "INSTALL_VALIDATION_FAILED");
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(current)) pending.push(path.join(current, child));
    } else if (!stat.isFile()) {
      throw installError(`Runtime bundle contains an unsupported entry: ${current}`, "INSTALL_VALIDATION_FAILED");
    }
  }
}

async function validateLauncherTargets(root, launcherSurface) {
  for (const group of Object.values(launcherSurface)) {
    for (const [name, relative] of Object.entries(group)) {
      const target = assertPathInside(root, path.join(root, relative));
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw installError(`Stable launcher target is missing or invalid (${name}): ${relative}`, "INSTALL_VALIDATION_FAILED");
      }
    }
  }
}

async function installStableLaunchers(paths, launcherSurface, activeRoot, options = {}) {
  const { capabilities, stableSourceFiles, bunProxyHelpers } = launcherSurface;
  const binDir = path.join(paths.home, "bin");
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  const nodeName = options.launcherNodeCommand ?? "node";
  if (typeof nodeName !== "string" || !nodeName || /[\0\r\n]/.test(nodeName)) {
    throw installError("Invalid launcher Node command", "INSTALL_NODE_REQUIRED");
  }

  await atomicWriteFile(path.join(binDir, "gstack-resolve.mjs"), activeResolverSource(), { mode: 0o755 });
  await atomicWriteFile(path.join(binDir, "gstack-launcher.mjs"), gstackLauncherSource(), { mode: 0o755 });
  await atomicWriteFile(path.join(binDir, "gstack-capability-launcher.mjs"), capabilityLauncherSource(), { mode: 0o755 });
  await atomicWriteFile(path.join(binDir, "gstack"), posixLauncher("gstack-launcher.mjs", [], nodeName), { mode: 0o755 });
  await atomicWriteFile(path.join(binDir, "gstack.cmd"), windowsLauncher("gstack-launcher.mjs", [], nodeName), { mode: 0o644 });

  for (const [name, target] of Object.entries(capabilities)) {
    await atomicWriteFile(path.join(binDir, name), posixLauncher("gstack-capability-launcher.mjs", [target], nodeName), { mode: 0o755 });
    await atomicWriteFile(path.join(binDir, `${name}.cmd`), windowsLauncher("gstack-capability-launcher.mjs", [target], nodeName), { mode: 0o644 });
  }
  for (const [name, target] of Object.entries(stableSourceFiles)) {
    const source = assertPathInside(activeRoot, path.join(activeRoot, target));
    const stat = await fs.lstat(source);
    await atomicWriteFile(path.join(binDir, name), await fs.readFile(source), { mode: stat.mode & 0o777 });
  }
  for (const [name, target] of Object.entries(bunProxyHelpers)) {
    await atomicWriteFile(path.join(binDir, name), bunProxySource(target), { mode: 0o755 });
  }
}

function gstackLauncherSource() {
  return `#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveActiveRoot } from "./gstack-resolve.mjs";
const { home, root } = await resolveActiveRoot(import.meta.url);
process.env.GSTACK_HOME ||= home;
const cli = path.join(root, "runtime", "cli.js");
const stat = await fs.lstat(cli).catch(() => null);
if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("Active gstack CLI is missing or unsafe; rerun ./setup");
const { main } = await import(pathToFileURL(cli).href);
process.exitCode = await main(process.argv.slice(2));
`;
}

function capabilityLauncherSource() {
  return `#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveActiveRoot } from "./gstack-resolve.mjs";
const [relative, ...args] = process.argv.slice(2);
if (!relative || path.isAbsolute(relative) || relative.split(/[\\\\/]/).includes("..")) throw new Error("Invalid capability target");
const { home, root } = await resolveActiveRoot(import.meta.url);
const target = path.resolve(root, relative);
const inside = path.relative(root, target);
if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) throw new Error("Capability target escaped the active runtime");
const stat = await fs.lstat(target).catch(() => null);
if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("Active capability target is missing or unsafe");
const handle = await fs.open(target, "r");
const headerBuffer = Buffer.alloc(192);
const { bytesRead } = await handle.read(headerBuffer, 0, headerBuffer.length, 0);
await handle.close();
const header = headerBuffer.subarray(0, bytesRead).toString("utf8").split(/\\r?\\n/, 1)[0];
let command = target;
let commandArgs = args;
if (/^#!.*\\bbun(?:\\s|$)/.test(header)) {
  command = process.env.BUN_CMD || "bun";
  commandArgs = [target, ...args];
} else if (/^#!.*\\b(?:bash|sh)(?:\\s|$)/.test(header)) {
  command = process.env.GSTACK_BASH || "bash";
  commandArgs = [target, ...args];
} else if (/^#!.*\\bpython3?(?:\\s|$)/.test(header)) {
  command = process.env.GSTACK_PYTHON || (process.platform === "win32" ? "python" : "python3");
  commandArgs = [target, ...args];
} else if (/^#!.*\\bnode(?:\\s|$)/.test(header)) {
  command = process.env.GSTACK_NODE || "node";
  commandArgs = [target, ...args];
}
const child = spawn(command, commandArgs, {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, GSTACK_HOME: process.env.GSTACK_HOME || home },
});
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
`;
}

function activeResolverSource() {
  return `import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

export async function resolveActiveRoot(metaUrl) {
  const bin = path.dirname(fileURLToPath(metaUrl));
  const home = path.dirname(bin);
  await recoverInterruptedInstall(home);
  const pointerPath = path.join(home, "versions", "current.json");
  let pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  if (pointer.status === "pending") pointer = await recoverPending(pointerPath, home, pointer);
  if (pointer.status !== "active" || !validVersion(pointer.current)) {
    throw new Error("No verified active gstack runtime; run ./setup");
  }
  const root = path.join(home, "versions", pointer.current);
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Active gstack runtime is missing or unsafe; rerun ./setup");
  return { home, root, pointer };
}

async function recoverInterruptedInstall(home) {
  const journalPath = path.join(home, ".gstack-runtime-transaction.json");
  if (!await exists(journalPath)) return;
  const release = await acquireLifecycleLock(home);
  try {
    const journal = await readJsonOrNull(journalPath);
    if (!journal) return;
    const journalHome = typeof journal.home === "string"
      ? await fs.realpath(journal.home).catch(() => path.resolve(journal.home))
      : null;
    const physicalHome = await fs.realpath(home).catch(() => path.resolve(home));
    if (journal.schemaVersion !== 1 || journal.kind !== "gstack-runtime-install-transaction" ||
        journal.status !== "prepared" || journalHome !== physicalHome || !Array.isArray(journal.files) ||
        typeof journal.previousPointerExists !== "boolean") {
      throw new Error("Managed runtime transaction journal is invalid; rerun ./setup");
    }
    for (const file of journal.files) {
      const relative = validTransactionPath(file?.path);
      const absolute = path.join(home, relative);
      if (file.existed === false) {
        const stat = await fs.lstat(absolute).catch(() => null);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) throw new Error("Refusing invalid runtime transaction directory");
        await fs.rm(absolute, { force: true });
      } else {
        if (file.existed !== true || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 ||
            typeof file.dataBase64 !== "string" || file.dataBase64.length > 16 * 1024 * 1024 || !validBase64(file.dataBase64)) {
          throw new Error("Managed runtime transaction snapshot is invalid");
        }
        await atomicReplaceFile(absolute, Buffer.from(file.dataBase64, "base64"), file.mode);
      }
    }
    const pointerPath = path.join(home, "versions", "current.json");
    if (journal.previousPointerExists) {
      if (journal.previousPointer?.schemaVersion !== 2) throw new Error("Managed runtime pointer snapshot is invalid");
      await atomicReplaceJson(pointerPath, journal.previousPointer);
    }
    else await fs.rm(pointerPath, { force: true });
    await fs.rm(journalPath, { force: true });
  } finally {
    await release();
  }
}

async function acquireLifecycleLock(home) {
  const lock = home + ".runtime-lifecycle.lock";
  const token = randomUUID();
  const started = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({
        token,
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      }) + "\\n", { mode: 0o600 });
      return async () => {
        const owner = await readJsonOrNull(path.join(lock, "owner.json"));
        if (owner?.token === token) await fs.rm(lock, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readJsonOrNull(path.join(lock, "owner.json"));
      if (owner?.hostname === hostname() && !processIsAlive(owner.pid)) {
        const stale = lock + ".stale-" + process.pid + "-" + randomUUID();
        await fs.rename(lock, stale).then(() => fs.rm(stale, { recursive: true, force: true })).catch(() => {});
        continue;
      }
      if (Date.now() - started > 30_000) throw new Error("Timed out waiting to recover interrupted gstack install");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function validTransactionPath(value) {
  if (value === "runtime-install.json" || (typeof value === "string" && /^bin\\/[A-Za-z0-9._-]+$/.test(value))) return value;
  throw new Error("Invalid managed runtime transaction path");
}

function validBase64(value) {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

async function readJsonOrNull(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function recoverPending(pointerPath, home, pointer) {
  const fallback = pointer.lastKnownGood;
  const fallbackRoot = validVersion(fallback) ? path.join(home, "versions", fallback) : null;
  const fallbackStat = fallbackRoot ? await fs.lstat(fallbackRoot).catch(() => null) : null;
  const recovered = fallbackStat?.isDirectory() && !fallbackStat.isSymbolicLink()
    ? {
        schemaVersion: 2,
        status: "active",
        current: fallback,
        lastKnownGood: null,
        recoveredFrom: pointer.current ?? null,
        recoveredAt: new Date().toISOString(),
      }
    : {
        schemaVersion: 2,
        status: "rolled_back",
        current: null,
        lastKnownGood: null,
        failedVersion: pointer.current ?? null,
        recoveredAt: new Date().toISOString(),
      };
  await atomicReplaceJson(pointerPath, recovered);
  return recovered;
}

async function atomicReplaceJson(file, value) {
  await atomicReplaceFile(file, JSON.stringify(value, null, 2) + "\\n", 0o600);
}

async function atomicReplaceFile(file, value, mode) {
  const temporary = path.join(path.dirname(file), ".current.json.recover-" + process.pid + "-" + randomUUID());
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, value, { flag: "wx", mode });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    if (!["EEXIST", "EPERM", "EACCES"].includes(error?.code)) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    const backup = file + ".recover-backup-" + process.pid + "-" + randomUUID();
    await fs.rename(file, backup);
    try {
      await fs.rename(temporary, file);
      await fs.rm(backup, { force: true });
    } catch (replacementError) {
      await fs.rename(backup, file).catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw replacementError;
    }
  }
  await fs.chmod(file, mode).catch(() => {});
}

function validVersion(value) {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/.test(value);
}
`;
}

function bunProxySource(relativeTarget) {
  return `#!/usr/bin/env bun
import path from "node:path";
import { resolveActiveRoot } from "./gstack-resolve.mjs";
const { home, root } = await resolveActiveRoot(import.meta.url);
const target = path.join(root, ${JSON.stringify(relativeTarget)});
const child = Bun.spawn([process.env.BUN_CMD || "bun", target, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, GSTACK_HOME: process.env.GSTACK_HOME || home },
});
process.exitCode = await child.exited;
`;
}

function posixLauncher(script, fixedArgs, nodeName) {
  const args = fixedArgs.map(shellLiteral).join(" ");
  return `#!/bin/sh
set -eu
bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_command=\${GSTACK_NODE:-}
[ -n "$node_command" ] || node_command=${shellLiteral(nodeName)}
exec "$node_command" "$bin_dir/${script}"${args ? ` ${args}` : ""} "$@"
`;
}

function windowsLauncher(script, fixedArgs, nodeName) {
  const args = fixedArgs.map(windowsLiteral).join(" ");
  return `@echo off\r
setlocal\r
if defined GSTACK_NODE (set "_GSTACK_NODE=%GSTACK_NODE%") else (set "_GSTACK_NODE=${String(nodeName).replaceAll('"', '""')}")\r
"%_GSTACK_NODE%" "%~dp0${script}"${args ? ` ${args}` : ""} %*\r
exit /b %ERRORLEVEL%\r
`;
}

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function windowsLiteral(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function launcherRelativePaths(launcherSurface) {
  const { capabilities, stableSourceFiles, bunProxyHelpers } = launcherSurface;
  return [
    "bin/gstack-resolve.mjs",
    "bin/gstack-launcher.mjs",
    "bin/gstack-capability-launcher.mjs",
    "bin/gstack",
    "bin/gstack.cmd",
    ...Object.keys(capabilities).flatMap((name) => [`bin/${name}`, `bin/${name}.cmd`]),
    ...Object.keys(stableSourceFiles).map((name) => `bin/${name}`),
    ...Object.keys(bunProxyHelpers).map((name) => `bin/${name}`),
  ];
}

function launcherPaths(home, launcherSurface) {
  return launcherRelativePaths(launcherSurface).map((relative) => path.join(home, relative));
}

async function writeInstallManifest(paths, _pointer, launcherSurface, now) {
  const relativePath = "runtime-install.json";
  const manifest = {
    schemaVersion: INSTALL_SCHEMA_VERSION,
    kind: "gstack-managed-runtime",
    versionStore: "versions",
    versionPointer: "versions/current.json",
    managedPaths: [
      "versions",
      ...launcherRelativePaths(launcherSurface),
      relativePath,
    ],
    preservedOnRuntimeUninstall: [".gstack-managed-home.json", "config.json", "secrets.json", "projects", "plans"],
    installedAt: isoNow(now),
  };
  await atomicWriteJson(path.join(paths.home, relativePath), manifest, { mode: 0o600 });
  return manifest;
}

async function captureInstallSurface(paths, launcherSurface) {
  const manifestPath = path.join(paths.home, "runtime-install.json");
  const oldManifest = await readJson(manifestPath, null);
  const oldLaunchers = validateInstallManifestForUninstall(oldManifest);
  const relativePaths = new Set([
    "runtime-install.json",
    ...oldLaunchers,
    ...launcherRelativePaths(launcherSurface),
  ]);
  const files = new Map();
  for (const relative of relativePaths) {
    const absolute = assertPathInside(paths.home, path.join(paths.home, relative));
    const stat = await fs.lstat(absolute).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) {
      files.set(relative, null);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw installError(`Refusing unexpected managed install path: ${relative}`, "INSTALL_MANIFEST_INVALID");
    }
    files.set(relative, { data: await fs.readFile(absolute), mode: stat.mode & 0o777 });
  }
  return files;
}

async function restoreInstallSurface(paths, snapshot) {
  for (const [relative, previous] of snapshot) {
    const absolute = assertPathInside(paths.home, path.join(paths.home, relative));
    if (previous == null) await fs.rm(absolute, { force: true });
    else await atomicWriteFile(absolute, previous.data, { mode: previous.mode });
  }
  await fs.rmdir(path.join(paths.home, "bin")).catch((error) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  });
}

async function removeObsoleteLaunchers(paths, snapshot, launcherSurface) {
  const desired = new Set(launcherRelativePaths(launcherSurface));
  for (const relative of snapshot.keys()) {
    if (relative.startsWith("bin/") && !desired.has(relative)) {
      await fs.rm(assertPathInside(paths.home, path.join(paths.home, relative)), { force: true });
    }
  }
}

async function writeRuntimeTransactionJournal(paths, snapshot, context) {
  const files = [];
  for (const [relative, previous] of snapshot) {
    files.push(previous == null
      ? { path: relative, existed: false }
      : {
          path: relative,
          existed: true,
          mode: previous.mode,
          dataBase64: previous.data.toString("base64"),
        });
  }
  await atomicWriteJson(path.join(paths.home, RUNTIME_TRANSACTION_FILE), {
    schemaVersion: 1,
    kind: "gstack-runtime-install-transaction",
    status: "prepared",
    home: paths.home,
    version: context.version,
    previousPointerExists: context.previousPointerExists,
    previousPointer: context.previousPointer,
    files,
    preparedAt: new Date().toISOString(),
  }, { mode: 0o600 });
}

function validateInstallManifestForUninstall(manifest) {
  if (manifest == null) return [];
  if (manifest.kind !== "gstack-managed-runtime" || manifest.schemaVersion !== INSTALL_SCHEMA_VERSION ||
      !Array.isArray(manifest.managedPaths)) {
    throw installError("Refusing an unknown or unsupported runtime install manifest", "INSTALL_MANIFEST_INVALID");
  }
  const launchers = [];
  const seen = new Set();
  for (const candidate of manifest.managedPaths) {
    const relative = normalizeRelativePath(candidate, "managed uninstall path");
    if (seen.has(relative)) throw installError(`Duplicate managed install path: ${relative}`, "INSTALL_MANIFEST_INVALID");
    seen.add(relative);
    const parts = relative.split("/");
    if (parts.length === 2 && parts[0] === "bin") launchers.push(relative);
  }
  return launchers;
}

async function readPackageMetadata(sourceDir) {
  const pkg = await readJson(path.join(sourceDir, "package.json"), null);
  if (!pkg?.version) throw installError("package.json does not contain a runtime version", "INSTALL_VERSION_MISSING");
  return pkg;
}

function validatePackageIdentity(pkg, version) {
  if (pkg?.name !== "gstack" || pkg?.version !== version) {
    throw installError(
      "Upgrade source must be a complete gstack package whose package version matches --version",
      "INSTALL_SOURCE_IDENTITY_INVALID",
    );
  }
}

function validateVersion(value) {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/.test(value)) {
    throw new TypeError("Version must contain only letters, numbers, dots, underscores, or hyphens");
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  const data = await fs.readFile(file);
  hash.update(data);
  return hash.digest("hex");
}

async function listBundlePayloadFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = await fs.lstat(current);
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(current)) pending.push(path.join(current, child));
    } else if (stat.isFile()) {
      const relative = path.relative(root, current).split(path.sep).join("/");
      if (![".gstack-bundle.json", ".gstack-version.json"].includes(relative)) files.push(relative);
    }
  }
  return files.sort();
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    let settled = false;
    let timeout = null;
    let killGrace = null;
    let timeoutError = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killGrace) clearTimeout(killGrace);
      callback(value);
    };
    const timeoutMs = Number(options.timeoutMs);
    const killGraceMs = Number.isFinite(Number(options.killGraceMs)) && Number(options.killGraceMs) > 0
      ? Number(options.killGraceMs)
      : 5_000;
    child.once("error", (error) => {
      if (!timeoutError) return finish(reject, error);
      // A kill error is evidence that termination is not yet confirmed. Keep
      // waiting for `exit` or the bounded kill-grace deadline.
      timeoutError.cause ??= error;
    });
    child.once("exit", (code, signal) => {
      if (!timeoutError && timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      // A timeout is not complete until the direct child is confirmed dead.
      // Timed installer probes are deliberately single-process commands; this
      // helper does not claim to supervise commands that daemonize descendants.
      if (timeoutError) {
        timeoutError.exitCode = code;
        timeoutError.signal = signal;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(reject, timeoutError);
      }
    });
    child.once("close", (code, signal) => {
      if (timeoutError) return finish(reject, timeoutError);
      if (code === 0) finish(resolve, { code, stdout, stderr });
      else {
        const error = new Error(`Command failed (${signal ?? code}): ${command} ${args.join(" ")}`);
        error.code = "INSTALL_COMMAND_FAILED";
        error.exitCode = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(reject, error);
      }
    });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timeoutError = new Error(`Command timed out after ${timeoutMs}ms: ${command}`);
        timeoutError.code = "INSTALL_COMMAND_TIMEOUT";
        timeoutError.timeoutMs = timeoutMs;
        try {
          child.kill("SIGKILL");
        } catch (cause) {
          timeoutError.cause = cause;
        }
        killGrace = setTimeout(() => {
          const error = new Error(`Timed-out command did not terminate within ${killGraceMs}ms: ${command}`);
          error.code = "INSTALL_COMMAND_KILL_TIMEOUT";
          error.timeoutMs = timeoutMs;
          error.killGraceMs = killGraceMs;
          error.cause = timeoutError;
          finish(reject, error);
        }, killGraceMs);
      }, timeoutMs);
    }
  });
}

function parseInstallerArgs(argv) {
  const result = { sourceDir: null, home: null, version: undefined, bunCommand: undefined, quiet: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["-h", "--help"].includes(arg)) result.help = true;
    else if (["-q", "--quiet"].includes(arg)) result.quiet = true;
    else if (arg === "--json") result.json = true;
    else if (["--source", "--home", "--version", "--bun"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${arg}`);
      index += 1;
      const key = { "--source": "sourceDir", "--home": "home", "--version": "version", "--bun": "bunCommand" }[arg];
      result[key] = value;
    } else {
      throw new TypeError(`Unknown setup option: ${arg}. Skill placement is delegated to: npx skills add time-attack/gstack`);
    }
  }
  return result;
}

function installerUsage() {
  return `Usage: ./setup [--home <path>] [--version <version>] [--json] [--quiet]\n\n` +
    "Installs only the optional host-neutral runtime and local capability bundle.\n" +
    "Install the six skills separately with: npx skills add time-attack/gstack\n";
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await runInstallerCli();
}
