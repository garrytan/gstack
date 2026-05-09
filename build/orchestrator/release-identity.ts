import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as path from "node:path";
import { safeRegistryKey } from "./registry";

export type RemoteRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; encoding?: BufferEncoding },
) => SpawnSyncReturns<string>;

function stripGitSuffix(input: string): string {
  return input.replace(/\/+$/, "").replace(/\.git$/i, "");
}

export function normalizeRemoteIdentity(remoteUrl: string): string | null {
  const raw = remoteUrl.trim();
  if (!raw) return null;

  const scpLike = raw.match(/^(?:[^@/\s]+@)?([^:\s]+):(.+)$/);
  if (scpLike && !raw.includes("://")) {
    return stripGitSuffix(`${scpLike[1].toLowerCase()}/${scpLike[2].replace(/^\/+/, "")}`);
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "file:") {
      return stripGitSuffix(`file:${path.resolve(parsed.pathname)}`);
    }
    if (!parsed.hostname) return stripGitSuffix(raw);
    return stripGitSuffix(
      `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/\/+/g, "/"),
    );
  } catch {
    return stripGitSuffix(raw);
  }
}

export function canonicalRepoIdentity(args: {
  cwd: string;
  repoPath?: string;
  run?: RemoteRunner;
}): { identity: string; key: string; source: "remote" | "path" } {
  const run = args.run ?? (spawnSync as RemoteRunner);
  let remote: SpawnSyncReturns<string> | null = null;
  try {
    remote = run("git", ["remote", "get-url", "origin"], {
      cwd: args.cwd,
      encoding: "utf8",
    });
  } catch {
    remote = null;
  }
  const normalized =
    remote?.status === 0 ? normalizeRemoteIdentity(remote.stdout) : null;
  if (normalized) {
    return { identity: normalized, key: safeRegistryKey(normalized), source: "remote" };
  }
  const fallback = `path:${path.resolve(args.repoPath ?? args.cwd)}`;
  return { identity: fallback, key: safeRegistryKey(fallback), source: "path" };
}
