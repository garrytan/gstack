import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { resolveRuntimePaths } from "./paths.js";
import { readJson, pathExists } from "./storage.js";
import { discoverProjectIdentity } from "./identity.js";
import { RUNTIME_SCHEMA_VERSION, RUNTIME_MIGRATION_ID } from "./migrations.js";
import { assertManagedHome } from "./managed-home.js";
import { recoverPendingUpgrade } from "./upgrade.js";
import { bashCandidates } from "./tooling.js";
import {
  OPTIONAL_RUNTIME_CAPABILITIES,
  RUNTIME_CAPABILITY_DEPENDENCIES,
  RUNTIME_COMPATIBILITY,
  managedBunRelativePath,
} from "./install.js";

export const CAPABILITY_READINESS_CAPABILITIES = Object.freeze([
  "browser",
  "design",
  "diagram",
  "pdf",
  "ios",
]);

export async function runDoctor(options = {}) {
  const paths = resolveRuntimePaths(options);
  const checks = [];
  const add = (id, status, message, details) => checks.push({ id, status, message, ...(details ? { details } : {}) });
  const now = options.now ? options.now() : new Date();
  const expectedSkillApi = options.expectedSkillApi ?? RUNTIME_COMPATIBILITY.skillApi;
  if (typeof expectedSkillApi !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(expectedSkillApi)) {
    throw new TypeError("Expected skill API must be a short version identifier");
  }

  const node = await inspectLauncherNode(options.nodeCommand ?? process.env.GSTACK_NODE ?? "node");
  add("launcher-node", node.ok ? "pass" : "fail", node.message, node.details);

  if (!(await pathExists(paths.home))) {
    add("home", "fail", `State home does not exist: ${paths.home}`, { remedy: "Run `gstack init`." });
  } else {
    try {
      await fs.access(paths.home, fsConstants.R_OK | fsConstants.W_OK);
      add("home", "pass", `State home is readable and writable: ${paths.home}`);
    } catch (error) {
      add("home", "fail", `State home is not readable and writable: ${paths.home}`, { code: error.code });
    }
    try {
      await assertManagedHome(paths.home, options);
      add("ownership", "pass", "Managed home ownership sentinel is valid");
    } catch (error) {
      add("ownership", "fail", `Managed home ownership cannot be verified: ${error.message}`, {
        code: error.code,
        remedy: "Run `gstack init` with the intended GSTACK_HOME.",
      });
    }
  }

  try {
    const config = await readJson(paths.config);
    add("config", config?.schemaVersion <= RUNTIME_SCHEMA_VERSION ? "pass" : "fail",
      `Config schema ${config?.schemaVersion ?? "unknown"}`);
    const enabled = config?.network?.mode === "context" && config?.network?.consent === true;
    add("network", enabled ? "pass" : "warn",
      enabled ? "Context.dev network mode has explicit consent" : "Network access is off (safe default)");
  } catch (error) {
    add("config", "fail", `Config cannot be read: ${error.message}`);
  }

  try {
    const stat = await fs.stat(paths.secrets);
    const privateMode = process.platform === "win32" || (stat.mode & 0o077) === 0;
    await readJson(paths.secrets);
    add("secrets", privateMode ? "pass" : "fail",
      privateMode ? "Secrets file is private" : "Secrets file permissions are broader than 0600",
      process.platform === "win32" ? undefined : { mode: `0${(stat.mode & 0o777).toString(8)}` });
  } catch (error) {
    add("secrets", "fail", `Secrets file cannot be read: ${error.message}`);
  }

  try {
    const migration = await readJson(paths.migrations);
    const supported = migration.schemaVersion === RUNTIME_SCHEMA_VERSION &&
      migration.applied?.some((entry) => entry.id === RUNTIME_MIGRATION_ID);
    add("migration", supported ? "pass" : "fail",
      supported ? `Forward-only schema ${migration.schemaVersion} is current` : "Migration marker is absent or unsupported");
  } catch (error) {
    add("migration", "fail", `Migration marker cannot be read: ${error.message}`);
  }

  try {
    const identity = await discoverProjectIdentity(options.cwd ?? process.cwd());
    const stateFile = path.join(paths.projects, identity.projectId, "state.json");
    if (await pathExists(stateFile)) {
      const state = await readJson(stateFile);
      const valid = state.schemaVersion <= RUNTIME_SCHEMA_VERSION && state.project?.id === identity.projectId;
      add("project", valid ? "pass" : "fail",
        valid ? `Project state found for ${identity.projectId}` : "Project state identity/schema does not match");
    } else {
      add("project", "warn", `No state initialized for ${identity.projectId}`, { remedy: "Run `gstack init`." });
    }
    add("git", identity.isGit ? "pass" : "warn",
      identity.isGit ? `Git worktree ${identity.worktreeId}` : "Current directory is not a Git worktree");
  } catch (error) {
    add("project", "fail", `Project identity failed: ${error.message}`);
  }

  try {
    const recovery = await recoverPendingUpgrade(paths.home, options);
    const pointer = recovery.pointer;
    add("upgrade", recovery.recovered ? "warn" : "pass", recovery.recovered
      ? `Recovered interrupted upgrade${pointer?.current ? ` to ${pointer.current}` : " without a last-known-good version"}`
      : pointer?.current ? `Version pointer is active: ${pointer.current}` : "No pending managed runtime transaction");
    if (!pointer?.current) {
      add("managed-runtime", "fail", "No active managed runtime", {
        remedy: "Install the optional runtime explicitly from the GStack bootstrap package; judgment-only skills remain available.",
      });
      for (const capability of OPTIONAL_RUNTIME_CAPABILITIES) {
        add(`capability:${capability}`, "warn", "not installed");
      }
    } else {
      const activeRoot = path.join(paths.versions, pointer.current);
      const stat = await fs.lstat(activeRoot).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        add("managed-runtime", "fail", `Active managed runtime is missing or unsafe: ${pointer.current}`);
        for (const capability of OPTIONAL_RUNTIME_CAPABILITIES) add(`capability:${capability}`, "warn", "runtime unavailable");
      } else {
        const manifest = await readJson(path.join(activeRoot, ".gstack-bundle.json"), null);
        const compatible = manifest?.compatibility?.skillApi === expectedSkillApi;
        add("managed-runtime", compatible ? (recovery.recovered ? "warn" : "pass") : "fail",
          compatible
            ? `${recovery.recovered ? "Recovered" : "Active"} managed runtime ${pointer.current} (skill API ${manifest.compatibility.skillApi})`
            : `Managed runtime ${pointer.current} is missing compatible skill API metadata`,
          compatible ? { skillApi: manifest.compatibility.skillApi } : {
            expectedSkillApi,
            remedy: "Upgrade the GStack runtime to match the installed skills.",
          });
        const bun = await inspectRuntimeBun(activeRoot, manifest, options.nodeCommand ?? process.env.GSTACK_NODE ?? "node");
        add("runtime-tool:bun", bun.ok ? "pass" : "fail", bun.message, bun.details);
        const shell = await inspectBash(options.env ?? process.env);
        add("helper-shell:bash", shell.ok ? "pass" : "fail", shell.message, shell.details);
        const python = await inspectPython(options.env ?? process.env);
        add("specialist-tool:python", python.ok ? "pass" : "warn", python.message, python.details);
        const selected = new Set(Array.isArray(manifest?.selectedCapabilities) ? manifest.selectedCapabilities : []);
        const launchers = manifest?.capabilities ?? {};
        for (const capability of OPTIONAL_RUNTIME_CAPABILITIES) {
          if (!selected.has(capability)) {
            add(`capability:${capability}`, "warn", "not selected");
            continue;
          }
          const missingDependencies = (RUNTIME_CAPABILITY_DEPENDENCIES[capability] ?? [])
            .filter((dependency) => !selected.has(dependency));
          if (missingDependencies.length) {
            add(`capability:${capability}`, "fail", `installed without required dependencies: ${missingDependencies.join(", ")}`);
            continue;
          }
          if (!capabilityLaunchersReady(capability, launchers)) {
            add(`capability:${capability}`, "fail", "selected but required launcher metadata is missing");
            continue;
          }
          if (capability === "browser") {
            const browser = await inspectManagedChromium(activeRoot, options.nodeCommand ?? process.env.GSTACK_NODE ?? "node");
            add(`capability:${capability}`, browser.ok ? "pass" : "fail", browser.message, browser.details);
            continue;
          }
          if (capability === "ios") {
            const ios = await inspectXcrun();
            add(`capability:${capability}`, ios.ok ? "pass" : "fail", ios.message, ios.details);
            continue;
          }
          add(`capability:${capability}`, "pass", "installed with required dependencies and launcher metadata");
        }
      }
    }
  } catch (error) {
    add("managed-runtime", "fail", `Managed runtime cannot be inspected: ${error.message}`);
    for (const capability of OPTIONAL_RUNTIME_CAPABILITIES) {
      if (!checks.some((check) => check.id === `capability:${capability}`)) {
        add(`capability:${capability}`, "warn", "readiness unknown because runtime inspection failed");
      }
    }
  }

  return {
    ok: !checks.some((check) => check.status === "fail"),
    home: paths.home,
    checkedAt: now.toISOString(),
    checks,
  };
}

