/**
 * Environment for fixture git commands and `gstack-redact install-prepush-hook`.
 *
 * With the parent environment, a developer's global or system core.hooksPath
 * (or the same key via GIT_CONFIG_COUNT / GIT_CONFIG_PARAMETERS) reaches the
 * fixture: `git rev-parse --git-path hooks` resolves to that directory, so the
 * install rewrites the developer's own pre-push (#3353), and their hook runs
 * on fixture pushes and rejects the local remote (#2967). /dev/null drops the
 * global file on every platform: Git for Windows rejects NUL. Config written
 * inside the fixture repo still applies.
 */
export function gitEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_COUNT = "0";
  delete env.GIT_CONFIG_PARAMETERS;
  return env;
}
