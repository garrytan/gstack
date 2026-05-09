/**
 * Model taxonomy — neutral module with no imports from hosts/ or resolvers/.
 *
 * Model families supported by model overlays in model-overlays/{family}.md.
 * Host configs can reference these as `defaultModel` strings (validated at
 * generation time), but the model axis is independent of the host axis.
 *
 * IMPORTANT: host ≠ model. Claude Code can run any Claude model (Opus, Sonnet,
 * Haiku, future). Codex CLI runs GPT/o-series models. Cursor and OpenCode can
 * front multiple providers. We do NOT auto-detect the model from the host —
 * users pass --model explicitly. Default is 'claude'.
 */

export const ALL_MODEL_NAMES = [
  'claude',
  'opus-4-7',
  'gpt',
  'gpt-5.4',
  'gemini',
  'o-series',
] as const;

export type Model = (typeof ALL_MODEL_NAMES)[number];

/**
 * Resolve a model argument from CLI input to a known Model family.
 *
 * Precedence rules:
 * 1. Exact match against ALL_MODEL_NAMES → return as-is.
 * 2. Family heuristics for common variants:
 *    - `gpt-5.4-mini`, `gpt-5.4-turbo`, `gpt-5.4-*` → `gpt-5.4`
 *    - `gpt-*` (anything else GPT) → `gpt`
 *    - `o3`, `o4`, `o4-mini`, `o1`, `o1-mini`, `o1-pro` → `o-series`
 *    - `claude-*` (sonnet, opus, haiku, any version) → `claude`
 *    - `gemini-*` (2.5-pro, flash, etc.) → `gemini`
 * 3. Unknown input → returns null (caller decides: error, or fall back).
 *
 * The resolver file in model-overlays/{model}.md applies further fallback
 * (e.g., missing gpt-5.4.md falls back to gpt.md). This function only
 * normalizes CLI input to a family name.
 */
export function resolveModel(input: string): Model | null {
  const s = input.trim();
  if (!s) return null;

  // Exact match first
  if ((ALL_MODEL_NAMES as readonly string[]).includes(s)) {
    return s as Model;
  }

  // Family heuristics
  if (/^gpt-5\.4(-|$)/.test(s)) return 'gpt-5.4';
  if (/^gpt(-|$)/.test(s)) return 'gpt';
  if (/^o[0-9]+(-|$)/.test(s)) return 'o-series';
  if (/^claude-opus-4-7(-|$)/.test(s)) return 'opus-4-7';
  if (/^claude(-|$)/.test(s)) return 'claude';
  if (/^gemini(-|$)/.test(s)) return 'gemini';

  return null;
}

/**
 * Validate a string against ALL_MODEL_NAMES. Used by host-config validators
 * when a HostConfig declares `defaultModel`. Returns an error message or null
 * if valid.
 */
export function validateModel(input: string): string | null {
  if ((ALL_MODEL_NAMES as readonly string[]).includes(input)) return null;
  return `'${input}' is not a known model. Use ${ALL_MODEL_NAMES.join(', ')}.`;
}
