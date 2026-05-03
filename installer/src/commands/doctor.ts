import fs from "node:fs";
import path from "node:path";
import { resolveActiveInstall, readVersion } from "../lib/paths.js";
import {
  checkRequirements,
  getBunVersion,
  getGitVersion,
  detectInstalledHosts,
} from "../lib/system.js";
import { getInstalledCommit } from "../lib/git.js";
import { scanSkills } from "../lib/skills.js";
import { HOSTS } from "../lib/hosts.js";
import { createLogger, colors } from "../lib/logger.js";

export interface DoctorArgs {
  quiet: boolean;
}

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function doctor(args: DoctorArgs): Promise<void> {
  const log = createLogger(args.quiet);
  const { paths, mode } = resolveActiveInstall();
  const checks: Check[] = [];

  const sys = await checkRequirements();
  checks.push({
    name: "git",
    status: sys.missing.includes("git") ? "fail" : "ok",
    detail: (await getGitVersion()) ?? "not found",
  });
  checks.push({
    name: "bun",
    status: sys.missing.includes("bun") ? "fail" : "ok",
    detail: (await getBunVersion()) ?? "not found (required to build binaries)",
  });

  const installed = mode !== "none";
  checks.push({
    name: "install",
    status: installed ? "ok" : "fail",
    detail: installed
      ? `${paths.gstackDir}${mode === "project-local" ? " (project-local)" : ""}`
      : `missing (run \`gstack install\`)`,
  });

  if (installed) {
    const version = readVersion(paths);
    const commit = await getInstalledCommit(paths);
    checks.push({
      name: "version",
      status: "ok",
      detail: `${version ?? "(unversioned)"}${commit ? ` @ ${commit}` : ""}`,
    });

    const browseBin = path.join(paths.gstackDir, "browse", "dist", "browse");
    const hasBinary = fs.existsSync(browseBin);
    checks.push({
      name: "browse binary",
      status: hasBinary ? "ok" : "warn",
      detail: hasBinary ? browseBin : "not built (run `gstack upgrade` to rebuild)",
    });

    const skills = scanSkills(paths);
    checks.push({
      name: "skills",
      status: skills.length > 0 ? "ok" : "warn",
      detail: `${skills.length} discovered`,
    });

    const hosts = await detectInstalledHosts();
    for (const host of HOSTS) {
      const skillsPath = host.skillsDir.replace("~", paths.home);
      const gstackEntry = path.join(skillsPath, "gstack");
      const entryExists = fs.existsSync(gstackEntry);
      const isInstalledHost = hosts.includes(host.id);
      if (!isInstalledHost && !entryExists) continue;
      checks.push({
        name: `host: ${host.label}`,
        status: entryExists ? "ok" : isInstalledHost ? "warn" : "ok",
        detail: entryExists
          ? `registered at ${gstackEntry}`
          : isInstalledHost
            ? `detected but not registered (run \`gstack install --host ${host.id}\`)`
            : "not installed",
      });
    }
  }

  for (const w of sys.warnings) log.warn(w);

  log.plain("");
  const pad = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const badge =
      c.status === "ok"
        ? colors.green("✓")
        : c.status === "warn"
          ? colors.yellow("!")
          : colors.red("✗");
    log.plain(`${badge} ${c.name.padEnd(pad)}  ${colors.dim(c.detail)}`);
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  log.plain("");
  if (failed > 0) {
    log.error(`${failed} check${failed === 1 ? "" : "s"} failed.`);
    process.exit(1);
  } else if (warned > 0) {
    log.warn(`${warned} warning${warned === 1 ? "" : "s"}.`);
  } else {
    log.success("All checks passed.");
  }
}
