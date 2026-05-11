import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as path from "node:path";
import { safeRegistryKey } from "./registry";
import { canonicalRepoIdentity } from "./release-identity";

export interface ReleaseLockPayload {
  ownerId: string;
  repoPath: string;
  repoIdentity?: string;
  baseBranch: string;
  createdAt: string;
  expiresAt: string;
}

export interface ReleaseLockHandle {
  ref: string;
  ownerId: string;
  commit: string;
  repoPath: string;
  repoIdentity: string;
  baseBranch: string;
}

export type GitRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; encoding?: BufferEncoding; input?: string },
) => SpawnSyncReturns<string>;

function runGit(
  run: GitRunner,
  cwd: string,
  args: string[],
  input?: string,
): SpawnSyncReturns<string> {
  return run("git", args, { cwd, encoding: "utf8", ...(input ? { input } : {}) });
}

export function releaseLockRef(args: {
  cwd?: string;
  repoPath: string;
  baseBranch: string;
  run?: GitRunner;
}): string {
  const repoKey = args.cwd
    ? canonicalRepoIdentity({
        cwd: args.cwd,
        repoPath: args.repoPath,
        run: args.run,
      }).key
    : safeRegistryKey(path.resolve(args.repoPath));
  const baseKey = safeRegistryKey(args.baseBranch);
  return `refs/gstack/release-locks/${repoKey}/${baseKey}`;
}

export function encodeReleaseLockPayload(payload: ReleaseLockPayload): string {
  return [
    "gstack release lock",
    "",
    JSON.stringify(payload, null, 2),
    "",
  ].join("\n");
}

