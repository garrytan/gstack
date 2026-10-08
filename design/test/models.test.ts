/**
 * #2807: the design binary's OpenAI model choice lives in design/src/models.ts.
 *
 * Every call site is driven through its exported entry point with a stubbed
 * fetch, so these tests prove REQUEST SHAPE only: which endpoint, which model
 * (the GSTACK_DESIGN_MODEL override reaches all ten sites), the pinned
 * image tool model, the token parameter the gpt-5 family accepts with
 * reasoning headroom, and an error that names
 * GSTACK_DESIGN_MODEL when OpenAI rejects the model. They do not prove that
 * any account is entitled to any model; that needs a live keyed call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
  DEFAULT_DESIGN_MODELS,
  DESIGN_MODEL_ENV,
  IMAGE_TOOL_MODEL,
  REASONING_HEADROOM_TOKENS,
  designModel,
  modelRejectionHint,
} from "../src/models";
import { checkMockup } from "../src/check";
import { diffMockups } from "../src/diff";
import { extractDesignLanguage } from "../src/memory";
import { generateDesignToCodePrompt } from "../src/design-to-code";
import { evolve } from "../src/evolve";
import { generate } from "../src/generate";
import { iterate } from "../src/iterate";
import { generateVariant } from "../src/variants";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
const OVERRIDE = "gpt-test-override";
const REJECTED = JSON.stringify({ error: { message: `The model \`${OVERRIDE}\` does not exist or you do not have access to it.`, type: "invalid_request_error" } });

interface Call { url: string; body: any }
let calls: Call[];
let errors: string[];
let dir: string;
const saved: Record<string, string | undefined> = {};
const savedFetch = globalThis.fetch;
const savedConsoleError = console.error;
const savedConsoleLog = console.log;

/** Stub fetch: `reply(url, n)` returns the Response for the n-th call. */
function stubFetch(reply: (url: string, n: number) => Response) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return reply(url, calls.length);
  }) as typeof globalThis.fetch;
}

