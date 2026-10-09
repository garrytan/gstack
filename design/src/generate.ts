/**
 * Generate UI mockups via OpenAI Responses API with image_generation tool.
 */

import { openaiUrl, requireApiKey } from "./auth";
import { receiptedFetch } from "./receipted-fetch";
import { imageRequestBody, modelRejectionHint } from "./models";
import { parseBrief } from "./brief";
import { createSession, sessionPath } from "./session";
import { checkMockup } from "./check";
import { emitResult, exitCodeFor, newAccounting, persistImage, recordOutcome, type ExitCode, type RunAccounting } from "./persist";

export interface GenerateOptions {
  brief?: string;
  briefFile?: string;
  output: string;
  check?: boolean;
  retry?: number;
  size?: string;
  quality?: string;
}

export interface GenerateAttempt {
  path: string;
  sessionFile: string;
  responseId: string;
  check?: { pass: boolean; issues: string };
}

export interface GenerateResult extends RunAccounting {
  outputPath: string | null;
  sessionFile: string | null;
  responseId: string | null;
  checkResult?: { pass: boolean; issues: string };
  attempts: GenerateAttempt[];
  selected: string | null;
  exitCode: ExitCode;
}

/**
 * Call OpenAI Responses API with image_generation tool.
 * Returns the response ID and base64 image data.
 */
async function callImageGeneration(
  apiKey: string,
  prompt: string,
  size: string,
  quality: string,
): Promise<{ responseId: string; imageData: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);

  try {
    const response = await receiptedFetch("generate-image-request", openaiUrl("responses"), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: imageRequestBody(prompt, { size, quality }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      if (response.status === 403 && error.includes("organization must be verified")) {
        throw new Error(
          "OpenAI organization verification required.\n"
          + "Go to https://platform.openai.com/settings/organization to verify.\n"
          + "After verification, wait up to 15 minutes for access to propagate.",
        );
      }
      throw new Error(`API error (${response.status}): ${error.slice(0, 200)}${modelRejectionHint(response.status, error, "image")}`);
    }

    const data = await response.json() as any;

    const imageItem = data.output?.find((item: any) =>
      item.type === "image_generation_call"
    );

    if (!imageItem?.result) {
      throw new Error(
        `No image data in response. Output types: ${data.output?.map((o: any) => o.type).join(", ") || "none"}`
      );
    }

    return {
      responseId: data.id,
      imageData: imageItem.result,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate a single mockup from a brief. Every --retry attempt is its own paid
 * image and is saved under its own claimed name before its quality check.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const acct = newAccounting(1);
  const attempts: GenerateAttempt[] = [];
  let selected: GenerateAttempt | null = null;

  try {
    const apiKey = requireApiKey();
    const prompt = options.briefFile
      ? parseBrief(options.briefFile, true)
      : parseBrief(options.brief!, false);
    const size = options.size || "1536x1024";
    const quality = options.quality || "high";
    const maxRetries = options.retry ?? 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        console.error(`Retry ${attempt}/${maxRetries}...`);
      }

      const startTime = Date.now();
      const { responseId, imageData } = await callImageGeneration(apiKey, prompt, size, quality);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      const outcome = persistImage(imageData, options.output);
      const savedPath = recordOutcome(acct, outcome);
      if (!savedPath) break;

      const session = createSession(responseId, prompt, savedPath);
      const entry: GenerateAttempt = { path: savedPath, sessionFile: sessionPath(session.id), responseId };
      attempts.push(entry);
      console.error(`Generated (${elapsed}s, ${outcome.ok ? (outcome.bytes / 1024).toFixed(0) : 0}KB) → ${savedPath}`);

      if (!options.check) {
        selected = entry;
        break;
      }

      const checked = await checkMockup(savedPath, prompt);
      entry.check = checked;
      if (checked.pass) {
        console.error(checked.status === "skipped" ? `Quality check: SKIPPED — ${checked.issues}` : `Quality check: PASS`);
        selected = entry;
        break;
      }
      console.error(`Quality check: FAIL — ${entry.check.issues}`);
      if (attempt < maxRetries) {
        console.error("Will retry...");
      } else {
        selected = entry;
      }
    }
  } catch (err: any) {
    const reason = err?.message || String(err);
    console.error(reason);
    acct.failures.push({ file: options.output, reason });
  }

  const exitCode = exitCodeFor(selected !== null, acct.saved.length);
  const result: GenerateResult = {
    outputPath: selected?.path ?? null,
    sessionFile: selected?.sessionFile ?? null,
    responseId: selected?.responseId ?? null,
    ...(selected?.check ? { checkResult: selected.check } : {}),
    attempts,
    requested: acct.requested,
    saved: acct.saved,
    selected: selected?.path ?? null,
    failures: acct.failures,
    recovered: acct.recovered,
    exitCode,
  };
  const { exitCode: _omit, ...printed } = result;
  emitResult(printed, exitCode);
  return result;
}
