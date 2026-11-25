/**
 * Model taxonomy — neutral module with no imports from hosts/ or resolvers/.
 *
 * Model families supported by model overlays in model-overlays/{family}.md.
 * Host configs reference these as `defaultModel` strings (validated at
 * generation time), but the model axis is independent of the host axis.
 *
 * IMPORTANT: host ≠ model. Claude Code can run any Claude model (Opus, Sonnet,
 * Haiku, future). Codex CLI runs GPT/o-series models. Cursor and OpenCode can
 * front multiple providers. The generator does NOT auto-detect the model from
 * the host — users can pass --model explicitly, otherwise each host supplies
 * its own generation default. Exception outside this module: ./setup detects
 * the Codex model from ${CODEX_HOME:-~/.codex}/config.toml
 * (scripts/resolve-codex-generation-model.ts) and passes it as an explicit
 * --model.
 */

export const ALL_MODEL_NAMES = [
  'claude',
  'opus-4-7',
  'fable-5',
  'opus-4-8',
  'sonnet-5',
  'gpt',
  'gpt-5.4',
  'gpt-5.6-sol',
  'gpt-6-astra',
  'gemini',
  'o-series',
] as const;

export type Model = (typeof ALL_MODEL_NAMES)[number];

/**
 * Resolve a model argument from CLI input to a known Model family.
 *
 * Input is trimmed and lowercased, and one trailing `[...]` context marker
 * (for example `claude-sonnet-5[1m]`) is stripped before matching.
 *
 * Precedence rules:
 * 1. Exact match against ALL_MODEL_NAMES → return as-is. This is the ONLY
 *    path that selects `gpt-5.6-sol` — Sol is intentionally exact-only.
 *    It is also how to force a model-pinned profile: `--model opus-4-7`,
 *    `--model sonnet-5`, and so on.
 * 2. Family heuristics for common variants:
 *    - `gpt-6.2-astra` and every other GPT-6 Astra point release or snapshot
 *      → `gpt-6-astra`, the overlay for gstack's default Codex model
 *      (lib/model-families.ts)
 *    - `gpt-5.4-mini`, `gpt-5.4-turbo`, `gpt-5.4-*` → `gpt-5.4`
 *    - `gpt-*` (anything else GPT, including other 5.6 variants) → `gpt`
 *    - `o3`, `o4`, `o4-mini`, `o1`, `o1-mini`, `o1-pro` → `o-series`
 *    - Model-pinned Claude families (Opus 4.7, Opus 4.8, Sonnet 5) use an
 *      allowlist: the bare ID (`claude-<family>-<major>`), the bare ID plus
 *      an 8-digit date snapshot (`-YYYYMMDD`), and the bare ID plus `-latest`
 *      keep the pinned profile. Any other suffix, including a point release
 *      with or without a date (`claude-opus-4-7-1`, `claude-sonnet-5-5`,
 *      `claude-sonnet-5-5-20261001`), falls to `claude`: a newer model should
 *      not read nudges written for an older one.
 *    - Fable is the exception: any `claude-fable-5-*` ID keeps `fable-5`
 *      while a Fable 5 point release is one of gstack's eval models (the
 *      judge, CLAUDE_JUDGE_EVAL_MODEL in lib/eval-model.ts). The exception
 *      ends when CLAUDE_JUDGE_EVAL_MODEL leaves Fable 5.
 *    - Any other `claude-*` (including `claude-opus-5-5`) → `claude`
 *    - `gemini-*` (2.5-pro, flash, etc.) → `gemini`
 * 3. Unknown input → returns null (caller decides: error, or fall back).
 *
 * The resolver file in model-overlays/{model}.md applies further fallback
 * (e.g., missing gpt-5.4.md falls back to gpt.md). This function only
 * normalizes CLI input to a family name.
 */
