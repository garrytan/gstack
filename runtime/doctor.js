import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { resolveRuntimePaths } from "./paths.js";
import { readJson, pathExists } from "./storage.js";
import { discoverProjectIdentity } from "./identity.js";
import { RUNTIME_SCHEMA_VERSION, RUNTIME_MIGRATION_ID } from "./migrations.js";
import { assertManagedHome } from "./managed-home.js";
import { recoverPendingUpgrade } from "./upgrade.js";

export async function runDoctor(options = {}) {
  const paths = resolveRuntimePaths(options);
  const checks = [];
  const add = (id, status, message, details) => checks.push({ id, status, message, ...(details ? { details } : {}) });
  const now = options.now ? options.now() : new Date();

  const node = await inspectLauncherNode(options.nodeCommand ?? process.env.GSTACK_NODE ?? "node");
  add("runtime", node.ok ? "pass" : "fail", node.message, node.details);

  if (!(await pathExists(paths.home))) {
    add("home", "fail", `State home does not exist: ${paths.home}`, { remedy: "Run `gstack setup`." });
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
        remedy: "Run `gstack setup` with the intended GSTACK_HOME.",
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
      add("project", "warn", `No state initialized for ${identity.projectId}`, { remedy: "Run `gstack setup`." });
    }
    add("git", identity.isGit ? "pass" : "warn",
      identity.isGit ? `Git worktree ${identity.worktreeId}` : "Current directory is not a Git worktree");
  } catch (error) {
    add("project", "fail", `Project identity failed: ${error.message}`);
  }

  try {
    const recovery = await recoverPendingUpgrade(paths.home, options);
    const pointer = recovery.pointer;
    if (!pointer) add("upgrade", "pass", "No managed version pointer (package-managed install)");
    else if (recovery.recovered) {
      add("upgrade", pointer.current ? "warn" : "fail", pointer.current
        ? `Recovered interrupted upgrade to last-known-good version: ${pointer.current}`
        : "Interrupted upgrade had no valid last-known-good version");
    } else add("upgrade", "pass", pointer.current ? `Active managed version: ${pointer.current}` : "No active managed version");
  } catch (error) {
    add("upgrade", "fail", `Version pointer cannot be read: ${error.message}`);
  }

  return {
    ok: !checks.some((check) => check.status === "fail"),
    home: paths.home,
    checkedAt: now.toISOString(),
    checks,
  };
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

function captureCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
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
