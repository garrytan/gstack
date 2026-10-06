/**
 * The OpenAI models the design binary calls: one place, one override (#2807).
 *
 * Two call types, each with its own default:
 *   - "image":  Responses API (`/v1/responses`) orchestrator driving the
 *     hosted `image_generation` tool — generate, variants, iterate, evolve.
 *   - "vision": Chat Completions (`/v1/chat/completions`) screenshot/mockup
 *     analysis — check, diff, memory, design-to-code, evolve's analysis step.
 *
 * `GSTACK_DESIGN_MODEL` (named like `GSTACK_CODEX_MODEL`) replaces both.
 * `GSTACK_DESIGN_IMAGE_MODEL` replaces the image_generation tool's model; it
 * must look like a gpt-image model name (IMAGE_TOOL_MODEL_PATTERN) and a bad
 * value fails before any request, naming the variable.
 *
 * Defaults (checked against OpenAI's model and deprecation pages, 2026-10):
 * gpt-5.5 lists Chat Completions, image input and the Responses
 * image_generation tool, and has no announced shutdown. The tool's model is
 * pinned to gpt-image-2: an unpinned tool falls back to gpt-image-1, which
 * shuts down 2026-10-23. gpt-image-2 needs a gpt-5-class orchestrator (#1771:
 * gpt-4o + gpt-image-2 is a 400), so an override to an older model fails
 * before any request is sent, naming GSTACK_DESIGN_MODEL.
 *
 * Vision requests carry `max_completion_tokens`, never `max_tokens` (the
 * gpt-5 family rejects it), and that limit covers reasoning tokens too: each
 * call's visible-answer budget gets REASONING_HEADROOM_TOKENS on top, so a
 * reasoning model cannot spend the whole limit thinking and return nothing.
 * The limit is a cap, not a charge — only generated tokens are billed.
 *
 * `bun run design/scripts/live-model-check.ts` probes these defaults with a
 * real key. It always tests the defaults (overrides are ignored), so an
 * override cannot mask a retirement.
 */

export const DESIGN_MODEL_ENV = "GSTACK_DESIGN_MODEL";

export type DesignCall = "image" | "vision";

export const DEFAULT_DESIGN_MODELS: Readonly<Record<DesignCall, string>> = {
  image: "gpt-5.5",
  vision: "gpt-5.5",
};

/** The image model the hosted image_generation tool runs by default; never omitted (the API default is gpt-image-1). */
export const IMAGE_TOOL_MODEL = "gpt-image-2";

export const DESIGN_IMAGE_MODEL_ENV = "GSTACK_DESIGN_IMAGE_MODEL";

/** Conservative shape for an image tool model override: gpt-image-<version>[-variant]. */
export const IMAGE_TOOL_MODEL_PATTERN = /^gpt-image-[0-9][a-z0-9.-]{0,31}$/;

/**
 * The image_generation tool's model: `GSTACK_DESIGN_IMAGE_MODEL` when set,
 * else IMAGE_TOOL_MODEL. Throws, naming the variable, when the override does
 * not match IMAGE_TOOL_MODEL_PATTERN.
 */
export function imageToolModel(env: Record<string, string | undefined> = process.env): string {
  const override = env[DESIGN_IMAGE_MODEL_ENV]?.trim();
  if (!override) return IMAGE_TOOL_MODEL;
  if (!IMAGE_TOOL_MODEL_PATTERN.test(override)) {
    throw new Error(`${DESIGN_IMAGE_MODEL_ENV}=${JSON.stringify(override.slice(0, 80))} is not a gpt-image model name ` +
      `(expected something like ${IMAGE_TOOL_MODEL}); fix it or unset it to use ${IMAGE_TOOL_MODEL}`);
  }
  return override;
}

/** Reasoning allowance added to every vision call's visible-answer budget. */
export const REASONING_HEADROOM_TOKENS = 8192;

/** The model for one call type: `GSTACK_DESIGN_MODEL` when set, else that call type's default. */
export function designModel(call: DesignCall, env: Record<string, string | undefined> = process.env): string {
  return env[DESIGN_MODEL_ENV]?.trim() || DEFAULT_DESIGN_MODELS[call];
}

/** Why `orchestrator` cannot drive the image_generation tool model, or null when it can. */
export function imagePairingProblem(orchestrator: string, toolModel = IMAGE_TOOL_MODEL): string | null {
  if (!/^(?:gpt-4|gpt-3|chatgpt-4o)/i.test(orchestrator)) return null;
  return `${orchestrator} cannot drive the ${toolModel} image_generation tool (OpenAI returns 400 for that pairing); ` +
    `set ${DESIGN_MODEL_ENV} to a gpt-5-class model such as ${DEFAULT_DESIGN_MODELS.image}, or unset it`;
}

/**
 * Responses API body for an image call: the image orchestrator plus the
 * image_generation tool with its model pinned. Throws (before any request)
 * when the orchestrator cannot drive that tool model.
 */
export function imageRequestBody(
  input: string,
  tool: { size: string; quality: string },
  extra: Record<string, unknown> = {},
): string {
  const model = designModel("image");
  const toolModel = imageToolModel();
  const problem = imagePairingProblem(model, toolModel);
  if (problem) throw new Error(problem);
  return JSON.stringify({
    model,
    input,
    ...extra,
    tools: [{ type: "image_generation", model: toolModel, size: tool.size, quality: tool.quality }],
  });
}

/** Chat Completions body for a vision call; `visibleTokens` is the answer's budget, reasoning headroom is added. */
export function visionRequestBody(
  messages: unknown[],
  visibleTokens: number,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    model: designModel("vision"),
    messages,
    max_completion_tokens: visibleTokens + REASONING_HEADROOM_TOKENS,
    ...extra,
  });
}

/**
 * Suffix for an OpenAI error message when the failure is about the model or a
 * parameter the model rejects: names the model sent and `GSTACK_DESIGN_MODEL`,
 * so a rejected override (or a retired default) says how to fix it. Empty for
 * every other failure.
 */
export function modelRejectionHint(status: number, body: string, call: DesignCall): string {
  if (![400, 403, 404].includes(status)) return "";
  if (!/\bmodel\b|unsupported (?:parameter|value)|not supported/i.test(body)) return "";
  const model = designModel(call);
  const source = process.env[DESIGN_MODEL_ENV]?.trim() ? `${DESIGN_MODEL_ENV}=${model}` : `the default model ${model}`;
  if (call !== "image") {
    return ` — OpenAI rejected ${source} for this vision (Chat Completions) call; set ${DESIGN_MODEL_ENV} to a model your account can use for it`;
  }
  const toolOverride = process.env[DESIGN_IMAGE_MODEL_ENV]?.trim();
  const tool = toolOverride ? `${DESIGN_IMAGE_MODEL_ENV}=${toolOverride}` : `the default tool model ${IMAGE_TOOL_MODEL}`;
  return ` — OpenAI rejected ${source} or ${tool} for this image-generation (Responses API) call; ` +
    `set ${DESIGN_MODEL_ENV} or ${DESIGN_IMAGE_MODEL_ENV} to models your account can use for it`;
}
