/**
 * Provider factory.
 *
 * Resolves the concrete DesignProvider for the current process based on:
 *   1. GSTACK_DESIGN_PROVIDER env var ("gemini" | "openai") — explicit choice
 *   2. Auto-detect: prefer Gemini if a Gemini key is available, fall back to OpenAI
 *
 * All design tool call sites should import getProvider from here instead of
 * constructing providers directly or reading API keys themselves.
 */

import type { DesignProvider, ProviderName } from "./provider";
import { GEMINI_KEY_URL, OPENAI_KEY_URL } from "./provider";
import { OpenAIProvider } from "./openai";
import { GeminiProvider } from "./gemini";
import { resolveGeminiKey, resolveOpenAIKey } from "../auth";

let cached: DesignProvider | null = null;

export function getProvider(): DesignProvider {
  if (cached) return cached;

  const raw = (process.env.GSTACK_DESIGN_PROVIDER || "").trim().toLowerCase();
  const forced: ProviderName | "" = raw === "openai" || raw === "gemini" ? raw : "";
  if (raw && !forced) {
    console.warn(
      `GSTACK_DESIGN_PROVIDER="${process.env.GSTACK_DESIGN_PROVIDER}" is not recognized (expected "openai" or "gemini"); falling back to auto-detect.`,
    );
  }

  if (forced === "openai") {
    const key = resolveOpenAIKey();
    if (!key) {
      throw new Error(
        "GSTACK_DESIGN_PROVIDER=openai but no OpenAI key found.\n"
        + "Set OPENAI_API_KEY or save to ~/.gstack/openai.json.\n"
        + `Get one at: ${OPENAI_KEY_URL}`,
      );
    }
    cached = new OpenAIProvider(key);
    return cached;
  }

  if (forced === "gemini") {
    const key = resolveGeminiKey();
    if (!key) {
      throw new Error(
        "GSTACK_DESIGN_PROVIDER=gemini but no Gemini key found.\n"
        + "Set GEMINI_API_KEY or save to ~/.gstack/gemini.json.\n"
        + `Get one at: ${GEMINI_KEY_URL}`,
      );
    }
    cached = new GeminiProvider(key);
    return cached;
  }

  // Auto: prefer Gemini (new default, better quality/price on typography
  // and UI accuracy per Nano Banana 2 benchmarks), fall back to OpenAI.
  const geminiKey = resolveGeminiKey();
  if (geminiKey) {
    cached = new GeminiProvider(geminiKey);
    return cached;
  }

  const openaiKey = resolveOpenAIKey();
  if (openaiKey) {
    cached = new OpenAIProvider(openaiKey);
    return cached;
  }

  throw new Error(
    "No design provider API key found.\n"
    + "\n"
    + `Gemini (recommended, default): ${GEMINI_KEY_URL}\n`
    + "  Save to ~/.gstack/gemini.json or set GEMINI_API_KEY\n"
    + "\n"
    + `OpenAI (legacy): ${OPENAI_KEY_URL}\n`
    + "  Save to ~/.gstack/openai.json or set OPENAI_API_KEY\n"
    + "\n"
    + "Run: $D setup",
  );
}

/** Clear the cached provider. Useful for tests and for setup flows. */
export function resetProvider(): void {
  cached = null;
}
