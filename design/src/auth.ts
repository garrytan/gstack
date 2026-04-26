/**
 * Auth resolution for design provider API keys.
 *
 * Supports both OpenAI and Google Gemini. Each provider has its own resolution
 * path and its own on-disk config file so users can have both keys available
 * and switch between providers via the GSTACK_DESIGN_PROVIDER env var.
 *
 * OpenAI resolution order:
 *   1. ~/.gstack/openai.json → { "api_key": "sk-..." }
 *   2. OPENAI_API_KEY environment variable
 *   3. null
 *
 * Gemini resolution order:
 *   1. ~/.gstack/gemini.json → { "api_key": "..." }
 *   2. GEMINI_API_KEY environment variable
 *   3. GOOGLE_API_KEY environment variable (common Google AI alias)
 *   4. null
 */

import fs from "fs";
import path from "path";

const HOME = process.env.HOME || "~";
const OPENAI_CONFIG_PATH = path.join(HOME, ".gstack", "openai.json");
const GEMINI_CONFIG_PATH = path.join(HOME, ".gstack", "gemini.json");

function readKeyFromFile(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      const config = JSON.parse(content);
      if (config.api_key && typeof config.api_key === "string") {
        return config.api_key;
      }
    }
  } catch {
    // fall through to caller's next fallback
  }
  return null;
}

function saveKeyToFile(filePath: string, key: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ api_key: key }, null, 2));
  fs.chmodSync(filePath, 0o600);
}

// --- OpenAI ---

export function resolveOpenAIKey(): string | null {
  const fromFile = readKeyFromFile(OPENAI_CONFIG_PATH);
  if (fromFile) return fromFile;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return null;
}

export function saveOpenAIKey(key: string): void {
  saveKeyToFile(OPENAI_CONFIG_PATH, key);
}

// --- Gemini ---

export function resolveGeminiKey(): string | null {
  const fromFile = readKeyFromFile(GEMINI_CONFIG_PATH);
  if (fromFile) return fromFile;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  return null;
}

export function saveGeminiKey(key: string): void {
  saveKeyToFile(GEMINI_CONFIG_PATH, key);
}

// --- Legacy back-compat ---
// These preserve the old public API so any caller outside this module that
// still imports resolveApiKey/saveApiKey continues to work. New code should
// use getProvider() from ./providers/factory instead.

/** @deprecated Use resolveOpenAIKey or getProvider() from ./providers/factory. */
export function resolveApiKey(): string | null {
  return resolveOpenAIKey();
}

/** @deprecated Use saveOpenAIKey. */
export function saveApiKey(key: string): void {
  saveOpenAIKey(key);
}

/** @deprecated Use getProvider() from ./providers/factory. */
export function requireApiKey(): string {
  const key = resolveOpenAIKey();
  if (!key) {
    console.error("No OpenAI API key found.");
    console.error("");
    console.error("Prefer the new provider abstraction:");
    console.error("  import { getProvider } from './providers/factory'");
    console.error("");
    console.error("Or run: $D setup");
    process.exit(1);
  }
  return key;
}
