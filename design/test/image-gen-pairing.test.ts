import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  DEFAULT_DESIGN_MODELS,
  DESIGN_IMAGE_MODEL_ENV,
  DESIGN_MODEL_ENV,
  IMAGE_TOOL_MODEL,
  imagePairingProblem,
  imageRequestBody,
  imageToolModel,
} from "../src/models";

// Tripwire for the image_generation orchestrator/tool pairing.
//
// History: v1.43.2.0 (66f3a180) pinned the tool to `gpt-image-2` under a
// `gpt-4o` orchestrator, a 400 on the Responses API that took every image
// command offline (#1771); v1.64.0.0 (#2571) dropped the pin, which made the
// tool fall back to `gpt-image-1`. OpenAI shuts gpt-image-1 down on
// 2026-10-23 (replacement: gpt-image-2), so an unpinned tool is a dead
// pairing too (#2807).
//
// The contract now: every image call goes through models.ts's
// imageRequestBody(), which pins the tool to IMAGE_TOOL_MODEL (gpt-image-2)
// under a gpt-5-class orchestrator and refuses, before sending, an
// orchestrator that cannot drive it (gpt-4o and older).
// design/test/models.test.ts drives each of the five call sites and checks
// the body each one actually sends.

const DESIGN_SRC = path.join(import.meta.dir, "..", "src");
const sources = fs
  .readdirSync(DESIGN_SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ rel: `src/${f}`, body: fs.readFileSync(path.join(DESIGN_SRC, f), "utf-8") }));

const savedOverride = process.env[DESIGN_MODEL_ENV];
const savedImageOverride = process.env[DESIGN_IMAGE_MODEL_ENV];
afterEach(() => {
  if (savedOverride === undefined) delete process.env[DESIGN_MODEL_ENV];
  else process.env[DESIGN_MODEL_ENV] = savedOverride;
  if (savedImageOverride === undefined) delete process.env[DESIGN_IMAGE_MODEL_ENV];
  else process.env[DESIGN_IMAGE_MODEL_ENV] = savedImageOverride;
});

