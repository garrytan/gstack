/**
 * Generate N design variants from a brief.
 * Uses staggered parallel: 1s delay between API calls to avoid rate limits.
 * Falls back to exponential backoff on 429s.
 */

import fs from "fs";
import path from "path";
import { openaiUrl, requireApiKey } from "./auth";
import { receiptedFetch } from "./receipted-fetch";
import { imageRequestBody, modelRejectionHint } from "./models";
import { parseBrief } from "./brief";
import { normalizeIntFlag } from "./flag-utils";
import { checkMockup, type CheckResult } from "./check";
import { analyzeScreenshot, evolvePrompt } from "./evolve";
import {
  emitResult,
  exitCodeFor,
  newAccounting,
  persistImage,
  type ExitCode,
  type Recovery,
  type RunAccounting,
} from "./persist";

export interface VariantsOptions {
  brief?: string;
  briefFile?: string;
  /** JSON array of { brief, screenshot? }, one entry per variant. */
  briefsFile?: string;
  /**
   * Raw CLI flag value or a number. Normalized inside variants() (#2032):
   * nonsense errors loudly; above STYLE_VARIATIONS.length clamps with a
   * warning — past that index variants degrade to duplicate base-brief runs.
   */
  count?: number | string | boolean;
  outputDir: string;
  size?: string;
  quality?: string;
  viewports?: string; // "desktop,tablet,mobile" — generates at multiple sizes
}

const STYLE_VARIATIONS = [
  "", // First variant uses the brief as-is
  "Use a bolder, more dramatic visual style with stronger contrast and larger typography.",
  "Use a calmer, more minimal style with generous whitespace and subtle colors.",
  "Use a warmer, more approachable style with rounded corners and friendly typography.",
  "Use a more professional, corporate style with sharp edges and structured grid layout.",
  "Commit to one saturated hue across large surfaces (drenched color) with restrained decoration and texture from the product's material world.",
  "Use a playful, modern style with asymmetric layout and unexpected color accents.",
];

export interface VariantResult {
  requested: string;
  path: string;
  success: boolean;
  error?: string;
  recovered?: Recovery;
  /** Exhausted its 429 retries. */
  rateLimited?: boolean;
  /** A rerun of the same operation could succeed (rate limit, timeout, deadline, 5xx, empty image). */
  retryable?: boolean;
  /** The API returned an empty image; nothing was saved. */
  empty?: boolean;
}

type RequestFailure = { error: string; rateLimited?: boolean; retryable: boolean };

const DEADLINE_ERROR = "Batch deadline reached";

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Request one variant image, retrying only the API call on 429. Returns the
 * base64 image or the final error; nothing here touches the filesystem.
 * `signal` (a batch deadline) stops backoff waits and the request; once it
 * has aborted no new attempt starts.
 */
