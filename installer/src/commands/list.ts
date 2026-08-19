import { resolveActiveInstall } from "../lib/paths.js";
import { scanSkills } from "../lib/skills.js";
import { createLogger, colors } from "../lib/logger.js";

export interface ListArgs {
  quiet: boolean;
}

export async function list(args: ListArgs): Promise<void> {
  const log = createLogger(args.quiet);
  const { paths, mode } = resolveActiveInstall();

  if (mode === "none") {
    log.error("gstack is not installed. Run `gstack install` first.");
    process.exit(1);
  }

  const skills = scanSkills(paths);
  if (skills.length === 0) {
    log.warn("No skills discovered.");
    return;
  }

  log.plain(colors.bold(`${skills.length} skills available:`));
  log.plain("");

  const pad = Math.max(...skills.map((s) => s.skillName.length));
  for (const skill of skills) {
    const name = `/${skill.skillName}`.padEnd(pad + 2);
    const desc = skill.description
      ? colors.dim(truncate(skill.description, 80))
      : colors.dim("(no description)");
    log.plain(`  ${colors.cyan(name)}  ${desc}`);
  }
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}
