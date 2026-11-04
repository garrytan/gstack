/**
 * Auth resolution for the design binary's image providers.
 *
 * OpenAI key: ~/.gstack/openai.json → { "api_key": "sk-..." }, then OPENAI_API_KEY.
 * Gemini key: ~/.gstack/gemini.json → { "api_key": "AIza..." }, then GEMINI_API_KEY.
 *
 * Provider (resolveProvider), one fixed order: GSTACK_DESIGN_PROVIDER=openai|gemini
 * when set; else OpenAI when an OpenAI key resolves; else Gemini when a Gemini
 * key resolves; else null (caller prints the no-key error). A failure on the
 * picked provider never retries on the other one.
 *
 * When a key comes from the environment AND its value matches the same entry
 * in the current directory's .env / .env.<NODE_ENV> / .env.local, we disclose
 * the source on stderr before the run. Catches the silent-billing surface
 * reported in #1248: design generation inside someone else's project would
 * silently bill their account if their .env was loaded into the shell.
 */

import fs from "fs";
import path from "path";

type ApiKeySource = "config" | "env";

export type ProviderName = "openai" | "gemini";

export const DESIGN_PROVIDER_ENV = "GSTACK_DESIGN_PROVIDER";

/** The provider a run talks to, its key, and where that key came from (for messages; never the key). */
export interface ProviderKey {
  provider: ProviderName;
  key: string;
  source: string;
  warning?: string;
}

const PROVIDERS: Record<ProviderName, { label: string; file: string; env: string }> = {
  openai: { label: "OpenAI", file: "openai.json", env: "OPENAI_API_KEY" },
  gemini: { label: "Gemini", file: "gemini.json", env: "GEMINI_API_KEY" },
};

export interface ApiKeyResolution {
  key: string;
  source: ApiKeySource;
  envFile?: string;
  warning?: string;
}