export async function requestVariantImage(
  apiKey: string,
  prompt: string,
  size: string,
  quality: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<{ imageData: string } | RequestFailure> {
  const maxRetries = 3;
  const MAX_RETRY_AFTER_MS = 60_000; // cap honored Retry-After to bound stalls
  let lastError = "";
  let skipLeadingDelay = false;
  let body: string;
  try {
    body = imageRequestBody(prompt, { size, quality });
  } catch (err: any) {
    return { error: err.message, retryable: false };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && !skipLeadingDelay) {
      // Exponential backoff: 2s, 4s, 8s
      const delay = Math.pow(2, attempt) * 1000;
      console.error(`  Rate limited, retrying in ${delay / 1000}s...`);
      await sleep(delay, signal);
    }
    skipLeadingDelay = false;
    if (signal?.aborted) return { error: DEADLINE_ERROR, retryable: true };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);

    let response: Response;
    try {
      response = await receiptedFetch("variants-image-request", openaiUrl("responses"), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      }, fetchFn);
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === "AbortError") return { error: signal?.aborted ? DEADLINE_ERROR : "Timeout (240s)", retryable: true };
      lastError = err.message;
      continue;
    }
    clearTimeout(timeout);

    if (response.status === 429) {
      lastError = "Rate limited (429)";
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const trimmed = retryAfter.trim();
        let waitMs: number | null = null;
        if (/^\d+$/.test(trimmed)) {
          // delta-seconds (RFC 7231)
          waitMs = Math.min(Number.parseInt(trimmed, 10) * 1000, MAX_RETRY_AFTER_MS);
        } else {
          // HTTP-date (RFC 7231)
          const dateMs = Date.parse(trimmed);
          if (!Number.isNaN(dateMs)) {
            waitMs = Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
          }
        }
        if (waitMs !== null) {
          if (waitMs > 0) {
            await sleep(waitMs, signal);
          }
          // Honored Retry-After (incl. 0 / past date "retry now") — skip the
          // next iteration's leading exponential sleep so we don't double-wait.
          skipLeadingDelay = true;
        }
      }
      continue;
    }

    if (!response.ok) {
      const error = await response.text();
      if (response.status === 403 && error.includes("organization must be verified")) {
        return { error: "OpenAI organization verification required. Go to https://platform.openai.com/settings/organization to verify.", retryable: false };
      }
      return { error: `API error (${response.status}): ${error.slice(0, 200)}${modelRejectionHint(response.status, error, "image")}`, retryable: response.status >= 500 };
    }

    try {
      const data = await response.json() as any;
      const imageItem = data.output?.find((item: any) => item.type === "image_generation_call");
      if (!imageItem?.result) return { error: "No image data in response", retryable: true };
      return { imageData: imageItem.result };
    } catch (err: any) {
      return { error: signal?.aborted ? DEADLINE_ERROR : `Unreadable API response: ${err.message}`, retryable: true };
    }
  }

  return { error: lastError, rateLimited: lastError === "Rate limited (429)", retryable: true };
}

/**
 * Generate a single variant: one API request (with 429 retry), then exactly
 * one persistence attempt on the received bytes. A save failure is reported
 * with its path and never triggers another request.
 *
 * Exported for testability. Pass `fetchFn` to inject a stubbed fetch in tests;
 * production code uses the global fetch by default.
 */
