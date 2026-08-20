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
 *   capture — AskUserQuestion SDK capture runs: sonnet (D1a)
 *   warmup  — PTY warm-up ping (cheapest thing that answers): haiku
 *   distill — free-text distillation (cheap, structured): haiku (pinned)
 */

// `as const satisfies` keeps EvalModelKind the literal union
// 'capture' | 'warmup' | 'distill' — a `Record<string, string>` annotation
// would widen it to string and let any typo through the type gate.
const DEFAULTS = {
  // D1a (2026-08 test-infra review): capture runs default to Sonnet, matching
  // session-runner — the old Opus default was an inconsistency between
  // runners, not a choice; tests needing Opus pass it explicitly or set
  // GSTACK_EVAL_MODEL_CAPTURE.
  capture: "claude-sonnet-4-6",
  warmup: "claude-haiku-4-5",
  distill: "claude-haiku-4-5-20251001",
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
