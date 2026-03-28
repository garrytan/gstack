/**
 * Multi-turn design iteration using OpenAI Responses API.
 *
 * Primary: uses previous_response_id for conversational threading.
 * Fallback: if threading doesn't retain visual context, re-generates
 * with original brief + accumulated feedback in a single prompt.
 */

import fs from "fs";
import path from "path";
import { requireApiKey } from "./auth";
import { readSession, updateSession } from "./session";

export interface IterateOptions {
  session: string;   // Path to session JSON file
  feedback: string;  // User feedback text
  output: string;    // Output path for new PNG
}

/**
 * Iterate on an existing design using session state.
 */
export async function iterate(options: IterateOptions): Promise<void> {
  const apiKey = requireApiKey();
  const session = readSession(options.session);

  console.error(`Iterating on session ${session.id}...`);
  console.error(`  Previous iterations: ${session.feedbackHistory.length}`);
  console.error(`  Feedback: "${options.feedback}"`);

  const startTime = Date.now();

  // Try multi-turn with previous_response_id first
  let success = false;
  let responseId = "";

  try {
    const result = await callWithThreading(apiKey, session.lastResponseId, options.feedback);
    responseId = result.responseId;

    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, Buffer.from(result.imageData, "base64"));
    success = true;
  } catch (err: any) {
    console.error(`  Threading failed: ${err.message}`);
    console.error("  Falling back to re-generation with accumulated feedback...");

    // Fallback: re-generate with original brief + all feedback
    const accumulatedPrompt = buildAccumulatedPrompt(
      session.originalBrief,
      [...session.feedbackHistory, options.feedback]
    );

    const result = await callFresh(apiKey, accumulatedPrompt);
    responseId = result.responseId;

    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, Buffer.from(result.imageData, "base64"));
    success = true;
  }

  if (success) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const size = fs.statSync(options.output).size;
    console.error(`Generated (${elapsed}s, ${(size / 1024).toFixed(0)}KB) → ${options.output}`);

    // Update session
    updateSession(session, responseId, options.feedback, options.output);

    console.log(JSON.stringify({
      outputPath: options.output,
      sessionFile: options.session,
      responseId,
      iteration: session.feedbackHistory.length + 1,
    }, null, 2));
  }
}

async function callWithThreading(
  apiKey: string,
  previousResponseId: string,
  feedback: string,
): Promise<{ responseId: string; imageData: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: `Based on the previous design, make these changes: ${feedback}`,
        previous_response_id: previousResponseId,
        tools: [{ type: "image_generation", size: "1536x1024", quality: "high" }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error (${response.status}): ${error.slice(0, 300)}`);
    }

    const data = await response.json() as any;
    const imageItem = data.output?.find((item: any) => item.type === "image_generation_call");

    if (!imageItem?.result) {
      throw new Error("No image data in threaded response");
    }

    return { responseId: data.id, imageData: imageItem.result };
  } finally {
    clearTimeout(timeout);
  }
}

async function callFresh(
  apiKey: string,
  prompt: string,
): Promise<{ responseId: string; imageData: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: prompt,
        tools: [{ type: "image_generation", size: "1536x1024", quality: "high" }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error (${response.status}): ${error.slice(0, 300)}`);
    }

    const data = await response.json() as any;
    const imageItem = data.output?.find((item: any) => item.type === "image_generation_call");

    if (!imageItem?.result) {
      throw new Error("No image data in fresh response");
    }

    return { responseId: data.id, imageData: imageItem.result };
  } finally {
    clearTimeout(timeout);
  }
}

function buildAccumulatedPrompt(originalBrief: string, feedback: string[]): string {
  const lines = [
    originalBrief,
    "",
    "Previous feedback (apply all of these changes):",
  ];

  feedback.forEach((f, i) => {
    lines.push(`${i + 1}. ${f}`);
  });

  lines.push(
    "",
    "Generate a new mockup incorporating ALL the feedback above.",
    "The result should look like a real production UI, not a wireframe."
  );

  return lines.join("\n");
}
