import { join } from "node:path";
import type { RicoConfig, ResolveConfigInput } from "./types";

export function resolveConfig(input: ResolveConfigInput = {}): RicoConfig {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const stateDir = join(cwd, ".gstack", "rico");

  return {
    cwd,
    stateDir,
    dbPath: join(stateDir, "rico.sqlite"),
    artifactDir: join(stateDir, "artifacts"),
    maxActiveProjects: Number(env.RICO_MAX_ACTIVE_PROJECTS ?? "2"),
  };
}
