/**
 * Live check of the design binary's OpenAI defaults (#2807, E5). It spends
 * real tokens (one low-quality 1024x1024 image, one short vision answer).
 *
 *   OPENAI_API_KEY=... bun run design/scripts/live-model-check.ts
 *
 * Sends exactly the request bodies the design commands send (built by
 * design/src/models.ts) with the DEFAULT models: GSTACK_DESIGN_MODEL and
 * GSTACK_DESIGN_IMAGE_MODEL are ignored (and named when set), so an override
 * cannot mask a retirement of a default. Prints the models requested and
 * returned, HTTP status, token usage and PASS/FAIL per call — never the key,
 * and any key-shaped text in an error body is redacted.
 * Exit 0 both pass, 1 any fail, 2 OPENAI_API_KEY unset: a skip that checked
 * nothing, which a caller must record as skipped with no coverage credit.
 */

import {
  DESIGN_IMAGE_MODEL_ENV,
  DESIGN_MODEL_ENV,
  designModel,
  imageRequestBody,
  imageToolModel,
  visionRequestBody,
} from "../src/models";
import { openaiUrl } from "../src/auth";
import { receiptedFetch } from "../src/receipted-fetch";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

const ignored = [DESIGN_MODEL_ENV, DESIGN_IMAGE_MODEL_ENV].filter((name) => process.env[name]?.trim());
for (const name of ignored) delete process.env[name];
console.log(`testing defaults: image=${designModel("image")} tool=${imageToolModel()} vision=${designModel("vision")}` +
  (ignored.length ? ` (ignored: ${ignored.join(", ")})` : ""));

const key = process.env.OPENAI_API_KEY?.trim();
if (!key) {
  console.log("SKIP: OPENAI_API_KEY is not set; the design model defaults were not checked (no coverage)");
  process.exit(2);
}

const redact = (s: string) => s.replace(/\b(?:sk|org|proj)-[A-Za-z0-9_*.-]{4,}/g, "[redacted]").slice(0, 400);

async function post(payloadClass: string, url: string, body: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await receiptedFetch(payloadClass, url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { status: res.status, ok: res.ok, json, text, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, ok: false, json: null, text: (err as Error).message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const report = (fields: Record<string, unknown>) =>
  console.log(Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" "));

let failed = false;
let image = TINY_PNG;

// 1. Image generation: Responses API + image_generation tool.
{
  let body: string;
  try {
    body = imageRequestBody("Draw a plain blue square on a white background.", { size: "1024x1024", quality: "low" });
  } catch (err) {
    body = "";
    report({ call: "image", result: "FAIL", error: (err as Error).message });
    failed = true;
  }
  if (body) {
    const r = await post("live-check-image-request", openaiUrl("responses"), body, 240_000);
    const item = r.json?.output?.find((o: any) => o.type === "image_generation_call");
    const pass = r.ok && typeof item?.result === "string" && item.result.length > 0;
    if (pass) image = item.result;
    report({
      call: "image", result: pass ? "PASS" : "FAIL", status: r.status, ms: r.ms,
      requested_model: designModel("image"), returned_model: r.json?.model ?? null,
      tool_model: imageToolModel(), image_bytes: pass ? Buffer.from(item.result, "base64").length : 0,
      ...(pass ? {} : { error: redact(r.json?.error?.message ?? r.text) }),
    });
    failed ||= !pass;
  }
}

// 2. Vision analysis: Chat Completions with an image input.
{
  const body = visionRequestBody([{
    role: "user",
    content: [
      { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
      { type: "text", text: "Reply with exactly one word: PASS." },
    ],
  }], 20);
  const r = await post("live-check-vision-request", openaiUrl("chat/completions"), body, 120_000);
  const choice = r.json?.choices?.[0];
  const content = String(choice?.message?.content ?? "").trim();
  const pass = r.ok && content.length > 0;
  report({
    call: "vision", result: pass ? "PASS" : "FAIL", status: r.status, ms: r.ms,
    requested_model: designModel("vision"), returned_model: r.json?.model ?? null,
    max_completion_tokens: JSON.parse(body).max_completion_tokens, finish_reason: choice?.finish_reason ?? null,
    completion_tokens: r.json?.usage?.completion_tokens ?? null,
    reasoning_tokens: r.json?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    answer: content.slice(0, 40),
    ...(pass ? {} : { error: redact(r.json?.error?.message ?? r.text) }),
  });
  failed ||= !pass;
}

process.exit(failed ? 1 : 0);