export async function generateVariant(
  apiKey: string,
  prompt: string,
  outputPath: string,
  size: string,
  quality: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<VariantResult> {
  const received = await requestVariantImage(apiKey, prompt, size, quality, fetchFn, signal);
  if ("error" in received) {
    return { requested: outputPath, path: outputPath, success: false, ...received };
  }
  const outcome = persistImage(received.imageData, outputPath);
  if (outcome.ok) return { requested: outputPath, path: outcome.path, success: true };
  return {
    requested: outputPath,
    path: outputPath,
    success: false,
    error: outcome.failure.reason,
    ...(Buffer.from(received.imageData || "", "base64").length === 0 ? { retryable: true, empty: true } : { retryable: false }),
    ...(outcome.recovered ? { recovered: outcome.recovered } : {}),
  };
}

interface VariantJob {
  outputPath: string;
  prompt: string;
  size: string;
  label: string;
}

/** Launch jobs 1.5s apart, wait for all, and fold them into run accounting. */
async function runVariantJobs(apiKey: string, quality: string, jobs: VariantJob[]): Promise<{
  acct: RunAccounting;
  errors: string[];
}> {
  const promises = jobs.map((job, i) =>
    new Promise(resolve => setTimeout(resolve, i * 1500)).then(() => {
      console.error(`  Starting ${job.label}...`);
      return generateVariant(apiKey, job.prompt, job.outputPath, job.size, quality);
    })
  );
  const results = await Promise.allSettled(promises);

  const acct = newAccounting(jobs.length);
  const errors: string[] = [];
  results.forEach((result, i) => {
    const requested = jobs[i].outputPath;
    if (result.status === "fulfilled" && result.value.success) {
      const size = fs.statSync(result.value.path).size;
      console.error(`  ✓ ${path.basename(result.value.path)} (${(size / 1024).toFixed(0)}KB)`);
      acct.saved.push(result.value.path);
      return;
    }
    const reason = result.status === "fulfilled" ? result.value.error || "unknown error" : (result.reason as Error).message;
    console.error(`  ✗ ${path.basename(requested)}: ${reason}`);
    errors.push(path.basename(requested));
    acct.failures.push({ file: requested, reason });
    if (result.status === "fulfilled" && result.value.recovered) acct.recovered.push(result.value.recovered);
  });
  return { acct, errors };
}

function emitVariantsResult(outputDir: string, acct: RunAccounting, errors: string[], extra: Record<string, unknown> = {}, selected: string[] = acct.saved): ExitCode {
  return emitResult({
    outputDir,
    ...extra,
    count: acct.requested,
    succeeded: selected.length,
    failed: errors.length,
    paths: selected,
    errors,
    requested: acct.requested,
    saved: acct.saved,
    selected,
    failures: acct.failures,
    recovered: acct.recovered,
  }, exitCodeFor(selected.length > 0, acct.saved.length));
}

export interface BriefEntry {
  brief: string;
  screenshot?: string;
}

/** One entry per variant; the ceiling matches the built-in style directions. */
export const MAX_BRIEFS = STYLE_VARIATIONS.length;
/** Whole-batch deadline; the skill's Bash call allows 600s. */
export const BATCH_DEADLINE_MS = 540_000;
const STAGGER_MS = 1500;

/**
 * Read and validate a --briefs-file before any billable call. Errors name the
 * file, the entry index and the field.
 */
export function readBriefsFile(file: string): BriefEntry[] {
  const fail = (problem: string): never => { throw new Error(`--briefs-file ${file}: ${problem}`); };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err: any) {
    return fail(`cannot read a JSON array (${err.message})`);
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BRIEFS) {
    return fail(`expected a JSON array of 1 to ${MAX_BRIEFS} entries like [{"brief": "...", "screenshot": "optional.png"}]`);
  }
  return raw.map((entry: any, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`entry ${index}: expected an object with a "brief" field`);
    const unknown = Object.keys(entry).find(key => key !== "brief" && key !== "screenshot");
    if (unknown) fail(`entry ${index}: unknown field "${unknown}" (allowed: brief, screenshot)`);
    if (typeof entry.brief !== "string" || !entry.brief.trim()) fail(`entry ${index}: field "brief" must be a non-empty string`);
    if (entry.screenshot === undefined) return { brief: entry.brief };
    if (typeof entry.screenshot !== "string" || !entry.screenshot) fail(`entry ${index}: field "screenshot" must be a non-empty string`);
    let readable = false;
    try {
      fs.accessSync(entry.screenshot, fs.constants.R_OK);
      readable = fs.statSync(entry.screenshot).isFile();
    } catch {}
    if (!readable) fail(`entry ${index}: field "screenshot" is not a readable file: ${entry.screenshot}`);
    return { brief: entry.brief, screenshot: entry.screenshot };
  });
}

export interface BatchVariant {
  variant: string;
  /** This variant's pick: its last saved image, or the requested name when nothing was saved. */
  path: string;
  /** Every image this variant saved, in order (a failed check's regeneration adds one). */
  saved: string[];
  operation: "generate" | "evolve";
  status: "done" | "failed" | "rate_limited";
  error: string | null;
  retryable: boolean;
  check: { status: CheckResult["status"]; issues: string } | null;
}

export interface BatchOptions {
  apiKey: string;
  outputDir: string;
  size: string;
  quality: string;
  fetchFn?: typeof globalThis.fetch;
  deadlineMs?: number;
  staggerMs?: number;
}

/**
 * Generate one variant per brief with staggered parallel launches under one
 * batch deadline. Every image is saved without overwriting. Each variant
 * repeats its own operation (generate, or evolve when it has a screenshot)
 * once for an empty image and once for a failed check, keeping both images,
 * and always ends with a terminal status.
 */
