import { describe, expect, it } from "bun:test";
import {
  acquireRemoteReleaseLock,
  parseReleaseLockPayload,
  refreshRemoteReleaseLock,
  releaseLockRef,
  releaseRemoteReleaseLock,
  type GitRunner,
} from "../release-lock";

function fakeGit(opts: {
  existingSha?: string | null;
  lsRemoteSequence?: Array<string | null>;
  existingMessage?: string;
  remoteUrl?: string;
  fetchStatus?: number;
  pushCreateStatus?: number;
  stealStatus?: number;
  deleteStatus?: number;
} = {}): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const lsRemoteSequence = [...(opts.lsRemoteSequence ?? [])];
  const run: GitRunner = (_cmd, args) => {
    calls.push(args);
    const key = args.join(" ");
    if (args[0] === "remote") {
      return {
        status: opts.remoteUrl ? 0 : 1,
        stdout: opts.remoteUrl ? `${opts.remoteUrl}\n` : "",
        stderr: "",
        signal: null,
        output: [],
      } as any;
    }
    if (args[0] === "mktree") return { status: 0, stdout: "tree\n", stderr: "", signal: null, output: [] } as any;
    if (args[0] === "commit-tree") return { status: 0, stdout: "commit-new\n", stderr: "", signal: null, output: [] } as any;
    if (args[0] === "ls-remote") {
      const nextSha = lsRemoteSequence.length > 0 ? lsRemoteSequence.shift() : opts.existingSha;
      return {
        status: 0,
        stdout: nextSha ? `${nextSha}\t${args[2]}\n` : "",
        stderr: "",
        signal: null,
        output: [],
      } as any;
    }
    if (args[0] === "fetch") {
      return { status: opts.fetchStatus ?? 0, stdout: "", stderr: "fetch failed", signal: null, output: [] } as any;
    }
    if (args[0] === "log") {
      return {
        status: 0,
        stdout: opts.existingMessage ?? "",
        stderr: "",
        signal: null,
        output: [],
      } as any;
    }
    if (args[0] === "push" && key.includes("--force-with-lease")) {
      return { status: opts.stealStatus ?? 0, stdout: "", stderr: "steal failed", signal: null, output: [] } as any;
    }
    if (args[0] === "push" && args.some((arg) => arg.startsWith(":refs/"))) {
      return { status: opts.deleteStatus ?? 0, stdout: "", stderr: "delete failed", signal: null, output: [] } as any;
    }
    if (args[0] === "push") {
      return { status: opts.pushCreateStatus ?? 0, stdout: "", stderr: "push failed", signal: null, output: [] } as any;
    }
    return { status: 1, stdout: "", stderr: key, signal: null, output: [] } as any;
  };
  return { run, calls };
}

