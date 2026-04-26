/**
 * Auth resolution for image generation API access.
 *
 * Supports multiple providers:
 * - openai: GPT Image 1.5 (default, best text rendering for UI mockups)
 * - gemini: Nano Banana 2 / Gemini 3.1 Flash Image (fast, good quality)
 *
 * Provider resolution:
 * 1. ~/.gstack/design.json → { "provider": "openai"|"gemini", "openai_key": "...", "gemini_key": "..." }
 * 2. Environment variables: OPENAI_API_KEY, GEMINI_API_KEY
 * 3. Legacy ~/.gstack/openai.json → { "api_key": "sk-..." }
 * 4. Auto-detect: whichever key is available
 */

import fs from "fs";
import path from "path";

export type Provider = "openai" | "gemini";

export interface ProviderConfig {
  provider: Provider;
  apiKey: string;
}

const DESIGN_CONFIG_PATH = path.join(process.env.HOME || "~", ".gstack", "design.json");
const LEGACY_CONFIG_PATH = path.join(process.env.HOME || "~", ".gstack", "openai.json");

function readDesignConfig(): Record<string, string> | null {
  try {
    if (fs.existsSync(DESIGN_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(DESIGN_CONFIG_PATH, "utf-8"));
    }
  } catch { /* fall through */ }
  return null;
}

function readLegacyConfig(): string | null {
  try {
    if (fs.existsSync(LEGACY_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, "utf-8"));
      if (config.api_key && typeof config.api_key === "string") {
        return config.api_key;
      }
    }
  } catch { /* fall through */ }
  return null;
}

export function resolveProvider(): ProviderConfig | null {
  // 1. Check ~/.gstack/design.json (new multi-provider config)
  const config = readDesignConfig();
  if (config) {
    const provider = (config.provider || "openai") as Provider;
    if (provider === "gemini") {
      const key = config.gemini_key || process.env.GEMINI_API_KEY;
      if (key) return { provider: "gemini", apiKey: key };
    } else {
      const key = config.openai_key || process.env.OPENAI_API_KEY;
      if (key) return { provider: "openai", apiKey: key };
    }
  }

  // 2. Check environment variables (auto-detect provider)
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY) {
    return { provider: "gemini", apiKey: (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY)! };
  }

  // 3. Legacy ~/.gstack/openai.json
  const legacyKey = readLegacyConfig();
  if (legacyKey) {
    return { provider: "openai", apiKey: legacyKey };
  }

  return null;
}

/** Backwards-compatible: resolve just the API key (for check.ts, evolve.ts) */
export function resolveApiKey(): string | null {
  const config = resolveProvider();
  return config?.apiKey ?? null;
}

/**
 * Save provider config to ~/.gstack/design.json with 0600 permissions.
 */
export function saveProviderConfig(provider: Provider, key: string): void {
  const dir = path.dirname(DESIGN_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const existing = readDesignConfig() || {};
  if (provider === "openai") existing.openai_key = key;
  if (provider === "gemini") existing.gemini_key = key;
  existing.provider = provider;
  fs.writeFileSync(DESIGN_CONFIG_PATH, JSON.stringify(existing, null, 2));
  fs.chmodSync(DESIGN_CONFIG_PATH, 0o600);
}

/** Legacy compat */
export function saveApiKey(key: string): void {
  saveProviderConfig("openai", key);
}

/**
 * Get provider config or exit with setup instructions.
 */
export function requireProvider(): ProviderConfig {
  const config = resolveProvider();
  if (!config) {
    console.error("No API key found for image generation.");
    console.error("");
    console.error("Option 1 — OpenAI (best text rendering for UI mockups):");
    console.error("  echo '{\"provider\":\"openai\",\"openai_key\":\"sk-...\"}' > ~/.gstack/design.json");
    console.error("  or set OPENAI_API_KEY environment variable");
    console.error("");
    console.error("Option 2 — Gemini (fast, good quality, cheaper):");
    console.error("  echo '{\"provider\":\"gemini\",\"gemini_key\":\"...\"}' > ~/.gstack/design.json");
    console.error("  or set GEMINI_API_KEY environment variable");
    console.error("");
    console.error("Get keys at:");
    console.error("  OpenAI: https://platform.openai.com/api-keys");
    console.error("  Gemini: https://aistudio.google.com/apikey");
    process.exit(1);
  }
  return config;
}

/** Legacy compat */
export function requireApiKey(): string {
  return requireProvider().apiKey;
}
