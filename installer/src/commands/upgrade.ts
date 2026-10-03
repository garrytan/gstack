import * as p from "@clack/prompts";
import { resolveActiveInstall, readVersion } from "../lib/paths.js";
import { pullGstack, getInstalledCommit } from "../lib/git.js";
import { runSetup } from "../lib/setup.js";
import { createLogger } from "../lib/logger.js";

export interface UpgradeArgs {
  quiet: boolean;
}

export async function upgrade(args: UpgradeArgs): Promise<void> {
  const log = createLogger(args.quiet);
  const { paths, mode } = resolveActiveInstall();

  if (mode === "none") {
    log.error("gstack is not installed. Run `gstack install` first.");
    process.exit(1);
  }
  if (mode === "project-local") {
    log.info(`Upgrading project-local install at ${paths.gstackDir}`);
  }

  const beforeVersion = readVersion(paths);
  const beforeCommit = await getInstalledCommit(paths);

  const s = p.spinner();
  s.start("Pulling latest gstack");
  try {
    await pullGstack(paths);
    s.stop("Pulled latest gstack");
  } catch (err) {
    s.stop("Pull failed");
    throw err;
  }

  const afterVersion = readVersion(paths);
  const afterCommit = await getInstalledCommit(paths);

  log.info(`Rebuilding (setup re-runs with existing host config)`);
  await runSetup(paths, { host: "auto", quiet: args.quiet });

  log.plain("");
  if (beforeCommit === afterCommit) {
    log.success(`Already up to date (${afterVersion ?? afterCommit}).`);
  } else {
    log.success(`Upgraded: ${beforeVersion ?? beforeCommit} → ${afterVersion ?? afterCommit}`);
  }
}