describe("remote release lock", () => {
  it("keys the lock by canonical remote identity, not local checkout path", () => {
    const a = releaseLockRef({
      cwd: "/Users/alice/work/repo",
      repoPath: "/Users/alice/work/repo",
      baseBranch: "main",
      run: fakeGit({ remoteUrl: "git@github.com:acme/repo.git" }).run,
    });
    const b = releaseLockRef({
      cwd: "/home/bob/src/repo",
      repoPath: "/home/bob/src/repo",
      baseBranch: "main",
      run: fakeGit({ remoteUrl: "https://github.com/acme/repo.git" }).run,
    });
    expect(a).toBe(b);
    expect(a).toBe("refs/gstack/release-locks/github.com-acme-repo/main");
  });

  it("acquires a missing remote ref with push-create", () => {
    const git = fakeGit({ existingSha: null });
    const result = acquireRemoteReleaseLock({
      cwd: "/repo",
      repoPath: "/repo",
      baseBranch: "main",
      ownerId: "owner-a",
      run: git.run,
      now: new Date("2026-05-09T00:00:00.000Z"),
    });
    expect(result.acquired).toBe(true);
    expect(git.calls.some((args) => args[0] === "push" && !args.includes("--force-with-lease"))).toBe(true);
  });

  it("refuses a live lock and steals an expired lock with force-with-lease", () => {
    const livePayload = [
      "gstack release lock",
      "",
      JSON.stringify({
        ownerId: "owner-a",
        repoPath: "/repo",
        baseBranch: "main",
        createdAt: "2026-05-09T00:00:00.000Z",
        expiresAt: "2026-05-09T01:00:00.000Z",
      }),
    ].join("\n");
    const live = acquireRemoteReleaseLock({
      cwd: "/repo",
      repoPath: "/repo",
      baseBranch: "main",
      ownerId: "owner-b",
      run: fakeGit({ existingSha: "old", existingMessage: livePayload }).run,
      now: new Date("2026-05-09T00:05:00.000Z"),
    });
    expect(live.acquired).toBe(false);

    const expiredGit = fakeGit({ existingSha: "old", existingMessage: livePayload });
    const stolen = acquireRemoteReleaseLock({
      cwd: "/repo",
      repoPath: "/repo",
      baseBranch: "main",
      ownerId: "owner-b",
      run: expiredGit.run,
      now: new Date("2026-05-09T02:00:00.000Z"),
    });
    expect(stolen.acquired).toBe(true);
    expect(expiredGit.calls.some((args) => args.includes("--force-with-lease=refs/gstack/release-locks/path-repo/main:old"))).toBe(true);
  });

  it("fetches the remote lock object without updating the local lock ref", () => {
    const livePayload = [
      "gstack release lock",
      "",
      JSON.stringify({
        ownerId: "owner-a",
        repoPath: "/repo",
        baseBranch: "main",
        createdAt: "2026-05-09T00:00:00.000Z",
        expiresAt: "2026-05-09T01:00:00.000Z",
      }),
    ].join("\n");
    const git = fakeGit({ existingSha: "old", existingMessage: livePayload });
    const live = acquireRemoteReleaseLock({
      cwd: "/repo",
      repoPath: "/repo",
      baseBranch: "main",
      ownerId: "owner-b",
      run: git.run,
      now: new Date("2026-05-09T00:05:00.000Z"),
    });
    expect(live.acquired).toBe(false);
    expect(git.calls).toContainEqual([
      "fetch",
      "origin",
      "refs/gstack/release-locks/path-repo/main",
    ]);
    expect(git.calls.some((args) => args.includes("refs/gstack/release-locks/path-repo/main:refs/gstack/release-locks/path-repo/main"))).toBe(false);
    expect(git.calls.some((args) => args.includes("--force-with-lease=refs/gstack/release-locks/path-repo/main:old"))).toBe(false);
  });

  it("fails closed instead of stealing when the existing lock payload cannot be read", () => {
    const git = fakeGit({ existingSha: "old", fetchStatus: 1 });
    const result = acquireRemoteReleaseLock({
      cwd: "/repo",
      repoPath: "/repo",
      baseBranch: "main",
      ownerId: "owner-b",
      run: git.run,
      now: new Date("2026-05-09T02:00:00.000Z"),
    });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toContain("payload unreadable");
    expect(git.calls.some((args) => args.includes("--force-with-lease=refs/gstack/release-locks/path-repo/main:old"))).toBe(false);
  });

  it("refreshes a held lock with force-with-lease and returns the new commit", () => {
    const git = fakeGit({ existingSha: "mine" });
    const refreshed = refreshRemoteReleaseLock({
      cwd: "/repo",
      handle: {
        ref: "refs/gstack/release-locks/repo/main",
        ownerId: "me",
        commit: "mine",
        repoPath: "/repo",
        repoIdentity: "github.com/acme/repo",
        baseBranch: "main",
      },
      run: git.run,
      now: new Date("2026-05-09T00:10:00.000Z"),
    });
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.handle.commit).toBe("commit-new");
    expect(git.calls.some((args) => args.includes("--force-with-lease=refs/gstack/release-locks/repo/main:mine"))).toBe(true);
  });

  it("distinguishes transient heartbeat failure from lost ownership", () => {
    const transient = refreshRemoteReleaseLock({
      cwd: "/repo",
      handle: {
        ref: "refs/gstack/release-locks/repo/main",
        ownerId: "me",
        commit: "mine",
        repoPath: "/repo",
        repoIdentity: "github.com/acme/repo",
        baseBranch: "main",
      },
      run: fakeGit({ lsRemoteSequence: ["mine", "mine"], stealStatus: 1 }).run,
    });
    expect(transient.ok).toBe(false);
    if (!transient.ok) expect(transient.lostOwnership).toBe(false);

    const lost = refreshRemoteReleaseLock({
      cwd: "/repo",
      handle: {
        ref: "refs/gstack/release-locks/repo/main",
        ownerId: "me",
        commit: "mine",
        repoPath: "/repo",
        repoIdentity: "github.com/acme/repo",
        baseBranch: "main",
      },
      run: fakeGit({ lsRemoteSequence: ["mine", "other"], stealStatus: 1 }).run,
    });
    expect(lost.ok).toBe(false);
    if (!lost.ok) expect(lost.lostOwnership).toBe(true);
  });

  it("releases only when the remote ref still points at our commit", () => {
    const other = releaseRemoteReleaseLock({
      cwd: "/repo",
      handle: {
        ref: "refs/gstack/release-locks/repo/main",
        ownerId: "me",
        commit: "mine",
        repoPath: "/repo",
        repoIdentity: "github.com/acme/repo",
        baseBranch: "main",
      },
      run: fakeGit({ existingSha: "other" }).run,
    });
    expect(other.ok).toBe(false);

    const ours = releaseRemoteReleaseLock({
      cwd: "/repo",
      handle: {
        ref: "refs/gstack/release-locks/repo/main",
        ownerId: "me",
        commit: "mine",
        repoPath: "/repo",
        repoIdentity: "github.com/acme/repo",
        baseBranch: "main",
      },
      run: fakeGit({ existingSha: "mine" }).run,
    });
    expect(ours.ok).toBe(true);
  });

  it("parses the JSON payload from a lock commit message", () => {
    expect(parseReleaseLockPayload("header\n\n{\"ownerId\":\"o\",\"repoPath\":\"/r\",\"baseBranch\":\"main\",\"createdAt\":\"x\",\"expiresAt\":\"y\"}")?.ownerId).toBe("o");
  });
});
