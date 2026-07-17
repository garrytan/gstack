import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main as runtimeMain } from "../runtime/cli.js";
import {
  DEFAULT_CAPABILITY_LAUNCHERS,
  DEFAULT_RUNTIME_BUNDLE,
  DEFAULT_RUNTIME_HELPERS,
  defaultBunBuilder,
  installManagedRuntime,
  uninstallManagedRuntime,
  runCommand,
  validateRuntimeBundle,
} from "../runtime/install.js";

const ENTRIES = [
  { path: "runtime" },
  { path: "bin/gstack", executable: true },
  { path: "cap/tool", build: "fixture", executable: true },
];
const CAPABILITIES = { "fixture-tool": "cap/tool" };
const REPO_ROOT = path.resolve(import.meta.dir, "..");

describe("GStack 2 managed runtime installer", () => {
  test("installs, validates, activates, and writes an uninstall-friendly manifest", async () => {
    await withFixture(async ({ source, home }) => {
      const result = await installFixture(source, home, "2.0.0");

      expect(result.pointer.status).toBe("active");
      expect(result.pointer.current).toBe("2.0.0");
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
      const launched = await runCommand(path.join(home, "bin", "gstack"), ["version"], { capture: true });
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
    const bundlePaths = new Set(DEFAULT_RUNTIME_BUNDLE.map((item) => item.path));
    for (const dependency of [
      "node_modules/sharp",
      "node_modules/@img",
      "node_modules/detect-libc",
      "node_modules/semver",
      "node_modules/@ngrok",
    ]) expect(bundlePaths.has(dependency)).toBe(true);
    expect([...bundlePaths].some((item) => item.includes("@huggingface"))).toBe(false);
    for (const helper of contract.helpers) {
      expect(bundlePaths.has(helper.source_path)).toBe(true);
      if (helper.name === "gstack") continue;
      const declaredTarget = DEFAULT_RUNTIME_HELPERS[helper.name]?.target ?? DEFAULT_CAPABILITY_LAUNCHERS[helper.name];
      expect(declaredTarget).toBe(helper.source_path);
    }

    await withFixture(async ({ home }) => {
      const result = await installManagedRuntime({ sourceDir: REPO_ROOT, home, version: "helper-contract-test" });
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
        'await import("@anthropic-ai/sdk"); await import("sharp"); await import("@ngrok/ngrok");',
      ], { capture: true, cwd: result.path });
      expect(browserDependencies.code).toBe(0);

      const next = await runCommand(path.join(home, "bin", "gstack-next-version"), ["--help"], { capture: true });
      expect(next.stdout).toContain("Usage: gstack-next-version");
      const sourced = await runCommand("bash", ["-c", '. "$1"; type read_secret_to_env', "_", path.join(home, "bin", "gstack-gbrain-lib.sh")], { capture: true });
      expect(sourced.stdout).toContain("read_secret_to_env");
      const syncAlias = await runCommand(path.join(home, "bin", "gstack-gbrain-sync"), ["--help"], { capture: true });
      expect(`${syncAlias.stdout}${syncAlias.stderr}`).toContain("gstack-gbrain-sync");
      const syncTypeScriptAlias = await runCommand("bun", [path.join(home, "bin", "gstack-gbrain-sync.ts"), "--help"], { capture: true });
      expect(`${syncTypeScriptAlias.stdout}${syncTypeScriptAlias.stderr}`).toContain("gstack-gbrain-sync");

      const body = path.join(home, "audit-body.txt");
      await fs.writeFile(body, "safe body\n");
      await runCommand(path.join(home, "bin", "gstack-redact-audit-log"), [
        '{"repo_visibility":"public","outcome":"clean","categories_flagged":[]}',
        body,
      ], { capture: true, env: { ...process.env, GSTACK_HOME: home } });
      expect(await fs.readFile(path.join(home, "security", "semantic-reviews.jsonl"), "utf8")).toContain('"outcome":"clean"');
    }, { createDefaultSource: false });
  }, 30_000);

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
      const first = await runCommand(path.join(home, "bin", "gstack"), ["doctor"], { capture: true });
      expect(first.stdout).toContain("gstack fixture doctor");

      await fs.writeFile(path.join(source, "runtime", "cli.js"), fixtureCli("second"));
      await installFixture(source, home, "2.0.0");
      const second = await runCommand(path.join(home, "bin", "gstack"), ["doctor"], { capture: true });
      expect(second.stdout).toContain("gstack fixture second doctor");

      const capability = await runCommand(path.join(home, "bin", "fixture-tool"), ["hello world"], { capture: true });
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

      const launched = await runCommand(path.join(home, "bin", "gstack"), ["doctor"], { capture: true });
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
        await expect(validateRuntimeBundle(result.path, { version: "2.0.0" })).rejects.toMatchObject({
          code: "INSTALL_VALIDATION_FAILED",
        });
        await fs.chmod(cli, originalMode);
      }

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
      const launched = await runCommand(path.join(home, "bin", "gstack"), ["doctor"], { capture: true });
      expect(launched.stdout).toContain("gstack fixture doctor");
    });
  });

  test("a launcher repairs a crash journal before resolving any runtime", async () => {
    await withFixture(async ({ source, home }) => {
      await installFixture(source, home, "1.0.0");
      const pointer = await readJson(path.join(home, "versions", "current.json"));
      const manifest = await fs.readFile(path.join(home, "runtime-install.json"));
      const windowsLauncher = await fs.readFile(path.join(home, "bin", "gstack.cmd"));
      await fs.writeFile(path.join(home, "runtime-install.json"), '{"activeVersion":"crashed"}\n');
      await fs.writeFile(path.join(home, "bin", "gstack.cmd"), "candidate launcher\n");
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
          { path: "bin/gstack.cmd", existed: true, mode: 0o644, dataBase64: windowsLauncher.toString("base64") },
        ],
      }, null, 2)}\n`, { mode: 0o600 });
      const orphanedLock = `${home}.runtime-lifecycle.lock`;
      await fs.mkdir(orphanedLock);
      await fs.writeFile(path.join(orphanedLock, "owner.json"), `${JSON.stringify({
        token: "orphaned",
        pid: 2_147_483_647,
        hostname: os.hostname(),
      })}\n`);

      const launched = await runCommand(path.join(home, "bin", "gstack"), ["doctor"], { capture: true });
      expect(launched.stdout).toContain("gstack fixture doctor");
      expect(await readJson(path.join(home, "versions", "current.json"))).toEqual(pointer);
      expect(await fs.readFile(path.join(home, "runtime-install.json"))).toEqual(manifest);
      expect(await fs.readFile(path.join(home, "bin", "gstack.cmd"))).toEqual(windowsLauncher);
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
      const calls: Array<{ command: string; args: string[] }> = [];
      await installFixture(source, home, "1.0.0", {
        runCommand: async (command: string, args: string[]) => {
          calls.push({ command, args });
          if (args[0] === "--version") return { code: 0, stdout: "v20.18.0\n", stderr: "" };
          return { code: 0, stdout: "gstack runtime fixture\n", stderr: "" };
        },
      });
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.command === "node")).toBe(true);
      expect(calls[0].args).toEqual(["--version"]);
    });
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
      await fs.mkdir(path.join(root, "node_modules"));
      await fs.copyFile(path.join(REPO_ROOT, "setup"), path.join(root, "setup"));
      await fs.chmod(path.join(root, "setup"), 0o755);
      await fs.writeFile(path.join(root, "package.json"), '{"type":"module","dependencies":{"fixture-dependency":"1.0.0"},"devDependencies":{"test-only-sdk":"1.0.0"}}\n');
      await fs.writeFile(path.join(runtime, "install.js"), 'console.log(`installer=${process.release.name}`);\n');
      await fs.writeFile(path.join(fakeBin, "bun"), `#!/bin/sh
printf '%s\\n' "$*" >> "$BUN_LOG"
mkdir -p "$FIXTURE_ROOT/node_modules/fixture-dependency"
printf '{"name":"fixture-dependency"}\\n' > "$FIXTURE_ROOT/node_modules/fixture-dependency/package.json"
`, { mode: 0o755 });

      const result = await runCommand(path.join(root, "setup"), [], {
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

      const second = await runCommand(path.join(root, "setup"), [], {
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
      expect(installs).toEqual(["install --production --frozen-lockfile"]);
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

async function createSource(source: string) {
  await fs.mkdir(path.join(source, "runtime"), { recursive: true });
  await fs.mkdir(path.join(source, "bin"), { recursive: true });
  await fs.mkdir(path.join(source, "cap"), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), '{"name":"gstack","version":"2.0.0","type":"module"}\n');
  await fs.writeFile(path.join(source, "runtime", "cli.js"), fixtureCli(""));
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
    await fs.rm(root, { recursive: true, force: true });
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