export function capabilityReadiness(report, capability, options = {}) {
  if (!CAPABILITY_READINESS_CAPABILITIES.includes(capability)) {
    throw new TypeError(`Unknown capability: ${capability}`);
  }
  const platform = options.platform ?? process.platform;
  const checkedAt = report.checkedAt;
  const judgment = {
    status: "available",
    message: "Pure-judgment skill guidance is available without the optional runtime.",
  };
  if (capability === "ios" && platform !== "darwin") {
    return {
      ok: false,
      capability,
      checkedAt,
      judgment,
      platform: { status: "unsupported", platform, message: "Physical iOS requires macOS and the existing CoreDevice harness." },
      consent: {
        preview: { status: "not-applicable", granted: false },
        install: { status: "not-applicable", granted: false },
      },
      readiness: { status: "unsupported", message: "The runtime capability is unsupported on this platform." },
      nextAction: "Continue with pure judgment or move the physical-iOS workflow to macOS.",
    };
  }

  const capabilityCheck = report.checks.find((check) => check.id === `capability:${capability}`);
  const runtimeCheck = report.checks.find((check) => check.id === "managed-runtime");
  let status;
  if (capabilityCheck?.status === "pass" && runtimeCheck?.status === "pass") status = "ready";
  else if (capabilityCheck?.status === "pass") status = "degraded";
  else if (capabilityCheck?.status === "fail") status = "failed";
  else status = "unavailable";

  const needsSetup = status === "unavailable" || status === "failed";
  const messages = {
    ready: "The selected capability passed its runtime readiness checks.",
    degraded: "The capability check passed, but the managed runtime reported a degraded condition.",
    unavailable: "The optional runtime capability is not installed or cannot currently be inspected.",
    failed: "The selected capability is installed but failed readiness checks.",
  };
  return {
    ok: status === "ready" || status === "degraded",
    capability,
    checkedAt,
    judgment,
    platform: { status: "supported", platform },
    consent: {
      preview: {
        status: needsSetup ? "required" : "not-required",
        granted: false,
        message: needsSetup
          ? "Consent is required before an uncached signed-manifest metadata preview; this command does not grant it."
          : "No setup preview is needed for the current readiness state.",
      },
      install: {
        status: needsSetup ? "required-after-preview" : "not-required",
        granted: false,
        message: needsSetup
          ? "Install consent is separate and may be requested only after the complete preview; this command does not grant it."
          : "No install is needed for the current readiness state.",
      },
    },
    readiness: {
      status,
      message: messages[status],
      evidence: [runtimeCheck, capabilityCheck].filter(Boolean),
    },
    nextAction: needsSetup
      ? `Ask for preview consent, then run the packaged bootstrap preview for ${capability}; continue judgment-only work if setup is deferred.`
      : status === "degraded"
        ? "Review the managed-runtime warning before capability-dependent evidence work."
        : "Proceed with capability-dependent work.",
  };
}

