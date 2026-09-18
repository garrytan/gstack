import path from "node:path";
import fs from "node:fs";
import { resolveInstallPaths, isInstalled, findGitRoot } from "../lib/paths.js";
import { runSetup, runTeamInit } from "../lib/setup.js";
import { run } from "../lib/exec.js";
import { buildGstackBlock, upsertClaudeMd } from "../lib/claude-md.js";
import { createLogger } from "../lib/logger.js";
import { installGlobal, type InstallArgs } from "./install.js";

export interface InitArgs {
  tier: "required" | "optional";
  commit: boolean;
  quiet: boolean;
  writeClaudeMd: boolean;
  globalArgs: InstallArgs;
}

export async function initProject(args: InitArgs): Promise<void> {
  const log = createLogger(args.quiet);
  const paths = resolveInstallPaths();

  const repoRoot = findGitRoot(process.cwd());
  if (!repoRoot) {
    log.error("Not inside a git repository. `gstack init` must be run from a project root.");
    log.dim("Run `git init` first, or use `gstack install` for a personal (non-team) install.");
    process.exit(1);
  }

  if (!isInstalled(paths)) {
    log.info("gstack not installed globally yet — installing first");
    await installGlobal(args.globalArgs);
  }

  log.info("Enabling team mode (auto-update hook)");
  await runSetup(paths, {
    host: "claude",
    team: true,
    prefix: args.globalArgs.prefix,
    quiet: args.quiet,
  });

  log.info(`Bootstrapping ${repoRoot} with tier=${args.tier}`);
  await runTeamInit(paths, repoRoot, args.tier);

  if (args.writeClaudeMd) {
    const projectClaudeMd = path.join(repoRoot, "CLAUDE.md");
    const block = buildGstackBlock(paths);
    const result = upsertClaudeMd(projectClaudeMd, block);
    if (result.action !== "unchanged") {
      log.success(`${result.action} gstack section in ${result.targetPath}`);
    }
  }

  const stageTargets = [".claude", "CLAUDE.md"].filter((rel) =>
    fs.existsSync(path.join(repoRoot, rel)),
  );
  if (stageTargets.length > 0) {
    await run("git", ["-C", repoRoot, "add", ...stageTargets]);
    log.success(`Staged: ${stageTargets.join(", ")}`);
  }

  if (args.commit) {
    const msg = "require gstack for AI-assisted work";
    const r = await run("git", ["-C", repoRoot, "commit", "-m", msg]);
    if (r.code === 0) {
      log.success(`Committed: "${msg}"`);
    } else {
      log.warn("Nothing to commit (or commit failed — staged files remain).");
    }
  } else {
    log.dim("Review staged changes and commit when ready.");
  }

  log.plain("");
  log.success(`gstack ${args.tier} in this repo. Teammates will auto-update on session start.`);
}