describe("design image-generation tool/orchestrator pairing (#1771, #2807)", () => {
  test("the default pairing is a gpt-5-class orchestrator with the tool pinned to gpt-image-2", () => {
    delete process.env[DESIGN_MODEL_ENV];
    expect(DEFAULT_DESIGN_MODELS.image).toMatch(/^gpt-(?:5|6)/);
    expect(IMAGE_TOOL_MODEL).toBe("gpt-image-2");
    expect(imagePairingProblem(DEFAULT_DESIGN_MODELS.image)).toBeNull();
    const body = JSON.parse(imageRequestBody("a login page", { size: "1536x1024", quality: "high" }));
    expect(body.model).toBe(DEFAULT_DESIGN_MODELS.image);
    expect(body.tools).toEqual([{ type: "image_generation", model: "gpt-image-2", size: "1536x1024", quality: "high" }]);
  });

  test("gpt-4o (and older) + gpt-image-2 is refused before any request, naming GSTACK_DESIGN_MODEL", () => {
    for (const old of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "chatgpt-4o-latest"]) {
      expect(imagePairingProblem(old)).toContain(DESIGN_MODEL_ENV);
      process.env[DESIGN_MODEL_ENV] = old;
      expect(() => imageRequestBody("x", { size: "1024x1024", quality: "low" })).toThrow(DESIGN_MODEL_ENV);
    }
    process.env[DESIGN_MODEL_ENV] = "gpt-5.6-sol";
    expect(() => imageRequestBody("x", { size: "1024x1024", quality: "low" })).not.toThrow();
  });

  for (const { rel, body } of sources.filter((s) => s.rel !== "src/models.ts")) {
    test(`${rel}: image calls pin the tool model through imageRequestBody`, () => {
      // An image_generation tool spec written outside models.ts could omit the
      // tool model (→ gpt-image-1) or pair it with an old orchestrator.
      expect(/type:\s*["'`]image_generation["'`]/.test(body), `${rel} builds its own image_generation tool spec`).toBe(false);
      expect(body.includes(`model: "gpt-image-`), `${rel} pins an image model outside models.ts`).toBe(false);
      if (body.includes("/v1/responses")) {
        expect(body.includes("imageRequestBody("), `${rel} calls the Responses API without imageRequestBody()`).toBe(true);
      }
    });
  }
});

// E5: users switch the tool model without editing code; a bad value fails
// before any request, naming the variable; the live check always tests the
// defaults, and a missing key is a skip, never a pass.
describe("GSTACK_DESIGN_IMAGE_MODEL override (E5)", () => {
  const body = () => JSON.parse(imageRequestBody("x", { size: "1024x1024", quality: "low" }));

  test("a gpt-image model name replaces the tool model; blank means the default", () => {
    delete process.env[DESIGN_MODEL_ENV];
    for (const model of ["gpt-image-1.5", "gpt-image-2-mini", "gpt-image-3"]) {
      process.env[DESIGN_IMAGE_MODEL_ENV] = ` ${model} `;
      expect(body().tools[0].model).toBe(model);
    }
    process.env[DESIGN_IMAGE_MODEL_ENV] = "   ";
    expect(body().tools[0].model).toBe(IMAGE_TOOL_MODEL);
    expect(imageToolModel({})).toBe(IMAGE_TOOL_MODEL);
  });

  test("anything else is refused before a request, naming the variable", () => {
    for (const bad of ["dall-e-3", "gpt-5.5", "GPT-IMAGE-2", "gpt-image-2 --x", 'gpt-image-2"}', "gpt-image-", `gpt-image-2${"a".repeat(40)}`]) {
      process.env[DESIGN_IMAGE_MODEL_ENV] = bad;
      expect(() => body()).toThrow(`${DESIGN_IMAGE_MODEL_ENV}=`);
      expect(() => imageToolModel()).toThrow(`unset it to use ${IMAGE_TOOL_MODEL}`);
    }
  });

  test("the pairing refusal names the tool model actually requested", () => {
    process.env[DESIGN_MODEL_ENV] = "gpt-4o";
    process.env[DESIGN_IMAGE_MODEL_ENV] = "gpt-image-1.5";
    expect(() => body()).toThrow("cannot drive the gpt-image-1.5 image_generation tool");
  });
});

describe("live-model-check always tests the defaults (E5)", () => {
  const script = path.join(import.meta.dir, "..", "scripts", "live-model-check.ts");
  const run = (env: Record<string, string>) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "design-live-check-"));
    try {
      return spawnSync(process.execPath, ["run", script], {
        encoding: "utf8", timeout: 60_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GSTACK_HOME: home, ...env },
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  const overrides = { [DESIGN_MODEL_ENV]: "gpt-4.1", [DESIGN_IMAGE_MODEL_ENV]: "gpt-image-1" };

  test("no key: exit 2 with a no-coverage SKIP line, after naming the ignored overrides", () => {
    const r = run(overrides);
    expect(r.status).toBe(2);
    expect(r.stdout.trim().split("\n")).toEqual([
      `testing defaults: image=${DEFAULT_DESIGN_MODELS.image} tool=${IMAGE_TOOL_MODEL} vision=${DEFAULT_DESIGN_MODELS.vision} (ignored: ${DESIGN_MODEL_ENV}, ${DESIGN_IMAGE_MODEL_ENV})`,
      "SKIP: OPENAI_API_KEY is not set; the design model defaults were not checked (no coverage)",
    ]);
  });

  test("with a key, the requests carry the defaults even when overrides are set", () => {
    // An unreachable proxy fails both calls locally: no request leaves the machine.
    const r = run({ ...overrides, OPENAI_API_KEY: "sk-test-not-a-real-key", HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" });
    expect(r.status).toBe(1);
    const image = r.stdout.split("\n").find((l) => l.startsWith("call=image")) ?? "";
    const vision = r.stdout.split("\n").find((l) => l.startsWith("call=vision")) ?? "";
    expect(image).toContain(`requested_model=${DEFAULT_DESIGN_MODELS.image}`);
    expect(image).toContain(`tool_model=${IMAGE_TOOL_MODEL}`);
    expect(vision).toContain(`requested_model=${DEFAULT_DESIGN_MODELS.vision}`);
    expect(r.stdout).not.toContain("sk-test-not-a-real-key");
  });
});
