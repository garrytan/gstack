import fs from "node:fs";
import * as p from "@clack/prompts";
import { resolveInstallPaths, isInstalled } from "../lib/paths.js";
import { checkRequirements } from "../lib/system.js";
import { cloneGstack, pullGstack } from "../lib/git.js";
import { runSetupForHosts } from "../lib/setup.js";
import { buildGstackBlock, upsertClaudeMd } from "../lib/claude-md.js";
import { HOSTS, type HostId } from "../lib/hosts.js";
import { createLogger } from "../lib/logger.js";

export interface InstallArgs {
  hosts: HostId[];
  prefix: boolean;
  writeClaudeMd: boolean;
  quiet: boolean;
  reinstall: boolean;
}

export async function installGlobal(args: InstallArgs): Promise<void> {
  const paths = resolveInstallPaths();
  const log = createLogger(args.quiet);

  const sys = await checkRequirements();
  if (!sys.ok) {
    log.error(`Missing required tools: ${sys.missing.join(", ")}`);
    log.plain("");
    log.plain("Install them and try again:");
    if (sys.missing.includes("bun")) log.bullet("bun: https://bun.sh/");
    if (sys.missing.includes("git")) log.bullet("git: https://git-scm.com/");
    process.exit(1);
  }
  for (const warn of sys.warnings) log.warn(warn);

  const alreadyInstalled = isInstalled(paths);

  if (alreadyInstalled && !args.reinstall) {
    const s = p.spinner();
    s.start("Updating existing gstack checkout");
    try {
      await pullGstack(paths);
      s.stop("Updated existing gstack checkout");
    } catch (err) {
      s.stop("Pull failed");
      throw err;
    }
  } else {
    if (alreadyInstalled && args.reinstall) {
      log.info(`Removing existing install at ${paths.gstackDir}`);
      fs.rmSync(paths.gstackDir, { recursive: true, force: true });
    }
    const s = p.spinner();
    s.start(`Cloning gstack into ${paths.gstackDir}`);
    try {
      await cloneGstack(paths);
      s.stop("Cloned gstack");
    } catch (err) {
      s.stop("Clone failed");
      throw err;
    }
  }

  const hosts = args.hosts.length > 0 ? args.hosts : (["claude"] as HostId[]);
  log.info(`Registering with ${hosts.map((h) => HOSTS.find((x) => x.id === h)?.label ?? h).join(", ")}`);
  await runSetupForHosts(paths, hosts, {
    prefix: args.prefix,
    quiet: args.quiet,
  });

  if (args.writeClaudeMd) {
    const block = buildGstackBlock(paths);
    const result = upsertClaudeMd(paths.claudeMd, block);
    if (result.action === "unchanged") {
      log.dim(`CLAUDE.md already up to date (${result.targetPath})`);
    } else {
      log.success(`${result.action} gstack section in ${result.targetPath}`);
    }
  }

  log.plain("");
  log.success("gstack installed.");
  log.bullet(`Location: ${paths.gstackDir}`);
  log.bullet(`Hosts: ${hosts.join(", ")}`);
  log.plain("");
  log.plain("Next: open Claude Code and try /office-hours, /review, or /qa");
}
