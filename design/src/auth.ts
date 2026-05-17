/**
 * Auth resolution for OpenAI API access.
 *
 * Resolution order:
 * 1. ~/.gstack/openai.json → { "api_key": "sk-..." }
 * 2. OPENAI_API_KEY environment variable
 * 3. ~/.gstack/minimax.json → { "api_key": "sk-cp-..." }
 * 4. null (caller handles guided setup or fallback)
 */

import fs from "fs";
import path from "path";

const OPENAI_CONFIG_PATH = path.join(process.env.HOME || "~", ".gstack", "openai.json");
const MINIMAX_CONFIG_PATH = path.join(process.env.HOME || "~", ".gstack", "minimax.json");

export function resolveApiKey(): string | null {
  // 1. Check ~/.gstack/openai.json
  try {
    if (fs.existsSync(OPENAI_CONFIG_PATH)) {
      const content = fs.readFileSync(OPENAI_CONFIG_PATH, "utf-8");
      const config = JSON.parse(content);
      if (config.api_key && typeof config.api_key === "string") {
        return config.api_key;
      }
    }
  } catch {
    // Fall through to env var
  }

  // 2. Check environment variable
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  return null;
}

/**
 * Check if MINIMAX_API_KEY is available (for MiniMax image generation).
 */
export function resolveMiniMaxApiKey(): string | null {
  if (process.env.MINIMAX_API_KEY) {
    return process.env.MINIMAX_API_KEY;
  }
  try {
    if (fs.existsSync(MINIMAX_CONFIG_PATH)) {
      const content = fs.readFileSync(MINIMAX_CONFIG_PATH, "utf-8");
      const config = JSON.parse(content);
      if (config.api_key && typeof config.api_key === "string") {
        return config.api_key;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Save an API key to ~/.gstack/openai.json with 0600 permissions.
 */
export function saveApiKey(key: string): void {
  const dir = path.dirname(OPENAI_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OPENAI_CONFIG_PATH, JSON.stringify({ api_key: key }, null, 2));
  fs.chmodSync(OPENAI_CONFIG_PATH, 0o600);
}

/**
 * Get API key or exit with setup instructions.
 */
export function requireApiKey(): string {
  const key = resolveApiKey();
  if (!key) {
    console.error("No OpenAI API key found.");
    console.error("");
    console.error("Run: $D setup");
    console.error("  or save to ~/.gstack/openai.json: { \"api_key\": \"sk-...\" }");
    console.error("  or set OPENAI_API_KEY environment variable");
    console.error("  or save to ~/.gstack/minimax.json: { \"api_key\": \"sk-cp-...\" }");
    console.error("");
    console.error("Get a key at: https://platform.openai.com/api-keys");
    process.exit(1);
  }
  return key;
}
