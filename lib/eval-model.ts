/**
 * Host-neutral eval/harness model resolution (fork port wave 2, G cluster).
 *
 * Model IDs were hardcoded at six call sites across the eval helpers and the
 * distill bin, so an environment that pins a different model (CI cost
 * control, a model migration, an air-gapped proxy alias) had to patch source.
 * One resolution point, env-overridable:
 *
 *   GSTACK_EVAL_MODEL_<KIND>  (e.g. GSTACK_EVAL_MODEL_WARMUP) — per-kind
 *   GSTACK_EVAL_MODEL                                        — global
 *   explicit argument                                        — caller wins
 *   per-kind default                                         — last resort
 *
 * Kinds and their defaults:
 *   capture — the model under test in every Claude session, PTY and Agent SDK
 *             eval run: CLAUDE_CAPTURE_EVAL_MODEL
 *   warmup  — PTY warm-up ping (cheapest thing that answers): haiku
 *   distill — free-text distillation (cheap, structured): haiku (pinned)
 *   judge   — LLM-judge rubric calls: CLAUDE_JUDGE_EVAL_MODEL
 */

/** The model under test: Anthropic's best code model (Garry, 2026-10-18). */
export const CLAUDE_CAPTURE_EVAL_MODEL = "claude-opus-5-5";
/**
 * The judge is the ruler, not the model under test: its calibration fixtures
 * (test/fixtures/judge-calibration) are keyed to it, so it moves only with a
 * recalibration, never with the model under test.
 */
export const CLAUDE_JUDGE_EVAL_MODEL = "claude-fable-5-1";
export const DEFAULT_JUDGE_MAX_TOKENS = 8192;

// `as const satisfies` keeps EvalModelKind the literal union
// 'capture' | 'warmup' | 'distill' — a `Record<string, string>` annotation
// would widen it to string and let any typo through the type gate.
const DEFAULTS = {
  // Tests needing a cheaper or historical model pass it explicitly or set
  // GSTACK_EVAL_MODEL_CAPTURE / GSTACK_EVAL_MODEL_JUDGE / GSTACK_EVAL_MODEL.
  capture: CLAUDE_CAPTURE_EVAL_MODEL,
  warmup: "claude-haiku-5-5",
  distill: "claude-haiku-5-5",
  judge: CLAUDE_JUDGE_EVAL_MODEL,
} as const satisfies Record<string, string>;

export type EvalModelKind = keyof typeof DEFAULTS;

export function resolveEvalModel(
  kind: EvalModelKind,
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit) return explicit;
  const perKind = env[`GSTACK_EVAL_MODEL_${kind.toUpperCase()}`];
  if (perKind) return perKind;
  if (env.GSTACK_EVAL_MODEL) return env.GSTACK_EVAL_MODEL;
  const fallback = DEFAULTS[kind];
  if (!fallback) throw new Error(`resolveEvalModel: unknown kind "${kind}"`);
  return fallback;
}
