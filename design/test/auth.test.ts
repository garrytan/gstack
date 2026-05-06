import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildMissingProviderMessage,
  resolveImageProvider,
  sanitizeProviderError,
} from "../src/auth";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gstack-design-auth-"));
}

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("design image provider auth", () => {
  test("auto prefers Codex OAuth when ChatGPT login is available", () => {
    expect(resolveImageProvider("auto", { openAIKey: false, codexChatGPT: true }).kind).toBe("codex");
    expect(resolveImageProvider(undefined, { openAIKey: false, codexChatGPT: true }).kind).toBe("codex");
  });

  test("explicit openai still preserves API-key based generation", () => {
    const provider = resolveImageProvider("openai", { openAIKey: true, codexChatGPT: true }, "sk-test");
    expect(provider.kind).toBe("openai");
  });

  test("auto falls back to OpenAI API key when Codex OAuth is unavailable", () => {
    const provider = resolveImageProvider("auto", { openAIKey: true, codexChatGPT: false }, "sk-test");
    expect(provider.kind).toBe("openai");
  });

  test("explicit codex fails with actionable login guidance when unavailable", () => {
    expect(() => resolveImageProvider("codex", { openAIKey: true, codexChatGPT: false })).toThrow(/codex login/i);
  });

  test("missing credentials message mentions Codex OAuth and API key fallback", () => {
    const message = buildMissingProviderMessage();
    expect(message).toContain("codex login");
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain("~/.gstack/openai.json");
  });

  test("provider error sanitizer redacts bearer tokens and API-key shaped values", () => {
    const err = sanitizeProviderError("Authorization: Bearer sk-real-secret OPENAI_API_KEY=sk-another-secret access_token=abc.def.ghi");
    expect(err).not.toContain("sk-real-secret");
    expect(err).not.toContain("sk-another-secret");
    expect(err).not.toContain("abc.def.ghi");
    expect(err).toContain("[REDACTED]");
  });
});
