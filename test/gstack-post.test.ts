/**
 * gstack-post (B4: DX-6 synopsis and exit codes, ENG-9 digest-token
 * confirmation and argument safety, CEO-19 the helper owns the scan).
 *
 * Drives lib/gstack-post.ts in process with a fake runner, so the posting
 * logic is covered on Windows too (DX-15). test/gstack-post-cli.test.ts runs
 * the real executable against stub gh/glab on POSIX.
 */
import { describe, expect, test } from "bun:test";
import { EXIT, attributionCallout, mergeBodySections, runPost, type PostEnv } from "../lib/gstack-post";

interface Call { cmd: string; args: string[]; input?: string }

function fakeEnv(opts: {
  remote?: string;
  files?: Record<string, string>;
  visibility?: string;
  email?: string;
  /** The repository root `git rev-parse --show-toplevel` reports; VERSION and CHANGELOG.md are read from `files` under it. */
  root?: string;
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
      if (cmd === "git" && args[0] === "rev-parse") return { status: opts.root ? 0 : 128, stdout: (opts.root ?? "") + "\n", stderr: opts.root ? "" : "fatal: not a git repository" };
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

  test("the repo's own release versions in prose are not public IPs; other dotted quads still need confirmation", () => {
    const repo = {
      "/repo/VERSION": "1.91.226.0\n",
      "/repo/CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n## [1.91.191.0] - 2026-10-24\n- x\n\n## v1.91.190.0\n\n## [1.128.1.0 mirror]\n",
    };
    const clean = [
      "The receipt is written to a file (1.91.191.0).",
      "Since v1.91.226.0 the queue refuses a READY without it.",
      "1.91.191.0",
      "landed in release 1.91.190.0 and 1.91.226.0",
    ];
    for (const body of clean) {
      const f = fakeEnv({ files: { ...repo, "/b": body + "\n" }, root: "/repo", visibility: "public" });
      expect([body, run(["pr-comment", "12", "--body-file", "/b"], f)]).toEqual([body, EXIT.posted]);
      expect(f.posts()).toHaveLength(1);
    }
    const controls = [
      "resolver 8.8.8.8 answered",
      "egress is 203.0.113.7 in prod",
      "the mirror at 1.128.1.0 is ours",
      "host: 1.91.192.0",
    ];
    for (const body of controls) {
      const f = fakeEnv({ files: { ...repo, "/b": body + "\n" }, root: "/repo", visibility: "public" });
      expect([body, run(["pr-comment", "12", "--body-file", "/b"], f)]).toEqual([body, EXIT.confirm]);
      expect(f.stdout()).toContain("RULE: pii.ip_public LINE: 1 PART: body");
      expect(f.posts()).toEqual([]);
    }
    const elsewhere = fakeEnv({ files: { "/b": "The receipt is written to a file (1.91.191.0).\n" }, visibility: "public" });
    expect(run(["pr-comment", "12", "--body-file", "/b"], elsewhere)).toBe(EXIT.confirm);
    expect(elsewhere.stdout()).toContain("RULE: pii.ip_public LINE: 1 PART: body");
    const noVersion = fakeEnv({ files: { "/repo/VERSION": "2.4.0\n", "/b": "see (1.91.191.0)\n" }, root: "/repo", visibility: "public" });
    expect(run(["pr-comment", "12", "--body-file", "/b"], noVersion)).toBe(EXIT.confirm);
  });

  test("a receipt's all-digit tree hash and GitHub run ids in prose or link text are not phone numbers; real numbers still are", () => {
    const clean = [
      "SHIP_RECEIPT: pr=3424 head=abc tree=704992822996",
      "receipt tree 704992822996 verified",
      "head=193687123456 gated_tree=704992822996 predecessor=123456789012 (gate-reuse: eligible)",
      "cleared by run 19368712345",
      "see [run 19368712345](https://github.com/garrytan/gstack/actions/runs/19368712345) for the gate",
      "run #19368712345 is green",
    ];
    for (const body of clean) {
      const f = fakeEnv({ files: { "/b": body + "\n" }, visibility: "public" });
      expect([body, run(["pr-comment", "12", "--body-file", "/b"], f)]).toEqual([body, EXIT.posted]);
      expect(f.posts()).toHaveLength(1);
    }
    const controls = [
      "call +14155551234 for the on-call",
      "the id is 19368712345",
      "run 4155551234 answered",
      "tree=70499282299 is short",
      "subtree=704992822996 is not a receipt key",
    ];
    for (const body of controls) {
      const f = fakeEnv({ files: { "/b": body + "\n" }, visibility: "public" });
      expect([body, run(["pr-comment", "12", "--body-file", "/b"], f)]).toEqual([body, EXIT.confirm]);
      expect(f.stdout()).toContain("RULE: pii.phone.e164 LINE: 1 PART: body");
      expect(f.posts()).toEqual([]);
    }
  });

  // Value: protects=an 11-digit GitHub Actions run id written after a run word (run, screen, gate, backstop, bisect, rerun, dispatched, failed, passed,
  // with an optional ':' '#' '='), or chained after one with ",", "and", "&", "or" or "/" (a "(#1234)" between allowed), posts without a pii.phone.e164
  // confirmation, while a generic word (id, job, attempt, workflow) exempts nothing; fails_when=real receipts ("failed 40269992077 | rerun passed
  // 40287239206", "screen 40269992077 (#3434) and 40275443393 (#3453)", "gate 40323989742") need --confirm, "customer id 14155551234" or "job 40323989748"
  // posts unconfirmed, or a bare 11-digit number, a 10-digit national number or an E.164 number stops reporting;
  // why_new=the receipt-token test allowlists only "run <id>" and the /actions/runs/ URL; seam=none; no_claim=none beyond protects
  test("run ids next to run words, and the ids chained after them, are not phone numbers; a bare id, a national number and an E.164 number still are", () => {
    const clean = [
      "failed 40269992077 | rerun passed 40287239206",
      "screen 40269992077 (#3434) and 40275443393 (#3453)",
      "gate 40323989742",
      "gates: 40323989742, 40323989743 or 40323989744",
      "backstop=40323989742 bisect #40323989745",
      "dispatched 40323989742 / 40323989746 & 40323989747",
      "runs 40323989742 and 40323989753 (#3454), 40323989754",
    ];
    for (const body of clean) {
      const f = fakeEnv({ files: { "/b": body + "\n" }, visibility: "public" });
      expect([body, run(["pr-comment", "12", "--body-file", "/b"], f)]).toEqual([body, EXIT.posted]);
      expect(f.posts()).toHaveLength(1);
    }
    const controls = [
      "the id is 19368712345",
      "customer id 14155551234",
      "job 40323989748",
      "workflow 40323989742; attempt 40323989749; ids 40323989751, 40323989752",
      "40269992077 failed",
      "gate 40323989742. Then 40323989743 on its own",
      "gate 4155551234",
      "call +14155551234 for the on-call",
      "run +14155551234",
      "see 40323989742, 40323989743",
    ];
    for (const body of controls) {
      const f = fakeEnv({ files: { "/b": body + "\n" }, visibility: "public" });
      expect([body, run(["pr-comment", "12", "--body-file", "/b"], f)]).toEqual([body, EXIT.confirm]);
      expect(f.stdout()).toContain("RULE: pii.phone.e164 LINE: 1 PART: body");
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

describe("gstack-post --attribute labels a comment, opt-in and off by default", () => {
  const CALLOUT = "> [!NOTE]\n> 🤖 **Claude Opus on behalf of octocat**\n\n";
  test("without the flag the body is sent exactly as written", () => {
    const f = fakeEnv({ files: { "/b": "Fixed in abc123.\n" } });
    expect(run(["pr-comment", "12", "--body-file", "/b"], f)).toBe(EXIT.posted);
    expect(f.posts()[0]!.input).toBe("Fixed in abc123.\n");
    expect(f.stdout()).not.toContain("attributed");
  });

  test("with the flag every comment operation opens with the callout and the body follows unchanged", () => {
    expect(attributionCallout("Claude Opus on behalf of octocat")).toBe(CALLOUT);
    const body = "Fixed in abc123.\n";
    const cases: Array<[string[], string[]]> = [
      [["pr-comment", "12"], ["pr", "comment", "12", "--body-file=-"]],
      [["issue-comment", "3"], ["issue", "comment", "3", "--body-file=-"]],
      [["reply", "4", "--to", "991"], ["api", "--method=POST", "repos/{owner}/{repo}/pulls/4/comments/991/replies", "--field=body=@-"]],
    ];
    for (const [argv, args] of cases) {
      const f = fakeEnv({ files: { "/b": body } });
      expect(run([...argv, "--body-file", "/b", "--attribute", "Claude Opus on behalf of octocat"], f)).toBe(EXIT.posted);
      expect(f.posts()).toEqual([{ cmd: "gh", args, input: CALLOUT + body }]);
      expect(f.stdout()).toContain(`POSTED: ${argv[0]} ${argv[1]} (attributed: Claude Opus on behalf of octocat)`);
    }
    const gl = fakeEnv({ files: { "/b": body }, remote: "https://gitlab.com/grp/proj.git" });
    expect(run(["pr-comment", "8", "--body-file", "/b", "--attribute", "Claude Opus on behalf of octocat"], gl)).toBe(EXIT.posted);
    expect(gl.posts()[0]!.args).toEqual(["mr", "note", "8", `--message=${CALLOUT}${body}`]);
  });

  test("the scan and the confirmation token cover the callout bytes too", () => {
    const files = { "/b": "Ping jane.roe@acme-corp.io about it.\n" };
    const first = fakeEnv({ files, visibility: "public" });
    expect(run(["pr-comment", "9", "--body-file", "/b", "--attribute", "GPT on behalf of octocat"], first)).toBe(EXIT.confirm);
    expect(first.stdout()).toContain("RULE: pii.email LINE: 1 PART: body");
    const t = token(first.stdout())!;
    const plain = fakeEnv({ files, visibility: "public" });
    expect(run(["pr-comment", "9", "--body-file", "/b"], plain)).toBe(EXIT.confirm);
    expect(token(plain.stdout())).not.toBe(t);
    const other = fakeEnv({ files, visibility: "public" });
    expect(run(["pr-comment", "9", "--body-file", "/b", "--attribute", "GPT on behalf of someone-else", "--confirm", t], other)).toBe(EXIT.confirm);
    expect(other.posts()).toEqual([]);
    const second = fakeEnv({ files, visibility: "public" });
    expect(run(["pr-comment", "9", "--body-file", "/b", "--attribute", "GPT on behalf of octocat", "--confirm", t], second)).toBe(EXIT.posted);
    expect(second.posts()[0]!.input).toBe(attributionCallout("GPT on behalf of octocat") + files["/b"]);
    const secret = fakeEnv({ files: { "/b": "ok\n" } });
    expect(run(["pr-comment", "9", "--body-file", "/b", "--attribute", `key ${AWS}`], secret)).toBe(EXIT.refused);
    expect(secret.stdout()).toContain("HIGH RULE: aws.access_key LINE: 1 PART: attribute");
    expect(secret.posts()).toEqual([]);
  });

  test("the flag is refused on non-comment operations and for empty or multi-line text", () => {
    const files = { "/t": "v1.2.3 fix: title", "/b": "body" };
    for (const argv of [
      ["pr-body", "5", "--body-file", "/b", "--attribute", "x on behalf of y"],
      ["pr-title", "5", "--title-file", "/t", "--attribute", "x on behalf of y"],
      ["pr-create", "--base", "main", "--title-file", "/t", "--body-file", "/b", "--attribute", "x on behalf of y"],
      ["issue-create", "--title-file", "/t", "--body-file", "/b", "--attribute", "x on behalf of y"],
      ["pr-comment", "5", "--body-file", "/b", "--attribute", "   "],
      ["pr-comment", "5", "--body-file", "/b", "--attribute", "two\nlines"],
      ["pr-comment", "5", "--body-file", "/b", "--attribute", "x".repeat(201)],
      ["pr-comment", "5", "--body-file", "/b", "--attribute"],
    ]) {
      const f = fakeEnv({ files });
      expect(run(argv, f), argv.join(" ")).toBe(EXIT.usage);
      expect(f.posts()).toEqual([]);
    }
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

describe("gstack-post pr-body merges the PR body by section", () => {
  const RECEIPT = (head: string) => "```gstack-ship-receipt\n{\n  \"schema_version\": 1,\n  \"pr\": \"5\",\n  \"head\": \"" + head + "\"\n}\n```\n";
  const CURRENT = RECEIPT("aaaa") + "\n## What changed\n\n- the old summary\n\n## Why\n\nBecause.\n\n## Approvals\n\n- owner: do it\n";
  const withBody = (current: string, files: Record<string, string>) => fakeEnv({
    files,
    respond: c => (c.cmd === "gh" && c.args[1] === "view" && c.args.includes("body") ? { status: 0, stdout: current + "\n" } : undefined),
  });
  const sent = (f: ReturnType<typeof fakeEnv>) => f.posts().find(c => c.args[1] === "edit")!;

  // Value: protects=a pr-body post holding one section replaces only that section: same-titled sections (case-insensitively) are replaced in place, the
  // receipt block is its own section, sections the new body lacks are kept, new sections are appended, and one stderr line names each group;
  // fails_when=pr-body overwrites the whole body (a "## What changed"-only post wipes Why, Approvals and the receipt), the receipt is folded into the
  // section before it, or the merge changes the kept sections' bytes; why_new=pr-body was a plain overwrite; seam=the fake run answers gh pr view --json body;
  // no_claim=real gh (unit through runPost)
  test("a first-section-only body keeps the other sections and the receipt; a same-titled section is replaced in place; new sections are appended", () => {
    const f = withBody(CURRENT, { "/b": "## What Changed\n\n- the new summary\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], f)).toBe(EXIT.posted);
    expect(sent(f).input).toBe(RECEIPT("aaaa") + "\n## What Changed\n\n- the new summary\n\n## Why\n\nBecause.\n\n## Approvals\n\n- owner: do it\n");
    expect(f.stderr()).toBe("gstack-post: pr-body merged by section: replaced What changed; kept ship receipt, Why, Approvals; added none\n");
    expect(f.calls.find(c => c.cmd === "gh" && c.args[1] === "view")!.args).toEqual(["pr", "view", "5", "--json", "body", "--jq", ".body"]);

    const receipt = withBody(CURRENT, { "/b": RECEIPT("bbbb") });
    expect(run(["pr-body", "5", "--body-file", "/b"], receipt)).toBe(EXIT.posted);
    expect(sent(receipt).input).toBe(CURRENT.replace(RECEIPT("aaaa"), RECEIPT("bbbb")));
    expect(receipt.stderr()).toBe("gstack-post: pr-body merged by section: replaced ship receipt; kept What changed, Why, Approvals; added none\n");

    const added = withBody(CURRENT, { "/b": "## Why\n\nStill because.\n\n## Tests\n\n- one\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], added)).toBe(EXIT.posted);
    expect(sent(added).input).toBe(RECEIPT("aaaa") + "\n## What changed\n\n- the old summary\n\n## Why\n\nStill because.\n\n## Approvals\n\n- owner: do it\n\n## Tests\n\n- one\n");
    expect(added.stderr()).toBe("gstack-post: pr-body merged by section: replaced Why; kept ship receipt, What changed, Approvals; added Tests\n");

    const fenced = withBody("## Notes\n\n```md\n## not a heading\n```\n\n## Why\n\nold\n", { "/b": "## Why\n\nnew\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], fenced)).toBe(EXIT.posted);
    expect(sent(fenced).input).toBe("## Notes\n\n```md\n## not a heading\n```\n\n## Why\n\nnew\n");
  });

  // Value: protects=a fence closes only on a run of its own character at least as long as the opener with nothing after it, so a ``` line inside a
  // ```` block, a ```js line and a ~~~ line close nothing and the headings inside stay kept bytes, and a receipt fence that never closes is an unclosed
  // fence rather than a receipt that swallows the sections after it; fails_when=a longer or info-string fence closes early and a heading inside the
  // block is replaced (dropping the block's own closing fence and the sections after it), or an unclosed receipt fence loses ## Approvals;
  // why_new=the fenced case above covers only a three-backtick block closed by its own fence; seam=fake run; no_claim=real gh
  test("longer fences, info-string closers and an unclosed receipt fence never expose a heading inside them to the merge", () => {
    const long = "## Notes\n\n````md\n```\n## Tests\nfake\n```\n````\n\n## Tests\n\nold\n";
    const four = withBody(long, { "/b": "## Tests\n\nnew\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], four)).toBe(EXIT.posted);
    expect(sent(four).input).toBe("## Notes\n\n````md\n```\n## Tests\nfake\n```\n````\n\n## Tests\n\nnew\n");
    expect(four.stderr()).toBe("gstack-post: pr-body merged by section: replaced Tests; kept Notes; added none\n");

    const info = withBody("## Notes\n\n```sh\n```js\n## Tests\n~~~\n```\n\n## Tests\n\nold\n", { "/b": "## Tests\n\nnew\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], info)).toBe(EXIT.posted);
    expect(sent(info).input).toBe("## Notes\n\n```sh\n```js\n## Tests\n~~~\n```\n\n## Tests\n\nnew\n");

    const unclosed = "```gstack-ship-receipt\nSHIP_RECEIPT: pr=5 head=aaaa\n\n## Summary\n\nold\n\n## Approvals\n\n- owner: do it\n";
    const open = withBody(unclosed, { "/b": RECEIPT("bbbb") + "\n## Summary\n\nnew\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], open)).toBe(EXIT.posted);
    expect(sent(open).input).toBe(RECEIPT("bbbb") + "\n" + unclosed + "\n## Summary\n\nnew\n");
    expect(open.stderr()).toBe("gstack-post: pr-body merged by section: replaced none; kept unclosed receipt fence; added ship receipt, Summary\n");

    const prose = withBody(unclosed, { "/b": "Updated introduction\n\n## Summary\n\nnew\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], prose)).toBe(EXIT.posted);
    expect(sent(prose).input).toBe("Updated introduction\n\n" + unclosed + "\n## Summary\n\nnew\n");

    const inside = withBody("Intro\n\n## Notes\n\n" + unclosed, { "/b": "New intro\n\n## Notes\n\nnew notes\n\n## Approvals\n\n- owner: still\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], inside)).toBe(EXIT.posted);
    expect(sent(inside).input).toBe("New intro\n\n## Notes\n\nnew notes\n\n" + unclosed + "\n## Approvals\n\n- owner: still\n");
    expect(inside.stderr()).toBe("gstack-post: pr-body merged by section: replaced leading text, Notes; kept unclosed receipt fence; added Approvals\n");

    const after = withBody(RECEIPT("aaaa") + "\n## Why\n\nold\n\n" + unclosed, { "/b": RECEIPT("bbbb") + "\n## Why\n\nnew\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], after)).toBe(EXIT.posted);
    expect(sent(after).input).toBe(RECEIPT("bbbb") + "\n## Why\n\nnew\n\n" + unclosed);
    expect(after.stderr()).toBe("gstack-post: pr-body merged by section: replaced ship receipt, Why; kept unclosed receipt fence; added none\n");
  });

  // Value: protects=--replace keeps the plain overwrite for a caller that composed the whole body, a current body with no H2 headings is kept as the leading
  // section, an empty current body posts the new body byte for byte, the scan runs on the merged bytes, and an unreadable current body is exit 3 with
  // the --replace hint rather than an overwrite; fails_when=--replace merges, headingless text is dropped, the merge changes a lone new body, a secret in a
  // kept section passes the scan, or a failed read overwrites; why_new=first pr-body merge tests; seam=fake run; no_claim=real gh
  test("--replace overwrites; a body without H2 headings is kept as a leading section; the merged bytes are what is scanned; a failed read refuses", () => {
    const replaced = withBody(CURRENT, { "/b": "## What changed\n\nonly this\n" });
    expect(run(["pr-body", "5", "--replace", "--body-file", "/b"], replaced)).toBe(EXIT.posted);
    expect(sent(replaced).input).toBe("## What changed\n\nonly this\n");
    expect(replaced.stderr()).toBe("");
    expect(replaced.calls.some(c => c.cmd === "gh" && c.args[1] === "view")).toBe(false);

    const plain = withBody("Just a paragraph.\nAnother line.", { "/b": "## Tests\n\n- one\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], plain)).toBe(EXIT.posted);
    expect(sent(plain).input).toBe("Just a paragraph.\nAnother line.\n\n## Tests\n\n- one\n");
    expect(plain.stderr()).toBe("gstack-post: pr-body merged by section: replaced none; kept leading text; added Tests\n");

    const empty = withBody("", { "/b": "new body" });
    expect(run(["pr-body", "6", "--body-file", "/b"], empty)).toBe(EXIT.posted);
    expect(sent(empty).input).toBe("new body");

    const secret = fakeEnv({ files: { "/b": "## What changed\n\nclean\n" }, respond: c => (c.cmd === "gh" && c.args[1] === "view" ? { status: 0, stdout: "## Keys\n\n" + AWS + "\n" } : undefined) });
    expect(run(["pr-body", "5", "--body-file", "/b"], secret)).toBe(EXIT.refused);
    expect(secret.stdout()).toContain("HIGH RULE: ");
    expect(secret.posts().filter(c => c.args[1] === "edit")).toEqual([]);

    const unreadable = fakeEnv({ files: { "/b": "## What changed\n\nx\n" }, respond: c => (c.cmd === "gh" && c.args[1] === "view" ? { status: 1, stderr: "GraphQL: Could not resolve to a PullRequest" } : undefined) });
    expect(run(["pr-body", "5", "--body-file", "/b"], unreadable)).toBe(EXIT.cliFailed);
    expect(unreadable.stderr()).toContain("cannot read PR 5's current body");
    expect(unreadable.stderr()).toContain("--replace");
    expect(unreadable.posts()).toEqual([]);
    expect(run(["pr-comment", "5", "--replace", "--body-file", "/b"], fakeEnv({ files: { "/b": "x" } }))).toBe(EXIT.usage);
  });

  // Value: protects=on GitLab the merge reads the MR's description from `glab mr view <n> --output json`, posts the merged bytes through
  // `glab mr update --description=`, treats an empty answer as an empty body (the file is posted unchanged), and a non-JSON answer is exit 3 with the
  // --replace hint and nothing posted; fails_when=the GitLab merge reads the wrong field or command, overwrites the MR on a failed read, or refuses an MR
  // whose description is empty; why_new=the merge tests above run against gh only; seam=fake run answers glab mr view; no_claim=real glab
  test("on GitLab the current description comes from glab mr view JSON; an empty answer is an empty body; a non-JSON answer refuses", () => {
    const remote = "https://gitlab.com/grp/sub/proj.git";
    const view = (stdout: string) => (c: Call) => (c.cmd === "glab" && c.args[0] === "mr" && c.args[1] === "view" ? { status: 0, stdout } : undefined);
    const merged = fakeEnv({ remote, files: { "/b": "## Why\n\nnew\n" }, respond: view(JSON.stringify({ iid: 8, description: "## What changed\n\n- old\n\n## Why\n\nold\n" }) + "\n") });
    expect(run(["pr-body", "8", "--body-file", "/b"], merged)).toBe(EXIT.posted);
    expect(merged.calls.find(c => c.cmd === "glab" && c.args[1] === "view")!.args).toEqual(["mr", "view", "8", "--output", "json"]);
    expect(merged.posts()).toEqual([{ cmd: "glab", args: ["mr", "update", "8", "--description=## What changed\n\n- old\n\n## Why\n\nnew\n"], input: undefined }]);
    expect(merged.stderr()).toBe("gstack-post: pr-body merged by section: replaced Why; kept What changed; added none\n");

    const empty = fakeEnv({ remote, files: { "/b": "## Why\n\nnew\n" }, respond: view("") });
    expect(run(["pr-body", "8", "--body-file", "/b"], empty)).toBe(EXIT.posted);
    expect(empty.posts()[0]!.args).toEqual(["mr", "update", "8", "--description=## Why\n\nnew\n"]);
    const nullDescription = fakeEnv({ remote, files: { "/b": "## Why\n\nnew\n" }, respond: view('{"iid":8,"description":null}\n') });
    expect(run(["pr-body", "8", "--body-file", "/b"], nullDescription)).toBe(EXIT.posted);
    expect(nullDescription.posts()[0]!.args).toEqual(["mr", "update", "8", "--description=## Why\n\nnew\n"]);

    const garbled = fakeEnv({ remote, files: { "/b": "## Why\n\nnew\n" }, respond: view("<html>502</html>\n") });
    expect(run(["pr-body", "8", "--body-file", "/b"], garbled)).toBe(EXIT.cliFailed);
    expect(garbled.stderr()).toContain("cannot read PR 8's current body to merge into (glab returned no JSON)");
    expect(garbled.stderr()).toContain("--replace");
    expect(garbled.posts()).toEqual([]);
  });

  // Value: protects=section matching survives the bodies GitHub actually returns and the shapes /ship composes: a CRLF current body (web-edited) keeps
  // its kept section's bytes and still replaces the same-titled section, a receipt new to a body without one goes first (where gstack-ship-receipt puts
  // it), a current body with two same-titled sections replaces the first and keeps the second, and a current body with no trailing newline still gets a
  // blank-line seam before an appended section; fails_when=a CRLF title no longer matches an LF one (the section is appended as a duplicate), a kept
  // CRLF section is rewritten, a new receipt lands after the sections, the second duplicate is dropped, or an appended section is glued to the last line;
  // why_new=the merge tests above use LF bodies with unique titles and a receipt that already exists; seam=none (mergeBodySections); no_claim=rendering
  test("a CRLF current body, a receipt new to the body, duplicate titles and a body without a trailing newline merge by section", () => {
    const crlfKept = "## What changed\r\n\r\n- old\r\n\r\n";
    const crlf = mergeBodySections(crlfKept + "## Why\r\n\r\nBecause.\r\n", "## why\n\nnew\n");
    expect([crlf.replaced, crlf.kept, crlf.added]).toEqual([["Why"], ["What changed"], []]);
    expect(crlf.body.startsWith(crlfKept)).toBe(true);
    expect(crlf.body.endsWith("\n## why\n\nnew\n")).toBe(true);
    expect(crlf.body).not.toContain("Because.");
    expect(crlf.body.match(/^ {0,3}## /gm)).toHaveLength(2);

    const receipt = "```gstack-ship-receipt\n{\n  \"pr\": \"5\"\n}\n```\n";
    const fresh = mergeBodySections("## A\n\na\n", receipt + "## A\n\nb\n");
    expect(fresh.body).toBe(receipt + "\n## A\n\nb\n");
    expect([fresh.replaced, fresh.kept, fresh.added]).toEqual([["A"], [], ["ship receipt"]]);

    expect(() => mergeBodySections("## A\na\n## A\na2\n", "## A\nnew\n")).toThrow('holds "A" more than once');
    const untouched = mergeBodySections("## A\na\n## A\na2\n", "## B\nb\n");
    expect(untouched.body).toBe("## A\na\n## A\na2\n\n## B\nb\n");
    expect([untouched.kept, untouched.added]).toEqual([["A", "A"], ["B"]]);

    const glued = mergeBodySections("## A\n\na", "## B\n\nb");
    expect(glued.body).toBe("## A\n\na\n\n## B\n\nb");
    expect(mergeBodySections("## A\n\na\n\n", "## B\n\nb\n").body).toBe("## A\n\na\n\n## B\n\nb\n");
  });

  // Value: protects=a PR body holding a section title twice (an old description pasted under the /ship body, gstack-evals#19) refuses to merge,
  // posts nothing and names the fix, so the stale copy is never kept beside the new one; --replace posts the file as written;
  // fails_when=the file's section replaces the first copy and the old one is kept (the #19 duplicate); why_new=the merge matched duplicate titles
  // one to one and reported the leftover as kept; seam=the fake run answers gh pr view --json body; no_claim=real gh
  test("a current body with a title twice refuses the merge and posts nothing; --replace posts the file", () => {
    const fresh = RECEIPT("bbbb") + "\n## What changed\n\n- the /ship summary\n\n## Test plan\n\n- [x] bun test\n";
    const current = RECEIPT("aaaa") + "\n## What changed\n\n- the /ship summary\n\n## Test plan\n\n- [x] bun test\n\n---\n\nOriginal intro.\n\n## What changed\n\n- the old summary\n\n## Checks\n\n- old checks\n";
    const f = withBody(current, { "/b": fresh + "\n## Original description\n\nOriginal intro.\n" });
    expect(run(["pr-body", "5", "--body-file", "/b"], f)).toBe(EXIT.usage);
    expect(f.posts().some(c => c.args[1] === "edit")).toBe(false);
    expect(f.stderr()).toContain(`the PR's current body holds "What changed" more than once`);
    expect(f.stderr()).toContain("Rerun with --replace and the whole body");

    const replaced = withBody(current, { "/b": fresh });
    expect(run(["pr-body", "5", "--body-file", "/b", "--replace"], replaced)).toBe(EXIT.posted);
    expect(sent(replaced).input).toBe(fresh);
  });

  // Value: protects=a current body holding two ship-receipt blocks (an old receipt pasted below) refuses like a doubled title, so the stale
  // receipt is never kept beside the new one; fails_when=receipt keys are exempted from the duplicate check or matched one to one again;
  // why_new=only doubled ## titles were tested; seam=none; no_claim=how /ship reports the refusal
  test("a current body with two receipt blocks refuses a file that carries a receipt", () => {
    const current = RECEIPT("aaaa") + "\n## A\n\na\n\n" + RECEIPT("bbbb") + "\n## B\n\nb\n";
    expect(() => mergeBodySections(current, RECEIPT("cccc") + "\n## A\n\nnew\n")).toThrow('holds "ship receipt" more than once');
  });

  // Value: protects=the body /ship composes (lib/ship-receipt.ts placeReceiptFirst: the receipt block, one blank line, then the sections) reposts
  // idempotently: merged into a PR body of the same shape it yields the file's bytes, the receipt stays byte-first, and the stderr line reports no
  // addition; fails_when=the blank line after the receipt is read as new leading text and prepended before the receipt (one more leading newline per
  // repost, "added leading text" on every /ship re-READY), or a kept blank line is counted as added; why_new=the merge tests above post a receipt-only
  // file or a file without a receipt, never the composed shape; seam=none (mergeBodySections); no_claim=the gh round trip
  test("the composed receipt-then-sections body reposts byte for byte, receipt first, with nothing reported as added", () => {
    const receipt = (head: string) => "```gstack-ship-receipt\n{\n  \"head\": \"" + head + "\"\n}\n```\n";
    const composed = (head: string, summary: string) => receipt(head) + "\n## Summary\n\n" + summary + "\n\n## Test plan\n\n- [x] bun test\n";
    const first = mergeBodySections(composed("aaaa", "old"), composed("bbbb", "new"));
    expect(first.body).toBe(composed("bbbb", "new"));
    expect([first.replaced, first.kept, first.added]).toEqual([["ship receipt", "Summary", "Test plan"], [], []]);
    const again = mergeBodySections(first.body, composed("bbbb", "new"));
    expect(again.body).toBe(composed("bbbb", "new"));
    expect(again.added).toEqual([]);
  });

  // Value: protects=leading prose in the file replaces the current body's leading prose instead of being prepended again, so a repost of a file that
  // opens with text keeps one copy; fails_when=text sections are never matched and the file's leading text is treated as fresh on every post;
  // why_new=the merge tests above post files that open with a heading or a receipt, never with prose; seam=none (mergeBodySections); no_claim=the gh round trip
  test("leading prose in the file replaces the current leading prose and reposts once", () => {
    const current = "Intro line\n\n## Summary\n\nold\n\n## Approvals\n\nx\n";
    const once = mergeBodySections(current, "Intro line\n\n## Summary\n\nnew\n");
    expect(once.body).toBe("Intro line\n\n## Summary\n\nnew\n\n## Approvals\n\nx\n");
    expect([once.replaced, once.kept, once.added]).toEqual([["leading text", "Summary"], ["Approvals"], []]);
    const twice = mergeBodySections(once.body, "Intro line\n\n## Summary\n\nnew\n");
    expect(twice.body).toBe(once.body);
    const fresh = mergeBodySections("## Summary\n\nold\n", "Intro line\n\n## Summary\n\nnew\n");
    expect(fresh.body).toBe("Intro line\n\n## Summary\n\nnew\n");
    expect(fresh.added).toEqual(["leading text"]);
    const receipt = "```gstack-ship-receipt\n{\n  \"head\": \"a\"\n}\n```\n";
    const afterReceipt = mergeBodySections("Intro line\n\n## Summary\n\nold\n", receipt + "note\n\n## Summary\n\nnew\n");
    expect(afterReceipt.body).toContain("Intro line\n");
    expect(afterReceipt.body).toContain("note\n");
    expect(afterReceipt.replaced).toEqual(["Summary"]);
  });
});
