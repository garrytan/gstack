/**
 * Conductor workspaces don't inherit the user's interactive shell env, so the
 * canonical ANTHROPIC_API_KEY / OPENAI_API_KEY may be missing while
 * Conductor's GSTACK_-prefixed forms are present. Promote the GSTACK_ form to
 * canonical when canonical is empty, so subprocesses (gbrain embed,
 * @anthropic-ai/claude-agent-sdk, etc) pick it up.
 *
 * Import this for its side effect: `import "../lib/conductor-env-shim";`
 */
const PROMOTED_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/**
 * Pure form: returns a copy of `base` with each GSTACK_-prefixed key promoted
 * to its canonical name when the canonical is empty. Single source of truth
 * for promotion semantics — used by the ambient mutator below and by the
 * hermetic env builder (test/helpers/hermetic-env.ts), which must not mutate
 * process.env.
 */
export function promotedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const key of PROMOTED_KEYS) {
    if (!out[key] && out[`GSTACK_${key}`]) {
      out[key] = out[`GSTACK_${key}`];
    }
  }
  return out;
}

export function promoteConductorEnv(): void {
  const promoted = promotedEnv(process.env);
  for (const key of PROMOTED_KEYS) {
    if (promoted[key]) process.env[key] = promoted[key];
  }
}

promoteConductorEnv();