export async function runBriefsBatch(entries: BriefEntry[], opts: BatchOptions, acct: RunAccounting = newAccounting(entries.length)): Promise<BatchVariant[]> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), opts.deadlineMs ?? BATCH_DEADLINE_MS);
  const signal = controller.signal;

  const runOne = async (entry: BriefEntry, index: number): Promise<BatchVariant> => {
    const variant = String.fromCharCode(65 + index);
    const requested = path.join(opts.outputDir, `variant-${variant}.png`);
    const operation = entry.screenshot ? "evolve" : "generate";
    const saved: string[] = [];
    let attempted = false;
    const finish = (status: BatchVariant["status"], error: string | null, retryable: boolean, check: BatchVariant["check"]): BatchVariant => {
      const pick = saved.at(-1) ?? requested;
      if (error && !attempted) acct.failures.push({ file: requested, reason: error });
      const detail = status === "done" ? `${saved.join(", ")} (check ${check!.status})` : error;
      console.error(`VARIANT_${variant}_${status.toUpperCase()}: ${detail}`);
      return { variant, path: pick, saved, operation, status, error, retryable, check };
    };
    const attempt = async (): Promise<VariantResult> => {
      attempted = true;
      let result: VariantResult;
      if (!entry.screenshot) {
        result = await generateVariant(opts.apiKey, entry.brief, requested, opts.size, opts.quality, fetchFn, signal);
      } else {
        let analysis: string | null = null;
        try {
          analysis = await analyzeScreenshot(opts.apiKey, fs.readFileSync(entry.screenshot).toString("base64"), fetchFn, signal);
        } catch (err: any) {
          result = { requested, path: requested, success: false, error: signal.aborted ? DEADLINE_ERROR : `Screenshot analysis failed: ${err.message}`, retryable: true };
        }
        if (analysis !== null) result = await generateVariant(opts.apiKey, evolvePrompt(analysis, entry.brief), requested, opts.size, opts.quality, fetchFn, signal);
      }
      if (result!.success) {
        saved.push(result!.path);
        acct.saved.push(result!.path);
      } else {
        acct.failures.push({ file: requested, reason: result!.error ?? "unknown error" });
      }
      if (result!.recovered) acct.recovered.push(result!.recovered);
      return result!;
    };
    const check = async (): Promise<NonNullable<BatchVariant["check"]>> => {
      if (signal.aborted) return { status: "skipped", issues: `${DEADLINE_ERROR} before the check` };
      try {
        const result = await checkMockup(saved.at(-1)!, entry.brief, { apiKey: opts.apiKey, fetchFn, signal });
        return { status: result.status, issues: result.issues };
      } catch (err: any) {
        return { status: "skipped", issues: signal.aborted ? `${DEADLINE_ERROR} during the check` : `Check failed to run: ${err.message}` };
      }
    };

    await sleep(index * (opts.staggerMs ?? STAGGER_MS), signal);
    if (signal.aborted) return finish("failed", `${DEADLINE_ERROR} before start`, true, null);
    console.error(`  Starting variant ${variant} (${operation})...`);

    let result = await attempt();
    if (result.empty && !signal.aborted) result = await attempt();
    if (!result.success) return finish(result.rateLimited ? "rate_limited" : "failed", result.error ?? "unknown error", result.retryable ?? true, null);

    let checked = await check();
    if (checked.status === "fail" && !signal.aborted) {
      const regenerated = await attempt();
      if (regenerated.success) checked = await check();
    }
    return finish("done", null, false, checked);
  };

  try {
    return await Promise.all(entries.map(runOne));
  } finally {
    clearTimeout(deadline);
  }
}

