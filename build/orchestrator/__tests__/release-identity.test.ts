import { describe, expect, it } from "bun:test";
import {
  canonicalRepoIdentity,
  normalizeRemoteIdentity,
  type RemoteRunner,
} from "../release-identity";

describe("release identity", () => {
  it("normalizes common SSH and HTTPS remotes to the same canonical identity", () => {
    expect(normalizeRemoteIdentity("git@github.com:acme/repo.git")).toBe("github.com/acme/repo");
    expect(normalizeRemoteIdentity("https://github.com/acme/repo.git")).toBe("github.com/acme/repo");
    expect(normalizeRemoteIdentity("ssh://git@github.com/acme/repo.git")).toBe("github.com/acme/repo");
  });

  it("retains enterprise hosts and nested GitLab paths", () => {
    expect(normalizeRemoteIdentity("git@gitlab.example.com:group/sub/repo.git")).toBe(
      "gitlab.example.com/group/sub/repo",
    );
    expect(normalizeRemoteIdentity("https://github.enterprise.test/org/repo")).toBe(
      "github.enterprise.test/org/repo",
    );
  });

  it("falls back to the local path when origin is unavailable", () => {
    const run = (() => ({ status: 1, stdout: "", stderr: "", signal: null, output: [] })) as RemoteRunner;
    const identity = canonicalRepoIdentity({
      cwd: "/tmp/a/repo",
      repoPath: "/tmp/a/repo",
      run,
    });
    expect(identity.source).toBe("path");
    expect(identity.identity).toBe("path:/tmp/a/repo");
  });

  it("uses the remote identity instead of local path when origin is available", () => {
    const run = (() => ({
      status: 0,
      stdout: "git@github.com:acme/repo.git\n",
      stderr: "",
      signal: null,
      output: [],
    })) as RemoteRunner;
    expect(canonicalRepoIdentity({ cwd: "/tmp/a/repo", repoPath: "/tmp/a/repo", run })).toEqual({
      identity: "github.com/acme/repo",
      key: "github.com-acme-repo",
      source: "remote",
    });
  });
});
