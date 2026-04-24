import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { resolveInstallPaths, isInstalled, findGitRoot } from "../lib/paths.js";
import {
  cleanupHostSymlinks,
  removeGstackInstall,
  projectGstackArtifacts,
  scrubSettingsJson,
} from "../lib/cleanup.js";
import { removeGstackBlock } from "../lib/claude-md.js";
import { runSetup } from "../lib/setup.js";
import { createLogger } from "../lib/logger.js";
import { run } from "../lib/exec.js";

export interface UninstallArgs {
  project: boolean;
  yes: boolean;
  keepClaudeMd: boolean;
  quiet: boolean;
}

export async function uninstall(args: UninstallArgs): Promise<void> {
  if (args.project) {
    await uninstallProject(args);
  } else {
    await uninstallGlobal(args);
  }
}

async function uninstallGlobal(args: UninstallArgs): Promise<void> {
  const log = createLogger(args.quiet);
  const paths = resolveInstallPaths();

  if (!isInstalled(paths)) {
    log.info("gstack is not installed globally.");
    return;
  }

  if (!args.yes) {
    const proceed = await p.confirm({
      message: `Remove gstack from ${paths.gstackDir} and all registered host symlinks?`,
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      log.dim("Aborted.");
      return;
    }
  }

  if (isInstalled(paths)) {
    try {
      await runSetup(paths, { host: "claude", noTeam: true, quiet: true });
    } catch {
      // setup --no-team may fail if checkout is broken; continue
    }
  }

  const cleanup = cleanupHostSymlinks(paths);
  for (const link of cleanup.removedSymlinks) log.bullet(`unlinked ${link}`);
  for (const dir of cleanup.removedDirs) log.bullet(`removed ${dir}`);

  if (removeGstackInstall(paths)) {
    log.bullet(`removed ${paths.gstackDir}`);
  }

  if (!args.keepClaudeMd) {
    if (removeGstackBlock(paths.claudeMd)) {
      log.bullet(`removed gstack block from ${paths.claudeMd}`);
    }
  }

  log.plain("");
  log.success("gstack uninstalled.");
  log.dim(`State kept at ${paths.gstackStateDir} (session history, config). Delete manually if you want a clean slate.`);
}

async function uninstallProject(args: UninstallArgs): Promise<void> {
  const log = createLogger(args.quiet);

  const repoRoot = findGitRoot(process.cwd());
  if (!repoRoot) {
    log.error("Not inside a git repository.");
    process.exit(1);
  }

  const artifacts = projectGstackArtifacts(repoRoot);
  const projectClaudeMd = path.join(repoRoot, "CLAUDE.md");
  const hasClaudeMdBlock =
    fs.existsSync(projectClaudeMd) &&
    fs.readFileSync(projectClaudeMd, "utf-8").includes("<!-- gstack:begin -->");

  if (artifacts.length === 0 && !hasClaudeMdBlock) {
    log.info("No project-level gstack artifacts found.");
    return;
  }

  if (!args.yes) {
    log.plain("This will remove from the project:");
    for (const artifact of artifacts) log.bullet(artifact);
    if (hasClaudeMdBlock && !args.keepClaudeMd) log.bullet(`gstack section in ${projectClaudeMd}`);
    const proceed = await p.confirm({
      message: "Proceed?",
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      log.dim("Aborted.");
      return;
    }
  }

  for (const artifact of artifacts) {
    fs.rmSync(artifact, { recursive: true, force: true });
    log.bullet(`removed ${artifact}`);
  }

  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  if (scrubSettingsJson(settingsPath)) {
    log.bullet(`scrubbed gstack hooks from ${settingsPath}`);
  }

  if (hasClaudeMdBlock && !args.keepClaudeMd) {
    removeGstackBlock(projectClaudeMd);
    log.bullet(`removed gstack block from ${projectClaudeMd}`);
  }

  const stageTargets = [".claude", "CLAUDE.md", ".gstack"];
  await run("git", ["-C", repoRoot, "add", "--", ...stageTargets]);

  log.plain("");
  log.success("gstack removed from this project.");
  log.dim("Review `git status` and commit when ready.");
}
