/**
 * gstack-post (B4: DX-6 synopsis and exit codes, ENG-9 digest-token
 * confirmation and argument safety, CEO-19 the helper owns the scan).
 *
 * Drives lib/gstack-post.ts in process with a fake runner, so the posting
 * logic is covered on Windows too (DX-15). test/gstack-post-cli.test.ts runs
 * the real executable against stub gh/glab on POSIX.
 */
import { describe, expect, test } from "bun:test";
import { EXIT, runPost, type PostEnv } from "../lib/gstack-post";

interface Call { cmd: string; args: string[]; input?: string }

function fakeEnv(opts: {
  remote?: string;
  files?: Record<string, string>;
  visibility?: string;
  email?: string;
  respond?: (c: Call) => { status: number; stdout?: string; stderr?: string } | undefined;
} = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let title = "";
  const env: PostEnv = {
    run(cmd, args, input) {
      const call = { cmd, args, input };
      calls.push(call);
      const custom = opts.respond?.(call);
      if (custom) return { stdout: "", stderr: "", ...custom };
      if (cmd === "git" && args[0] === "remote") return { status: 0, stdout: (opts.remote ?? "git@github.com:acme/widget.git") + "\n", stderr: "" };
      if (cmd === "git" && args[0] === "config") return { status: opts.email ? 0 : 1, stdout: (opts.email ?? "") + "\n", stderr: "" };
      if (cmd === "cfg") return { status: 0, stdout: (opts.visibility ?? "private") + "\n", stderr: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
        const t = args.find(a => a.startsWith("--title="));
        if (t) title = t.slice("--title=".length);
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { status: 0, stdout: title + "\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    readFile(p) {
      const f = opts.files ?? {};
      if (!(p in f)) throw new Error("ENOENT");
      return f[p]!;
    },
    out: t => { out.push(t); },
    err: t => { err.push(t); },
  };
  const posts = () => calls.filter(c => (c.cmd === "gh" || c.cmd === "glab") && !(c.args[0] === "repo" || c.args[1] === "view"));
  return { env, calls, posts, stdout: () => out.join(""), stderr: () => err.join("") };
}

const run = (argv: string[], f: ReturnType<typeof fakeEnv>) => runPost(argv, f.env, "cfg");
const token = (stdout: string) => /^TOKEN: ([0-9a-f]+)$/m.exec(stdout)?.[1];
const AWS = "AKIA" + "1234567890ABCDEF";

describe("gstack-post posts through argv, never a shell string", () => {
  test("a clean comment goes to gh as an argument array with the body on stdin", () => {
    const body = "Fixed in `abc123`. $(touch pwned) \"quoted\" and 'single'\n";
    const f = fakeEnv({ files: { "/b": body } });
    expect(run(["pr-comment", "12", "--body-file", "/b"], f)).toBe(EXIT.posted);
    expect(f.posts()).toEqual([{ cmd: "gh", args: ["pr", "comment", "12", "--body-file=-"], input: body }]);
    expect(f.stdout()).toContain("POSTED: pr-comment 12");
  });

  test("a title of --repo evil/x is posted as text, in --title=<value> form", () => {
    const f = fakeEnv({ files: { "/t": "--repo evil/x\n" } });
    expect(run(["pr-title", "7", "--title-file", "/t"], f)).toBe(EXIT.posted);
    expect(f.posts()[0]).toEqual({ cmd: "gh", args: ["pr", "edit", "7", "--title=--repo evil/x"], input: undefined });
    const g = fakeEnv({ files: { "/t": "--repo evil/x", "/b": "body" } });
    expect(run(["pr-create", "--base", "main", "--draft", "--title-file", "/t", "--body-file", "/b"], g)).toBe(EXIT.posted);
    expect(g.posts()[0]!.args).toEqual(["pr", "create", "--base=main", "--title=--repo evil/x", "--body-file=-", "--draft"]);
  });

  test("every operation's GitHub and GitLab argv", () => {
    const files = { "/t": "v1.2.3 fix: title", "/b": "line one\nline two" };
    const gh = (argv: string[]) => { const f = fakeEnv({ files }); expect(run(argv, f)).toBe(0); return f.posts()[0]!; };
    expect(gh(["issue-comment", "3", "--body-file", "/b"]).args).toEqual(["issue", "comment", "3", "--body-file=-"]);
    expect(gh(["reply", "4", "--to", "991", "--body-file", "/b"]).args).toEqual(["api", "--method=POST", "repos/{owner}/{repo}/pulls/4/comments/991/replies", "--field=body=@-"]);
    expect(gh(["pr-body", "5", "--body-file", "/b"])).toEqual({ cmd: "gh", args: ["pr", "edit", "5", "--body-file=-"], input: files["/b"] });
    expect(gh(["issue-create", "--title-file", "/t", "--body-file", "/b"]).args).toEqual(["issue", "create", "--title=v1.2.3 fix: title", "--body-file=-"]);
    const gl = (argv: string[]) => { const f = fakeEnv({ files, remote: "https://gitlab.com/grp/sub/proj.git" }); expect(run(argv, f)).toBe(0); return f.posts()[0]!; };
    expect(gl(["pr-comment", "8", "--body-file", "/b"]).args).toEqual(["mr", "note", "8", "--message=line one\nline two"]);
    expect(gl(["pr-body", "8", "--body-file", "/b"]).args).toEqual(["mr", "update", "8", "--description=line one\nline two"]);
    expect(gl(["pr-create", "--base", "main", "--title-file", "/t", "--body-file", "/b"]).args)
      .toEqual(["mr", "create", "--target-branch=main", "--title=v1.2.3 fix: title", "--description=line one\nline two", "--yes"]);
    expect(gl(["issue-create", "--title-file", "/t", "--body-file", "/b"]).args).toEqual(["issue", "create", "--title=v1.2.3 fix: title", "--description=line one\nline two", "--yes"]);
  });

  test("a target is a number or a URL of this repository on the same host", () => {
    const files = { "/b": "hello" };
    const ok = fakeEnv({ files });
    expect(run(["pr-comment", "https://github.com/Acme/widget/pull/42", "--body-file", "/b"], ok)).toBe(0);
    expect(ok.posts()[0]!.args[2]).toBe("42");
    for (const bad of ["https://evil.example/acme/widget/pull/42", "https://github.com/evil/x/pull/42", "https://github.com/acme/widget/issues/42", "--repo=evil/x", "12abc"]) {
      const f = fakeEnv({ files });
      expect(run(["pr-comment", bad, "--body-file", "/b"], f)).toBe(EXIT.usage);
      expect(f.posts()).toEqual([]);
    }
  });

  test("usage errors exit 64 and post nothing", () => {
    for (const argv of [[], ["pr-merge", "1"], ["pr-title", "1", "--body-file", "/b"], ["reply", "1", "--body-file", "/b"], ["pr-comment", "1", "--body-file", "/missing"], ["pr-title", "1", "--title-file", "/two"]]) {
      const f = fakeEnv({ files: { "/b": "x", "/two": "a\nb" } });
      expect(run(argv, f)).toBe(EXIT.usage);
      expect(f.posts()).toEqual([]);
    }
  });
});

describe("gstack-post owns the redaction scan", () => {
  test("a HIGH secret is refused, even with --confirm, and nothing is posted", () => {
    const f = fakeEnv({ files: { "/b": `see key ${AWS}\n` } });
    expect(run(["pr-comment", "1", "--body-file", "/b"], f)).toBe(EXIT.refused);
    expect(f.stdout()).toContain("HIGH RULE: aws.access_key LINE: 1 PART: body");
    expect(f.stdout()).not.toContain(AWS);
    expect(f.stderr()).toContain("aws.access_key");
    const g = fakeEnv({ files: { "/b": `see key ${AWS}\n` } });
    expect(run(["pr-comment", "1", "--body-file", "/b", "--confirm", "0".repeat(24)], g)).toBe(EXIT.refused);
    expect([...f.posts(), ...g.posts()]).toEqual([]);
  });

  test("MEDIUM posts nothing until the caller confirms with the token for those bytes", () => {
    const files = { "/b": "Ping jane.roe@acme-corp.io about it.\n" };
    const first = fakeEnv({ files, visibility: "public" });
    expect(run(["issue-comment", "9", "--body-file", "/b"], first)).toBe(EXIT.confirm);
    expect(first.stdout()).toContain("REPO_VISIBILITY: public");
    expect(first.stdout()).toContain("RULE: pii.email LINE: 1 PART: body");
    expect(first.stdout()).not.toContain("jane.roe");
    expect(first.posts()).toEqual([]);
    const t = token(first.stdout())!;
    expect(t).toMatch(/^[0-9a-f]{24}$/);
    const second = fakeEnv({ files, visibility: "public" });
    expect(run(["issue-comment", "9", "--body-file", "/b", "--confirm", t], second)).toBe(EXIT.posted);
    expect(second.posts()).toEqual([{ cmd: "gh", args: ["issue", "comment", "9", "--body-file=-"], input: files["/b"] }]);
  });

  test("changed bytes with the same rule and line need a new token", () => {
    const a = fakeEnv({ files: { "/b": "Ping jane.roe@acme-corp.io about it.\n" } });
    expect(run(["pr-comment", "9", "--body-file", "/b"], a)).toBe(EXIT.confirm);
    const old = token(a.stdout())!;
    const b = fakeEnv({ files: { "/b": "Ping john.doe@acme-corp.io about it.\n" } });
    expect(run(["pr-comment", "9", "--body-file", "/b", "--confirm", old], b)).toBe(EXIT.confirm);
    expect(b.stdout()).toContain("RULE: pii.email LINE: 1 PART: body");
    expect(token(b.stdout())).not.toBe(old);
    expect(b.stderr()).toContain("changed since that token");
    expect(b.posts()).toEqual([]);
  });

  test("the token is bound to the destination and operation", () => {
    const files = { "/b": "Ping jane.roe@acme-corp.io about it.\n" };
    const a = fakeEnv({ files });
    run(["pr-comment", "9", "--body-file", "/b"], a);
    const t = token(a.stdout())!;
    for (const argv of [["pr-comment", "10", "--body-file", "/b"], ["issue-comment", "9", "--body-file", "/b"], ["pr-body", "9", "--body-file", "/b"]]) {
      const f = fakeEnv({ files });
      expect(run([...argv, "--confirm", t], f)).toBe(EXIT.confirm);
      expect(f.posts()).toEqual([]);
    }
  });

  test("the title is scanned too, and the pusher's own email is not a finding", () => {
    const f = fakeEnv({ files: { "/t": "v1 fix for jane.roe@acme-corp.io", "/b": "body" } });
    expect(run(["pr-create", "--base", "main", "--title-file", "/t", "--body-file", "/b"], f)).toBe(EXIT.confirm);
    expect(f.stdout()).toContain("RULE: pii.email LINE: 1 PART: title");
    const own = fakeEnv({ files: { "/b": "Ping jane.roe@acme-corp.io" }, email: "jane.roe@acme-corp.io" });
    expect(run(["pr-comment", "1", "--body-file", "/b"], own)).toBe(EXIT.posted);
  });
});

describe("gstack-post reports CLI failures and repairs known edit failures", () => {
  test("a failed gh call exits 3", () => {
    const f = fakeEnv({ files: { "/b": "hi" }, respond: c => (c.cmd === "gh" && c.args[0] === "pr" ? { status: 1, stderr: "HTTP 404" } : undefined) });
    expect(run(["pr-comment", "1", "--body-file", "/b"], f)).toBe(EXIT.cliFailed);
    expect(f.stderr()).toContain("HTTP 404");
  });

  test("the projectCards GraphQL failure falls back to the REST PATCH with the same bytes", () => {
    const f = fakeEnv({ files: { "/b": "new body" }, respond: c => (c.args[1] === "edit" ? { status: 1, stderr: "GraphQL: repository.pullRequest.projectCards is deprecated" } : undefined) });
    expect(run(["pr-body", "6", "--body-file", "/b"], f)).toBe(EXIT.posted);
    expect(f.posts().at(-1)).toEqual({ cmd: "gh", args: ["api", "--method=PATCH", "repos/{owner}/{repo}/pulls/6", "--field=body=@-", "--silent"], input: "new body" });
  });

  test("a title that does not read back is retried once, then reported", () => {
    let views = 0;
    const f = fakeEnv({ files: { "/t": "v2 feat: x" }, respond: c => (c.args[1] === "view" ? { status: 0, stdout: views++ === 0 ? "old\n" : "v2 feat: x\n" } : undefined) });
    expect(run(["pr-title", "2", "--title-file", "/t"], f)).toBe(EXIT.posted);
    expect(f.posts().filter(c => c.args[1] === "edit")).toHaveLength(2);
    const stuck = fakeEnv({ files: { "/t": "v2 feat: x" }, respond: c => (c.args[1] === "view" ? { status: 0, stdout: "old\n" } : undefined) });
    expect(run(["pr-title", "2", "--title-file", "/t"], stuck)).toBe(EXIT.cliFailed);
  });

  test("an unrecognized remote host asks gh for the repository URL", () => {
    const f = fakeEnv({ files: { "/b": "hi" }, remote: "https://proxy.internal/acme/widget.git", respond: c => (c.args[0] === "repo" && c.cmd === "gh" ? { status: 0, stdout: "https://github.com/acme/widget\n" } : undefined) });
    expect(run(["pr-comment", "https://github.com/acme/widget/pull/3", "--body-file", "/b"], f)).toBe(EXIT.posted);
    expect(f.posts()[0]!.args.slice(0, 3)).toEqual(["pr", "comment", "3"]);
  });
});
