import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BROWSER_PROVIDERS = Object.freeze(["managed", "installed"]);

const BROWSER_CAPABILITIES = new Set(["browser", "browser-visible", "diagram", "pdf"]);

const NAMED_CANDIDATES = Object.freeze({
  darwin: Object.freeze([
    ["Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    ["Google Chrome Beta", "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"],
    ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    ["Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  ]),
  win32: Object.freeze([
    ["Google Chrome", ["LOCALAPPDATA", "Google/Chrome/Application/chrome.exe"]],
    ["Google Chrome", ["PROGRAMFILES", "Google/Chrome/Application/chrome.exe"]],
    ["Google Chrome", ["PROGRAMFILES(X86)", "Google/Chrome/Application/chrome.exe"]],
    ["Microsoft Edge", ["PROGRAMFILES(X86)", "Microsoft/Edge/Application/msedge.exe"]],
    ["Microsoft Edge", ["PROGRAMFILES", "Microsoft/Edge/Application/msedge.exe"]],
    ["Brave", ["LOCALAPPDATA", "BraveSoftware/Brave-Browser/Application/brave.exe"]],
  ]),
});

const PATH_CANDIDATES = Object.freeze([
  ["Google Chrome", "google-chrome"],
  ["Google Chrome", "google-chrome-stable"],
  ["Chromium", "chromium"],
  ["Chromium", "chromium-browser"],
  ["Microsoft Edge", "microsoft-edge"],
  ["Microsoft Edge", "microsoft-edge-stable"],
  ["Brave", "brave-browser"],
]);

export function browserChoiceRequired(capabilities) {
  return capabilities.some((capability) => BROWSER_CAPABILITIES.has(capability));
}

export function assertBrowserChoiceSupportsCapabilities(choice, capabilities) {
  if (choice?.provider === "installed" && capabilities.includes("browser-visible")) {
    throw browserChoiceError(
      "Visible GStack Browser requires managed Chromium because installed Chrome-family builds can block automation extension loading; choose `managed` for this capability",
      "BROWSER_PROVIDER_UNSUPPORTED",
    );
  }
  return choice;
}

export function applyBrowserProviderToComponents(components, choice) {
  if (choice?.provider !== "installed") return Object.freeze([...components].sort());
  return Object.freeze(components
    .filter((component) => component !== "browser-headless" && component !== "browser-visible")
    .sort());
}

export async function detectInstalledBrowsers(options = {}) {
  if (Array.isArray(options.candidates)) {
    const resolved = [];
    for (const candidate of options.candidates) {
      const browser = await inspectCandidate(candidate.name, candidate.executablePath, options);
      if (browser) resolved.push(browser);
    }
    return deduplicate(resolved);
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const candidates = [];
  if (platform === "darwin") {
    for (const [name, executablePath] of NAMED_CANDIDATES.darwin) {
      candidates.push({ name, executablePath });
      candidates.push({
        name,
        executablePath: path.join(homeDir, executablePath.replace(/^\/Applications\//, "Applications/")),
      });
    }
  } else if (platform === "win32") {
    for (const [name, [variable, suffix]] of NAMED_CANDIDATES.win32) {
      const base = env[variable];
      if (base) candidates.push({ name, executablePath: path.join(base, ...suffix.split("/")) });
    }
  } else if (platform === "linux") {
    for (const [name, command] of PATH_CANDIDATES) {
      for (const directory of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
        candidates.push({ name, executablePath: path.join(directory, command) });
      }
    }
  }

  const resolved = [];
  for (const candidate of candidates) {
    const browser = await inspectCandidate(candidate.name, candidate.executablePath, options);
    if (browser) resolved.push(browser);
  }
  return deduplicate(resolved);
}

export async function resolveBrowserChoice(choice, options = {}) {
  if (!choice || !BROWSER_PROVIDERS.includes(choice.provider)) {
    throw browserChoiceError(
      "Choose a browser provider: `managed` downloads GStack's isolated Chromium, while `installed` uses an explicitly selected local Chromium executable",
      "BROWSER_CHOICE_REQUIRED",
    );
  }
  if (choice.provider === "managed") {
    if (choice.executablePath != null) {
      throw browserChoiceError("Managed Chromium cannot include an installed-browser path", "BROWSER_CHOICE_INVALID");
    }
    return Object.freeze({ provider: "managed", executablePath: null });
  }
  if (typeof choice.executablePath !== "string" || !path.isAbsolute(choice.executablePath)) {
    throw browserChoiceError("Installed browser setup requires an absolute executable path", "BROWSER_PATH_REQUIRED");
  }
  const inspected = await inspectCandidate(choice.name ?? "Installed Chromium", choice.executablePath, options);
  if (!inspected) {
    throw browserChoiceError(`Installed browser executable is unavailable or not executable: ${choice.executablePath}`, "BROWSER_PATH_INVALID");
  }
  return Object.freeze({ provider: "installed", executablePath: inspected.executablePath });
}

async function inspectCandidate(name, executablePath, options) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) return null;
  const fs_ = options.fs ?? fs;
  try {
    const invocationPath = path.resolve(executablePath);
    const physical = await fs_.realpath(invocationPath);
    const stat = await fs_.lstat(physical);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if ((options.platform ?? process.platform) !== "win32") await fs_.access(physical, fsConstants.X_OK);
    return Object.freeze({ name, executablePath: invocationPath, physicalPath: physical });
  } catch {
    return null;
  }
}

function deduplicate(candidates) {
  const seen = new Set();
  return Object.freeze(candidates.flatMap((candidate) => {
    const identity = candidate.physicalPath ?? candidate.executablePath;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [Object.freeze({ name: candidate.name, executablePath: candidate.executablePath })];
  }));
}

function browserChoiceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
