import { describe, expect, test } from "bun:test";

import { normalizeSizeForProvider } from "../design/src/generate";

describe("normalizeSizeForProvider", () => {
  test("uses provider defaults when size is omitted", () => {
    expect(normalizeSizeForProvider(undefined, "openai")).toBe("1536x1024");
    expect(normalizeSizeForProvider(undefined, "minimax")).toBe("9:16");
  });

  test("converts OpenAI WxH sizes into MiniMax aspect ratios", () => {
    expect(normalizeSizeForProvider("1536x1024", "minimax")).toBe("3:2");
    expect(normalizeSizeForProvider("1024x1536", "minimax")).toBe("2:3");
    expect(normalizeSizeForProvider("1024x1024", "minimax")).toBe("1:1");
  });

  test("converts aspect ratios into OpenAI-supported orientations", () => {
    expect(normalizeSizeForProvider("16:9", "openai")).toBe("1536x1024");
    expect(normalizeSizeForProvider("9:16", "openai")).toBe("1024x1536");
    expect(normalizeSizeForProvider("1:1", "openai")).toBe("1024x1024");
  });
});
