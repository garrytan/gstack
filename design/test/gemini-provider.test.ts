/**
 * Gemini as the design binary's second image provider (#990), with every
 * provider call answered by a fake fetch (no network, no spend). Request and
 * response shapes follow Google's documented examples:
 * https://ai.google.dev/gemini-api/docs/image-generation (generateContent,
 * inlineData parts, imageConfig.aspectRatio) and
 * https://ai.google.dev/gemini-api/docs/openai (Chat Completions on
 * /v1beta/openai/). Not checked against the live API.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProvider, requireProvider, saveApiKey } from "../src/auth";
import { checkMockup } from "../src/check";
import { DESIGN_IMAGE_MODEL_ENV, DESIGN_MODEL_ENV, GEMINI_DEFAULT_MODELS, geminiModel } from "../src/models";
import { DesignImageError, geminiFailure, imageRequest, readImage } from "../src/provider";
import { generateVariant } from "../src/variants";
import { iterate } from "../src/iterate";
import { listReceipts } from "../../lib/egress-receipt";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
const GEMINI_KEY = "AIzaFixtureNotARealKey0000000000000000";
const ENV_KEYS = ["HOME", "GSTACK_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY", "GSTACK_DESIGN_PROVIDER", DESIGN_MODEL_ENV, DESIGN_IMAGE_MODEL_ENV];

/** Google's documented generateContent answer: candidates[0].content.parts with an inlineData image. */
const geminiImage = (data = TINY_PNG, mimeType = "image/png") => ({
  candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType, data } }] }, finishReason: "STOP" }],
  responseId: "gemini-resp-1",
});

interface Call { url: string; headers: Record<string, string>; body: any }
let calls: Call[];
let errors: string[];
let dir: string;
const saved: Record<string, string | undefined> = {};
const savedFetch = globalThis.fetch;
const savedConsoleError = console.error;
const savedConsoleLog = console.log;

function stubFetch(reply: (url: string, n: number) => Response) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, headers: { ...init?.headers }, body: JSON.parse(String(init?.body)) });
    return reply(url, calls.length);
  }) as typeof globalThis.fetch;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

