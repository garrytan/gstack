import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, readJson, withLock } from "./storage.js";
import { resolveRuntimePaths } from "./paths.js";
import { BROWSER_PROVIDERS } from "./browser-choice.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 2,
  network: Object.freeze({ mode: "off", consent: false, selection: null }),
  context: Object.freeze({
    baseUrl: "https://api.context.dev/v1",
    validation: Object.freeze({ status: "unverified", checkedAt: null }),
  }),
  browser: Object.freeze({ provider: null, executablePath: null }),
  cleanup: Object.freeze({ retentionDays: 30 }),
});

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const COHERENT_NETWORK_CHOICES = new Set([
  "context:true:context",
  "host:false:host",
  "local-browser:false:local-browser",
  "off:false:none",
]);

export async function ensureConfig(home) {
  const paths = resolveRuntimePaths({ home });
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  return withLock(path.join(paths.locks, "config.lock"), async () => {
    let config = await readJson(paths.config, null);
    if (!config) {
      config = mergeDefaults(await readLegacyConfig(home));
      validateConfig(config);
      await atomicWriteJson(paths.config, config, { mode: 0o644 });
    }
    let secrets = await readJson(paths.secrets, null);
    if (!secrets) {
      secrets = { schemaVersion: 2, context: {} };
      await atomicWriteJson(paths.secrets, secrets, { mode: 0o600 });
    } else {
      await fs.chmod(paths.secrets, 0o600);
    }
    return { config, secrets };
  });
}

/** Read-only migration input. config.json remains the sole write authority. */
export async function readLegacyConfig(home) {
  const legacyPath = path.join(home, "config.yaml");
  const content = await fs.readFile(legacyPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+(?:@[a-f0-9]+)?):\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;
    const raw = unquoteLegacyScalar(match[2]);
    result[match[1]] = parseConfigValue(raw);
  }
  return result;
}

function unquoteLegacyScalar(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}

export async function loadConfig(home) {
  const paths = resolveRuntimePaths({ home });
  const stored = await readJson(paths.config, null);
  return stored ? mergeDefaults(stored) : cloneDefaultConfig();
}

export async function loadSecrets(home, options = {}) {
  const paths = resolveRuntimePaths({ home });
  try {
    const stat = await fs.stat(paths.secrets);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      if (options.repairPermissions) await fs.chmod(paths.secrets, 0o600);
      else {
        const error = new Error(`Secrets file permissions must be 0600: ${paths.secrets}`);
        error.code = "INSECURE_SECRETS";
        throw error;
      }
    }
    return await readJson(paths.secrets, { schemaVersion: 2, context: {} });
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 2, context: {} };
    throw error;
  }
}

export async function configGet(home, key) {
  const config = await loadConfig(home);
  if (!key) return config;
  return getPath(config, key);
}

export async function configSet(home, key, value) {
  if (!key) throw new TypeError("A config key is required");
  if (looksLikeSecretKey(key)) {
    const error = new Error("Secrets cannot be stored in config.json; use `gstack context setup`");
    error.code = "SECRET_IN_CONFIG";
    throw error;
  }
  return updateConfig(home, (config) => {
    setPath(config, key, value);
    return getPath(config, key);
  });
}

/** Persist the complete network choice in one locked atomic replacement. */
export async function configSetNetworkChoice(home, choice) {
  const keys = Object.keys(choice ?? {}).sort();
  if (keys.join(",") !== "consent,mode,selection") {
    throw new TypeError("A network choice requires mode, consent, and selection");
  }
  const signature = `${choice.mode}:${choice.consent}:${choice.selection}`;
  if (!COHERENT_NETWORK_CHOICES.has(signature)) {
    throw new TypeError("Network mode, consent, and selection must describe one coherent choice");
  }
  return updateConfig(home, (config) => {
    config.network = { ...config.network, ...choice };
    return { ...config.network };
  });
}

/** Persist one coherent browser-engine choice or clear it atomically. */
export async function configSetBrowserChoice(home, choice) {
  const normalized = choice == null
    ? { provider: null, executablePath: null }
    : { provider: choice.provider, executablePath: choice.executablePath ?? null };
  validateBrowserChoice(normalized);
  return updateConfig(home, (config) => {
    config.browser = normalized;
    return { ...config.browser };
  });
}

async function updateConfig(home, mutate) {
  const paths = resolveRuntimePaths({ home });
  return withLock(path.join(paths.locks, "config.lock"), async () => {
    const config = mergeDefaults(await readJson(paths.config, cloneDefaultConfig()));
    const result = mutate(config);
    validateConfig(config);
    await atomicWriteJson(paths.config, config, { mode: 0o644 });
    return result;
  });
}

function looksLikeSecretKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1.$2");
  return normalized.split(/[.\-_]/).some((segment) =>
    /^(key|apikey|api.?key|secret|token|jwt|session|cookie|access.?token|refresh.?token|password|passwd|credential|credentials|authorization|bearer)$/i.test(segment),
  ) || /api[._-]?key|access[._-]?token|refresh[._-]?token/i.test(String(key));
}

export async function secretSet(home, key, value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Secret value is required");
  const paths = resolveRuntimePaths({ home });
  return withLock(path.join(paths.locks, "config.lock"), async () => {
    const secrets = await readJson(paths.secrets, { schemaVersion: 2, context: {} });
    setPath(secrets, key, value);
    await atomicWriteJson(paths.secrets, secrets, { mode: 0o600 });
  });
}

export function parseConfigValue(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function getPath(object, dotted) {
  return splitKey(dotted).reduce((value, segment) => value?.[segment], object);
}

export function setPath(object, dotted, value) {
  const parts = splitKey(dotted);
  let cursor = object;
  for (const segment of parts.slice(0, -1)) {
    if (!cursor[segment] || typeof cursor[segment] !== "object" || Array.isArray(cursor[segment])) {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  cursor[parts.at(-1)] = value;
}

function splitKey(dotted) {
  if (typeof dotted !== "string" || !dotted) throw new TypeError("Config key is required");
  const parts = dotted.split(".");
  if (parts.some((part) => !part || FORBIDDEN_SEGMENTS.has(part))) throw new TypeError("Invalid config key");
  return parts;
}

function validateConfig(config) {
  if (config.network?.mode != null && !["off", "context", "host", "local-browser"].includes(config.network.mode)) {
    throw new TypeError("network.mode must be `off`, `context`, `host`, or `local-browser`");
  }
  if (config.network?.consent != null && typeof config.network.consent !== "boolean") {
    throw new TypeError("network.consent must be a boolean");
  }
  if (config.network?.selection != null && !["context", "host", "local-browser", "none"].includes(config.network.selection)) {
    throw new TypeError("network.selection must be `context`, `host`, `local-browser`, `none`, or null");
  }
  if (config.context?.baseUrl != null) {
    const url = new URL(config.context.baseUrl);
    if (url.origin !== "https://api.context.dev" || !["/v1", "/v1/"].includes(url.pathname) ||
        url.search || url.hash || url.username || url.password) {
      throw new TypeError("context.baseUrl must be the official credential-free Context.dev v1 HTTPS endpoint");
    }
  }
  if (config.context?.validation != null) {
    if (!["verified", "unverified"].includes(config.context.validation.status)) {
      throw new TypeError("context.validation.status must be `verified` or `unverified`");
    }
    if (config.context.validation.checkedAt != null &&
        !Number.isFinite(Date.parse(config.context.validation.checkedAt))) {
      throw new TypeError("context.validation.checkedAt must be an ISO timestamp or null");
    }
  }
  validateBrowserChoice(config.browser ?? { provider: null, executablePath: null });
}

function validateBrowserChoice(browser) {
  if (browser == null || typeof browser !== "object" || Array.isArray(browser)) {
    throw new TypeError("browser must be an object");
  }
  const keys = Object.keys(browser).sort();
  if (keys.join(",") !== "executablePath,provider") {
    throw new TypeError("browser requires exactly provider and executablePath");
  }
  if (browser.provider == null) {
    if (browser.executablePath != null) throw new TypeError("An unselected browser cannot have an executable path");
    return;
  }
  if (!BROWSER_PROVIDERS.includes(browser.provider)) {
    throw new TypeError("browser.provider must be `managed`, `installed`, or null");
  }
  if (browser.provider === "managed" && browser.executablePath != null) {
    throw new TypeError("Managed Chromium cannot have an installed executable path");
  }
  if (browser.provider === "installed" &&
      (typeof browser.executablePath !== "string" || !path.isAbsolute(browser.executablePath))) {
    throw new TypeError("An installed browser requires an absolute executable path");
  }
}

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function mergeDefaults(stored) {
  return {
    ...cloneDefaultConfig(),
    ...stored,
    network: { ...DEFAULT_CONFIG.network, ...(stored.network ?? {}) },
    context: { ...DEFAULT_CONFIG.context, ...(stored.context ?? {}) },
    browser: { ...DEFAULT_CONFIG.browser, ...(stored.browser ?? {}) },
    cleanup: { ...DEFAULT_CONFIG.cleanup, ...(stored.cleanup ?? {}) },
  };
}
