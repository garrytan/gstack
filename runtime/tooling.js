import fs from "node:fs/promises";
import path from "node:path";

export function bashCandidates(env = process.env, platform = process.platform) {
  const values = [env.GSTACK_BASH];
  if (platform === "win32") {
    for (const root of [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"),
    ]) {
      if (!root) continue;
      values.push(
        path.join(root, "Git", "bin", "bash.exe"),
        path.join(root, "Git", "usr", "bin", "bash.exe"),
      );
    }
  }
  values.push("bash");
  return values.filter((entry, index, list) => entry && list.indexOf(entry) === index);
}

export async function resolveBashCommand(env = process.env, platform = process.platform) {
  for (const candidate of bashCandidates(env, platform)) {
    if (!path.isAbsolute(candidate)) return candidate;
    const stat = await fs.lstat(candidate).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  return "bash";
}