function configPath(provider: ProviderName = "openai"): string {
  return path.join(process.env.HOME || "~", ".gstack", PROVIDERS[provider].file);
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

function resolveKeyInfo(provider: ProviderName): ApiKeyResolution | null {
  const { env } = PROVIDERS[provider];
  try {
    const authPath = configPath(provider);
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

  const value = process.env[env];
  if (value) {
    const envFile = matchingCwdEnvFile(env, value);
    const { label, file } = PROVIDERS[provider];
    const warning = envFile
      ? `Warning: ${env} matches ${envFile} in the current directory. Design generation may bill that project's ${label} account. Run $D setup${provider === "gemini" ? " --provider gemini" : ""} to store a gstack-specific key in ~/.gstack/${file}.`
      : undefined;
    return { key: value, source: "env", envFile: envFile ?? undefined, warning };
  }

  return null;
}

export function resolveApiKeyInfo(): ApiKeyResolution | null {
  return resolveKeyInfo("openai");
}

export function resolveGeminiKeyInfo(): ApiKeyResolution | null {
  return resolveKeyInfo("gemini");
}

export function resolveApiKey(): string | null {
  return resolveApiKeyInfo()?.key ?? null;
}

/**
 * OpenAI API URL for one endpoint. OPENAI_BASE_URL (the OpenAI SDK convention)
 * points every design call at an OpenAI-compatible gateway; egress receipts
 * record whichever host is used.
 */
export function openaiUrl(endpoint: "responses" | "chat/completions"): string {
  const base = process.env.OPENAI_BASE_URL?.trim().replace(/\/+$/, "") || "https://api.openai.com/v1";
  return `${base}/${endpoint}`;
}

export function describeKeySource(provider: ProviderName, resolution: ApiKeyResolution): string {
  const { file, env } = PROVIDERS[provider];
  if (resolution.source === "config") return `~/.gstack/${file}`;
  if (resolution.envFile) return `${env} environment variable (matches ${resolution.envFile} in current directory)`;
  return `${env} environment variable`;
}

export function describeApiKeySource(resolution: ApiKeyResolution): string {
  return describeKeySource("openai", resolution);
}

export const NO_IMAGE_KEY_MESSAGE = [
  "No image API key found (OpenAI or Gemini).",
  "",
  "Run: $D setup",
  "  or set OPENAI_API_KEY (https://platform.openai.com/api-keys)",
  "  or set GEMINI_API_KEY (free key: https://aistudio.google.com/apikey)",
  "Fix: export GEMINI_API_KEY=<your key>, or run $D setup --provider gemini. See docs/troubleshooting.md#design-no-image-key",
].join("\n");

/**
 * The provider this run uses, per the order in the header. Throws before any
 * request when GSTACK_DESIGN_PROVIDER names no provider, or names one with no
 * key; returns null when no key resolves at all.
 */
export function resolveProvider(): ProviderKey | null {
  const forced = process.env[DESIGN_PROVIDER_ENV]?.trim().toLowerCase();
  if (forced && forced !== "openai" && forced !== "gemini") {
    throw new Error(`${DESIGN_PROVIDER_ENV}=${JSON.stringify(forced.slice(0, 40))} is not a design provider (expected openai or gemini).\n` +
      `Fix: set it to openai or gemini, or unset it. See docs/troubleshooting.md#design-provider-invalid`);
  }
  const order: ProviderName[] = forced ? [forced as ProviderName] : ["openai", "gemini"];
  for (const provider of order) {
    const resolution = resolveKeyInfo(provider);
    if (resolution) return { provider, key: resolution.key, source: describeKeySource(provider, resolution), warning: resolution.warning };
  }
  if (!forced) return null;
  const { label, file, env } = PROVIDERS[forced as ProviderName];
  throw new Error(`${DESIGN_PROVIDER_ENV}=${forced} but no ${label} key was found (checked ~/.gstack/${file} and ${env}).\n` +
    `Fix: export ${env}=<your key>, run $D setup --provider ${forced}, or unset ${DESIGN_PROVIDER_ENV}. See docs/troubleshooting.md#design-provider-no-key`);
}

export const GEMINI_DATA_NOTICE = "Note: on Google's free tier, Gemini API prompts and images may be used to improve Google's products " +
  "(https://ai.google.dev/gemini-api/terms); a key with billing enabled is not.";

let geminiNoticeShown = false;

/** Resolve the provider or throw the no-key error; says once per run which key is used. */
export function requireProvider(): ProviderKey {
  const resolved = resolveProvider();
  if (!resolved) throw new Error(NO_IMAGE_KEY_MESSAGE);
  console.error(`Using ${PROVIDERS[resolved.provider].label} key from ${resolved.source}.`);
  if (resolved.warning) console.error(resolved.warning);
  if (resolved.provider === "gemini" && !geminiNoticeShown) {
    geminiNoticeShown = true;
    console.error(GEMINI_DATA_NOTICE);
  }
  return resolved;
}

/**
 * Save an API key to ~/.gstack/<provider>.json with 0600 permissions.
 */
export function saveApiKey(key: string, provider: ProviderName = "openai"): void {
  const file = configPath(provider);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // Create the file owner-only up front so the API key is never briefly
  // world/group-readable in the window between write and chmod. The trailing
  // chmodSync is kept as a backstop to tighten a pre-existing loose file.
  fs.writeFileSync(file, JSON.stringify({ api_key: key }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Get API key or throw with setup instructions.
 */
export function requireApiKey(): string {
  const resolution = resolveApiKeyInfo();
  if (!resolution) {
    throw new Error([
      "No OpenAI API key found.",
      "",
      "Run: $D setup",
      "  or save to ~/.gstack/openai.json: { \"api_key\": \"sk-...\" }",
      "  or set OPENAI_API_KEY environment variable",
      "",
      "Get a key at: https://platform.openai.com/api-keys",
    ].join("\n"));
  }
  console.error(`Using OpenAI key from ${describeApiKeySource(resolution)}.`);
  if (resolution.warning) console.error(resolution.warning);
  return resolution.key;
}
