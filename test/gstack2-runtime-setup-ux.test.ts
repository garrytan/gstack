import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runDoctor } from "../runtime/doctor.js";
import { runInstallerCli, runtimeSlotVersion, runtimeSurfaceForCapabilities } from "../runtime/install.js";
import { resolveRuntimePaths } from "../runtime/paths.js";
import { setupRuntime } from "../runtime/setup.js";
import { bashCandidates, resolveBashCommand } from "../runtime/tooling.js";
import {
  BOOTSTRAP_SCHEMA_VERSION,
  BOOTSTRAP_RUNTIME_VERSION,
  CAPABILITY_COMPONENTS,
  COMPONENT_DEPENDENCIES,
  OFFICIAL_MANIFEST_URL,
  main as bootstrapMain,
} from "../runtime/runtime-bootstrap.mjs";

function capture() {
  let value = "";
  return { stream: { write: (chunk: string) => { value += chunk; } }, value: () => value };
}

function officialManifestFixture(target: string, customize?: (component: string, artifact: Record<string, unknown>) => void) {
  const components = Object.fromEntries(Object.keys(COMPONENT_DEPENDENCIES)
    .filter((component) => component !== "ios" || target.startsWith("darwin-"))
    .map((component) => {
      const artifact: Record<string, unknown> = {
        url: `https://github.com/time-attack/gstack/releases/download/v${BOOTSTRAP_RUNTIME_VERSION}/${component}.tar.gz`,
        sha256: "0".repeat(64),
        bytes: 8,
        format: "tar.gz",
      };
      customize?.(component, artifact);
      return [component, artifact];
    }));
  return {
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    version: BOOTSTRAP_RUNTIME_VERSION,
    skillApi: "2.0",
    capabilityComponents: CAPABILITY_COMPONENTS,
    componentDependencies: COMPONENT_DEPENDENCIES,
    targets: { [target]: { components } },
  };
}