async function variantsFromBriefsFile(options: VariantsOptions): Promise<ExitCode> {
  if (typeof options.briefsFile !== "string") throw new Error("--briefs-file needs the path of a JSON file");
  if (options.brief !== undefined || options.briefFile !== undefined || options.viewports !== undefined) {
    throw new Error("--briefs-file cannot be combined with --brief, --brief-file or --viewports; put each variant's brief in the file.");
  }
  const entries = readBriefsFile(options.briefsFile);
  if (options.count !== undefined) console.error(`warning: --count is ignored with --briefs-file; generating ${entries.length} variants, one per entry.`);
  const apiKey = requireApiKey();

  console.error(`Generating ${entries.length} variants from ${options.briefsFile}...`);
  const startTime = Date.now();
  const acct = newAccounting(entries.length);
  const results = await runBriefsBatch(entries, {
    apiKey, outputDir: options.outputDir, size: options.size || "1536x1024", quality: options.quality || "high",
  }, acct);
  const done = results.filter(r => r.status === "done");
  console.error(`\n${done.length}/${results.length} variants generated (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
  return emitVariantsResult(options.outputDir, acct, results.filter(r => r.status !== "done").map(r => path.basename(r.path)), {
    validated: done.filter(r => r.check?.status === "pass").length,
    variants: results,
  }, done.map(r => r.path));
}

/**
 * Generate N variants with staggered parallel execution.
 */
export async function variants(options: VariantsOptions): Promise<ExitCode> {
  if (options.briefsFile !== undefined) return variantsFromBriefsFile(options);
  let apiKey: string;
  let baseBrief: string;
  try {
    apiKey = requireApiKey();
    baseBrief = options.briefFile
      ? parseBrief(options.briefFile, true)
      : parseBrief(options.brief!, false);
  } catch (err: any) {
    const reason = err?.message || String(err);
    console.error(reason);
    const acct = newAccounting(0);
    acct.failures.push({ file: options.outputDir, reason });
    return emitVariantsResult(options.outputDir, acct, []);
  }

  const quality = options.quality || "high";

  // If viewports specified, generate responsive variants instead of style variants
  if (options.viewports) {
    return generateResponsiveVariants(apiKey, baseBrief, options.outputDir, options.viewports, quality);
  }

  // #2032: normalize at the consumption site so every caller (CLI or
  // programmatic) gets the loud-on-nonsense contract; the ceiling derives
  // from STYLE_VARIATIONS so it self-adjusts when styles are added.
  const count = normalizeIntFlag(options.count, {
    name: "count",
    def: 3,
    min: 1,
    max: STYLE_VARIATIONS.length,
  });
  const size = options.size || "1536x1024";

  console.error(`Generating ${count} variants...`);
  const startTime = Date.now();

  const jobs: VariantJob[] = [];
  for (let i = 0; i < count; i++) {
    const variation = STYLE_VARIATIONS[i] || "";
    const letter = String.fromCharCode(65 + i);
    jobs.push({
      outputPath: path.join(options.outputDir, `variant-${letter}.png`),
      prompt: variation ? `${baseBrief}\n\nStyle direction: ${variation}` : baseBrief,
      size,
      label: `variant ${letter}`,
    });
  }

  const { acct, errors } = await runVariantJobs(apiKey, quality, jobs);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n${acct.saved.length}/${count} variants generated (${elapsed}s)`);
  return emitVariantsResult(options.outputDir, acct, errors);
}

const VIEWPORT_CONFIGS: Record<string, { size: string; suffix: string; desc: string }> = {
  desktop: { size: "1536x1024", suffix: "desktop", desc: "Desktop (1536x1024)" },
  tablet: { size: "1024x1024", suffix: "tablet", desc: "Tablet (1024x1024)" },
  mobile: { size: "1024x1536", suffix: "mobile", desc: "Mobile (1024x1536, portrait)" },
};

async function generateResponsiveVariants(
  apiKey: string,
  baseBrief: string,
  outputDir: string,
  viewports: string,
  quality: string,
): Promise<ExitCode> {
  const viewportList = viewports.split(",").map(v => v.trim().toLowerCase());
  const configs = viewportList.map(v => VIEWPORT_CONFIGS[v]).filter(Boolean);

  if (configs.length === 0) {
    const reason = `No valid viewports. Use: desktop, tablet, mobile`;
    console.error(reason);
    const acct = newAccounting(viewportList.length);
    acct.failures.push({ file: outputDir, reason });
    return emitVariantsResult(outputDir, acct, [], { viewports: viewportList });
  }

  console.error(`Generating responsive variants: ${configs.map(c => c.desc).join(", ")}...`);
  const startTime = Date.now();

  const jobs: VariantJob[] = configs.map(config => ({
    outputPath: path.join(outputDir, `responsive-${config.suffix}.png`),
    prompt: `${baseBrief}\n\nViewport: ${config.desc}. Adapt the layout for this screen size. ${
      config.suffix === "mobile" ? "Use a single-column layout, larger touch targets, and mobile navigation patterns." :
      config.suffix === "tablet" ? "Use a responsive layout that works for medium screens." :
      ""
    }`,
    size: config.size,
    label: config.desc,
  }));

  const { acct, errors } = await runVariantJobs(apiKey, quality, jobs);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n${acct.saved.length}/${configs.length} responsive variants generated (${elapsed}s)`);
  return emitVariantsResult(outputDir, acct, errors, { viewports: viewportList });
}
