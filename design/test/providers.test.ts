import { describe, test, expect, afterEach, mock } from "bun:test";
import { OpenAIProvider } from "../src/providers/openai";
import { GeminiProvider } from "../src/providers/gemini";
import { ProviderError } from "../src/providers/provider";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type FetchCall = { url: string; body: any };

function mockFetch(response: unknown, status = 200): () => FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const bodyStr = init?.body as string | undefined;
    calls.push({ url: urlStr, body: bodyStr ? JSON.parse(bodyStr) : undefined });
    const text = typeof response === "string" ? response : JSON.stringify(response);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as any;
  return () => calls;
}

/** Make fetch throw an AbortError — simulates AbortController-driven timeout. */
function mockFetchAborts(): void {
  globalThis.fetch = mock(async () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    throw err;
  }) as any;
}

/** Make fetch throw a raw TypeError — simulates DNS/TLS/socket/network failure. */
function mockFetchNetworkError(message = "Failed to fetch"): void {
  globalThis.fetch = mock(async () => {
    throw new TypeError(message);
  }) as any;
}

describe("OpenAIProvider", () => {
  test("generateImage returns imageData + responseId from responses API", async () => {
    const getCalls = mockFetch({
      id: "resp_abc123",
      output: [
        { type: "reasoning", content: "..." },
        { type: "image_generation_call", result: "base64imagedata" },
      ],
    });
    const provider = new OpenAIProvider("sk-test");
    const result = await provider.generateImage({ prompt: "a cat" });

    expect(result.imageData).toBe("base64imagedata");
    expect(result.responseId).toBe("resp_abc123");
    expect(result.mimeType).toBe("image/png");

    const [call] = getCalls();
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.body.model).toBe("gpt-4o");
    expect(call.body.input).toBe("a cat");
    expect(call.body.tools[0]).toMatchObject({
      type: "image_generation",
      size: "1536x1024",
      quality: "high",
    });
  });

  test("generateImage forwards previousResponseId for threading", async () => {
    const getCalls = mockFetch({
      id: "resp_next",
      output: [{ type: "image_generation_call", result: "img2" }],
    });
    const provider = new OpenAIProvider("sk-test");
    await provider.generateImage({ prompt: "iterate", previousResponseId: "resp_prev" });
    expect(getCalls()[0].body.previous_response_id).toBe("resp_prev");
  });

  test("generateImage refuses referenceImage (unsupported on this API)", async () => {
    const provider = new OpenAIProvider("sk-test");
    await expect(
      provider.generateImage({
        prompt: "edit",
        referenceImage: { data: "abc", mimeType: "image/png" },
      }),
    ).rejects.toThrow(/does not accept reference images/);
  });

  test("generateImage surfaces org-verification error with actionable hint (not retryable)", async () => {
    mockFetch({ error: "organization must be verified" }, 403);
    const provider = new OpenAIProvider("sk-test");
    try {
      await provider.generateImage({ prompt: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(403);
      expect((err as ProviderError).retryable).toBe(false);
      expect((err as Error).message).toMatch(/organization/i);
    }
  });

  test.each([
    [429, "rate limited"],
    [500, "internal server error"],
    [503, "service unavailable"],
  ])("generateImage marks %i as retryable metadata", async (status, msg) => {
    mockFetch({ error: msg }, status);
    const provider = new OpenAIProvider("sk-test");
    try {
      await provider.generateImage({ prompt: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as ProviderError).status).toBe(status);
    }
  });

  test("generateImage wraps AbortError as retryable ProviderError", async () => {
    mockFetchAborts();
    const provider = new OpenAIProvider("sk-test");
    try {
      await provider.generateImage({ prompt: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as Error).message).toMatch(/timed out/i);
    }
  });

  test("generateImage wraps raw TypeError (DNS/TLS/socket) as retryable ProviderError", async () => {
    mockFetchNetworkError("Failed to fetch");
    const provider = new OpenAIProvider("sk-test");
    try {
      await provider.generateImage({ prompt: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as ProviderError).providerName).toBe("openai");
      expect((err as Error).message).toMatch(/transport error.*Failed to fetch/);
    }
  });

  test("vision wraps raw TypeError as retryable ProviderError", async () => {
    mockFetchNetworkError("ENOTFOUND api.openai.com");
    const provider = new OpenAIProvider("sk-test");
    try {
      await provider.vision({ prompt: "x", images: [{ data: "a", mimeType: "image/png" }] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as Error).message).toMatch(/vision transport error.*ENOTFOUND/);
    }
  });

  test("generateImage throws when response has no image output", async () => {
    mockFetch({ id: "resp_x", output: [{ type: "reasoning", content: "..." }] });
    const provider = new OpenAIProvider("sk-test");
    await expect(provider.generateImage({ prompt: "x" }))
      .rejects.toThrow(/No image data.*Output types: reasoning/);
  });

  test("vision returns trimmed text from chat completions", async () => {
    const getCalls = mockFetch({
      choices: [{ message: { content: "  PASS  " } }],
    });
    const provider = new OpenAIProvider("sk-test");
    const result = await provider.vision({
      prompt: "check this",
      images: [{ data: "abc", mimeType: "image/png" }],
    });
    expect(result.text).toBe("PASS");

    const [call] = getCalls();
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.body.model).toBe("gpt-4o");
    expect(call.body.max_tokens).toBe(400);
    expect(call.body.messages[0].content).toHaveLength(2);
    expect(call.body.messages[0].content[0].type).toBe("image_url");
    expect(call.body.messages[0].content[1].type).toBe("text");
  });

  test("vision with jsonMode sets response_format", async () => {
    const getCalls = mockFetch({ choices: [{ message: { content: "{}" } }] });
    const provider = new OpenAIProvider("sk-test");
    await provider.vision({
      prompt: "check",
      images: [{ data: "a", mimeType: "image/png" }],
      jsonMode: true,
    });
    expect(getCalls()[0].body.response_format).toEqual({ type: "json_object" });
  });

  test("capability flags: no imageRef, yes threading", () => {
    const provider = new OpenAIProvider("sk-test");
    expect(provider.supportsImageRef()).toBe(false);
    expect(provider.supportsThreading()).toBe(true);
    expect(provider.name).toBe("openai");
  });
});

