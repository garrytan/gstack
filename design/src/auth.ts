/**
 * Auth resolution for OpenAI API access.
 *
 * Resolution order:
 * 1. ~/.gstack/openai.json → { "api_key": "sk-..." }
 * 2. OPENAI_API_KEY environment variable
 * 3. null (caller handles guided setup or fallback)
 */

import fs from "fs";
import path from "path";

type ApiKeySource = "config" | "env";

export interface ApiKeyResolution {
  key: string;
  source: ApiKeySource;
  envFile?: string;
  warning?: string;
}

function configPath(): string {
  return path.join(process.env.HOME || "~", ".gstack", "openai.json");
}

function readEnvValue(filePath: string, key: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)\\s*$`));
    if (!match) continue;

    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }

  return null;
}

function matchingCwdEnvFile(key: string, value: string): string | null {
  const candidates = [".env"];
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv) candidates.push(`.env.${nodeEnv}`);
  candidates.push(".env.local");

  for (const fileName of candidates) {
    const fileValue = readEnvValue(path.join(process.cwd(), fileName), key);
    if (fileValue === value) return fileName;
  }

  return null;
}

export function resolveApiKeyInfo(): ApiKeyResolution | null {
  // 1. Check ~/.gstack/openai.json
  try {
    const authPath = configPath();
    if (fs.existsSync(authPath)) {
      const content = fs.readFileSync(authPath, "utf-8");
      const config = JSON.parse(content);
      if (config.api_key && typeof config.api_key === "string") {
        return { key: config.api_key, source: "config" };
      }
    }
  } catch {
    // Fall through to env var
  }

  // 2. Check environment variable
  if (process.env.OPENAI_API_KEY) {
    const envFile = matchingCwdEnvFile("OPENAI_API_KEY", process.env.OPENAI_API_KEY);
    const warning = envFile
      ? `Warning: OPENAI_API_KEY matches ${envFile} in the current directory. Design generation may bill that project's OpenAI account. Run $D setup to store a gstack-specific key in ~/.gstack/openai.json.`
      : undefined;
    return { key: process.env.OPENAI_API_KEY, source: "env", envFile: envFile ?? undefined, warning };
  }

  return null;
}

export function resolveApiKey(): string | null {
  return resolveApiKeyInfo()?.key ?? null;
}

export function describeApiKeySource(resolution: ApiKeyResolution): string {
  if (resolution.source === "config") return "~/.gstack/openai.json";
  if (resolution.envFile) return `OPENAI_API_KEY environment variable (matches ${resolution.envFile} in current directory)`;
  return "OPENAI_API_KEY environment variable";
}

/**
 * Save an API key to ~/.gstack/openai.json with 0600 permissions.
 */
export function saveApiKey(key: string): void {
  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ api_key: key }, null, 2));
  fs.chmodSync(configPath(), 0o600);
}

/**
 * Get API key or exit with setup instructions.
 */
export function requireApiKey(): string {
  const resolution = resolveApiKeyInfo();
  if (!resolution) {
    console.error("No OpenAI API key found.");
    console.error("");
    console.error("Run: $D setup");
    console.error("  or save to ~/.gstack/openai.json: { \"api_key\": \"sk-...\" }");
    console.error("  or set OPENAI_API_KEY environment variable");
    console.error("");
    console.error("Get a key at: https://platform.openai.com/api-keys");
    process.exit(1);
  }
  console.error(`Using OpenAI key from ${describeApiKeySource(resolution)}.`);
  if (resolution.warning) console.error(resolution.warning);
  return resolution.key;
}