function ok(url: string, chatContent = "{}"): Response {
  const body = url.endsWith("/v1/responses")
    ? { id: "resp_test", output: [{ type: "image_generation_call", result: TINY_PNG }] }
    : { choices: [{ message: { content: chatContent } }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
const rejected = () => new Response(REJECTED, { status: 400 });

beforeEach(() => {
  calls = [];
  errors = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-models-"));
  for (const k of ["HOME", "GSTACK_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL", DESIGN_MODEL_ENV]) saved[k] = process.env[k];
  delete process.env.OPENAI_BASE_URL;
  process.env.HOME = dir;
  process.env.GSTACK_HOME = dir;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env[DESIGN_MODEL_ENV] = OVERRIDE;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  console.log = () => {};
  fs.writeFileSync(path.join(dir, "shot.png"), Buffer.from(TINY_PNG, "base64"));
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  console.error = savedConsoleError;
  console.log = savedConsoleLog;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function expectImageShape(c: Call) {
  expect(c.url).toBe("https://api.openai.com/v1/responses");
  expect(c.body.model).toBe(OVERRIDE);
  expect(c.body.tools).toHaveLength(1);
  expect(c.body.tools[0].type).toBe("image_generation");
  // Never omitted: the API's fallback, gpt-image-1, shuts down 2026-10-23.
  expect(c.body.tools[0].model).toBe(IMAGE_TOOL_MODEL);
}

function expectVisionShape(c: Call) {
  expect(c.url).toBe("https://api.openai.com/v1/chat/completions");
  expect(c.body.model).toBe(OVERRIDE);
  expect(c.body.max_tokens).toBeUndefined();
  expect(c.body.max_completion_tokens).toBeGreaterThan(REASONING_HEADROOM_TOKENS);
  expect(c.body.messages[0].content.some((p: any) => p.type === "image_url")).toBe(true);
}

const names = (s: string) => expect(s).toContain(`${DESIGN_MODEL_ENV}=${OVERRIDE}`);

describe("designModel / modelRejectionHint", () => {
  test("defaults per call type; GSTACK_DESIGN_MODEL overrides both; blank is unset", () => {
    expect(designModel("image", {})).toBe("gpt-5.5");
    expect(designModel("vision", {})).toBe("gpt-5.5");
    expect(designModel("image", {})).toBe(DEFAULT_DESIGN_MODELS.image);
    expect(designModel("vision", {})).toBe(DEFAULT_DESIGN_MODELS.vision);
    expect(designModel("image", { [DESIGN_MODEL_ENV]: " gpt-x " })).toBe("gpt-x");
    expect(designModel("vision", { [DESIGN_MODEL_ENV]: "  " })).toBe(DEFAULT_DESIGN_MODELS.vision);
  });

  test("the hint fires for model/parameter rejections only", () => {
    names(modelRejectionHint(400, "Unsupported parameter: 'max_tokens' is not supported with this model.", "vision"));
    names(modelRejectionHint(404, REJECTED, "image"));
    expect(modelRejectionHint(400, "Invalid image: could not decode", "vision")).toBe("");
    expect(modelRejectionHint(429, "Rate limit for model gpt-4o", "image")).toBe("");
    expect(modelRejectionHint(500, "model overloaded", "image")).toBe("");
    delete process.env[DESIGN_MODEL_ENV];
    expect(modelRejectionHint(400, REJECTED, "image")).toContain(`the default model ${DEFAULT_DESIGN_MODELS.image}`);
    expect(modelRejectionHint(400, REJECTED, "image")).toContain(`set ${DESIGN_MODEL_ENV}`);
  });

  test("no design/src module hardcodes a model or the max_tokens parameter outside models.ts", () => {
    const src = path.join(import.meta.dir, "..", "src");
    for (const f of fs.readdirSync(src).filter((n) => n.endsWith(".ts") && n !== "models.ts")) {
      const body = fs.readFileSync(path.join(src, f), "utf-8");
      expect({ f, literal: /\bmodel:\s*["'`]/.test(body), maxTokens: /\bmax_tokens\b/.test(body) }).toEqual({ f, literal: false, maxTokens: false });
    }
  });
});

describe("image-generation call sites (Responses API)", () => {
  test("generate", async () => {
    stubFetch((u) => ok(u));
    const r = await generate({ brief: "a login page", output: path.join(dir, "g.png") });
    fs.rmSync(r.sessionFile!, { force: true });
    expect(calls).toHaveLength(1);
    expectImageShape(calls[0]);
    stubFetch(() => rejected());
    const failed = await generate({ brief: "x", output: path.join(dir, "g2.png") });
    expect(failed.exitCode).toBe(2);
    names(failed.failures[0].reason);
    // An override that cannot drive gpt-image-2 fails before any request.
    calls = [];
    process.env[DESIGN_MODEL_ENV] = "gpt-4o";
    const refused = await generate({ brief: "x", output: path.join(dir, "g3.png") });
    expect(refused.exitCode).toBe(2);
    expect(refused.failures[0].reason).toContain(DESIGN_MODEL_ENV);
    expect(calls).toHaveLength(0);
  });

  test("variants", async () => {
    stubFetch((u) => ok(u));
    expect((await generateVariant("sk", "p", path.join(dir, "v.png"), "1536x1024", "high")).success).toBe(true);
    expectImageShape(calls[0]);
    stubFetch(() => rejected());
    const r = await generateVariant("sk", "p", path.join(dir, "v2.png"), "1536x1024", "high");
    expect(r.success).toBe(false);
    names(r.error!);
  });

  test("iterate: threaded and fresh fallback", async () => {
    const id = `models-test-${process.pid}-${Date.now()}`;
    const session = path.join(os.tmpdir(), `design-session-${id}.json`);
    const write = () => fs.writeFileSync(session, JSON.stringify({ id, lastResponseId: "resp_prev", originalBrief: "b", feedbackHistory: [], outputPaths: [], createdAt: "", updatedAt: "" }));
    try {
      write();
      stubFetch((u, n) => (n === 1 ? new Response("server error", { status: 500 }) : ok(u)));
      await iterate({ session, feedback: "bigger", output: path.join(dir, "i.png") });
      expect(calls).toHaveLength(2);
      expectImageShape(calls[0]);
      expect(calls[0].body.previous_response_id).toBe("resp_prev");
      expectImageShape(calls[1]);
      expect(calls[1].body.previous_response_id).toBeUndefined();
      write();
      errors = [];
      stubFetch(() => rejected());
      expect(await iterate({ session, feedback: "x", output: path.join(dir, "i2.png") })).toBe(2);
      names(errors.at(-1)!);
      names(errors.find((e) => e.includes("Threading failed"))!);
    } finally {
      fs.rmSync(session, { force: true });
    }
  });

  test("evolve: vision analysis, then image generation", async () => {
    stubFetch((u) => ok(u, "a centered card"));
    await evolve({ screenshot: path.join(dir, "shot.png"), brief: "darker", output: path.join(dir, "e.png") });
    expect(calls).toHaveLength(2);
    expectVisionShape(calls[0]);
    expectImageShape(calls[1]);
    expect(calls[1].body.input).toContain("a centered card");
    stubFetch(() => rejected());
    expect(await evolve({ screenshot: path.join(dir, "shot.png"), brief: "x", output: path.join(dir, "e2.png") })).toBe(2);
    names(errors.at(-1)!);
    names(errors.find((e) => e.includes("Screenshot analysis failed"))!);
  });
});

test("OPENAI_BASE_URL sends image and vision calls to the gateway", async () => {
  process.env.OPENAI_BASE_URL = "https://gateway.example/openai/v1/";
  stubFetch((u) => ok(u, "a centered card"));
  await evolve({ screenshot: path.join(dir, "shot.png"), brief: "darker", output: path.join(dir, "e.png") });
  expect(calls.map((c) => c.url)).toEqual([
    "https://gateway.example/openai/v1/chat/completions",
    "https://gateway.example/openai/v1/responses",
  ]);
});

describe("vision call sites (Chat Completions)", () => {
  test("check", async () => {
    stubFetch((u) => ok(u, "PASS"));
    expect(await checkMockup(path.join(dir, "shot.png"), "brief")).toEqual({ pass: true, status: "pass", issues: "" });
    expectVisionShape(calls[0]);
    stubFetch(() => rejected());
    await checkMockup(path.join(dir, "shot.png"), "brief");
    names(errors.find((e) => e.includes("Vision check API error"))!);
  });

  test("diff", async () => {
    stubFetch((u) => ok(u, JSON.stringify({ differences: [], summary: "same", matchScore: 100 })));
    expect((await diffMockups(path.join(dir, "shot.png"), path.join(dir, "shot.png"))).matchScore).toBe(100);
    expectVisionShape(calls[0]);
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    stubFetch(() => rejected());
    expect((await diffMockups(path.join(dir, "shot.png"), path.join(dir, "shot.png"))).matchScore).toBe(-1);
    names(errors.find((e) => e.includes("Diff API error"))!);
  });

  test("memory", async () => {
    stubFetch((u) => ok(u, JSON.stringify({ colors: [], typography: [], spacing: [], layout: [], mood: "calm" })));
    expect((await extractDesignLanguage(path.join(dir, "shot.png"))).mood).toBe("calm");
    expectVisionShape(calls[0]);
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    stubFetch(() => rejected());
    await extractDesignLanguage(path.join(dir, "shot.png"));
    names(errors.find((e) => e.includes("Vision extraction failed"))!);
  });

  test("design-to-code", async () => {
    const result = { implementationPrompt: "build it", colors: [], typography: [], layout: [], components: [] };
    stubFetch((u) => ok(u, JSON.stringify(result)));
    expect(await generateDesignToCodePrompt(path.join(dir, "shot.png"))).toEqual(result);
    expectVisionShape(calls[0]);
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    stubFetch(() => rejected());
    await expect(generateDesignToCodePrompt(path.join(dir, "shot.png"))).rejects.toThrow(`${DESIGN_MODEL_ENV}=${OVERRIDE}`);
  });
});

/**
 * A reasoning model bills its hidden reasoning against max_completion_tokens.
 * This stub spends REASONING_SPEND tokens thinking first (gpt-5.5 defaults to
 * medium effort) and returns the answer only if the limit leaves room for it,
 * else an empty message with finish_reason "length" — what OpenAI returns
 * when reasoning exhausts the limit. Every vision site must still get its answer.
 */
describe("vision budgets leave room for reasoning", () => {
  const REASONING_SPEND = 6000;
  const reasoningStub = (answer: string) => (url: string) => {
    const limit = calls[calls.length - 1].body.max_completion_tokens as number;
    const starved = limit < REASONING_SPEND + 50;
    const message = { content: starved ? "" : answer };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: starved ? "length" : "stop" }] }), { status: 200 });
  };

  test("check, diff, memory, design-to-code and evolve analysis all answer", async () => {
    stubFetch(reasoningStub("PASS"));
    expect(await checkMockup(path.join(dir, "shot.png"), "brief")).toEqual({ pass: true, status: "pass", issues: "" });
    stubFetch(reasoningStub(JSON.stringify({ differences: [], summary: "same", matchScore: 100 })));
    expect((await diffMockups(path.join(dir, "shot.png"), path.join(dir, "shot.png"))).matchScore).toBe(100);
    stubFetch(reasoningStub(JSON.stringify({ colors: [], typography: [], spacing: [], layout: [], mood: "calm" })));
    expect((await extractDesignLanguage(path.join(dir, "shot.png"))).mood).toBe("calm");
    const d2c = { implementationPrompt: "build it", colors: [], typography: [], layout: [], components: [] };
    stubFetch(reasoningStub(JSON.stringify(d2c)));
    expect(await generateDesignToCodePrompt(path.join(dir, "shot.png"))).toEqual(d2c);
    stubFetch((u) => (u.endsWith("/v1/responses") ? ok(u) : reasoningStub("a centered card")(u)));
    await evolve({ screenshot: path.join(dir, "shot.png"), brief: "darker", output: path.join(dir, "e.png") });
    expect(calls[calls.length - 1].body.input).toContain("a centered card");
  });
});