// --- GeminiProvider ---

describe("GeminiProvider", () => {
  test("generateImage returns inlineData + synthetic responseId", async () => {
    const getCalls = mockFetch({
      candidates: [{
        content: {
          parts: [{ inlineData: { data: "geminiimg", mimeType: "image/png" } }],
        },
      }],
    });
    const provider = new GeminiProvider("gem-test");
    const result = await provider.generateImage({ prompt: "a cat" });

    expect(result.imageData).toBe("geminiimg");
    expect(result.responseId).toMatch(/^gemini-\d+$/);
    expect(result.mimeType).toBe("image/png");

    const [call] = getCalls();
    expect(call.url).toContain("generateContent");
    expect(call.url).toContain("gemini-3-pro-image-preview");
    expect(call.body.generationConfig.responseModalities).toEqual(["IMAGE"]);
  });

  test("generateImage handles snake_case inline_data from older response shapes", async () => {
    mockFetch({
      candidates: [{
        content: {
          parts: [{ inline_data: { data: "oldshape", mime_type: "image/jpeg" } }],
        },
      }],
    });
    const provider = new GeminiProvider("gem-test");
    const result = await provider.generateImage({ prompt: "a" });
    expect(result.imageData).toBe("oldshape");
    expect(result.mimeType).toBe("image/jpeg");
  });

  test.each([
    ["1024x1024", "1:1"],
    ["1536x1024", "3:2"],
    ["1080x1920", "9:16"],
    ["not-a-size", "16:9"],
  ])("sizeToAspectRatio maps %s → %s", async (input, expected) => {
    const getCalls = mockFetch({
      candidates: [{ content: { parts: [{ inlineData: { data: "x" } }] } }],
    });
    const provider = new GeminiProvider("gem-test");
    await provider.generateImage({ prompt: "a", size: input });
    expect(getCalls()[0].body.generationConfig.imageConfig.aspectRatio).toBe(expected);
  });

  test("generateImage throws on previousResponseId (Gemini has no threading)", async () => {
    const provider = new GeminiProvider("gem-test");
    await expect(
      provider.generateImage({ prompt: "a", previousResponseId: "resp_x" }),
    ).rejects.toThrow(/does not support response_id threading/);
  });

  test("generateImage passes referenceImage as a second part", async () => {
    const getCalls = mockFetch({
      candidates: [{ content: { parts: [{ inlineData: { data: "out" } }] } }],
    });
    const provider = new GeminiProvider("gem-test");
    await provider.generateImage({
      prompt: "edit this",
      referenceImage: { data: "base64in", mimeType: "image/png" },
    });
    const parts = getCalls()[0].body.contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ text: "edit this" });
    expect(parts[1].inlineData).toEqual({ mimeType: "image/png", data: "base64in" });
  });

  test("generateImage surfaces finishReason + blockReason on empty response", async () => {
    mockFetch({
      candidates: [{ finishReason: "SAFETY", content: { parts: [] } }],
      promptFeedback: { blockReason: "SAFETY" },
    });
    const provider = new GeminiProvider("gem-test");
    await expect(provider.generateImage({ prompt: "x" }))
      .rejects.toThrow(/finishReason=SAFETY, blockReason=SAFETY/);
  });

  test("generateImage surfaces 401 as AUTH_HINT", async () => {
    mockFetch({ error: { message: "invalid key" } }, 401);
    const provider = new GeminiProvider("gem-test");
    await expect(provider.generateImage({ prompt: "x" }))
      .rejects.toThrow(/aistudio\.google\.com\/app\/apikey/);
  });

  test.each([
    [429, "quota exceeded"],
    [500, "internal error"],
    [503, "unavailable"],
  ])("generateImage marks %i as retryable metadata", async (status, msg) => {
    mockFetch({ error: { message: msg } }, status);
    const provider = new GeminiProvider("gem-test");
    try {
      await provider.generateImage({ prompt: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as ProviderError).status).toBe(status);
    }
  });

  test("generateImage wraps AbortError as retryable ProviderError", async () => {
    mockFetchAborts();
    const provider = new GeminiProvider("gem-test");
    try {
      await provider.generateImage({ prompt: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as Error).message).toMatch(/timed out/i);
    }
  });

  test("generateImage wraps raw TypeError (DNS/TLS/socket) as retryable ProviderError", async () => {
    mockFetchNetworkError("Failed to fetch");
    const provider = new GeminiProvider("gem-test");
    try {
      await provider.generateImage({ prompt: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as ProviderError).providerName).toBe("gemini");
      expect((err as Error).message).toMatch(/image transport error.*Failed to fetch/);
    }
  });

  test("vision wraps raw TypeError as retryable ProviderError", async () => {
    mockFetchNetworkError("ECONNRESET");
    const provider = new GeminiProvider("gem-test");
    try {
      await provider.vision({ prompt: "x", images: [{ data: "a", mimeType: "image/png" }] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as Error).message).toMatch(/vision transport error.*ECONNRESET/);
    }
  });

  test("vision returns trimmed text from candidates parts", async () => {
    const getCalls = mockFetch({
      candidates: [{
        content: { parts: [{ text: "  FAIL: label unreadable  " }] },
      }],
    });
    const provider = new GeminiProvider("gem-test");
    const result = await provider.vision({
      prompt: "check",
      images: [{ data: "a", mimeType: "image/png" }],
    });
    expect(result.text).toBe("FAIL: label unreadable");

    const [call] = getCalls();
    expect(call.url).toContain("gemini-2.5-flash");
    expect(call.body.generationConfig.maxOutputTokens).toBe(400);
    expect(call.body.contents[0].parts).toHaveLength(2);
    expect(call.body.contents[0].parts[0].text).toBe("check");
    expect(call.body.contents[0].parts[1].inlineData).toEqual({
      mimeType: "image/png",
      data: "a",
    });
  });

  test("vision with jsonMode sets responseMimeType", async () => {
    const getCalls = mockFetch({
      candidates: [{ content: { parts: [{ text: "{}" } ] } }],
    });
    const provider = new GeminiProvider("gem-test");
    await provider.vision({
      prompt: "check",
      images: [{ data: "a", mimeType: "image/png" }],
      jsonMode: true,
    });
    expect(getCalls()[0].body.generationConfig.responseMimeType).toBe("application/json");
  });

  test("capability flags: yes imageRef, no threading", () => {
    const provider = new GeminiProvider("gem-test");
    expect(provider.supportsImageRef()).toBe(true);
    expect(provider.supportsThreading()).toBe(false);
    expect(provider.name).toBe("gemini");
  });
});
