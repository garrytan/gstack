import path from "node:path";
import { run, runOrThrow } from "./exec.js";
import type { InstallPaths } from "./paths.js";
import type { HostId } from "./hosts.js";

export interface SetupOptions {
  host: HostId | "auto";
  prefix?: boolean;
  team?: boolean;
  noTeam?: boolean;
  local?: boolean;
  quiet?: boolean;
}

export async function runSetup(paths: InstallPaths, opts: SetupOptions): Promise<void> {
  const args: string[] = ["--host", opts.host];
  if (opts.prefix === true) args.push("--prefix");
  if (opts.prefix === false) args.push("--no-prefix");
  if (opts.team) args.push("--team");
  if (opts.noTeam) args.push("--no-team");
  if (opts.local) args.push("--local");
  if (opts.quiet) args.push("-q");

  const setupScript = path.join(paths.gstackDir, "setup");

  await runOrThrow("bash", [setupScript, ...args], {
    cwd: paths.gstackDir,
    stream: true,
  });
}

export async function runSetupForHosts(
  paths: InstallPaths,
  hosts: HostId[],
  opts: Omit<SetupOptions, "host">,
): Promise<void> {
  if (hosts.length === 0) return;
  for (const host of hosts) {
    await runSetup(paths, { ...opts, host });
  }
}

export async function runTeamInit(
  paths: InstallPaths,
  cwd: string,
  tier: "required" | "optional",
): Promise<void> {
  const teamInit = path.join(paths.gstackDir, "bin", "gstack-team-init");
  await runOrThrow(teamInit, [tier], { cwd, stream: true });
}

export async function readGstackConfig(
  paths: InstallPaths,
  key: string,
): Promise<string | null> {
  const cfg = path.join(paths.gstackDir, "bin", "gstack-config");
  try {
    const r = await run(cfg, ["get", key]);
    if (r.code !== 0) return null;
    const out = r.stdout.trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}