export function parseReleaseLockPayload(message: string): ReleaseLockPayload | null {
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(message.slice(start, end + 1)) as ReleaseLockPayload;
    if (
      typeof parsed.ownerId === "string" &&
      typeof parsed.repoPath === "string" &&
      (typeof parsed.repoIdentity === "string" || parsed.repoIdentity === undefined) &&
      typeof parsed.baseBranch === "string" &&
      typeof parsed.expiresAt === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function createLockCommit(args: {
  cwd: string;
  payload: ReleaseLockPayload;
  run: GitRunner;
}): { ok: boolean; commit?: string; error?: string } {
  const tree = runGit(args.run, args.cwd, ["mktree"], "");
  if (tree.status !== 0) return { ok: false, error: tree.stderr || tree.stdout };
  const commit = runGit(
    args.run,
    args.cwd,
    ["commit-tree", tree.stdout.trim()],
    encodeReleaseLockPayload(args.payload),
  );
  if (commit.status !== 0) return { ok: false, error: commit.stderr || commit.stdout };
  return { ok: true, commit: commit.stdout.trim() };
}

function remoteRefSha(
  cwd: string,
  ref: string,
  run: GitRunner,
): string | null {
  const ls = runGit(run, cwd, ["ls-remote", "origin", ref]);
  if (ls.status !== 0 || !ls.stdout.trim()) return null;
  return ls.stdout.trim().split(/\s+/)[0] || null;
}

function readRemotePayload(
  cwd: string,
  ref: string,
  sha: string,
  run: GitRunner,
): ReleaseLockPayload | null {
  const fetched = runGit(run, cwd, ["fetch", "origin", ref]);
  if (fetched.status !== 0) return null;
  const msg = runGit(run, cwd, ["log", "-1", "--format=%B", sha]);
  if (msg.status !== 0) return null;
  return parseReleaseLockPayload(msg.stdout);
}

export function currentRemoteReleaseLockCommit(args: {
  cwd: string;
  ref: string;
  run?: GitRunner;
}): string | null {
  return remoteRefSha(args.cwd, args.ref, args.run ?? (spawnSync as GitRunner));
}

export function acquireRemoteReleaseLock(args: {
  cwd: string;
  repoPath: string;
  baseBranch: string;
  ownerId: string;
  ttlMs?: number;
  now?: Date;
  run?: GitRunner;
}): { acquired: true; handle: ReleaseLockHandle } | { acquired: false; reason: string } {
  const run = args.run ?? (spawnSync as GitRunner);
  const repoIdentity = canonicalRepoIdentity({
    cwd: args.cwd,
    repoPath: args.repoPath,
    run,
  });
  const ref = releaseLockRef({ ...args, run });
  const now = args.now ?? new Date();
  const ttlMs = args.ttlMs ?? 60 * 60 * 1000;
  const payload: ReleaseLockPayload = {
    ownerId: args.ownerId,
    repoPath: path.resolve(args.repoPath),
    repoIdentity: repoIdentity.identity,
    baseBranch: args.baseBranch,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  const created = createLockCommit({ cwd: args.cwd, payload, run });
  if (!created.ok || !created.commit) {
    return { acquired: false, reason: created.error ?? "could not create lock commit" };
  }

  const existing = remoteRefSha(args.cwd, ref, run);
  if (!existing) {
    const push = runGit(run, args.cwd, ["push", "origin", `${created.commit}:${ref}`]);
    if (push.status === 0) {
      return {
        acquired: true,
        handle: {
          ref,
          ownerId: args.ownerId,
          commit: created.commit,
          repoPath: path.resolve(args.repoPath),
          repoIdentity: repoIdentity.identity,
          baseBranch: args.baseBranch,
        },
      };
    }
    return { acquired: false, reason: push.stderr || push.stdout || "lock already held" };
  }

  const existingPayload = readRemotePayload(args.cwd, ref, existing, run);
  if (!existingPayload) {
    return {
      acquired: false,
      reason: `release lock payload unreadable at ${existing}`,
    };
  }
  const expiresAt = Date.parse(existingPayload.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return {
      acquired: false,
      reason: `release lock expiry unreadable for ${existingPayload.ownerId}`,
    };
  }
  if (expiresAt > now.getTime()) {
    return {
      acquired: false,
      reason: `release lock held by ${existingPayload?.ownerId ?? existing} until ${existingPayload?.expiresAt ?? "unknown"}`,
    };
  }

  const steal = runGit(run, args.cwd, [
    "push",
    "origin",
    `--force-with-lease=${ref}:${existing}`,
    `${created.commit}:${ref}`,
  ]);
  if (steal.status !== 0) {
    return { acquired: false, reason: steal.stderr || steal.stdout || "stale lock steal failed" };
  }
  return {
    acquired: true,
    handle: {
      ref,
      ownerId: args.ownerId,
      commit: created.commit,
      repoPath: path.resolve(args.repoPath),
      repoIdentity: repoIdentity.identity,
      baseBranch: args.baseBranch,
    },
  };
}

export function refreshRemoteReleaseLock(args: {
  cwd: string;
  handle: ReleaseLockHandle;
  ttlMs?: number;
  now?: Date;
  run?: GitRunner;
}): { ok: true; handle: ReleaseLockHandle } | { ok: false; lostOwnership: boolean; error: string } {
  const run = args.run ?? (spawnSync as GitRunner);
  const current = remoteRefSha(args.cwd, args.handle.ref, run);
  if (!current) {
    return { ok: false, lostOwnership: true, error: "release lock ref disappeared" };
  }
  if (current !== args.handle.commit) {
    return { ok: false, lostOwnership: true, error: "release lock is no longer owned by this daemon" };
  }
  const now = args.now ?? new Date();
  const ttlMs = args.ttlMs ?? 2 * 60 * 60 * 1000;
  const payload: ReleaseLockPayload = {
    ownerId: args.handle.ownerId,
    repoPath: args.handle.repoPath,
    repoIdentity: args.handle.repoIdentity,
    baseBranch: args.handle.baseBranch,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  const created = createLockCommit({ cwd: args.cwd, payload, run });
  if (!created.ok || !created.commit) {
    return {
      ok: false,
      lostOwnership: false,
      error: created.error ?? "could not create heartbeat lock commit",
    };
  }
  const pushed = runGit(run, args.cwd, [
    "push",
    "origin",
    `--force-with-lease=${args.handle.ref}:${current}`,
    `${created.commit}:${args.handle.ref}`,
  ]);
  if (pushed.status !== 0) {
    const after = remoteRefSha(args.cwd, args.handle.ref, run);
    return {
      ok: false,
      lostOwnership: after !== args.handle.commit,
      error: pushed.stderr || pushed.stdout || "release lock heartbeat failed",
    };
  }
  return {
    ok: true,
    handle: { ...args.handle, commit: created.commit },
  };
}

export function releaseRemoteReleaseLock(args: {
  cwd: string;
  handle: ReleaseLockHandle;
  run?: GitRunner;
}): { ok: boolean; error?: string } {
  const run = args.run ?? (spawnSync as GitRunner);
  const current = remoteRefSha(args.cwd, args.handle.ref, run);
  if (!current) return { ok: true };
  if (current !== args.handle.commit) {
    return { ok: false, error: "release lock is no longer owned by this daemon" };
  }
  const deleted = runGit(run, args.cwd, ["push", "origin", `:${args.handle.ref}`]);
  if (deleted.status !== 0) {
    return { ok: false, error: deleted.stderr || deleted.stdout };
  }
  return { ok: true };
}
