/**
 * The one table of model families gstack picks from: each family's newest model.
 * Every default that names a family's model (the agent preference, the tier
 * catalog, eval capture and judge models, the Codex frontier voice, the R95
 * fallback reader, Codex setup) reads it here, so a new generation is a one-line
 * change. test/model-generation-guard.test.ts fails when runtime code or
 * agent-loaded prose names an older generation of opus, fable, sol or astra.
 */
export type ModelFamily = 'opus' | 'fable' | 'sonnet' | 'haiku' | 'astra' | 'sol' | 'luna' | 'terra';

export const MODEL_FAMILIES: ReadonlyArray<Readonly<{ family: ModelFamily; provider: string; model: string }>> = Object.freeze([
  { family: 'opus', provider: 'anthropic', model: 'claude-opus-5-5' },
  { family: 'fable', provider: 'anthropic', model: 'claude-fable-5-2' },
  { family: 'sonnet', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { family: 'haiku', provider: 'anthropic', model: 'claude-haiku-5-5' },
  { family: 'astra', provider: 'openai', model: 'gpt-6.2-astra' },
  { family: 'sol', provider: 'openai', model: 'gpt-6.2-sol' },
  { family: 'luna', provider: 'openai', model: 'gpt-6-luna' },
  { family: 'terra', provider: 'openai', model: 'gpt-6.1-terra' },
].map(f => Object.freeze(f as { family: ModelFamily; provider: string; model: string })));

export function newestModel(family: ModelFamily): string {
  return MODEL_FAMILIES.find(f => f.family === family)!.model;
}

/** Today's frontier models under test (R54, docs/TESTING_INTERNALS.md#frontier-models-under-test); a small-tier plan is re-costed on these. */
export const FRONTIER_MODELS = [newestModel('opus'), newestModel('sol')] as const;
