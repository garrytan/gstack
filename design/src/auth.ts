/**
 * Auth resolution for Gemini API access.
 *
 * Resolution order:
 * 1. ~/.gstack/gemini.json → { "api_key": "..." }
 * 2. GEMINI_API_KEY environment variable
 * 3. null (caller handles guided setup or fallback)
 */

import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.env.HOME || "~", ".gstack", "gemini.json");

export function resolveApiKey(): string | null {
  // 1. Check ~/.gstack/gemini.json
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, "utf-8");
      const config = JSON.parse(content);
      if (config.api_key && typeof config.api_key === "string") {
        return config.api_key;
      }
    }
  } catch {
    // Fall through to env var
  }

  // 2. Check environment variable
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }

  return null;
}

/**
 * Save an API key to ~/.gstack/gemini.json with 0600 permissions.
 */
export function saveApiKey(key: string): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ api_key: key }, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
}

/**
 * Get API key or exit with setup instructions.
 */
export function requireApiKey(): string {
  const key = resolveApiKey();
  if (!key) {
    console.error("No Gemini API key found.");
    console.error("");
    console.error("Run: $D setup");
    console.error("  or save to ~/.gstack/gemini.json: { \"api_key\": \"...\" }");
    console.error("  or set GEMINI_API_KEY environment variable");
    console.error("");
    console.error("Get a key at: https://aistudio.google.com/apikey");
    process.exit(1);
  }
  return key;
}