async function inspectRuntimeBun(activeRoot, manifest) {
  const relative = managedBunRelativePath();
  const declared = manifest?.tools?.bun;
  if (declared?.path !== relative || typeof declared?.version !== "string") {
    return { ok: false, message: "managed Bun metadata is missing or incompatible" };
  }
  const executable = path.join(activeRoot, relative);
  const stat = await fs.lstat(executable).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) return { ok: false, message: "managed Bun executable is missing or unsafe" };
  try {
    if (process.platform !== "win32") await fs.access(executable, fsConstants.X_OK);
    const result = await captureCommand(executable, ["--version"]);
    const version = result.stdout.trim();
    if (version !== declared.version) return { ok: false, message: "managed Bun version does not match its bundle metadata" };
    return { ok: true, message: `managed Bun ${version} is runnable`, details: { executable, version } };
  } catch (error) {
    return { ok: false, message: `managed Bun is not runnable: ${error.message}` };
  }
}

async function inspectBash(env) {
  for (const command of bashCandidates(env)) {
    try {
      const result = await captureCommand(command, ["--version"]);
      return { ok: true, message: "retained shell-helper Bash is available", details: { command, version: result.stdout.split(/\r?\n/, 1)[0] } };
    } catch { /* try the next explicit candidate */ }
  }
  return {
    ok: false,
    message: process.platform === "win32"
      ? "retained shell helpers require Git for Windows Bash (set GSTACK_BASH or install Git for Windows)"
      : "retained shell helpers require Bash (set GSTACK_BASH)",
  };
}