beforeEach(() => {
  calls = [];
  errors = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-gemini-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.HOME = dir;
  process.env.GSTACK_HOME = dir;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  console.log = () => {};
  fs.writeFileSync(path.join(dir, "shot.png"), Buffer.from(TINY_PNG, "base64"));
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  console.error = savedConsoleError;
  console.log = savedConsoleLog;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("bug proof: a Gemini key alone makes a real mockup (#990)", () => {
  // Value: protects=a user with only GEMINI_API_KEY gets a PNG instead of "No OpenAI API key found" and a wireframe;
  //   fails_when=the design binary is OpenAI-only again; why_new=#990 (12 reactions); seam=fetch preload stub
  test("$D generate with only GEMINI_API_KEY saves the image, sends the documented request and receipts design-gemini", () => {
    const preload = path.join(dir, "stub.ts");
    const log = path.join(dir, "requests.jsonl");
    fs.writeFileSync(preload, `import { appendFileSync } from "node:fs";
globalThis.fetch = (async (url: unknown, init: any) => {
  appendFileSync(process.env.REQUESTS!, JSON.stringify({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(String(init?.body)) }) + "\\n");
  return Response.json(${JSON.stringify(geminiImage())});
}) as typeof fetch;
`);
    const out = path.join(dir, "mock.png");
    const r = spawnSync(process.execPath, ["--no-env-file", "--preload", preload, path.join(import.meta.dir, "..", "src", "cli.ts"),
      "generate", "--brief", "a settings page", "--output", out], {
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: process.env.PATH!, HOME: dir, GSTACK_HOME: path.join(dir, "state"), TMPDIR: dir, GEMINI_API_KEY: GEMINI_KEY, REQUESTS: log },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(out).toString("base64")).toBe(TINY_PNG);
    expect(r.stderr).toContain("Using Gemini key from GEMINI_API_KEY environment variable.");
    expect(r.stderr).toContain("Gemini API prompts and images may be used to improve Google's products");
    const [req] = fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(req.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent");
    expect(req.headers["x-goog-api-key"]).toBe(GEMINI_KEY);
    expect(req.url).not.toContain(GEMINI_KEY);
    expect(req.body).toEqual({
      contents: [{ role: "user", parts: [{ text: "a settings page" }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:2" } },
    });
    const receipts = listReceipts(path.join(dir, "state"));
    expect(receipts.map(x => [x.sink, x.host, x.payload_class])).toEqual([["design-gemini", "generativelanguage.googleapis.com", "generate-image-request"]]);
    expect(fs.readFileSync(path.join(dir, "state", "security", "egress.jsonl"), "utf8")).not.toContain(GEMINI_KEY);
  });
});

describe("$D setup reaches Gemini without a terminal", () => {
  const cli = (args: string[], env: Record<string, string>, input?: string) => {
    const preload = path.join(dir, "setup-stub.ts");
    fs.writeFileSync(preload, `globalThis.fetch = (async (url: unknown) => {
  if (!String(url).includes("generativelanguage.googleapis.com")) return new Response("wrong provider", { status: 500 });
  return Response.json(${JSON.stringify(geminiImage())});
}) as typeof fetch;
`);
    return spawnSync(process.execPath, ["--no-env-file", "--preload", preload, path.join(import.meta.dir, "..", "src", "cli.ts"), "setup", ...args], {
      encoding: "utf8", timeout: 60_000, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH!, HOME: dir, GSTACK_HOME: path.join(dir, "state"), TMPDIR: dir, ...env },
    });
  };

  // Value: protects=an agent running $D setup with no terminal gets a one-line Fix instead of a hang or a bare "Invalid key";
  //   fails_when=setup prompts on a closed stdin again; why_new=DX review F1; seam=none
  test("no key, no terminal: exits 1 at once with a Fix line naming --key-stdin", () => {
    const r = cli([], {});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Fix: printf %s \"$KEY\" | $D setup --provider gemini --key-stdin");
  });

  // Value: protects=a user whose OPENAI_API_KEY is unverified can still store and smoke-test a Gemini key;
  //   fails_when=setup skips to the existing OpenAI key; why_new=DX review F9; seam=fetch preload stub
  test("--provider gemini --key-stdin stores the Gemini key (0600) and smoke-tests Gemini even with OPENAI_API_KEY set", () => {
    const r = cli(["--provider", "gemini", "--key-stdin"], { OPENAI_API_KEY: "sk-unverified" }, GEMINI_KEY);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Key saved to ~/.gstack/gemini.json (0600 permissions).");
    expect(r.stdout).toContain("Smoke test PASSED.");
    const file = path.join(dir, ".gstack", "gemini.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ api_key: GEMINI_KEY });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(r.stdout + r.stderr).not.toContain(GEMINI_KEY);
    expect(r.stdout).toContain("Note: later $D runs will not use this Gemini key yet; OpenAI is picked first.\nFix: export GSTACK_DESIGN_PROVIDER=gemini");
  });

  // Value: protects=a piped key is never silently dropped because another provider's key already resolves;
  //   fails_when=--key-stdin without --provider smoke-tests the existing key and saves nothing; why_new=/ship review; seam=fetch preload stub
  test("--key-stdin without --provider stores the piped Gemini key even with OPENAI_API_KEY set", () => {
    const r = cli(["--key-stdin"], { OPENAI_API_KEY: "sk-unverified" }, GEMINI_KEY);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".gstack", "gemini.json"), "utf8"))).toEqual({ api_key: GEMINI_KEY });
    expect(r.stdout).toContain("Fix: export GSTACK_DESIGN_PROVIDER=gemini");
  });

  test("no switch line when the saved key is the one later runs pick", () => {
    const r = cli(["--provider", "gemini", "--key-stdin"], {}, GEMINI_KEY);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("GSTACK_DESIGN_PROVIDER");
  });
});

describe("provider selection is one fixed order", () => {
  const pick = () => resolveProvider()?.provider ?? null;

  test("no key: null; OpenAI only: openai; Gemini only: gemini; both: openai", () => {
    expect(pick()).toBeNull();
    process.env.OPENAI_API_KEY = "sk-env";
    expect(pick()).toBe("openai");
    Object.assign(process.env, { GEMINI_API_KEY: GEMINI_KEY });
    expect(pick()).toBe("openai");
    delete process.env.OPENAI_API_KEY;
    expect(pick()).toBe("gemini");
  });

  test("config files count like env keys, and ~/.gstack/gemini.json wins over GEMINI_API_KEY", () => {
    saveApiKey("AIzaFromConfigFile00000000000000000000", "gemini");
    Object.assign(process.env, { GEMINI_API_KEY: GEMINI_KEY });
    expect(resolveProvider()).toMatchObject({ provider: "gemini", key: "AIzaFromConfigFile00000000000000000000", source: "~/.gstack/gemini.json" });
    expect(fs.statSync(path.join(dir, ".gstack", "gemini.json")).mode & 0o777).toBe(0o600);
    saveApiKey("sk-config");
    expect(resolveProvider()).toMatchObject({ provider: "openai", source: "~/.gstack/openai.json" });
  });

  test("GSTACK_DESIGN_PROVIDER overrides the order either way", () => {
    process.env.OPENAI_API_KEY = "sk-env";
    Object.assign(process.env, { GEMINI_API_KEY: GEMINI_KEY });
    process.env.GSTACK_DESIGN_PROVIDER = "gemini";
    expect(pick()).toBe("gemini");
    process.env.GSTACK_DESIGN_PROVIDER = "OpenAI";
    expect(pick()).toBe("openai");
  });

  test("an override naming a provider with no key, or no provider at all, fails before any request with a Fix line", () => {
    Object.assign(process.env, { GEMINI_API_KEY: GEMINI_KEY });
    process.env.GSTACK_DESIGN_PROVIDER = "openai";
    expect(() => resolveProvider()).toThrow(/GSTACK_DESIGN_PROVIDER=openai but no OpenAI key was found[\s\S]*\nFix: .*#design-provider-no-key/);
    process.env.GSTACK_DESIGN_PROVIDER = "grok";
    expect(() => resolveProvider()).toThrow(/is not a design provider \(expected openai or gemini\)[\s\S]*#design-provider-invalid/);
  });

  test("no key at all: the error names both providers and ends with a Fix line", () => {
    expect(() => requireProvider()).toThrow(/^No image API key found \(OpenAI or Gemini\)\.[\s\S]*aistudio\.google\.com\/apikey[\s\S]*\nFix: [^\n]*#design-no-image-key$/);
  });
});

describe("Gemini responses", () => {
  const gemini = { provider: "gemini" as const, key: GEMINI_KEY, source: "test" };

  test("a safety block, a text-only answer and a non-PNG image are non-retryable; an empty normal answer is null", () => {
    const err = (data: unknown) => { try { readImage(gemini, data); } catch (e) { return e; } return null; };
    const blocked = err({ promptFeedback: { blockReason: "SAFETY" } });
    expect(blocked).toBeInstanceOf(DesignImageError);
    expect((blocked as DesignImageError).retryable).toBe(false);
    expect((err({ candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }] }) as Error).message).toContain("IMAGE_SAFETY");
    expect((err({ candidates: [{ content: { parts: [{ text: "I can't draw that." }] }, finishReason: "STOP" }] }) as Error).message).toContain("I can't draw that.");
    expect((err(geminiImage(TINY_PNG, "image/jpeg")) as Error).message).toContain("image/jpeg, not a PNG");
    expect(readImage(gemini, { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })).toBeNull();
    expect(readImage(gemini, { candidates: [{ content: { parts: [{ text: "here" }, { inline_data: { mime_type: "image/png", data: TINY_PNG } }] } }] }))
      .toMatchObject({ imageData: TINY_PNG });
  });

  test("a rejected key says how to fix it and never echoes the key", () => {
    const body = JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } });
    const failure = geminiFailure(gemini, 400, body, "image");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/\nFix: create a key at https:\/\/aistudio\.google\.com\/apikey .*#design-gemini-key-rejected$/);
    expect(failure.message).not.toContain(GEMINI_KEY);
  });

  test("a model override that is not a gemini- name fails before any request, naming the variable", () => {
    process.env[DESIGN_MODEL_ENV] = "gpt-5.5";
    expect(() => geminiModel("vision")).toThrow(/GSTACK_DESIGN_MODEL="gpt-5.5" is not a Gemini model name/);
    process.env[DESIGN_IMAGE_MODEL_ENV] = "gemini-3-pro-image";
    expect(geminiModel("image")).toBe("gemini-3-pro-image");
    expect(imageRequest(gemini, { prompt: "p", size: "1024x1536", quality: "high" }).url).toContain("/models/gemini-3-pro-image:generateContent");
    expect(() => imageRequest(gemini, { prompt: "p", size: "800x600", quality: "high" })).toThrow(/--size 800x600 has no Gemini aspect ratio/);
  });
});

