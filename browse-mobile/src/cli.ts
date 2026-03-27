/**
 * browse-mobile CLI
 *
 * Same lifecycle pattern as browse/src/cli.ts:
 * - Read state file → check server health → send command
 * - If no server → start one → wait for state file → send command
 */

import * as fs from "fs";
import * as path from "path";
import { execSync, spawn } from "child_process";

// ─── Configuration ───

interface Config {
  stateFile: string;
  lockFile: string;
  maxStartWait: number; // ms
}

function getConfig(): Config {
  const projectRoot = findProjectRoot();
  const gstackDir = path.join(projectRoot, ".gstack");

  return {
    stateFile: path.join(gstackDir, "browse-mobile.json"),
    lockFile: path.join(gstackDir, "browse-mobile.json.lock"),
    maxStartWait: 30000, // 30s — Appium is slow to start
  };
}

function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// ─── State File ───

interface ServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  serverPath: string;
}

function readState(config: Config): ServerState | null {
  try {
    const raw = fs.readFileSync(config.stateFile, "utf-8");
    return JSON.parse(raw) as ServerState;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we don't have permission — still alive
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

// ─── Lockfile ───

function acquireLock(config: Config): (() => void) | null {
  try {
    const fd = fs.openSync(
      config.lockFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    );
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    return () => {
      try {
        fs.unlinkSync(config.lockFile);
      } catch {
        /* ignore */
      }
    };
  } catch {
    return null;
  }
}

// ─── Setup Check ───

interface CheckResult {
  name: string;
  ok: boolean;
  version?: string;
  error?: string;
  fix?: string;
}

function runSetupCheck(): CheckResult[] {
  const results: CheckResult[] = [];

  // Java
  try {
    const output = execSync("java -version 2>&1", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const match = output.match(/version "(\d+)/);
    const version = match ? parseInt(match[1], 10) : 0;
    if (version >= 17) {
      results.push({
        name: "Java 17+",
        ok: true,
        version: match ? match[0] : "found",
      });
    } else {
      results.push({
        name: "Java 17+",
        ok: false,
        version: `${version}`,
        error: `Java ${version} found, need 17+`,
        fix: "brew install openjdk@17",
      });
    }
  } catch {
    results.push({
      name: "Java 17+",
      ok: false,
      error: "Java not found",
      fix: "brew install openjdk@17",
    });
  }

  // JAVA_HOME
  if (process.env.JAVA_HOME) {
    results.push({
      name: "JAVA_HOME",
      ok: true,
      version: process.env.JAVA_HOME,
    });
  } else {
    results.push({
      name: "JAVA_HOME",
      ok: false,
      error: "JAVA_HOME not set",
      fix: 'export JAVA_HOME=$(/usr/libexec/java_home) # add to ~/.zshrc',
    });
  }

  // Appium
  try {
    const output = execSync("appium --version", {
      encoding: "utf-8",
      timeout: 5000,
    });
    results.push({
      name: "Appium",
      ok: true,
      version: output.trim(),
    });
  } catch {
    results.push({
      name: "Appium",
      ok: false,
      error: "Appium not found",
      fix: "npm install -g appium",
    });
  }

  // xcuitest driver
  try {
    const output = execSync("appium driver list --installed 2>&1", {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (output.includes("xcuitest")) {
      results.push({ name: "xcuitest driver", ok: true, version: "installed" });
    } else {
      results.push({
        name: "xcuitest driver",
        ok: false,
        error: "xcuitest driver not installed",
        fix: "appium driver install xcuitest",
      });
    }
  } catch {
    results.push({
      name: "xcuitest driver",
      ok: false,
      error: "Could not check Appium drivers (is Appium installed?)",
      fix: "npm install -g appium && appium driver install xcuitest",
    });
  }

  // Xcode CLI tools
  try {
    execSync("xcode-select -p", { stdio: "pipe", timeout: 5000 });
    results.push({ name: "Xcode CLI Tools", ok: true });
  } catch {
    results.push({
      name: "Xcode CLI Tools",
      ok: false,
      error: "Xcode CLI tools not found",
      fix: "xcode-select --install",
    });
  }

  return results;
}

function printSetupCheck(): void {
  const results = runSetupCheck();
  const allOk = results.every((r) => r.ok);

  console.log("browse-mobile setup check\n");

  for (const r of results) {
    const status = r.ok ? "OK" : "MISSING";
    const icon = r.ok ? "+" : "x";
    let line = `  [${icon}] ${r.name}: ${status}`;
    if (r.version) line += ` (${r.version})`;
    if (r.error) line += ` — ${r.error}`;
    console.log(line);
    if (r.fix && !r.ok) {
      console.log(`      Fix: ${r.fix}`);
    }
  }

  console.log("");
  if (allOk) {
    console.log("All dependencies satisfied. Ready to use browse-mobile.");
  } else {
    console.log(
      "Some dependencies are missing. Install them and run setup-check again."
    );
    process.exit(1);
  }
}

// ─── Server Lifecycle ───

async function startServer(config: Config, bundleId?: string): Promise<ServerState> {
  const releaseLock = acquireLock(config);
  if (!releaseLock) {
    // Another process is starting the server — wait for it
    const start = Date.now();
    while (Date.now() - start < config.maxStartWait) {
      await new Promise((r) => setTimeout(r, 200));
      const state = readState(config);
      if (state && isPidAlive(state.pid)) {
        return state;
      }
    }
    throw new Error("Timed out waiting for another process to start the server");
  }

  try {
    // Ensure .gstack directory exists
    const dir = path.dirname(config.stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Spawn ourselves in server mode (--server flag runs the server in-process)
    // Use the bundled JS file (browse-mobile/dist/cli.js) with bun, or source .ts in dev
    const bundlePath = path.join(path.dirname(process.argv[1] || __filename), "../dist/cli.js");
    const sourcePath = path.join(path.dirname(process.argv[1] || __filename), "cli.ts");

    let serverCmd: string;
    let serverArgs: string[];

    if (fs.existsSync(bundlePath)) {
      // Production: run the bundled JS with bun
      serverCmd = "bun";
      serverArgs = ["run", bundlePath, "--server"];
    } else if (fs.existsSync(sourcePath)) {
      // Dev: run source directly
      serverCmd = "bun";
      serverArgs = ["run", sourcePath, "--server"];
    } else {
      // Fallback: try running ourselves (compiled binary case)
      serverCmd = process.argv[0];
      serverArgs = process.argv[1]?.endsWith(".ts")
        ? [process.argv[1], "--server"]
        : ["--server"];
    }

    const child = spawn(serverCmd, serverArgs, {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        BROWSE_MOBILE_STATE_FILE: config.stateFile,
        ...(bundleId ? { BROWSE_MOBILE_BUNDLE_ID: bundleId } : {}),
      },
    });
    child.unref();

    // Wait for state file to appear
    const start = Date.now();
    while (Date.now() - start < config.maxStartWait) {
      await new Promise((r) => setTimeout(r, 100));
      const state = readState(config);
      if (state && isPidAlive(state.pid)) {
        return state;
      }
    }

    throw new Error(
      `Server failed to start within ${config.maxStartWait / 1000}s. Check Appium installation: browse-mobile setup-check`
    );
  } finally {
    releaseLock();
  }
}


async function ensureServer(config: Config, bundleId?: string): Promise<ServerState> {
  // Check existing state
  const state = readState(config);
  if (state && isPidAlive(state.pid)) {
    // Health check
    try {
      const res = await fetch(`http://127.0.0.1:${state.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      const data = (await res.json()) as { status: string };
      if (data.status === "healthy" || data.status === "unhealthy") {
        return state; // Server is responding (may be waiting for Appium)
      }
    } catch {
      // Server not responding — kill and restart
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }
  }

  return startServer(config, bundleId);
}

async function sendCommand(
  state: ServerState,
  command: string,
  args: string[]
): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/command`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command, args }),
      // First command (goto) may trigger Appium connection + WDA build (~60-120s)
      signal: AbortSignal.timeout(command === "goto" ? 180000 : 60000),
    });

    if (res.status === 401) {
      console.error("Auth failed — server may have restarted. Try again.");
      process.exit(1);
    }

    const text = await res.text();

    if (res.ok) {
      console.log(text);
    } else {
      try {
        const err = JSON.parse(text) as { error: string; hint?: string };
        console.error(`Error: ${err.error}`);
        if (err.hint) console.error(`Hint: ${err.hint}`);
      } catch {
        console.error(text);
      }
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("Command timed out after 30s");
    } else {
      console.error(
        `Connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    process.exit(1);
  }
}

// ─── Main ───

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle --server mode: run the server in-process (used when binary spawns itself)
  if (args[0] === "--server") {
    await import("./server");
    return;
  }

  // Handle setup-check subcommand
  if (args[0] === "setup-check") {
    printSetupCheck();
    return;
  }

  // Handle help
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    console.log(`browse-mobile — Appium-backed mobile automation for gstack

Usage:
  browse-mobile <command> [args...]
  browse-mobile setup-check          Check dependencies

Commands:
  goto <app://bundle.id>    Launch app or deep link
  click <@e1>               Tap element by ref
  click label:Sign In       Tap by accessibility label
  tap <x> <y>               Tap at coordinates
  fill <@e1> <text>         Type into input field
  snapshot [-i] [-D] [-a]   Get accessibility tree with refs
  screenshot <path>         Save screenshot
  text                      Extract visible text
  scroll [up|down|left|right]
  back                      Device back button
  viewport <landscape|portrait>
  links                     List tappable elements
  forms                     List input fields
  status                    Server status
  stop                      Stop server

Examples:
  browse-mobile goto app://com.example.myapp
  browse-mobile snapshot -i
  browse-mobile click @e3
  browse-mobile click label:Sign In
  browse-mobile tap 195 750
  browse-mobile screenshot /tmp/screen.png`);
    return;
  }

  const config = getConfig();
  const command = args[0];
  const commandArgs = args.slice(1);

  // Extract bundle ID from goto app:// commands to pass to server
  let bundleId = process.env.BROWSE_MOBILE_BUNDLE_ID || "";
  if (command === "goto" && commandArgs[0]?.startsWith("app://")) {
    bundleId = commandArgs[0].replace("app://", "");
  }

  const state = await ensureServer(config, bundleId);
  await sendCommand(state, command, commandArgs);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
