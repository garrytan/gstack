import fs from "node:fs";
import path from "node:path";
import {
  resolveInstallPaths,
  isInstalled,
  readVersion,
  findGitRoot,
  findLocalInstall,
} from "../lib/paths.js";
import { getInstalledCommit } from "../lib/git.js";
import { readGstackConfig } from "../lib/setup.js";
import { listDisabledSkills } from "../lib/project-config.js";
import { scanSkills } from "../lib/skills.js";
import { HOSTS } from "../lib/hosts.js";
import { createLogger, colors } from "../lib/logger.js";

export interface StatusArgs {
  quiet: boolean;
}

export async function status(args: StatusArgs): Promise<void> {
  const log = createLogger(args.quiet);
  const globalPaths = resolveInstallPaths();
  const localPaths = findLocalInstall(process.cwd());

  const paths = isInstalled(globalPaths)
    ? globalPaths
    : localPaths ?? globalPaths;
  const mode =
    paths === globalPaths && isInstalled(globalPaths)
      ? "global"
      : localPaths
        ? "project-local"
        : "none";

  if (mode === "none") {
    log.plain(colors.bold("gstack:") + " " + colors.red("not installed"));
    log.dim("Run `gstack install` to install globally, or `gstack install --local` for project-only.");
    return;
  }

  const version = readVersion(paths);
  const commit = await getInstalledCommit(paths);
  const teamMode = await readGstackConfig(paths, "team_mode");
  const autoUpgrade = await readGstackConfig(paths, "auto_upgrade");
  const skillPrefix = await readGstackConfig(paths, "skill_prefix");

  log.plain(colors.bold("gstack") + " " + colors.dim(`(${version ?? "unversioned"}${commit ? ` @ ${commit}` : ""})`));
  log.plain("");
  log.plain(`  ${colors.dim("Mode:")}           ${mode === "project-local" ? colors.yellow("project-local (vendored)") : "global"}`);
  log.plain(`  ${colors.dim("Install:")}        ${paths.gstackDir}`);
  log.plain(`  ${colors.dim("Team mode:")}      ${teamMode === "true" ? colors.green("on") : "off"}`);
  log.plain(`  ${colors.dim("Auto-upgrade:")}   ${autoUpgrade === "true" ? colors.green("on") : "off"}`);
  log.plain(`  ${colors.dim("Skill prefix:")}   ${skillPrefix === "true" ? "gstack-*" : "flat"}`);

  const skills = scanSkills(paths);
  log.plain(`  ${colors.dim("Skills:")}         ${skills.length}`);

  log.plain("");
  log.plain(colors.bold("Hosts registered:"));
  for (const host of HOSTS) {
    const skillsPath = host.skillsDir.replace("~", paths.home);
    const gstackEntry = path.join(skillsPath, "gstack");
    const exists = fs.existsSync(gstackEntry);
    const badge = exists ? colors.green("✓") : colors.dim("·");
    log.plain(`  ${badge} ${host.label.padEnd(16)} ${colors.dim(exists ? gstackEntry : "not registered")}`);
  }

  const repoRoot = findGitRoot(process.cwd());
  if (repoRoot) {
    const disabled = listDisabledSkills(repoRoot);
    if (disabled.length > 0) {
      log.plain("");
      log.plain(colors.bold(`Project (${repoRoot}):`));
      log.plain(`  ${colors.dim("Disabled skills:")} ${disabled.join(", ")}`);
    }
  }
}
