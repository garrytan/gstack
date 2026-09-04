/**
 * lib/gbrain-repo-policy-client — batch trust-tier lookup (#2392).
 *
 * Covers the `get --batch` verb of bin/gstack-gbrain-repo-policy (bash level:
 * multiple urls in, per-line verdicts out, input order preserved) and the
 * TypeScript client `repoPolicyTierBatch` (ONE spawn, dedup, fast paths, and
 * the whole-batch `unreadable` classification on a corrupt store).
 *
 * Each test uses a temp GSTACK_HOME so nothing leaks into the user's real
 * ~/.gstack. The client is exercised against the REAL bash script — the
 * script owns URL normalization, so stub stores are seeded through its own
 * `set` verb.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { canRevokeReads } from "./helpers/fs-caps";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";

import { repoPolicyTierBatch } from "../lib/gbrain-repo-policy-client";
import { canonicalizeRemote } from "../lib/gstack-memory-helpers";

const ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(ROOT, "bin", "gstack-gbrain-repo-policy");

let tmpHome: string;

function env(): NodeJS.ProcessEnv {
  return { ...process.env, GSTACK_HOME: tmpHome };
}

function run(args: string[], input?: string) {
  const res = spawnSync(BIN, args, { env: env(), encoding: "utf-8", input, timeout: 30_000 });
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status ?? -1,
  };
}

function policyFile(): string {
  return path.join(tmpHome, "gbrain-repo-policy.json");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-policy-client-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("bin/gstack-gbrain-repo-policy get --batch (bash level)", () => {
  test("multiple urls in, per-line verdicts out, input order preserved", () => {
    expect(run(["set", "https://github.com/foo/bar.git", "deny"]).status).toBe(0);
    expect(run(["set", "git@github.com:baz/qux.git", "read-only"]).status).toBe(0);
    expect(run(["set", "https://github.com/rw/repo", "read-write"]).status).toBe(0);

    const r = run(
      ["get", "--batch"],
      // Mixed URL forms — the script's normalize() collapses them to the
      // stored keys. `nope/never` has no entry → none.
      "git@github.com:foo/bar.git\nhttps://github.com/nope/never\nhttps://github.com/baz/qux\nhttps://github.com/rw/repo.git\n",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("deny\nnone\nread-only\nread-write\n");
  });

  test("no store on disk: every line is none, and no file is created", () => {
    const r = run(["get", "--batch"], "https://github.com/a/a\nhttps://github.com/b/b\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("none\nnone\n");
    expect(fs.existsSync(policyFile())).toBe(false);
  });

  test("corrupt store: hard error (exit 2), NOT quarantined, names recovery", () => {
    fs.writeFileSync(policyFile(), "not valid json{", { mode: 0o600 });
    const r = run(["get", "--batch"], "https://github.com/foo/bar\n");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("corrupt");
    expect(r.stderr).toContain("gstack-gbrain-repo-policy list");
    // Unlike interactive `get`, batch must never quarantine-and-proceed —
    // that would bypass a set deny policy on an unattended ingest run.
    expect(fs.readFileSync(policyFile(), "utf-8")).toBe("not valid json{");
    expect(
      fs.readdirSync(tmpHome).find((f) => f.includes(".corrupt-")),
    ).toBeUndefined();
  });

  test("legacy allow entries migrate to read-write on batch read", () => {
    fs.writeFileSync(
      policyFile(),
      JSON.stringify({ "github.com/foo/bar": "allow" }),
      { mode: 0o600 },
    );
    const r = run(["get", "--batch"], "https://github.com/foo/bar\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("read-write\n");
  });
});

describe("repoPolicyTierBatch (TypeScript client)", () => {
  test("maps each input url to its verdict, dedup included", () => {
    expect(run(["set", "https://github.com/foo/bar", "deny"]).status).toBe(0);
    expect(run(["set", "https://github.com/baz/qux", "read-only"]).status).toBe(0);

    const verdicts = repoPolicyTierBatch(
      [
        "github.com/foo/bar", // canonical form, as memory-ingest passes it
        "github.com/baz/qux",
        "github.com/nope/never",
        "github.com/foo/bar", // duplicate — dedup keeps ONE map entry
      ],
      env(),
    );
    expect(verdicts.size).toBe(3);
    expect(verdicts.get("github.com/foo/bar")).toEqual({ tier: "deny" });
    expect(verdicts.get("github.com/baz/qux")).toEqual({ tier: "read-only" });
    expect(verdicts.get("github.com/nope/never")).toEqual({ tier: "none" });
  });

  test("no store on disk: every url is tier none with no error (fast path)", () => {
    const verdicts = repoPolicyTierBatch(["github.com/a/a", "github.com/b/b"], env());
    expect(verdicts.get("github.com/a/a")).toEqual({ tier: "none" });
    expect(verdicts.get("github.com/b/b")).toEqual({ tier: "none" });
    expect(fs.existsSync(policyFile())).toBe(false);
  });

  test("empty url list returns an empty map without spawning", () => {
    const verdicts = repoPolicyTierBatch([], env());
    expect(verdicts.size).toBe(0);
  });

  test("corrupt store: EVERY url maps to { tier: none, error: unreadable }", () => {
    fs.writeFileSync(policyFile(), "not valid json{", { mode: 0o600 });
    const verdicts = repoPolicyTierBatch(["github.com/foo/bar", "github.com/baz/qux"], env());
    expect(verdicts.get("github.com/foo/bar")).toEqual({ tier: "none", error: "unreadable" });
    expect(verdicts.get("github.com/baz/qux")).toEqual({ tier: "none", error: "unreadable" });
  });

  test("store unreadable on disk (chmod 000): whole batch classified unreadable", () => {
    if (!canRevokeReads()) return; // chmod is advisory here (win32, root, DAC-override containers)
    expect(run(["set", "https://github.com/foo/bar", "deny"]).status).toBe(0);
    fs.chmodSync(policyFile(), 0o000);
    try {
      const verdicts = repoPolicyTierBatch(["github.com/foo/bar"], env());
      expect(verdicts.get("github.com/foo/bar")).toEqual({ tier: "none", error: "unreadable" });
    } finally {
      fs.chmodSync(policyFile(), 0o600);
    }
  });
});

// ── Normalize parity: bash normalize() ↔ lib canonicalizeRemote ─────────────
//
// bin/gstack-memory-ingest.ts produces page.git_remote via canonicalizeRemote
// (lib/gstack-memory-helpers) and then looks the policy up through
// repoPolicyTierBatch — whose bash side re-normalizes with normalize(). If
// the two functions disagree on ANY URL shape, a policy the user set via the
// script silently fails to apply to ingest (a deny that doesn't deny). The
// contract pinned here: for every shape X, `set X <tier>` followed by a batch
// lookup of canonicalizeRemote(X) returns <tier>. Bash owns normalization —
// any divergence is fixed in the SCRIPT's normalize(), never by re-normalizing
// in TypeScript.

describe("normalize parity: bash normalize() ↔ canonicalizeRemote (edge URL shapes)", () => {
  // One distinct repo per shape so tiers don't overwrite each other.
  const CORPUS: Array<{ shape: string; tier: "read-write" | "read-only" | "deny" }> = [
    { shape: "https://github.com/acme/plain", tier: "deny" },
    { shape: "https://github.com/acme/dotgit.git", tier: "read-only" },
    { shape: "https://github.com/acme/slash/", tier: "read-write" },
    // .git + trailing slash: bash must strip the slash BEFORE the .git suffix
    // (slash-first order), as canonicalizeRemote does.
    { shape: "https://github.com/acme/dotgitslash.git/", tier: "deny" },
    // Uppercase .GIT: canonicalizeRemote strips case-insensitively; bash must
    // lowercase before the suffix strip or the key keeps a ".git" tail.
    { shape: "https://github.com/ACME/UpperGit.GIT", tier: "read-only" },
    { shape: "git@github.com:acme/scp.git", tier: "deny" },
    { shape: "ssh://git@github.com/acme/sshurl.git", tier: "read-write" },
  ];

  test("normalize <url> prints exactly canonicalizeRemote(url) for every corpus shape", () => {
    for (const { shape } of CORPUS) {
      const r = run(["normalize", shape]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(canonicalizeRemote(shape));
    }
  });

  test("a policy set via the script with shape X is found via canonicalizeRemote(X)", () => {
    for (const { shape, tier } of CORPUS) {
      expect(run(["set", shape, tier]).status).toBe(0);
    }
    const canon = CORPUS.map((c) => canonicalizeRemote(c.shape));
    const verdicts = repoPolicyTierBatch(canon, env());
    for (let i = 0; i < CORPUS.length; i++) {
      expect(verdicts.get(canon[i])).toEqual({ tier: CORPUS[i].tier });
    }
  });

  test("cross-shape: set through one shape, looked up through another shape of the same repo", () => {
    // The store keys on the normalized form, so every spelling of the same
    // repo shares one entry — set through scp form, read through https form.
    expect(run(["set", "git@github.com:acme/xshape.git", "deny"]).status).toBe(0);
    const canon = canonicalizeRemote("https://github.com/ACME/XShape.GIT/");
    const verdicts = repoPolicyTierBatch([canon], env());
    expect(verdicts.get(canon)).toEqual({ tier: "deny" });
  });
});