async function inspectPython(env) {
  const candidates = [env.GSTACK_PYTHON, ...(process.platform === "win32" ? ["python", "python3"] : ["python3", "python"])]
    .filter((entry, index, list) => entry && list.indexOf(entry) === index);
  for (const command of candidates) {
    try {
      const result = await captureCommand(command, ["--version"]);
      return { ok: true, message: "optional specialist Python is available", details: { command, version: `${result.stdout}${result.stderr}`.trim() } };
    } catch { /* optional candidate */ }
  }
  return { ok: false, message: "Python 3 is absent; only specialist flows that explicitly request it are unavailable" };
}

async function inspectManagedChromium(activeRoot, nodeCommand) {
  const browserRoot = path.join(activeRoot, ".gstack-runtime-browsers");
  const modulePath = path.join(activeRoot, "node_modules", "playwright", "index.mjs");
  const [browserStat, moduleStat] = await Promise.all([
    fs.lstat(browserRoot).catch(() => null),
    fs.lstat(modulePath).catch(() => null),
  ]);
  if (!browserStat?.isDirectory() || browserStat.isSymbolicLink() || !moduleStat?.isFile() || moduleStat.isSymbolicLink()) {
    return { ok: false, message: "managed Chromium or Playwright module is missing/unsafe" };
  }
  try {
    const moduleUrl = pathToFileURL(modulePath).href;
    const result = await captureCommand(nodeCommand, [
      "--input-type=module",
      "--eval",
      `const { chromium } = await import(${JSON.stringify(moduleUrl)}); const browser = await chromium.launch({ headless: true }); try { process.stdout.write(browser.version()); } finally { await browser.close(); }`,
    ], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot } });
    const version = result.stdout.trim();
    if (!version) return { ok: false, message: "managed Chromium launched without reporting a browser version" };
    return { ok: true, message: `managed headless Chromium ${version} launches and exits cleanly`, details: { browserRoot, version } };
  } catch (error) {
    return { ok: false, message: `managed Chromium is not runnable: ${error.message}` };
  }
}

async function inspectXcrun() {
  if (process.platform !== "darwin") return { ok: false, message: "physical-iOS capability requires macOS" };
  try {
    const result = await captureCommand("xcrun", ["--find", "devicectl"]);
    return { ok: true, message: "CoreDevice tooling is present", details: { devicectl: result.stdout.trim() } };
  } catch (error) {
    return { ok: false, message: `CoreDevice tooling is unavailable: ${error.message}` };
  }
}

function capabilityLaunchersReady(capability, launchers) {
  if (capability === "browser") return typeof launchers.browse === "string";
  if (capability === "design") return typeof launchers["gstack-design"] === "string";
  if (capability === "pdf") return typeof launchers["make-pdf"] === "string";
  if (capability === "diagram") return true;
  if (capability === "ios") {
    return typeof launchers["gstack-ios-qa-daemon"] === "string" &&
      typeof launchers["gstack-ios-qa-mint"] === "string";
  }
  return false;
}

async function inspectLauncherNode(command) {
  try {
    const result = await captureCommand(command, ["--version"]);
    const raw = `${result.stdout}${result.stderr}`.trim();
    const major = Number(raw.match(/v?(\d+)\./)?.[1]);
    if (!Number.isInteger(major) || major < 18) {
      return { ok: false, message: `Node 18+ is required by launchers; ${command} reported ${raw || "an unknown version"}` };
    }
    return { ok: true, message: `Launcher Node ${raw.replace(/^v/, "")}`, details: { command } };
  } catch (error) {
    return {
      ok: false,
      message: `Node 18+ launcher runtime is unavailable: ${error.message}`,
      details: { command, code: error.code },
    };
  }
}

function captureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(`${command} --version exited with ${code}`);
        error.code = "NODE_UNAVAILABLE";
        reject(error);
      }
    });
  });
}

export function formatDoctor(report) {
  const symbol = { pass: "OK", warn: "WARN", fail: "FAIL" };
  const lines = [`gstack doctor: ${report.ok ? "healthy" : "needs attention"}`, `home: ${report.home}`];
  for (const check of report.checks) lines.push(`${symbol[check.status]}  ${check.id}: ${check.message}`);
  return `${lines.join("\n")}\n`;
}

export function formatCapabilityReadiness(report) {
  const lines = [
    `gstack capability readiness: ${report.capability}`,
    `judgment: ${report.judgment.status}`,
    `platform: ${report.platform.status}`,
    `preview consent: ${report.consent.preview.status}`,
    `install consent: ${report.consent.install.status}`,
    `readiness: ${report.readiness.status}`,
    `next: ${report.nextAction}`,
  ];
  return `${lines.join("\n")}\n`;
}
