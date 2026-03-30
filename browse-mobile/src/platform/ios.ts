/**
 * iOS Simulator platform utilities
 */

import { execSync } from "child_process";

/** Validate a string is a safe shell argument (no injection) */
function assertSafeShellArg(value: string, name: string): void {
  if (/[;&|`$"'\\<>(){}\n\r]/.test(value)) {
    throw new Error(`Unsafe ${name}: contains shell metacharacters`);
  }
}

export interface SimulatorDevice {
  udid: string;
  name: string;
  state: "Booted" | "Shutdown";
  runtime: string;
}

/**
 * List available iOS Simulator devices
 */
export function listDevices(): SimulatorDevice[] {
  try {
    const output = execSync("xcrun simctl list devices available -j", {
      encoding: "utf-8",
      timeout: 10000,
    });
    const data = JSON.parse(output);
    const devices: SimulatorDevice[] = [];

    for (const [runtime, devs] of Object.entries(data.devices || {})) {
      if (!Array.isArray(devs)) continue;
      for (const dev of devs as Array<{
        udid: string;
        name: string;
        state: string;
      }>) {
        devices.push({
          udid: dev.udid,
          name: dev.name,
          state: dev.state as SimulatorDevice["state"],
          runtime: runtime.replace(
            /^com\.apple\.CoreSimulator\.SimRuntime\./,
            ""
          ),
        });
      }
    }

    return devices;
  } catch {
    return [];
  }
}

/**
 * Get the first booted simulator, or boot one if none are running
 */
export function ensureBootedSimulator(): SimulatorDevice | null {
  const devices = listDevices();

  // Prefer already booted
  const booted = devices.find((d) => d.state === "Booted");
  if (booted) return booted;

  // Find an iPhone to boot (prefer recent models)
  const iphones = devices
    .filter((d) => d.name.includes("iPhone") && d.state === "Shutdown")
    .sort((a, b) => {
      // Sort by name descending to get newest models first
      return b.name.localeCompare(a.name);
    });

  const target = iphones[0] || devices[0];
  if (!target) return null;

  try {
    assertSafeShellArg(target.udid, "simulator UDID");
    execSync(`xcrun simctl boot "${target.udid}"`, {
      timeout: 30000,
      stdio: "pipe",
    });
    return { ...target, state: "Booted" };
  } catch (err) {
    // May already be booted
    const msg =
      err instanceof Error ? err.message : String(err);
    if (msg.includes("current state: Booted")) {
      return { ...target, state: "Booted" };
    }
    return null;
  }
}

/**
 * Get the bundle ID from an Expo app.json or app.config.js
 */
export function detectBundleId(projectDir: string): string | null {
  try {
    // Try app.json first
    const { readFileSync } = require("fs");
    const { join } = require("path");

    for (const configFile of ["app.json", "app.config.json"]) {
      try {
        const raw = readFileSync(join(projectDir, configFile), "utf-8");
        const config = JSON.parse(raw);
        const expo = config.expo || config;
        return expo.ios?.bundleIdentifier || expo.slug || null;
      } catch {
        continue;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Check if Xcode command line tools are available
 */
export function hasXcodeTools(): boolean {
  try {
    execSync("xcode-select -p", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate an app on the simulator
 */
export function terminateApp(bundleId: string): void {
  try {
    assertSafeShellArg(bundleId, "bundle ID");
    execSync(`xcrun simctl terminate booted "${bundleId}"`, {
      stdio: "pipe",
      timeout: 10000,
    });
  } catch {
    // App may not be running
  }
}

/**
 * Shutdown the simulator
 */
export function shutdownSimulator(udid?: string): void {
  try {
    const target = udid || "booted";
    if (udid) assertSafeShellArg(udid, "simulator UDID");
    execSync(`xcrun simctl shutdown "${target}"`, {
      stdio: "pipe",
      timeout: 15000,
    });
  } catch {
    // May already be shutdown
  }
}
