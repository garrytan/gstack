/**
 * Auth and provider resolution for gstack design image generation.
 *
 * Resolution order for `auto`:
 * 1. Codex CLI ChatGPT OAuth (`codex login`) when available
 * 2. OpenAI API key from ~/.gstack/openai.json or OPENAI_API_KEY
 * 3. Guided failure message with both setup paths
 */

import * as fs from "fs";
import * as path from "path";

const CONFIG_PATH = path.join(process.env.HOME || "~", ".gstack", "openai.json");

export type ImageProviderKind = "codex" | "openai";
export type ImageProviderOption = "auto" | ImageProviderKind | undefined;

export interface CredentialStatus {
  openAIKey: boolean;
  codexChatGPT: boolean;
}

export interface ImageProvider {
  kind: ImageProviderKind;
  apiKey?: string;
}

export function resolveApiKey(): string | null {
  // 1. Check ~/.gstack/openai.json
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
 * Save an API key to ~/.gstack/openai.json with 0600 permissions.
 */
export function saveApiKey(key: string): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ api_key: key }, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
}

export function sanitizeProviderError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/(OPENAI_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9_\-]+/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9._\-]+/g, "[REDACTED]");
}

export function buildMissingProviderMessage(): string {
  return [
    "No image-generation auth found.",
    "",
    "Preferred: run `codex login` and sign in with ChatGPT. gstack design will use Codex OAuth automatically.",
    "Fallback: run `$D setup`, save ~/.gstack/openai.json: { \"api_key\": \"sk-...\" }, or set OPENAI_API_KEY.",
    "",
    "Use `--backend codex` to require Codex OAuth, or `--backend openai` to require an OpenAI API key.",
  ].join("\n");
}

export function resolveImageProvider(option: ImageProviderOption, status: CredentialStatus, apiKey = resolveApiKey()): ImageProvider {
  const requested = option ?? "auto";
  if (!["auto", "codex", "openai"].includes(requested)) {
    throw new Error("--backend must be one of: auto, codex, openai");
  }

  if (requested === "codex") {
    if (status.codexChatGPT) return { kind: "codex" };
    throw new Error("No Codex ChatGPT subscription auth found. Run `codex login` before using `gstack design --backend codex`.");
  }

  if (requested === "openai") {
    if (status.openAIKey && apiKey) return { kind: "openai", apiKey };
    throw new Error("No OpenAI API key found. Run `$D setup`, save ~/.gstack/openai.json, or set OPENAI_API_KEY.");
  }

  if (status.codexChatGPT) return { kind: "codex" };
  if (status.openAIKey && apiKey) return { kind: "openai", apiKey };
  throw new Error(buildMissingProviderMessage());
}

export async function commandReportsChatGPTLogin(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["codex", "login", "status"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGTERM"), 5_000);
    try {
      await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return `${stdout}\n${stderr}`.includes("Logged in using ChatGPT");
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  return {
    openAIKey: !!resolveApiKey(),
    codexChatGPT: await commandReportsChatGPTLogin(),
  };
}

export async function requireImageProvider(option?: ImageProviderOption): Promise<ImageProvider> {
  try {
    return resolveImageProvider(option, await getCredentialStatus());
  } catch (err: any) {
    console.error(sanitizeProviderError(err.message || String(err)));
    process.exit(1);
  }
}

/**
 * Backward-compatible API-key helper for older callers.
 */
export function requireApiKey(): string {
  const key = resolveApiKey();
  if (!key) {
    console.error(buildMissingProviderMessage());
    process.exit(1);
  }
  return key;
}