export function resolveModel(input: string): Model | null {
  const s = input.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').trim();
  if (!s) return null;

  // Exact match first
  if ((ALL_MODEL_NAMES as readonly string[]).includes(s)) {
    return s as Model;
  }

  // Family heuristics
  // Sol never reaches here — the exact match above already returned it. Do
  // not add a Sol family pattern: Terra, Luna, future 5.6 variants, and
  // suffixed model IDs must NOT inherit Sol's behavioral profile; they fall
  // through to the generic `gpt` family below.
  if (/^gpt-6(\.\d+)?-astra(-|$)/.test(s)) return 'gpt-6-astra';
  if (/^gpt-5\.4(-|$)/.test(s)) return 'gpt-5.4';
  if (/^gpt(-|$)/.test(s)) return 'gpt';
  if (/^o[0-9]+(-|$)/.test(s)) return 'o-series';
  const pinned = /^claude-(opus-4-7|opus-4-8|sonnet-5)(-\d{8}|-latest)?$/.exec(s);
  if (pinned) return pinned[1] as Model;
  if (/^claude-fable-5(-|$)/.test(s)) return 'fable-5';
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

/**
 * Overlays `./setup --claude-model <id>` may select for the Claude host. The
 * list is the Claude subset of ALL_MODEL_NAMES; a new Claude overlay joins
 * both lists.
 */
export const CLAUDE_OVERLAY_MODELS = ['claude', 'opus-4-7', 'opus-4-8', 'sonnet-5', 'fable-5'] as const;

export type ClaudeOverlay = (typeof CLAUDE_OVERLAY_MODELS)[number];

export interface ClaudeOverlayError {
  kind: 'alias' | 'unknown' | 'non-claude';
  problem: string;
  cause: string;
  fix: string;
}

export type ClaudeOverlayResult =
  | { overlay: ClaudeOverlay; generic: boolean }
  | { error: ClaudeOverlayError };

const CLAUDE_CODE_ALIASES = ['opus', 'sonnet', 'haiku', 'default'];

/**
 * Map a `--claude-model` value to the overlay setup renders. `resolveModel`
 * does the family matching (bracketed context suffixes, dated and `-latest`
 * snapshots); this adds the Claude-only allowlist and the errors setup prints.
 * `generic` is true when a specific model ID has no overlay of its own and
 * uses the generic `claude` overlay (for example `claude-opus-5-5`).
 */
export function resolveClaudeOverlay(id: string): ClaudeOverlayResult {
  const s = id.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').trim();
  const problem = `${JSON.stringify(id)} is not a Claude model ID that gstack can map to a skill overlay.`;
  if (CLAUDE_CODE_ALIASES.includes(s)) {
    return { error: {
      kind: 'alias',
      problem,
      cause: `"${s}" is a Claude Code alias whose model changes over time, so it names no fixed overlay.`,
      fix: 'Pass a full model ID, for example ./setup --claude-model claude-opus-4-8, or ./setup --claude-model claude for the generic overlay.',
    } };
  }
  const family = resolveModel(s);
  if (!family) {
    return { error: {
      kind: 'unknown',
      problem,
      cause: 'It does not match any model family gstack knows.',
      fix: 'Pass a Claude model ID such as claude-opus-4-8 or claude-sonnet-5, or claude for the generic overlay.',
    } };
  }
  if (!(CLAUDE_OVERLAY_MODELS as readonly string[]).includes(family)) {
    return { error: {
      kind: 'non-claude',
      problem,
      cause: `It belongs to the ${family} family, and --claude-model selects Claude overlays only.`,
      fix: `For Codex skills use ./setup --host codex --model ${id}. For Claude, pass a Claude model ID such as claude-opus-4-8.`,
    } };
  }
  return { overlay: family as ClaudeOverlay, generic: family === 'claude' && s !== 'claude' };
}

// `bun scripts/models.ts claude-overlay <id>` — setup's bridge to the table
// above. Prints "<overlay>\t<generic 0|1>" or the error lines on stderr (exit 1).
if (import.meta.main) {
  const [command, id] = process.argv.slice(2);
  if (command !== 'claude-overlay' || id === undefined) {
    console.error('Usage: bun scripts/models.ts claude-overlay <claude-model-id>');
    process.exit(2);
  }
  const result = resolveClaudeOverlay(id);
  if ('error' in result) {
    console.error(`${result.error.problem}\n${result.error.cause}\n${result.error.fix}`);
    process.exit(1);
  }
  console.log(`${result.overlay}\t${result.generic ? 1 : 0}`);
}
