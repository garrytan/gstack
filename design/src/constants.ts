/**
 * Shared constants for the design binary.
 */

/**
 * Default per-request timeout for OpenAI Responses API calls that drive the
 * `image_generation` tool. The previous 120_000 ceiling tipped over at default
 * settings (`gpt-4o`, 1536x1024, quality:high) on slower account tiers — see
 * issue #1519. Override per-invocation via `--api-timeout <ms>`.
 */
export const DEFAULT_IMAGE_GEN_TIMEOUT_MS = 300_000;
