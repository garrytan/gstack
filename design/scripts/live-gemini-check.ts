/**
 * Live check of the design binary's Gemini defaults (#990). Free model
 * lookups first (models.get for both default ids), then one image and one
 * short vision answer, which cost real money (about $0.04).
 *
 *   GEMINI_API_KEY=... bun run design/scripts/live-gemini-check.ts
 *
 * Sends exactly the requests the design commands send (built by
 * design/src/provider.ts) with the DEFAULT models: GSTACK_DESIGN_MODEL and
 * GSTACK_DESIGN_IMAGE_MODEL are ignored. Prints status, models and PASS/FAIL
 * per call, never the key; key-shaped text in an error body is redacted.
 * Exit 0 all pass, 1 any fail, 2 GEMINI_API_KEY unset (a skip that checked
 * nothing, to be recorded with no coverage credit).
 */

import { DESIGN_IMAGE_MODEL_ENV, DESIGN_MODEL_ENV, GEMINI_DEFAULT_MODELS } from "../src/models";
import { GEMINI_API_BASE, imageRequest, readImage, visionRequest, type DesignRequest } from "../src/provider";
import { DESIGN_RECEIPTS, receiptedFetch } from "../src/receipted-fetch";

for (const name of [DESIGN_MODEL_ENV, DESIGN_IMAGE_MODEL_ENV]) delete process.env[name];
console.log(`testing Gemini defaults: image=${GEMINI_DEFAULT_MODELS.image} vision=${GEMINI_DEFAULT_MODELS.vision}`);

const key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  console.log("SKIP: GEMINI_API_KEY is not set; the Gemini defaults were not checked (no coverage)");
  process.exit(2);
}
const gemini = { provider: "gemini" as const, key, source: "GEMINI_API_KEY environment variable" };
const redact = (s: string) => s.replace(/\bAIza[0-9A-Za-z_-]{10,}/g, "[redacted]").slice(0, 400);
let failed = false;
const report = (call: string, ok: boolean, detail: string) => {
  if (!ok) failed = true;
  console.log(`call=${call} result=${ok ? "PASS" : "FAIL"} ${redact(detail)}`);
};

async function send(payloadClass: string, request: DesignRequest, timeoutMs: number) {
  try {
    const res = await receiptedFetch(payloadClass, request.url, { ...request.init, signal: AbortSignal.timeout(timeoutMs) }, globalThis.fetch, request.receipt);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { status: res.status, ok: res.ok, json, text };
  } catch (err) {
    return { status: 0, ok: false, json: null, text: (err as Error).message };
  }
}

for (const model of Object.values(GEMINI_DEFAULT_MODELS)) {
  const res = await receiptedFetch("live-check-models-get", `${GEMINI_API_BASE}/models/${model}`,
    { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(30_000) }, globalThis.fetch, DESIGN_RECEIPTS.gemini).catch(err => err as Error);
  if (res instanceof Error) report(`models.get ${model}`, false, res.message);
  else report(`models.get ${model}`, res.ok, `status=${res.status}${res.ok ? "" : ` body=${await res.text()}`}`);
}

const image = await send("live-check-image-request", imageRequest(gemini, { prompt: "Draw a plain blue square on a white background.", size: "1024x1024", quality: "low" }), 240_000);
let png: string | null = null;
try {
  png = image.ok ? readImage(gemini, image.json)?.imageData ?? null : null;
  report("image", png !== null, `status=${image.status} bytes=${png ? Buffer.from(png, "base64").length : 0}${image.ok ? "" : ` body=${image.text}`}`);
} catch (err) {
  report("image", false, `status=${image.status} ${(err as Error).message}`);
}

const vision = await send("live-check-vision-request", visionRequest(gemini, [{
  role: "user",
  content: [
    { type: "image_url", image_url: { url: `data:image/png;base64,${png ?? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII="}` } },
    { type: "text", text: "Name the main color in this image in one word." },
  ],
}], 20), 60_000);
const answer = vision.json?.choices?.[0]?.message?.content?.trim();
report("vision", vision.ok && !!answer, `status=${vision.status} model=${vision.json?.model ?? "?"} answer=${answer ?? vision.text}`);

process.exit(failed ? 1 : 0);
