import { hasCmd, run } from "./exec.js";
import { HOSTS, type HostId } from "./hosts.js";

export interface SystemCheck {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

export async function checkRequirements(): Promise<SystemCheck> {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!(await hasCmd("git"))) missing.push("git");
  if (!(await hasCmd("bun"))) missing.push("bun");

  if (process.platform === "win32" && !(await hasCmd("node"))) {
    missing.push("node (Windows only)");
  }

  if (process.platform === "win32") {
    warnings.push(
      "Windows is partially supported. The setup script requires bash (use Git Bash or WSL).",
    );
  }

  return { ok: missing.length === 0, missing, warnings };
}

export async function detectInstalledHosts(): Promise<HostId[]> {
  const found: HostId[] = [];
  for (const h of HOSTS) {
    if (await hasCmd(h.detectCmd)) found.push(h.id);
  }
  return found;
}

export async function getBunVersion(): Promise<string | null> {
  const r = await run("bun", ["--version"]);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

export async function getGitVersion(): Promise<string | null> {
  const r = await run("git", ["--version"]);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}