describe("Gemini through the call sites", () => {
  const gemini = { provider: "gemini" as const, key: GEMINI_KEY, source: "test" };

  test("variants: a safety block is paid for once, never retried", async () => {
    stubFetch(() => json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }));
    const r = await generateVariant(gemini, "p", path.join(dir, "v.png"), "1536x1024", "high");
    expect(r).toMatchObject({ success: false, retryable: false });
    expect(r.error).toContain("PROHIBITED_CONTENT");
    expect(calls.length).toBe(1);
  });

  test("variants: a 429 waits Gemini's RetryInfo delay; a daily quota stops at once and names billing", async () => {
    const quota = (details: unknown[]) => json({ error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED", details } }, 429);
    stubFetch((_url, n) => n === 1 ? quota([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0s" }]) : json(geminiImage()));
    const ok = await generateVariant(gemini, "p", path.join(dir, "v.png"), "1536x1024", "high");
    expect(ok.success).toBe(true);
    expect(calls.length).toBe(2);

    calls = [];
    stubFetch(() => quota([{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }]));
    const stopped = await generateVariant(gemini, "p", path.join(dir, "w.png"), "1536x1024", "high");
    expect(stopped).toMatchObject({ success: false, retryable: false });
    expect(stopped.error).toContain("enable billing in Google AI Studio");
    expect(calls.length).toBe(1);
  });

  test("check: vision goes to Google's OpenAI-compatible endpoint with the Gemini model, ignoring OPENAI_BASE_URL", async () => {
    process.env.OPENAI_BASE_URL = "https://gateway.example.com/v1";
    stubFetch(() => json({ choices: [{ message: { content: "PASS" } }] }));
    expect(await checkMockup(path.join(dir, "shot.png"), "brief", { apiKey: gemini })).toEqual({ pass: true, status: "pass", issues: "" });
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${GEMINI_KEY}`);
    expect(calls[0].body.model).toBe(GEMINI_DEFAULT_MODELS.vision);
    expect(calls[0].body.messages[0].content[0].image_url.url).toStartWith("data:image/png;base64,");
  });

  test("iterate: a Gemini session edits its last image; an OpenAI or legacy session is refused before any request", async () => {
    Object.assign(process.env, { GEMINI_API_KEY: GEMINI_KEY });
    const session = (provider?: string) => {
      const file = path.join(dir, `session-${provider ?? "legacy"}.json`);
      fs.writeFileSync(file, JSON.stringify({ id: `s-${provider ?? "legacy"}`, ...(provider ? { provider } : {}), lastResponseId: "r0", originalBrief: "brief",
        feedbackHistory: [], outputPaths: [path.join(dir, "shot.png")], createdAt: "", updatedAt: "" }));
      return file;
    };
    stubFetch(() => json(geminiImage()));
    const geminiSession = session("gemini");
    expect(await iterate({ session: geminiSession, feedback: "bigger title", output: path.join(dir, "it.png") })).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0].body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: TINY_PNG } });
    expect(calls[0].body.contents[0].parts[1].text).toContain("<user-feedback>bigger title</user-feedback>");

    calls = [];
    for (const file of [session("openai"), session()]) {
      expect(await iterate({ session: file, feedback: "x", output: path.join(dir, "no.png") })).toBe(2);
    }
    expect(calls.length).toBe(0);
    expect(errors.join("\n")).toContain("was made with openai; the current provider is gemini.\nFix: set GSTACK_DESIGN_PROVIDER=openai");
  });
});

describe("live-gemini-check always tests the defaults", () => {
  const script = path.join(import.meta.dir, "..", "scripts", "live-gemini-check.ts");
  const run = (env: Record<string, string>) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "design-live-gemini-"));
    try {
      return spawnSync(process.execPath, ["--no-env-file", "run", script], {
        encoding: "utf8", timeout: 60_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GSTACK_HOME: home, ...env },
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  const overrides = { [DESIGN_MODEL_ENV]: "gemini-override-vision", [DESIGN_IMAGE_MODEL_ENV]: "gemini-override-image" };
  const banner = `testing Gemini defaults: image=${GEMINI_DEFAULT_MODELS.image} vision=${GEMINI_DEFAULT_MODELS.vision}`;

  test("no key: exit 2 with a no-coverage SKIP line", () => {
    const r = run(overrides);
    expect(r.status).toBe(2);
    expect(r.stdout.trim().split("\n")).toEqual([banner, "SKIP: GEMINI_API_KEY is not set; the Gemini defaults were not checked (no coverage)"]);
  });

  test("with a key, every call uses the defaults, fails locally behind a dead proxy, and never prints the key", () => {
    const r = run({ ...overrides, GEMINI_API_KEY: GEMINI_KEY, HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" });
    expect(r.status).toBe(1);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe(banner);
    expect(lines.slice(1).map(l => l.split(" result=")[0])).toEqual([
      `call=models.get ${GEMINI_DEFAULT_MODELS.image}`, `call=models.get ${GEMINI_DEFAULT_MODELS.vision}`, "call=image", "call=vision",
    ]);
    expect(lines.slice(1).every(l => l.includes("result=FAIL"))).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(GEMINI_KEY);
    expect(r.stdout).not.toContain("gemini-override");
  });
});


describe("Gemini iterate fallbacks", () => {
  const geminiSession = () => {
    Object.assign(process.env, { GEMINI_API_KEY: GEMINI_KEY });
    fs.writeFileSync(path.join(dir, "shot.png"), Buffer.from(TINY_PNG, "base64"));
    const file = path.join(dir, "session-fallback.json");
    fs.writeFileSync(file, JSON.stringify({ id: "s-fb", provider: "gemini", lastResponseId: "r0", originalBrief: "brief",
      feedbackHistory: [], outputPaths: [path.join(dir, "shot.png")], createdAt: "", updatedAt: "" }));
    return file;
  };

  test("a plain 400 on the edit regenerates once without the image; a rejected key never pays twice", async () => {
    const session = geminiSession();
    stubFetch((_url, n) => n === 1 ? json({ error: { code: 400, message: "bad edit", status: "INVALID_ARGUMENT" } }, 400) : json(geminiImage()));
    expect(await iterate({ session, feedback: "x", output: path.join(dir, "fb1.png") })).toBe(0);
    expect(calls.length).toBe(2);
    expect(calls[1].body.contents[0].parts.some((p: any) => p.inlineData)).toBe(false);

    calls = [];
    stubFetch(() => json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } }, 400));
    expect(await iterate({ session, feedback: "x", output: path.join(dir, "fb2.png") })).toBe(2);
    expect(calls.length).toBe(1);
  });

  test("an unreadable last image regenerates from the brief with one call", async () => {
    const session = geminiSession();
    fs.rmSync(path.join(dir, "shot.png"));
    stubFetch(() => json(geminiImage()));
    expect(await iterate({ session, feedback: "x", output: path.join(dir, "fb3.png") })).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0].body.contents[0].parts.some((p: any) => p.inlineData)).toBe(false);
  });
});

describe("Gemini image answers and iterate uploads", () => {
  test("a thinking answer saves the final image, not an interim draft", () => {
    const draft = Buffer.from("draft").toString("base64");
    const final = Buffer.from("final").toString("base64");
    const answer = { candidates: [{ content: { parts: [
      { inlineData: { mimeType: "image/png", data: draft }, thought: true },
      { text: "thinking" },
      { inlineData: { mimeType: "image/png", data: final } },
    ] } }] };
    expect(readImage({ provider: "gemini", key: GEMINI_KEY, source: "test" }, answer)?.imageData).toBe(final);
  });

  test("iterate never uploads a last output that is not a PNG or not an absolute path", async () => {
    Object.assign(process.env, { GEMINI_API_KEY: GEMINI_KEY });
    const secret = path.join(dir, "secret.txt");
    fs.writeFileSync(secret, "api_key=not-an-image");
    for (const [name, last] of [["text", secret], ["relative", "shot.png"]] as const) {
      fs.writeFileSync(path.join(dir, "shot.png"), Buffer.from(TINY_PNG, "base64"));
      const file = path.join(dir, `session-${name}.json`);
      fs.writeFileSync(file, JSON.stringify({ id: `s-${name}`, provider: "gemini", lastResponseId: "r0", originalBrief: "brief",
        feedbackHistory: [], outputPaths: [last], createdAt: "", updatedAt: "" }));
      calls = [];
      stubFetch(() => json(geminiImage()));
      expect(await iterate({ session: file, feedback: "x", output: path.join(dir, `${name}-out.png`) })).toBe(0);
      expect(calls.length).toBe(1);
      expect(calls[0].body.contents[0].parts.some((p: any) => p.inlineData)).toBe(false);
    }
    expect(errors.join("\n")).toContain("(not a PNG); regenerating");
    expect(errors.join("\n")).toContain("(relative path); regenerating");
  });
});
