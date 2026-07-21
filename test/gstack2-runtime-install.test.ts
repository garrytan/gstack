import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { main as runtimeMain } from "../runtime/cli.js";
import { summarizeRuntimeBundle } from "../scripts/gstack2/audit-runtime-bundle";
import {
  DEFAULT_CAPABILITY_LAUNCHERS,
  DEFAULT_RUNTIME_BUNDLE,
  DEFAULT_RUNTIME_HELPERS,
  MAX_RUNTIME_BUNDLE_BYTES,
  defaultBunBuilder,
  installManagedRuntime,
  normalizeManagedBrowserTree,
  runtimeReleaseComponentForPath,
  runtimeNativePackagePaths,
  uninstallManagedRuntime,
  runCommand,
  smokeRuntimeBundle,
  validateRuntimeBundle,
} from "../runtime/install.js";

const ENTRIES = [
  { path: "runtime" },
  { path: "bin/gstack", executable: true },
  { path: "cap/tool", build: "fixture", executable: true },
];
const CAPABILITIES = { "fixture-tool": "cap/tool" };
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const FULL_RUNTIME_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 30_000;

describe("GStack 2 managed runtime installer", () => {
  test("release staging excludes Playwright bookkeeping and Windows dependency validators", () => {
    expect(runtimeReleaseComponentForPath(".gstack-runtime-browsers/.links/example")).toBeNull();
    expect(runtimeReleaseComponentForPath(".gstack-runtime-browsers/winldd-1007/DEPENDENCIES_VALIDATED")).toBeNull();
    expect(runtimeReleaseComponentForPath(".gstack-runtime-browsers/winldd-1007/winldd.exe")).toBeNull();
    expect(runtimeReleaseComponentForPath(".gstack-runtime-browsers/chromium_headless_shell-1208/chrome.exe"))
      .toBe("browser-headless");
    expect(() => runtimeReleaseComponentForPath(".gstack-runtime-browsers/unknown-1/payload"))
      .toThrow("Unknown managed browser payload path");
  });

  test("browser link normalization accepts internal macOS-style links and rejects escape graphs", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-browser-links-"));
    try {
      const valid = path.join(root, "valid");
      const version = path.join(valid, "Framework", "Versions", "145");
      await fs.mkdir(version, { recursive: true });
      await fs.writeFile(path.join(version, "Chrome Framework"), "binary\n", { mode: 0o755 });
      await fs.symlink("145", path.join(valid, "Framework", "Versions", "Current"), "dir");
      await fs.symlink("Versions/Current/Chrome Framework", path.join(valid, "Framework", "Chrome Framework"), "file");
      expect(await normalizeManagedBrowserTree(valid)).toBe(2);
      expect((await fs.lstat(path.join(valid, "Framework", "Versions", "Current"))).isDirectory()).toBe(true);
      const executable = path.join(valid, "Framework", "Chrome Framework");
      expect((await fs.lstat(executable)).isFile()).toBe(true);
      expect((await fs.stat(executable)).mode & 0o111).not.toBe(0);

      const cases = ["escape", "absolute", "dangling", "loop", "nested-escape"];
      for (const name of cases) await fs.mkdir(path.join(root, name));
      await fs.writeFile(path.join(root, "outside"), "outside\n");
      await fs.symlink("../outside", path.join(root, "escape", "link"));
      await fs.symlink(path.join(root, "absolute"), path.join(root, "absolute", "link"));
      await fs.symlink("missing", path.join(root, "dangling", "link"));
      await fs.symlink("b", path.join(root, "loop", "a"));
      await fs.symlink("a", path.join(root, "loop", "b"));
      const nestedTarget = path.join(root, "nested-escape", "target");
      await fs.mkdir(nestedTarget);
      await fs.symlink("../../outside", path.join(nestedTarget, "evil"));
      await fs.symlink("target", path.join(root, "nested-escape", "link"), "dir");
      for (const name of cases) {
        await expect(normalizeManagedBrowserTree(path.join(root, name)))
          .rejects.toMatchObject({ code: "INSTALL_BROWSER_PAYLOAD_INVALID" });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("installs, validates, activates, and writes an uninstall-friendly manifest", async () => {
    await withFixture(async ({ source, home }) => {
      const result = await installFixture(source, home, "2.0.0");

      expect(result.pointer.status).toBe("active");
      expect(result.pointer.current).toBe("2.0.0");
      expect(result.consumedScratch).toBe(true);
      expect(await readJson(path.join(home, "versions", "current.json"))).toMatchObject({ current: "2.0.0" });
      expect(await fs.readFile(path.join(result.path, "cap", "tool"), "utf8")).toContain("fixture capability");
      expect((await fs.lstat(path.join(result.path, "runtime", "cli.js"))).isSymbolicLink()).toBe(false);

      const manifest = await readJson(path.join(home, "runtime-install.json"));
      expect(manifest.kind).toBe("gstack-managed-runtime");
      expect(manifest.versionStore).toBe("versions");
      expect(manifest.versionPointer).toBe("versions/current.json");
      expect(manifest.managedPaths).toContain("versions");
      expect(manifest.managedPaths).toContain("bin/gstack.cmd");
      expect(manifest.preservedOnRuntimeUninstall).toContain("projects");
    });
  });

  test("handles source and runtime paths containing spaces", async () => {
    await withFixture(async ({ root }) => {
      const source = path.join(root, "source tree with spaces");
      const home = path.join(root, "home tree with spaces", ".gstack runtime");
      await createSource(source);
      const result = await installFixture(source, home, "2.0.1");

      expect(result.path).toBe(path.join(home, "versions", "2.0.1"));
      const launched = await runInstalledLauncher(home, "gstack", ["version"], { capture: true });
      expect(launched.stdout).toContain("gstack fixture");
    }, { createDefaultSource: false });
  });

  test("accepts a symlink to the source root but rejects links inside the allowlist", async () => {
    if (process.platform === "win32") return;
    await withFixture(async ({ root, source, home }) => {
      const sourceLink = path.join(root, "source-link");
      await fs.symlink(source, sourceLink, "dir");
      const result = await installFixture(sourceLink, home, "2.0.2");
      expect(result.pointer.current).toBe("2.0.2");

      await fs.rm(path.join(source, "cap", "tool"));
      await fs.symlink(path.join(source, "runtime", "cli.js"), path.join(source, "cap", "tool"));
      await expect(installFixture(sourceLink, home, "2.0.3")).rejects.toMatchObject({ code: "INSTALL_SOURCE_LINK" });
      expect((await readJson(path.join(home, "versions", "current.json"))).current).toBe("2.0.2");

      await expect(installManagedRuntime({
        sourceDir: sourceLink,
        home,
        version: "2.0.4",
        entries: [{ path: "../outside" }],
        capabilities: {},
      })).rejects.toThrow("Invalid bundle entry");
    });
  });

  test("a failed build leaves the last-known-good version active", async () => {
    await withFixture(async ({ source, home }) => {
      await installFixture(source, home, "1.0.0");
      await fs.rm(path.join(source, "cap", "tool"));

      await expect(installFixture(source, home, "2.0.0", {
        builder: async () => { throw new Error("fixture build failed"); },
      })).rejects.toMatchObject({ code: "INSTALL_BUILD_FAILED" });
      expect(await activeVersion(home)).toBe("1.0.0");
    });
  });

  test("invokes the injected Bun builder only for absent capabilities", async () => {
    await withFixture(async ({ source, home }) => {
      await fs.rm(path.join(source, "cap", "tool"));
      let builds = 0;
      const builder = async ({ missing }: { missing: Array<{ path: string }> }) => {
        builds += 1;
        expect(missing.map((item) => item.path)).toEqual(["cap/tool"]);
        await fs.writeFile(path.join(source, "cap", "tool"), "#!/bin/sh\necho rebuilt\n", { mode: 0o755 });
      };
      await installFixture(source, home, "1.0.0", { builder });
      expect(builds).toBe(1);

      await installFixture(source, home, "2.0.0", {
        builder: async () => { throw new Error("builder should not run for complete source"); },
      });
      expect(builds).toBe(1);
    });
  });

  test("managed Chromium stages transactionally without mutating the source checkout", async () => {
    await withFixture(async ({ source, home }) => {
      await fs.mkdir(path.join(source, "node_modules", "playwright"), { recursive: true });
      await fs.writeFile(path.join(source, "node_modules", "playwright", "cli.js"), "fixture\n");
      const entries = [
        { path: "runtime" },
        { path: "bin/gstack", executable: true },
        { path: ".gstack-runtime-browsers", build: "browser" },
      ];
      const phases: string[] = [];
      const run = async (_command: string, args: string[], options: { env?: Record<string, string>; superviseTree?: boolean; timeoutMs?: number } = {}) => {
        if (!args[0]?.endsWith(path.join("node_modules", "playwright", "cli.js"))) return { code: 0, stdout: "", stderr: "" };
        expect(args.slice(1)).toEqual(["install", "--only-shell", "chromium"]);
        expect(options.superviseTree).toBe(true);
        expect(options.timeoutMs).toBe(15 * 60_000);
        const target = options.env?.PLAYWRIGHT_BROWSERS_PATH;
        if (!target) throw new Error("missing fixture browser destination");
        await fs.mkdir(path.join(target, "chromium-fixture"), { recursive: true });
        await fs.writeFile(path.join(target, "chromium-fixture", "chrome"), "fixture\n", { mode: 0o755 });
        return { code: 0, stdout: "", stderr: "" };
      };
      const result = await installManagedRuntime({
        sourceDir: source,
        home,
        version: "browser-transaction",
        entries,
        capabilities: { browse: ".gstack-runtime-browsers/chromium-fixture/chrome" },
        runCommand: run,
        smokeTest: async () => {},
        onPhase: (event: { phase: string }) => phases.push(event.phase),
      });
      expect(await exists(path.join(source, ".gstack-runtime-browsers"))).toBe(false);
      expect(await exists(path.join(result.path, ".gstack-runtime-browsers", "chromium-fixture", "chrome"))).toBe(true);
      expect((await fs.readdir(path.join(home, "tmp"))).some((name) => name.startsWith("install-"))).toBe(false);
      expect(phases).toEqual([
        "copy-source:start",
        "copy-source:complete",
        "managed-chromium:start",
        "managed-chromium:complete",
        "bundle-validation:start",
        "bundle-validation:complete",
        "activation:start",
        "activation:complete",
      ]);

      await expect(installManagedRuntime({
        sourceDir: source,
        home: path.join(home, "failed"),
        version: "browser-failure",
        entries,
        capabilities: { browse: ".gstack-runtime-browsers/chromium-fixture/chrome" },
        runCommand: async () => { throw new Error("download failed"); },
        smokeTest: async () => {},
      })).rejects.toMatchObject({ code: "INSTALL_BROWSER_DOWNLOAD_FAILED" });
      expect(await exists(path.join(source, ".gstack-runtime-browsers"))).toBe(false);
    });
  });

  test("ordinary source installs ignore an untracked browser cache while prepared artifacts retain their verified cache", async () => {
    await withFixture(async ({ source, home }) => {
      await fs.mkdir(path.join(source, "node_modules", "playwright"), { recursive: true });
      await fs.writeFile(path.join(source, "node_modules", "playwright", "cli.js"), "fixture\n");
      await fs.mkdir(path.join(source, ".gstack-runtime-browsers", "untrusted"), { recursive: true });
      await fs.writeFile(path.join(source, ".gstack-runtime-browsers", "untrusted", "chrome"), "untrusted\n", { mode: 0o755 });
      const entries = [
        { path: "runtime" },
        { path: "bin/gstack", executable: true },
        { path: ".gstack-runtime-browsers", build: "browser" },
      ];
      let downloads = 0;
      const result = await installManagedRuntime({
        sourceDir: source,
        home,
        version: "browser-source-cache-ignored",
        entries,
        capabilities: { browse: ".gstack-runtime-browsers/fresh/chrome" },
        runCommand: async (_command: string, args: string[], options: { env?: Record<string, string> } = {}) => {
          downloads += 1;
          expect(args.slice(1)).toEqual(["install", "--only-shell", "chromium"]);
          const target = options.env?.PLAYWRIGHT_BROWSERS_PATH;
          if (!target) throw new Error("missing fixture browser destination");
          await fs.mkdir(path.join(target, "fresh"), { recursive: true });
          await fs.writeFile(path.join(target, "fresh", "chrome"), "fresh\n", { mode: 0o755 });
          return { code: 0, stdout: "", stderr: "" };
        },
        smokeTest: async () => {},
      });
      expect(downloads).toBe(1);
      expect(await exists(path.join(result.path, ".gstack-runtime-browsers", "fresh", "chrome"))).toBe(true);
      expect(await exists(path.join(result.path, ".gstack-runtime-browsers", "untrusted", "chrome"))).toBe(false);
      expect(await fs.readFile(path.join(source, ".gstack-runtime-browsers", "untrusted", "chrome"), "utf8")).toBe("untrusted\n");

      let preparedDownloadAttempted = false;
      const prepared = await installManagedRuntime({
        sourceDir: source,
        home: path.join(home, "prepared-home"),
        version: "browser-prepared-cache",
        entries,
        capabilities: { browse: ".gstack-runtime-browsers/untrusted/chrome" },
        buildMissing: false,
        preparedSource: true,
        runCommand: async () => {
          preparedDownloadAttempted = true;
          throw new Error("prepared artifacts must not download Chromium again");
        },
        smokeTest: async () => {},
      });
      expect(preparedDownloadAttempted).toBe(false);
      expect(await fs.readFile(path.join(prepared.path, ".gstack-runtime-browsers", "untrusted", "chrome"), "utf8")).toBe("untrusted\n");
    });
  });

  test("ordinary source installs ignore an untracked Bun executable while prepared artifacts retain and probe theirs", async () => {
    await withFixture(async ({ source, home }) => {
      const relative = path.join(".gstack-runtime-tools", process.platform === "win32" ? "bun.exe" : "bun");
      const sourceBun = path.join(source, relative);
      await fs.mkdir(path.dirname(sourceBun), { recursive: true });
      await fs.writeFile(sourceBun, "untrusted checkout executable\n", { mode: 0o755 });
      const entries = [
        { path: "runtime" },
        { path: "bin/gstack", executable: true },
        { path: relative, build: "managed-bun", executable: true },
      ];
      const installed = await installManagedRuntime({
        sourceDir: source,
        home,
        version: "bun-source-cache-ignored",
        entries,
        capabilities: { bun: relative },
        bunCommand: process.execPath,
        smokeTest: async () => {},
      });
      expect(await fs.readFile(sourceBun, "utf8")).toBe("untrusted checkout executable\n");
      expect((await fs.stat(path.join(installed.path, relative))).size).toBeGreaterThan(1024 * 1024);
      expect(installed.pointer.current).toBe("bun-source-cache-ignored");

      await fs.copyFile(process.execPath, sourceBun);
      if (process.platform !== "win32") await fs.chmod(sourceBun, 0o755);
      const prepared = await installManagedRuntime({
        sourceDir: source,
        home: path.join(home, "prepared"),
        version: "bun-prepared-cache",
        entries,
        capabilities: { bun: relative },
        buildMissing: false,
        preparedSource: true,
        smokeTest: async () => {},
      });
      expect(prepared.pointer.current).toBe("bun-prepared-cache");
      expect((await readJson(path.join(prepared.path, ".gstack-bundle.json"))).tools.bun.version).toBe("1.3.14");
    });
  });

  test("browser-visible materializes full Chromium without also downloading the headless shell", async () => {
    await withFixture(async ({ home }) => {
      const installModes: string[] = [];
      const result = await installManagedRuntime({
        sourceDir: REPO_ROOT,
        home,
        version: "browser-visible-only",
        capabilityIds: ["browser-visible"],
        bunCommand: process.execPath,
        runCommand: async (command: string, args: string[], options: { env?: Record<string, string> } = {}) => {
          if (args[0] === "--eval" && args[1]?.includes("process.execPath")) {
            return { code: 0, stdout: process.execPath, stderr: "" };
          }
          if (args[0]?.endsWith(path.join("node_modules", "playwright", "cli.js"))) {
            installModes.push(args[2]);
            expect(args.slice(1)).toEqual(["install", "--no-shell", "chromium"]);
            const browserRoot = options.env?.PLAYWRIGHT_BROWSERS_PATH;
            if (!browserRoot) throw new Error("fixture browser root missing");
            await fs.mkdir(path.join(browserRoot, "chromium-fixture"), { recursive: true });
            await fs.writeFile(path.join(browserRoot, "chromium-fixture", "chrome"), "fixture\n", { mode: 0o755 });
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "--version" && (command === process.execPath || command.includes(".gstack-runtime-tools"))) {
            return { code: 0, stdout: "1.3.14\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        smokeTest: async () => {},
      });
      expect(installModes).toEqual(["--no-shell"]);
      const bundleManifest = await readJson(path.join(result.path, ".gstack-bundle.json"));
      expect(bundleManifest.selectedCapabilities).toEqual(["browser-visible"]);
      expect(bundleManifest.runtimeComponents).toContain("browser-visible");
      expect(bundleManifest.runtimeComponents).not.toContain("browser-headless");
    }, { createDefaultSource: false });
  }, FULL_RUNTIME_TEST_TIMEOUT_MS);

  test("default capability builds never regenerate the Agent Skills tree", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await defaultBunBuilder({
      sourceDir: REPO_ROOT,
      missing: [{ path: "browse/dist/browse", build: "core" }],
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual([{ command: "bun", args: ["run", "build:runtime"] }]);
  });

  test("generated helper closure is fully declared and selected helpers resolve from the managed home", async () => {
    const contract = await readJson(path.join(REPO_ROOT, "evals", "parity", "runtime-helper-closure.json"));
    const compiledHelpers = Object.fromEntries(
      contract.helpers
        .filter((helper) => helper.platform_source_paths)
        .map((helper) => [helper.name, helper.platform_source_paths]),
    );
    expect(compiledHelpers).toEqual({
      browse: { posix: "browse/dist/browse", win32: "browse/dist/browse.exe" },
      "gstack-design": { posix: "design/dist/design", win32: "design/dist/design.exe" },
      "make-pdf": { posix: "make-pdf/dist/pdf", win32: "make-pdf/dist/pdf.exe" },
    });
    const bundlePaths = new Set(DEFAULT_RUNTIME_BUNDLE.map((item) => item.path));
    for (const dependency of [
      "node_modules/sharp",
      "node_modules/detect-libc",
      "node_modules/semver",
      ...runtimeNativePackagePaths(),
    ]) expect(bundlePaths.has(dependency)).toBe(true);
    expect(bundlePaths.has("node_modules/@img")).toBe(false);
    expect(bundlePaths.has("node_modules/@ngrok")).toBe(false);
    expect([...bundlePaths].some((item) => item.includes("@huggingface"))).toBe(false);
    for (const helper of contract.helpers) {
      const sourcePath = helper.platform_source_paths?.[process.platform === "win32" ? "win32" : "posix"]
        ?? helper.source_path;
      expect(bundlePaths.has(sourcePath)).toBe(true);
      if (helper.name === "gstack") continue;
      const declaredTarget = DEFAULT_RUNTIME_HELPERS[helper.name]?.target ?? DEFAULT_CAPABILITY_LAUNCHERS[helper.name];
      expect(declaredTarget).toBe(sourcePath);
    }

    await withFixture(async ({ home }) => {
      const result = await installManagedRuntime({
        sourceDir: REPO_ROOT,
        home,
        version: "helper-contract-test",
        runCommand: async (command: string, args: string[], options: { env?: Record<string, string> } = {}) => {
          if (args[0] === "--eval" && args[1]?.includes("process.execPath")) {
            return { code: 0, stdout: process.execPath, stderr: "" };
          }
          if (args[0]?.endsWith(path.join("node_modules", "playwright", "cli.js"))) {
            const browserRoot = options.env?.PLAYWRIGHT_BROWSERS_PATH;
            if (!browserRoot) throw new Error("fixture browser root missing");
            await fs.mkdir(path.join(browserRoot, "chromium-fixture"), { recursive: true });
            await fs.writeFile(path.join(browserRoot, "chromium-fixture", "chrome"), "fixture\n", { mode: 0o755 });
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "--version" && (command === process.execPath || command.includes(".gstack-runtime-tools"))) {
            return { code: 0, stdout: "1.3.14\n", stderr: "" };
          }
          if (args[0] === "--version") return { code: 0, stdout: "v20.18.0\n", stderr: "" };
          return { code: 0, stdout: "gstack runtime fixture\n", stderr: "" };
        },
      });
      for (const helper of contract.helpers) {
        const stable = path.join(home, "bin", helper.name);
        const stat = await fs.lstat(stable);
        expect(stat.isFile()).toBe(true);
        expect(stat.isSymbolicLink()).toBe(false);
      }
      expect(result.manifest.managedPaths).toContain("bin/gstack-model-benchmark");
      expect(result.manifest.managedPaths).toContain("bin/gstack-gbrain-sync");
      expect(result.manifest.managedPaths).toContain("bin/gstack-memory-ingest");
      expect(result.manifest.managedPaths).toContain("bin/remote-slug");

      const browserDependencies = await runCommand("node", [
        "--input-type=module",
        "--eval",
        'await import("@anthropic-ai/sdk"); await import("sharp"); await import("@ngrok/ngrok"); process.exit(0);',
      ], { capture: true, cwd: result.path, timeoutMs: 15_000 });
      expect(browserDependencies.code).toBe(0);

      const next = await runInstalledLauncher(home, "gstack-next-version", ["--help"], { capture: true });
      expect(next.stdout).toContain("Usage: gstack-next-version");
      if (process.platform !== "win32") {
        const node = (await runCommand("node", ["-p", "process.execPath"], { capture: true })).stdout.trim();
        const nodeOnlyEnv = {
          ...process.env,
          PATH: "/usr/bin:/bin",
          GSTACK_NODE: node,
          BUN_CMD: "",
        };
        const managedBun = await runInstalledLauncher(home, "bun", ["--version"], { capture: true, env: nodeOnlyEnv });
        expect(managedBun.stdout.trim()).toBe("1.3.14");
        const nodeOnlyHelper = await runInstalledLauncher(home, "gstack-next-version", ["--help"], { capture: true, env: nodeOnlyEnv });
        expect(nodeOnlyHelper.stdout).toContain("Usage: gstack-next-version");
      }
      const sourced = await runCommand("bash", ["-c", '. "$1"; type read_secret_to_env', "_", path.join(home, "bin", "gstack-gbrain-lib.sh")], { capture: true });
      expect(sourced.stdout).toContain("read_secret_to_env");
      const syncAlias = await runInstalledLauncher(home, "gstack-gbrain-sync", ["--help"], { capture: true });
      expect(`${syncAlias.stdout}${syncAlias.stderr}`).toContain("gstack-gbrain-sync");
      const syncTypeScriptAlias = await runInstalledLauncher(home, "gstack-gbrain-sync.ts", ["--help"], { capture: true });
      expect(`${syncTypeScriptAlias.stdout}${syncTypeScriptAlias.stderr}`).toContain("gstack-gbrain-sync");

      const body = path.join(home, "audit-body.txt");
      await fs.writeFile(body, "safe body\n");
      await runInstalledLauncher(home, "gstack-redact-audit-log", [
        '{"repo_visibility":"public","outcome":"clean","categories_flagged":[]}',
        body,
      ], { capture: true, env: { ...process.env, GSTACK_HOME: home } });
      expect(await fs.readFile(path.join(home, "security", "semantic-reviews.jsonl"), "utf8")).toContain('"outcome":"clean"');
    }, { createDefaultSource: false });
  }, FULL_RUNTIME_TEST_TIMEOUT_MS);

  test("bounded subprocess execution confirms a timed-out command has exited", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-command-timeout-"));
    const pidPath = path.join(root, "pid.txt");
    try {
      await expect(runCommand(process.execPath, [
        "--eval",
        `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ], {
        capture: true,
        timeoutMs: 1_500,
      })).rejects.toMatchObject({ code: "INSTALL_COMMAND_TIMEOUT", timeoutMs: 1_500 });

      const pid = Number(await fs.readFile(pidPath, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("supervised timeout terminates descendants before returning cleanup authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-command-tree-timeout-"));
    const marker = path.join(root, "descendant-wrote-after-timeout");
    const childProgram = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe"), 500); setInterval(() => {}, 1000);`;
    const parentProgram = `require("node:child_process").spawn(process.execPath, ["--eval", ${JSON.stringify(childProgram)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
    try {
      await expect(runCommand(process.execPath, ["--eval", parentProgram], {
        capture: true,
        timeoutMs: 100,
        killGraceMs: 5_000,
        superviseTree: true,
      })).rejects.toMatchObject({ code: "INSTALL_COMMAND_TIMEOUT" });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(await exists(marker)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("supervised cancellation terminates descendants before the installer process exits", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-command-tree-cancel-"));
    const ready = path.join(root, "ready");
    const marker = path.join(root, "descendant-wrote-after-cancel");
    const childProgram = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe"), 700); setInterval(() => {}, 1000);`;
    const parentProgram = `require("node:child_process").spawn(process.execPath, ["--eval", ${JSON.stringify(childProgram)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
    const harness = [
      `import { runCommand } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "runtime", "install.js")).href)};`,
      `import fs from "node:fs";`,
      `fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
      `try { await runCommand(process.execPath, ["--eval", ${JSON.stringify(parentProgram)}], { superviseTree: true, timeoutMs: 60000 }); } catch { process.exitCode = 0; }`,
    ].join("\n");
    try {
      const process_ = spawn("node", ["--input-type=module", "--eval", harness], { stdio: "ignore" });
      for (let attempt = 0; attempt < 100 && !await exists(ready); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await exists(ready)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      process_.kill("SIGINT");
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("cancellation harness did not exit")), 5_000);
        process_.once("exit", () => { clearTimeout(timeout); resolve(null); });
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(await exists(marker)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("selects one deterministic native dependency closure per supported host", () => {
    expect(runtimeNativePackagePaths({ platform: "darwin", arch: "arm64" })).toEqual([
      "node_modules/@img/colour",
      "node_modules/@img/sharp-darwin-arm64",
      "node_modules/@img/sharp-libvips-darwin-arm64",
      "node_modules/@ngrok/ngrok-darwin-universal",
      "node_modules/@ngrok/ngrok",
    ]);
    expect(runtimeNativePackagePaths({ platform: "darwin", arch: "x64" })).toContain(
      "node_modules/@img/sharp-libvips-darwin-x64",
    );
    expect(runtimeNativePackagePaths({ platform: "linux", arch: "x64", libc: "glibc" })).toEqual([
      "node_modules/@img/colour",
      "node_modules/@img/sharp-linux-x64",
      "node_modules/@img/sharp-libvips-linux-x64",
      "node_modules/@ngrok/ngrok-linux-x64-gnu",
      "node_modules/@ngrok/ngrok",
    ]);
    expect(runtimeNativePackagePaths({ platform: "linux", arch: "arm64", libc: "glibc" })).toContain(
      "node_modules/@ngrok/ngrok-linux-arm64-gnu",
    );
    expect(runtimeNativePackagePaths({ platform: "linux", arch: "arm64", libc: "musl" })).toEqual([
      "node_modules/@img/colour",
      "node_modules/@img/sharp-linuxmusl-arm64",
      "node_modules/@img/sharp-libvips-linuxmusl-arm64",
      "node_modules/@ngrok/ngrok-linux-arm64-musl",
      "node_modules/@ngrok/ngrok",
    ]);
    expect(runtimeNativePackagePaths({ platform: "linux", arch: "x64", libc: "musl" })).toContain(
      "node_modules/@img/sharp-libvips-linuxmusl-x64",
    );
    expect(runtimeNativePackagePaths({ platform: "win32", arch: "x64" })).toEqual([
      "node_modules/@img/colour",
      "node_modules/@img/sharp-win32-x64",
      "node_modules/@ngrok/ngrok-win32-x64-msvc",
      "node_modules/@ngrok/ngrok",
    ]);
    expect(runtimeNativePackagePaths({ platform: "win32", arch: "arm64" })).toContain(
      "node_modules/@ngrok/ngrok-win32-arm64-msvc",
    );
    expect(() => runtimeNativePackagePaths({ platform: "linux", arch: "x64", libc: "unknown" }))
      .toThrow("Unsupported managed-runtime libc");
    expect(() => runtimeNativePackagePaths({ platform: "freebsd", arch: "x64" }))
      .toThrow("Unsupported managed-runtime platform");
  });

  test("summarizes a runtime bundle as deterministic, reproducible evidence", () => {
    const audit = summarizeRuntimeBundle({
      version: "fixture-version",
      components: ["runtime", ...runtimeNativePackagePaths()],
      files: [
        { path: "runtime/index.js", size: 17, mode: 0o644, sha256: "a".repeat(64) },
        { path: "runtime/cli.js", size: 23, mode: 0o755, sha256: "b".repeat(64) },
      ],
    });
    expect(audit).toMatchObject({
      schemaVersion: 1,
      sourceBundleVersion: "fixture-version",
      components: 1 + runtimeNativePackagePaths().length,
      files: 2,
      bytes: 40,
      forbiddenComponents: [],
    });
    expect(audit.nativeComponents).toEqual(runtimeNativePackagePaths());
    expect(typeof audit.sourceGitDirty).toBe("boolean");
    expect(audit.bundleManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.reproductionCommand).toContain(`evals/runtime-bundle/${process.platform}-${process.arch}.json`);
  });

  test("failed validation and failed smoke checks roll back activation", async () => {
    await withFixture(async ({ source, home }) => {
      await installFixture(source, home, "1.0.0");

      await expect(installFixture(source, home, "2.0.0", {
        validate: async () => { throw new Error("invalid fixture"); },
      })).rejects.toThrow("invalid fixture");
      expect(await activeVersion(home)).toBe("1.0.0");

      await expect(installFixture(source, home, "2.0.1", {
        smokeTest: async () => { throw new Error("smoke failed"); },
      })).rejects.toMatchObject({ code: "UPGRADE_ROLLED_BACK" });
      expect(await activeVersion(home)).toBe("1.0.0");
      expect(await exists(path.join(home, "versions", "2.0.1"))).toBe(false);

      const repaired = await installFixture(source, home, "2.0.1");
      expect(repaired.pointer.current).toBe("2.0.1");
    });
  });

  test("recovers an interrupted pointer before activating a new bundle", async () => {
    await withFixture(async ({ source, home }) => {
      await installFixture(source, home, "1.0.0");
      await fs.writeFile(path.join(home, "versions", "current.json"), `${JSON.stringify({
        schemaVersion: 2,
        status: "pending",
        transactionId: "interrupted",
        current: "half-written",
        lastKnownGood: "1.0.0",
      }, null, 2)}\n`);

      const result = await installFixture(source, home, "2.0.0");
      expect(result.pointer).toMatchObject({
        status: "active",
        current: "2.0.0",
        lastKnownGood: "1.0.0",
      });
    });
  });

  test("stable POSIX and Windows launchers resolve the active version", async () => {
    await withFixture(async ({ source, home }) => {
      await installFixture(source, home, "1.0.0");
      const first = await runInstalledLauncher(home, "gstack", ["doctor"], { capture: true });
      expect(first.stdout).toContain("gstack fixture doctor");

      await fs.writeFile(path.join(source, "runtime", "cli.js"), fixtureCli("second"));
      await installFixture(source, home, "2.0.0");
      const second = await runInstalledLauncher(home, "gstack", ["doctor"], { capture: true });
      expect(second.stdout).toContain("gstack fixture second doctor");

      const capability = await runInstalledLauncher(home, "fixture-tool", ["hello world"], { capture: true });
      expect(capability.stdout).toContain("fixture capability hello world");
      const windowsLauncher = await fs.readFile(path.join(home, "bin", "gstack.cmd"), "utf8");
      expect(windowsLauncher).toContain("%~dp0gstack-launcher.mjs");
      expect(windowsLauncher).toContain("%*");
    });
  });

  test("launchers never execute a pending candidate and recover last-known-good first", async () => {
    await withFixture(async ({ source, home }) => {
      await installFixture(source, home, "1.0.0");
      await fs.writeFile(path.join(source, "runtime", "cli.js"), fixtureCli("candidate"));
      await installFixture(source, home, "2.0.0");
      await fs.writeFile(path.join(home, "versions", "current.json"), `${JSON.stringify({
        schemaVersion: 2,
        status: "pending",
        transactionId: "interrupted",
        current: "2.0.0",
        lastKnownGood: "1.0.0",
      }, null, 2)}\n`);

      const launched = await runInstalledLauncher(home, "gstack", ["doctor"], { capture: true });
      expect(launched.stdout).toContain("gstack fixture doctor");
      expect(launched.stdout).not.toContain("candidate");
      expect(await readJson(path.join(home, "versions", "current.json"))).toMatchObject({
        status: "active",
        current: "1.0.0",
        recoveredFrom: "2.0.0",
      });
    });
  });

  test("bundle validation rejects empty manifests, extra files, and mode drift", async () => {
    await withFixture(async ({ source, home }) => {
      const result = await installFixture(source, home, "2.0.0");
      const manifestPath = path.join(result.path, ".gstack-bundle.json");
      const manifest = await readJson(manifestPath);

      await fs.writeFile(path.join(result.path, "unlisted.txt"), "not allowlisted\n");
      await expect(validateRuntimeBundle(result.path, { version: "2.0.0" })).rejects.toMatchObject({
        code: "INSTALL_VALIDATION_FAILED",
      });
      await fs.rm(path.join(result.path, "unlisted.txt"));

      if (process.platform !== "win32") {
        const cli = path.join(result.path, "runtime", "cli.js");
        const originalMode = (await fs.stat(cli)).mode & 0o777;
        await fs.chmod(cli, originalMode === 0o600 ? 0o644 : 0o600);
        await expect(validateRuntimeBundle(result.path, { version: "2.0.0", platform: "win32" })).resolves.toBe(true);
        await expect(validateRuntimeBundle(result.path, { version: "2.0.0", platform: "linux" })).rejects.toMatchObject({
          code: "INSTALL_VALIDATION_FAILED",
        });
        await fs.chmod(cli, originalMode);
      }

      await fs.writeFile(manifestPath, `${JSON.stringify({
        ...manifest,
        files: manifest.files.map((file: { size: number }, index: number) =>
          index === 0 ? { ...file, size: MAX_RUNTIME_BUNDLE_BYTES + 1 } : file),
      }, null, 2)}\n`);
      await expect(validateRuntimeBundle(result.path, { version: "2.0.0" })).rejects.toMatchObject({
        code: "INSTALL_VALIDATION_FAILED",
      });

      await fs.writeFile(manifestPath, `${JSON.stringify({ ...manifest, files: [] }, null, 2)}\n`);
      await expect(validateRuntimeBundle(result.path, { version: "2.0.0" })).rejects.toMatchObject({
        code: "INSTALL_VALIDATION_FAILED",
      });
    });
  });

  test("failed launcher/manifest publication restores the complete prior install surface", async () => {
    await withFixture(async ({ source, home }) => {
      await installFixture(source, home, "1.0.0", { launcherNodeCommand: "node" });
      const pointerBefore = await readJson(path.join(home, "versions", "current.json"));
      const manifestBefore = await fs.readFile(path.join(home, "runtime-install.json"), "utf8");
      const launcherBefore = await fs.readFile(path.join(home, "bin", "gstack"), "utf8");

      await expect(installFixture(source, home, "2.0.0", {
        launcherNodeCommand: "/definitely/not/the/old/node",
        manifestWriter: async () => { throw new Error("injected manifest write failure"); },
      })).rejects.toMatchObject({ code: "UPGRADE_ROLLED_BACK" });

      expect(await readJson(path.join(home, "versions", "current.json"))).toEqual(pointerBefore);
      expect(await fs.readFile(path.join(home, "runtime-install.json"), "utf8")).toBe(manifestBefore);
      expect(await fs.readFile(path.join(home, "bin", "gstack"), "utf8")).toBe(launcherBefore);
      const launched = await runInstalledLauncher(home, "gstack", ["doctor"], { capture: true });
      expect(launched.stdout).toContain("gstack fixture doctor");
    });
  });

  test("a launcher repairs a crash journal before resolving any runtime", async () => {
    await withFixture(async ({ source, home }) => {
      await installFixture(source, home, "1.0.0");
      const pointer = await readJson(path.join(home, "versions", "current.json"));
      const manifest = await fs.readFile(path.join(home, "runtime-install.json"));
      // Keep the launcher for this host executable so it can enter the shared
      // recovery path. The transaction restores the inactive host variant.
      const recoverableLauncher = process.platform === "win32" ? "gstack" : "gstack.cmd";
      const launcherPath = path.join(home, "bin", recoverableLauncher);
      const launcherBefore = await fs.readFile(launcherPath);
      await fs.writeFile(path.join(home, "runtime-install.json"), '{"activeVersion":"crashed"}\n');
      await fs.writeFile(launcherPath, "candidate launcher\n");
      await fs.writeFile(path.join(home, "versions", "current.json"), `${JSON.stringify({
        schemaVersion: 2,
        status: "active",
        current: "crashed-candidate",
        lastKnownGood: "1.0.0",
      }, null, 2)}\n`);
      await fs.writeFile(path.join(home, ".gstack-runtime-transaction.json"), `${JSON.stringify({
        schemaVersion: 1,
        kind: "gstack-runtime-install-transaction",
        status: "prepared",
        home,
        version: "crashed-candidate",
        previousPointerExists: true,
        previousPointer: pointer,
        files: [
          { path: "runtime-install.json", existed: true, mode: 0o600, dataBase64: manifest.toString("base64") },
          { path: `bin/${recoverableLauncher}`, existed: true, mode: 0o644, dataBase64: launcherBefore.toString("base64") },
        ],
      }, null, 2)}\n`, { mode: 0o600 });
      const orphanedLock = `${home}.runtime-lifecycle.lock`;
      await fs.mkdir(orphanedLock);
      await fs.writeFile(path.join(orphanedLock, "owner.json"), `${JSON.stringify({
        token: "orphaned",
        pid: 2_147_483_647,
        hostname: os.hostname(),
      })}\n`);

      const launched = await runInstalledLauncher(home, "gstack", ["doctor"], { capture: true });
      expect(launched.stdout).toContain("gstack fixture doctor");
      expect(await readJson(path.join(home, "versions", "current.json"))).toEqual(pointer);
      expect(await fs.readFile(path.join(home, "runtime-install.json"))).toEqual(manifest);
      expect(await fs.readFile(launcherPath)).toEqual(launcherBefore);
      expect(await exists(path.join(home, ".gstack-runtime-transaction.json"))).toBe(false);
      expect(await exists(orphanedLock)).toBe(false);
    });
  });

  test("install and uninstall serialize on one lifecycle lock", async () => {
    await withFixture(async ({ source, home }) => {
      let enteredResolve!: () => void;
      let releaseResolve!: () => void;
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      const installing = installFixture(source, home, "1.0.0", {
        smokeTest: async () => {
          enteredResolve();
          await release;
        },
      });
      await entered;

      let uninstallFinished = false;
      const uninstalling = uninstallManagedRuntime(home).then((result) => {
        uninstallFinished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(uninstallFinished).toBe(false);

      releaseResolve();
      await installing;
      const removed = await uninstalling;
      expect(removed.preservedState).toBe(true);
      expect(await exists(path.join(home, "versions"))).toBe(false);
      expect(await exists(path.join(home, "runtime-install.json"))).toBe(false);
    });
  });

  test("managed homes require an ownership sentinel and reject destructive path mistakes", async () => {
    await withFixture(async ({ root, source, home }) => {
      await installFixture(source, home, "1.0.0");
      expect(await readJson(path.join(home, ".gstack-managed-home.json"))).toMatchObject({
        kind: "gstack-managed-home",
        home,
      });

      await expect(installFixture(source, path.parse(REPO_ROOT).root, "2.0.0")).rejects.toMatchObject({
        code: "MANAGED_HOME_UNSAFE",
      });
      await expect(installFixture(source, REPO_ROOT, "2.0.0")).rejects.toMatchObject({
        code: "MANAGED_HOME_UNSAFE",
      });

      const arbitrary = path.join(root, "arbitrary purge target");
      await fs.mkdir(arbitrary);
      await fs.writeFile(path.join(arbitrary, "keep.txt"), "keep\n");
      await expect(uninstallManagedRuntime(arbitrary, { purge: true })).rejects.toMatchObject({
        code: "MANAGED_HOME_UNOWNED",
      });
      expect(await fs.readFile(path.join(arbitrary, "keep.txt"), "utf8")).toBe("keep\n");

      const preexisting = path.join(root, "legacy", ".gstack");
      await fs.mkdir(preexisting, { recursive: true });
      await fs.writeFile(path.join(preexisting, "config.yaml"), "telemetry: off\n");
      await installFixture(source, preexisting, "legacy-adoption");
      expect(await fs.readFile(path.join(preexisting, "config.yaml"), "utf8")).toBe("telemetry: off\n");
      expect(await readJson(path.join(preexisting, ".gstack-managed-home.json"))).toMatchObject({
        adoptedLegacy: true,
        preexistingTopLevel: ["config.yaml"],
      });

      const empty = path.join(root, "empty-owned-home");
      await fs.mkdir(empty);
      await installFixture(source, empty, "empty-adoption");
      expect(await readJson(path.join(empty, ".gstack-managed-home.json"))).toMatchObject({ kind: "gstack-managed-home" });
    });
  });

  test("default runtime smoke explicitly invokes Node, not the host running the installer", async () => {
    await withFixture(async ({ source, home }) => {
      const calls: Array<{ command: string; args: string[]; options: { timeoutMs?: number } }> = [];
      await installFixture(source, home, "1.0.0", {
        commandTimeoutMs: 4_321,
        runCommand: async (command: string, args: string[], options: { timeoutMs?: number }) => {
          calls.push({ command, args, options });
          if (args[0] === "--version") return { code: 0, stdout: "v20.18.0\n", stderr: "" };
          return { code: 0, stdout: "gstack runtime fixture\n", stderr: "" };
        },
      });
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.command === "node")).toBe(true);
      expect(calls.every((call) => call.options.timeoutMs === 4_321)).toBe(true);
      expect(calls[0].args).toEqual(["--version"]);
    });
  });

  test("default runtime smoke rejects an unloadable native dependency closure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack native smoke "));
    try {
      await fs.mkdir(path.join(root, "bin"), { recursive: true });
      await fs.mkdir(path.join(root, "node_modules", "sharp"), { recursive: true });
      await fs.writeFile(path.join(root, "bin", "gstack"), "fixture\n");
      await fs.writeFile(path.join(root, "node_modules", "sharp", "package.json"), '{"name":"sharp"}\n');
      const calls: string[][] = [];
      await expect(smokeRuntimeBundle(root, {
        run: async (_command: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "--version") return { code: 0, stdout: "v20.18.0\n", stderr: "" };
          if (args[0] === "--input-type=module") throw new Error("native binding unavailable");
          return { code: 0, stdout: "gstack fixture\n", stderr: "" };
        },
      })).rejects.toMatchObject({ code: "INSTALL_SMOKE_FAILED" });
      expect(calls.at(-1)?.[0]).toBe("--input-type=module");
      expect(calls.at(-1)?.at(-1)).toContain('import("sharp")');
      expect(calls.at(-1)?.at(-1)).not.toContain("@ngrok/ngrok");

      await fs.rm(path.join(root, "node_modules", "sharp"), { recursive: true, force: true });
      await fs.mkdir(path.join(root, "node_modules", "@ngrok", "ngrok"), { recursive: true });
      await fs.writeFile(path.join(root, "node_modules", "@ngrok", "ngrok", "package.json"), '{"name":"@ngrok/ngrok"}\n');
      calls.length = 0;
      await expect(smokeRuntimeBundle(root, {
        run: async (_command: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "--version") return { code: 0, stdout: "v20.18.0\n", stderr: "" };
          if (args[0] === "--input-type=module") throw new Error("native binding unavailable");
          return { code: 0, stdout: "gstack fixture\n", stderr: "" };
        },
      })).rejects.toMatchObject({ code: "INSTALL_SMOKE_FAILED" });
      expect(calls.at(-1)?.at(-1)).toContain('import("@ngrok/ngrok")');
      expect(calls.at(-1)?.at(-1)).not.toContain('import("sharp")');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("public upgrade reuses managed validation and rejects arbitrary or symlinked sources", async () => {
    if (process.platform === "win32") return;
    await withFixture(async ({ root, source, home }) => {
      await installFixture(source, home, "1.0.0");
      const output = captureStream();
      const common = {
        env: { ...process.env, GSTACK_HOME: home },
        cwd: root,
        stdout: output.stream,
        stderr: output.stream,
        installOptions: { entries: ENTRIES, capabilities: CAPABILITIES },
      };

      await fs.writeFile(path.join(source, "package.json"), '{"name":"not-gstack","version":"2.0.0","type":"module"}\n');
      expect(await runtimeMain(["upgrade", "--source", source, "--version", "2.0.0"], common)).toBe(1);
      expect(await activeVersion(home)).toBe("1.0.0");

      await fs.writeFile(path.join(source, "package.json"), '{"name":"gstack","version":"2.0.0","type":"module"}\n');
      const linked = path.join(root, "linked upgrade source");
      await fs.symlink(source, linked, "dir");
      expect(await runtimeMain(["upgrade", "--source", linked, "--version", "2.0.0"], common)).toBe(1);
      expect(await activeVersion(home)).toBe("1.0.0");

      expect(await runtimeMain(["upgrade", "--source", source, "--version", "2.0.0"], common)).toBe(0);
      expect(await activeVersion(home)).toBe("2.0.0");
      expect(output.value()).toContain("Activated 2.0.0");
    });
  });

  test("setup repairs a partial node_modules tree with a frozen install and runs under Node", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack setup dependency repair "));
    try {
      const fakeBin = path.join(root, "fake-bin");
      const runtime = path.join(root, "runtime");
      const log = path.join(root, "bun.log");
      await fs.mkdir(fakeBin);
      await fs.mkdir(runtime);
      await fs.mkdir(path.join(root, "node_modules", "sharp"), { recursive: true });
      await fs.copyFile(path.join(REPO_ROOT, "setup"), path.join(root, "setup"));
      await fs.chmod(path.join(root, "setup"), 0o755);
      await fs.writeFile(path.join(root, "package.json"), '{"type":"module","dependencies":{"sharp":"1.0.0"},"devDependencies":{"test-only-sdk":"1.0.0"}}\n');
      await fs.writeFile(path.join(root, "node_modules", "sharp", "package.json"), '{"name":"sharp","main":"index.js"}\n');
      await fs.writeFile(path.join(root, "node_modules", "sharp", "index.js"), 'module.exports = require("@img/sharp-fixture");\n');
      await fs.writeFile(path.join(runtime, "install.js"), `import { spawnSync } from "node:child_process";
const result = spawnSync(process.env.BUN_CMD || "bun", ["install", "--production", "--frozen-lockfile"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);
console.log(\`installer=\${process.release.name}\`);
`);
      await fs.writeFile(path.join(fakeBin, "bun"), `#!/bin/sh
printf '%s\\n' "$*" >> "$BUN_LOG"
mkdir -p "$FIXTURE_ROOT/node_modules/@img/sharp-fixture"
printf '{"name":"@img/sharp-fixture","main":"index.js"}\\n' > "$FIXTURE_ROOT/node_modules/@img/sharp-fixture/package.json"
printf 'module.exports = {}\\n' > "$FIXTURE_ROOT/node_modules/@img/sharp-fixture/index.js"
`, { mode: 0o755 });

      const result = await runCommand(path.join(root, "setup"), ["--install-now", "--yes"], {
        capture: true,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          BUN_LOG: log,
          FIXTURE_ROOT: root,
          GSTACK_HOME: path.join(root, "managed home"),
        },
      });
      expect(await fs.readFile(log, "utf8")).toContain("install --production --frozen-lockfile");
      expect(result.stdout).toContain("installer=node");

      const second = await runCommand(path.join(root, "setup"), ["--install-now", "--yes"], {
        capture: true,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          BUN_LOG: log,
          FIXTURE_ROOT: root,
          GSTACK_HOME: path.join(root, "managed home"),
        },
      });
      const installs = (await fs.readFile(log, "utf8")).trim().split("\n");
      expect(installs).toEqual([
        "install --production --frozen-lockfile",
        "install --production --frozen-lockfile",
      ]);
      expect(await exists(path.join(root, "node_modules", "test-only-sdk"))).toBe(false);
      expect(second.stdout).toContain("installer=node");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("the setup compatibility wrapper is host-neutral and resolves its physical source", async () => {
    const setup = await fs.readFile(path.join(REPO_ROOT, "setup"), "utf8");
    expect(setup).not.toMatch(/\.claude|\.codex|\.cursor|command -v (?:claude|codex)/);
    expect(setup).not.toMatch(/sudo|apt-get|dnf install|pacman|apk add|codesign|plan-tune-hooks|ensure_emoji_font/);
    expect(setup).toContain("runtime/install.js");

    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack setup link "));
    try {
      const linkedSetup = path.join(root, "linked setup");
      await fs.symlink(path.join(REPO_ROOT, "setup"), linkedSetup);
      const result = await runCommand(linkedSetup, ["--help"], { capture: true });
      expect(result.stdout).toContain("optional host-neutral runtime");
      expect(result.stdout).toContain("npx skills add time-attack/gstack");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("managed uninstall removes launchers and versions but preserves user state", async () => {
    await withFixture(async ({ source, home }) => {
      await installFixture(source, home, "2.0.0");
      await fs.writeFile(path.join(home, "config.json"), '{"user":"preserved"}\n');
      await fs.mkdir(path.join(home, "projects", "kept"), { recursive: true });

      const result = await uninstallManagedRuntime(home);
      expect(result).toMatchObject({ preservedState: true, manifestRemoved: true });
      expect(await exists(path.join(home, "versions"))).toBe(false);
      expect(await exists(path.join(home, "bin", "gstack"))).toBe(false);
      expect(await exists(path.join(home, "runtime-install.json"))).toBe(false);
      expect(await fs.readFile(path.join(home, "config.json"), "utf8")).toContain("preserved");
      expect(await exists(path.join(home, "projects", "kept"))).toBe(true);
    });
  });
});

async function installFixture(source: string, home: string, version: string, overrides: Record<string, unknown> = {}) {
  return installManagedRuntime({
    sourceDir: source,
    home,
    version,
    entries: ENTRIES,
    capabilities: CAPABILITIES,
    ...overrides,
  });
}

function runInstalledLauncher(
  home: string,
  name: string,
  args: string[],
  options: Record<string, unknown> = {},
) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new TypeError("Invalid installed launcher name");
  if (process.platform === "win32") {
    return runCommand(process.env.ComSpec || "cmd.exe", [
      "/d", "/s", "/c", "call", path.join(home, "bin", `${name}.cmd`), ...args,
    ], options);
  }
  return runCommand(path.join(home, "bin", name), args, options);
}

async function createSource(source: string) {
  await fs.mkdir(path.join(source, "runtime"), { recursive: true });
  await fs.mkdir(path.join(source, "bin"), { recursive: true });
  await fs.mkdir(path.join(source, "cap"), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), '{"name":"gstack","version":"2.0.0","type":"module"}\n');
  await fs.writeFile(path.join(source, "runtime", "cli.js"), fixtureCli(""));
  await fs.writeFile(path.join(source, "runtime", "tooling.js"),
    'export async function resolveBashCommand(env = process.env) { return env.GSTACK_BASH || "bash"; }\n');
  await fs.writeFile(path.join(source, "bin", "gstack"), `#!/usr/bin/env node
import { main } from "../runtime/cli.js";
process.exitCode = await main(process.argv.slice(2));
`, { mode: 0o755 });
  await fs.writeFile(path.join(source, "cap", "tool"), "#!/bin/sh\nprintf 'fixture capability %s\\n' \"$*\"\n", { mode: 0o755 });
}

function fixtureCli(label: string) {
  const marker = label ? `${label} ` : "";
  return `export async function main(argv = []) { console.log("gstack fixture ${marker}" + argv.join(" ")); return 0; }\n`;
}

async function withFixture(
  callback: (value: { root: string; source: string; home: string }) => Promise<void>,
  options: { createDefaultSource?: boolean } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-runtime-install-"));
  const source = path.join(root, "source");
  const home = path.join(root, "home", ".gstack");
  try {
    if (options.createDefaultSource !== false) await createSource(source);
    await callback({ root, source, home });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function activeVersion(home: string) {
  return (await readJson(path.join(home, "versions", "current.json"))).current;
}

async function exists(file: string) {
  return fs.access(file).then(() => true, () => false);
}

function captureStream() {
  let output = "";
  return {
    stream: {
      write(chunk: unknown) {
        output += String(chunk);
        return true;
      },
    },
    value: () => output,
  };
}