describe("GStack runtime setup UX", () => {
  test("capability selection keeps the core and excludes unselected heavyweight surfaces", () => {
    const surface = runtimeSurfaceForCapabilities(["browser"]);
    const paths = surface.entries.map((entry) => entry.path);
    expect(paths).toContain("runtime");
    expect(paths.some((entry) => entry.startsWith("browse/"))).toBe(true);
    expect(paths.some((entry) => entry.startsWith("design/"))).toBe(false);
    expect(paths.some((entry) => entry.startsWith("make-pdf/"))).toBe(false);
    expect(surface.capabilities.browse).toBeTruthy();
    expect(surface.capabilities["gstack-design"]).toBeUndefined();
    for (const target of Object.values(surface.capabilities)) {
      expect(paths.some((root) => target === root || target.startsWith(`${root}/`))).toBe(true);
    }
    const core = runtimeSurfaceForCapabilities([]);
    const corePaths = core.entries.map((entry) => entry.path);
    for (const target of Object.values(core.capabilities)) {
      expect(corePaths.some((root) => target === root || target.startsWith(`${root}/`))).toBe(true);
    }
    expect(runtimeSlotVersion("2.0.0", ["pdf", "browser"]))
      .toBe(runtimeSlotVersion("2.0.0", ["browser", "pdf"]));
    expect(runtimeSlotVersion("2.0.0", ["browser"]))
      .not.toBe(runtimeSlotVersion("2.0.0", ["browser", "pdf"]));
    const expected = {
      browser: ["browser"],
      design: ["design"],
      diagram: ["browser", "diagram"],
      pdf: ["browser", "diagram", "pdf"],
      ...(process.platform === "darwin" ? { ios: ["ios"] } : {}),
    };
    for (const [capability, dependencies] of Object.entries(expected)) {
      expect(runtimeSurfaceForCapabilities([capability]).selected).toEqual(dependencies);
    }
  });

  test("later capability installs retain already approved capabilities unless replacement is explicit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-setup-retain-"));
    const home = path.join(root, "home");
    const source = path.resolve(import.meta.dir, "..");
    const paths = resolveRuntimePaths({ home });
    const active = path.join(paths.versions, "existing");
    try {
      await fs.mkdir(active, { recursive: true });
      await fs.writeFile(paths.versionPointer, JSON.stringify({
        schemaVersion: 2, status: "active", current: "existing", lastKnownGood: "existing",
      }));
      await fs.writeFile(path.join(active, ".gstack-bundle.json"), JSON.stringify({
        selectedCapabilities: ["design"],
      }));
      const retained = capture();
      expect(await runInstallerCli([
        "--source", source, "--home", home, "--capabilities", "pdf", "--dry-run", "--json",
      ], { stdout: retained.stream, stderr: retained.stream })).toBe(0);
      expect(JSON.parse(retained.value()).preview.capabilities).toEqual(["browser", "design", "diagram", "pdf"]);

      const replaced = capture();
      expect(await runInstallerCli([
        "--source", source, "--home", home, "--capabilities", "pdf", "--replace-capabilities", "--dry-run", "--json",
      ], { stdout: replaced.stream, stderr: replaced.stream })).toBe(0);
      expect(JSON.parse(replaced.value()).preview.capabilities).toEqual(["browser", "diagram", "pdf"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("dry-run previews capabilities and exact bytes without creating state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-setup-preview-"));
    const home = path.join(root, "home");
    const source = path.resolve(import.meta.dir, "..");
    const output = capture();
    try {
      expect(await runInstallerCli([
        "--source", source,
        "--home", home,
        "--capabilities", "core",
        "--dry-run",
        "--json",
      ], { stdout: output.stream, stderr: output.stream })).toBe(0);
      const result = JSON.parse(output.value());
      expect(result).toMatchObject({ ok: true, action: "dry-run", mutated: false });
      expect(result.preview.capabilities).toEqual([]);
      expect(result.preview.bytes).toBeGreaterThan(0);
      expect(result.preview.materializations.find((item) => item.kind === "managed-bun-capture")).toMatchObject({
        available: true,
        version: "1.3.14",
      });
      await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("Node-only dry-run explains a missing source-build Bun without mutating or failing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-node-only-preview-"));
    const home = path.join(root, "home");
    const output = capture();
    try {
      expect(await runInstallerCli([
        "--source", path.resolve(import.meta.dir, ".."),
        "--home", home,
        "--capabilities", "browser",
        "--dry-run",
        "--json",
      ], {
        stdout: output.stream,
        stderr: output.stream,
        env: { ...process.env, BUN_CMD: "definitely-missing-bun" },
        installOptions: { runCommand: async () => { throw new Error("Bun absent"); } },
      })).toBe(0);
      const preview = JSON.parse(output.value()).preview;
      expect(preview.materializations.find((item) => item.kind === "managed-bun-capture")).toMatchObject({
        available: false,
        command: "definitely-missing-bun",
      });
      expect(preview.materializations.find((item) => item.kind === "playwright-chromium-download")).toBeTruthy();
      await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("Windows Bash discovery shared by doctor and launchers finds a standard Git installation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-git-bash-"));
    const bash = path.join(root, "Git", "bin", "bash.exe");
    try {
      await fs.mkdir(path.dirname(bash), { recursive: true });
      await fs.writeFile(bash, "fixture\n");
      const env = { ProgramFiles: root };
      expect(bashCandidates(env, "win32")).toContain(bash);
      expect(await resolveBashCommand(env, "win32")).toBe(bash);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("state initialization does not make doctor claim the runtime is installed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-doctor-missing-runtime-"));
    const home = path.join(root, "home");
    try {
      await setupRuntime({ home, cwd: root });
      const report = await runDoctor({ home, cwd: root, nodeCommand: process.execPath });
      expect(report.ok).toBe(false);
      expect(report.checks.find((check) => check.id === "managed-runtime")).toMatchObject({ status: "fail" });
      expect(report.checks.find((check) => check.id === "capability:browser")).toMatchObject({ status: "warn" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("doctor fails closed when installed skills require a different runtime API", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-doctor-api-"));
    const home = path.join(root, "home");
    try {
      await setupRuntime({ home, cwd: root });
      const paths = resolveRuntimePaths({ home });
      const active = path.join(paths.versions, "fixture");
      await fs.mkdir(active, { recursive: true });
      await fs.writeFile(path.join(active, ".gstack-bundle.json"), JSON.stringify({
        compatibility: { skillApi: "2.0" },
        selectedCapabilities: [],
        capabilities: {},
      }));
      await fs.writeFile(paths.versionPointer, JSON.stringify({
        schemaVersion: 2, status: "active", current: "fixture", lastKnownGood: "fixture",
      }));
      const report = await runDoctor({
        home, cwd: root, nodeCommand: process.execPath, expectedSkillApi: "3.0",
      });
      expect(report.ok).toBe(false);
      expect(report.checks.find((check) => check.id === "managed-runtime")).toMatchObject({
        status: "fail",
        details: { expectedSkillApi: "3.0" },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("doctor rejects selected capabilities whose declared dependencies are absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-doctor-deps-"));
    const home = path.join(root, "home");
    try {
      await setupRuntime({ home, cwd: root });
      const paths = resolveRuntimePaths({ home });
      const active = path.join(paths.versions, "fixture");
      await fs.mkdir(active, { recursive: true });
      await fs.writeFile(path.join(active, ".gstack-bundle.json"), JSON.stringify({
        compatibility: { skillApi: "2.0" },
        selectedCapabilities: ["pdf"],
        capabilities: { "make-pdf": "make-pdf/dist/pdf" },
      }));
      await fs.writeFile(paths.versionPointer, JSON.stringify({
        schemaVersion: 2, status: "active", current: "fixture", lastKnownGood: "fixture",
      }));
      const report = await runDoctor({ home, cwd: root, nodeCommand: process.execPath });
      expect(report.ok).toBe(false);
      expect(report.checks.find((check) => check.id === "capability:pdf")).toMatchObject({ status: "fail" });
      expect(report.checks.find((check) => check.id === "capability:pdf")?.message).toContain("browser, diagram");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("doctor launches the managed headless Chromium slot instead of requiring full Chromium", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-doctor-browser-"));
    const home = path.join(root, "home");
    try {
      await setupRuntime({ home, cwd: root });
      const paths = resolveRuntimePaths({ home });
      const active = path.join(paths.versions, "fixture");
      const browserRoot = path.join(active, ".gstack-runtime-browsers");
      const managedBun = path.join(active, ".gstack-runtime-tools", process.platform === "win32" ? "bun.exe" : "bun");
      const playwright = path.join(active, "node_modules", "playwright");
      await fs.mkdir(path.join(browserRoot, "chromium-headless-shell-fixture"), { recursive: true });
      await fs.mkdir(path.dirname(managedBun), { recursive: true });
      await fs.mkdir(playwright, { recursive: true });
      await fs.copyFile(process.execPath, managedBun);
      if (process.platform !== "win32") await fs.chmod(managedBun, 0o755);
      await fs.writeFile(path.join(playwright, "index.mjs"),
        `export const chromium = { launch: async ({ headless }) => { if (headless !== true) throw new Error("expected headless"); return { version: () => "fixture-chromium", close: async () => {} }; } };\n`);
      await fs.writeFile(path.join(active, ".gstack-bundle.json"), JSON.stringify({
        compatibility: { skillApi: "2.0" },
        selectedCapabilities: ["browser"],
        capabilities: { browse: "browse/dist/browse" },
        tools: { bun: { path: path.relative(active, managedBun).split(path.sep).join("/"), version: "1.3.14" } },
      }));
      await fs.writeFile(paths.versionPointer, JSON.stringify({
        schemaVersion: 2, status: "active", current: "fixture", lastKnownGood: "fixture",
      }));
      const report = await runDoctor({ home, cwd: root, nodeCommand: process.execPath });
      expect(report.checks.find((check) => check.id === "capability:browser")).toMatchObject({
        status: "pass",
        details: { browserRoot, version: "fixture-chromium" },
      });
      expect(report.checks.find((check) => check.id === "runtime-tool:bun")).toMatchObject({ status: "pass" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("bootstrap help has no dependency or network side effects", async () => {
    const output = capture();
    let fetches = 0;
    expect(await bootstrapMain(["--help"], {
      stdout: output.stream,
      stderr: output.stream,
      fetch: async () => { fetches += 1; throw new Error("unexpected fetch"); },
    })).toBe(0);
    expect(output.value()).toContain("--capability");
    expect(fetches).toBe(0);
  });

  test("bootstrap executes through a symlinked or aliased filesystem path", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-bootstrap-link-"));
    try {
      const linked = path.join(root, "runtime-bootstrap.mjs");
      await fs.symlink(path.resolve(import.meta.dir, "../runtime/runtime-bootstrap.mjs"), linked);
      const result = spawnSync(process.execPath, [linked, "--help"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: node runtime-bootstrap.mjs");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("bootstrap refuses an artifact whose SHA-256 does not match the official manifest", async () => {
    const output = capture();
    const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
    let calls = 0;
    const fetch_ = async (url: string) => {
      calls += 1;
      if (url === OFFICIAL_MANIFEST_URL) {
        return {
          ok: true,
          url,
          json: async () => officialManifestFixture(target),
        };
      }
      return {
        ok: true,
        url,
        arrayBuffer: async () => new TextEncoder().encode("tampered").buffer,
      };
    };
    expect(await bootstrapMain(["install", "--capability", "browser", "--yes"], {
      stdout: output.stream,
      stderr: output.stream,
      fetch: fetch_,
    })).toBe(1);
    expect(calls).toBe(2);
    expect(output.value()).toContain("SHA-256 mismatch");
  });

  test("bootstrap rejects physical iOS on non-macOS before any network request", async () => {
    const output = capture();
    let fetches = 0;
    expect(await bootstrapMain(["install", "--capability", "ios"], {
      platform: "linux",
      arch: "x64",
      stdout: output.stream,
      stderr: output.stream,
      fetch: async () => { fetches += 1; throw new Error("unexpected fetch"); },
    })).toBe(1);
    expect(fetches).toBe(0);
    expect(output.value()).toContain("only on macOS");
  });

  test("official Linux bootstrap rejects musl explicitly before any network request", async () => {
    const output = capture();
    let fetches = 0;
    expect(await bootstrapMain(["install", "--capability", "browser"], {
      platform: "linux",
      arch: "x64",
      libc: "musl",
      stdout: output.stream,
      stderr: output.stream,
      fetch: async () => { fetches += 1; throw new Error("unexpected fetch"); },
    })).toBe(1);
    expect(fetches).toBe(0);
    expect(output.value()).toContain("require glibc Linux");
  });

  test("declared Cosign bundles must bind the official release workflow identity", async () => {
    const output = capture();
    const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
    let calls = 0;
    expect(await bootstrapMain(["install", "--capability", "browser", "--yes"], {
      stdout: output.stream,
      stderr: output.stream,
      fetch: async (url: string) => {
        calls += 1;
        return {
          ok: true,
          url,
          json: async () => officialManifestFixture(target, (component, artifact) => {
            if (component !== "core") return;
            artifact.cosignBundleUrl = `${artifact.url}.sigstore.json`;
          }),
        };
      },
    })).toBe(1);
    expect(calls).toBe(1);
    expect(output.value()).toContain("does not bind the official GStack release workflow");
  });

  test("developer source fallback is explicit and does not mark the source as a prepared release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-bootstrap-source-"));
    const runtime = path.join(root, "runtime");
    const log = path.join(root, "args.json");
    const output = capture();
    try {
      await fs.mkdir(runtime);
      await fs.writeFile(path.join(runtime, "install.js"),
        `import fs from "node:fs"; fs.writeFileSync(process.env.BOOTSTRAP_TEST_LOG, JSON.stringify(process.argv.slice(2)));\n`);
      const previous = process.env.BOOTSTRAP_TEST_LOG;
      process.env.BOOTSTRAP_TEST_LOG = log;
      try {
        expect(await bootstrapMain([
          "install", "--source", root, "--capability", "pdf", "--home", path.join(root, "home"), "--yes",
        ], { stdout: output.stream, stderr: output.stream })).toBe(0);
      } finally {
        if (previous == null) delete process.env.BOOTSTRAP_TEST_LOG;
        else process.env.BOOTSTRAP_TEST_LOG = previous;
      }
      const args = JSON.parse(await fs.readFile(log, "utf8"));
      expect(args).toContain("--install-now");
      expect(args).toContain("--yes");
      expect(args).toContain("browser,diagram,pdf");
      expect(args).not.toContain("--prepared");
      expect(output.value()).toContain("Developer-only source install");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
