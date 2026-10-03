import { resolveInstallPaths, findGitRoot } from "../lib/paths.js";
import { scanSkills } from "../lib/skills.js";
import { disableSkill, enableSkill, listDisabledSkills } from "../lib/project-config.js";
import { createLogger } from "../lib/logger.js";

export interface ToggleArgs {
  skillName: string;
  quiet: boolean;
}

function normalizeName(name: string): string {
  return name.replace(/^\//, "").replace(/^gstack-/, "");
}

function validateSkill(skillName: string): boolean {
  const paths = resolveInstallPaths();
  const skills = scanSkills(paths);
  const normalized = normalizeName(skillName);
  return skills.some((s) => normalizeName(s.skillName) === normalized);
}

export async function enable(args: ToggleArgs): Promise<void> {
  const log = createLogger(args.quiet);
  const repoRoot = findGitRoot(process.cwd());
  if (!repoRoot) {
    log.error("Not inside a git repository. `gstack enable` configures per-project settings.");
    process.exit(1);
  }
  const name = normalizeName(args.skillName);
  const changed = enableSkill(repoRoot, name);
  if (changed) {
    log.success(`Enabled /${name} in this project.`);
  } else {
    const current = listDisabledSkills(repoRoot);
    if (current.includes(name)) {
      log.warn(`/${name} was already enabled (not in disabled list).`);
    } else {
      log.info(`/${name} is already enabled.`);
    }
  }
}

export async function disable(args: ToggleArgs): Promise<void> {
  const log = createLogger(args.quiet);
  const repoRoot = findGitRoot(process.cwd());
  if (!repoRoot) {
    log.error("Not inside a git repository. `gstack disable` configures per-project settings.");
    process.exit(1);
  }
  const name = normalizeName(args.skillName);
  if (!validateSkill(name)) {
    log.warn(`No installed skill matches "${name}". Disabling anyway (in case it's installed later).`);
  }
  const changed = disableSkill(repoRoot, name);
  if (changed) {
    log.success(`Disabled /${name} in this project.`);
  } else {
    log.info(`/${name} was already disabled.`);
  }
}
