/**
 * Auth resolution for OpenAI API access.
 *
 * Resolution order:
 * 1. ~/.nstack/openai.json → { "api_key": "sk-..." }
 * 2. OPENAI_API_KEY environment variable
 * 3. null (caller handles guided setup or fallback)
 */

import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.env.HOME || "~", ".nstack", "openai.json");

export function resolveApiKey(): string | null {
  // 1. Check ~/.nstack/openai.json
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
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  return null;
}

/**
 * Save an API key to ~/.nstack/openai.json with 0600 permissions.
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
    console.error("No OpenAI API key found.");
    console.error("");
    console.error("Run: $D setup");
    console.error("  or save to ~/.nstack/openai.json: { \"api_key\": \"sk-...\" }");
    console.error("  or set OPENAI_API_KEY environment variable");
    console.error("");
    console.error("Get a key at: https://platform.openai.com/api-keys");
    process.exit(1);
  }
  return key;
}
