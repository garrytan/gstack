/**
 * GST-1955: on a public repository (or one whose visibility cannot be read),
 * PR text gstack-post sends never carries a home path, a Capy jam id other than
 * the platform's own badge, or a cost, credits or token figure. The receipt
 * blocks /ship writes go out in their public form; any other private detail
 * refuses the post. Private repositories keep today's bytes.
 *
 * The fixtures are the shapes public gstack PRs carried: #3964's receipt
 * (spend_usd, a jam run id, a thread code) and #3878's pregate remote_gate line
 * (receipt=/home/user/.capy/work/...).
 */
import { describe, expect, test } from "bun:test";
import { EXIT, runPost, type PostEnv } from "../lib/gstack-post";
import { privateDetails, publicReceiptText } from "../lib/public-pr-text";
import { extractReceipt, receiptRuns } from "../lib/ship-receipt";

interface Call { cmd: string; args: string[]; input?: string }

function fakeEnv(opts: { files: Record<string, string>; visibility?: string; ghVisibility?: string; current?: string }) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const env: PostEnv = {
    run(cmd, args, input) {
      calls.push({ cmd, args, input });
      if (cmd === "git" && args[0] === "remote") return { status: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" };
      if (cmd === "git") return { status: 1, stdout: "", stderr: "" };
      if (cmd === "cfg") return opts.visibility === undefined ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: opts.visibility + "\n", stderr: "" };
      if (cmd === "gh" && args[0] === "repo") return opts.ghVisibility === undefined ? { status: 1, stdout: "", stderr: "gh: not logged in" } : { status: 0, stdout: opts.ghVisibility + "\n", stderr: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { status: 0, stdout: (opts.current ?? "") + "\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    readFile(p) {
      if (!(p in opts.files)) throw new Error("ENOENT");
      return opts.files[p]!;
    },
    out: t => { out.push(t); },
    err: t => { err.push(t); },
  };
  const sent = () => calls.filter(c => c.cmd === "gh" && (c.args[1] === "comment" || c.args[1] === "edit" || c.args[1] === "create")).map(c => c.input ?? c.args.join(" ")).join("\n");
  return { env, sent, stdout: () => out.join(""), stderr: () => err.join("") };
}
const run = (argv: string[], f: ReturnType<typeof fakeEnv>) => runPost(argv, f.env, "cfg");

const JAM = "jam_01M6FGN8NNX1Y5JK5GZAMD8J4F";
const BADGE = `<!-- capy-badge:start -->
<a href="https://capy.ai/thread/${JAM}"><picture><source media="(prefers-color-scheme: dark)" srcset="https://capy.ai/badge/accent-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://capy.ai/badge/accent-light.svg"><img alt="Open in Capy" src="https://capy.ai/badge/accent-light.svg"></picture></a>
<!-- capy-badge:end -->`;
const RECEIPT = {
  schema_version: 1, pr: 3964, head: "a".repeat(40), base: "main", spend_usd: 2.7, session_kind: "unattended",
  run: JAM, thread: "GSTA-256",
  pregate: "pass @0db1a0a9fd29 (9 checks, current for aaaaaaaaaaaa)",
  requires_remote: ["remote_gate: remote-gate tree=0db1a0a9fd29 tests=4556 receipt=/home/user/.capy/work/ship-b/remote-receipt.txt sha256=9b3385dae770"],
  review_loop: { passes: 2, blocking_found: 0, deferred: 1, est_input_tokens: 48210 },
};
const RUNS = JSON.stringify({ head: "b".repeat(40), run: "jam_01M5TMGA1TMRZ6P17Y16BAWZTB", review_loop: { passes: 1, blocking_found: 0, deferred: 0, est_input_tokens: 9000 } });
const body = (prose: string) => `${prose}

## Agent notes

<details><summary>Agent notes</summary>

\`\`\`gstack-ship-receipt
${JSON.stringify(RECEIPT, null, 2)}
\`\`\`

\`\`\`gstack-receipt-runs
${RUNS}
\`\`\`

</details>

${BADGE}
`;
const CLEAN = "Stop the pre-push check flagging real files.\n\nThe check now reads the path, not the name.";

describe("public repo: the receipt goes out in its public form", () => {
  test("repro: #3964/#3878's receipt posts without spend, jam ids, token figures or home paths, and still binds", () => {
    const f = fakeEnv({ files: { "/b": body(CLEAN) }, ghVisibility: "PUBLIC" });
    expect(run(["pr-body", "3964", "--body-file", "/b", "--replace"], f)).toBe(EXIT.posted);
    const sent = f.sent();
    expect(sent).not.toContain("spend_usd");
    expect(sent).not.toContain("est_input_tokens");
    expect(sent).not.toContain("/home/");
    expect(sent.replace(BADGE, "")).not.toContain("jam_");
    expect(sent).toContain(BADGE);
    expect(privateDetails(sent)).toEqual([]);
    const ex = extractReceipt(sent);
    expect(ex.errors).toEqual([]);
    expect(ex.receipt!.head).toBe("a".repeat(40));
    expect(ex.receipt!.pr).toBe(3964);
    expect(ex.receipt!.run).toMatch(/^anon-[0-9a-f]{12}$/);
    expect(ex.receipt!.thread).toMatch(/^anon-[0-9a-f]{12}$/);
    expect(ex.receipt!.requires_remote![0]).toContain("receipt=remote-receipt.txt sha256=9b3385dae770");
    expect(receiptRuns(sent)[0]!.run).toMatch(/^anon-[0-9a-f]{12}$/);
    expect(f.stdout()).toContain("PUBLIC_FORM:");
  });

  test("the public form is deterministic, so the same run id hashes the same way on every post", () => {
    const a = publicReceiptText(body(CLEAN)).text;
    expect(publicReceiptText(body(CLEAN)).text).toBe(a);
    expect(publicReceiptText(a).text).toBe(a);
    expect(publicReceiptText(a).changed).toEqual([]);
  });

  test("a repo-relative path with a home or users folder in a receipt string keeps its bytes", () => {
    const block = "```gstack-ship-receipt\n" + JSON.stringify({ schema_version: 1, pr: 1, head: "a", requires_remote: ["x receipt=app/users/r.txt", "y receipt=/home/user/z.txt"] }) + "\n```";
    const text = publicReceiptText(block).text;
    expect(text).toContain("x receipt=app/users/r.txt");
    expect(text).toContain("y receipt=z.txt");
    const nested = publicReceiptText("```gstack-ship-receipt\n" + JSON.stringify({ schema_version: 1, pr: 1, head: "a", requires_remote: ["w receipt=/mnt/c/Users/garry/z.txt"] }) + "\n```").text;
    expect(nested).toContain("w receipt=z.txt");
    expect(nested).not.toContain("/Users/garry");
  });

  test("ALL_CAPS result lines go out in their public form instead of refusing", () => {
    const lines = "- `BUDGET_FINAL: used=16585347 credits=4210 tokens=181234 cap=340000000`\nCI_CARRY: accepted ci-carry tree=6b87d68c160d tests=36599 receipt=/home/user/x.txt by " + JAM + "\nSpent $4.10 on the probe.";
    const f = fakeEnv({ files: { "/b": body(CLEAN + "\n\n" + lines) }, ghVisibility: "PUBLIC" });
    expect(run(["pr-body", "4180", "--body-file", "/b", "--replace"], f)).toBe(EXIT.posted);
    const sent = f.sent();
    expect(sent).toContain("- `BUDGET_FINAL: cap=340000000`");
    expect(sent).toContain("CI_CARRY: accepted ci-carry tree=6b87d68c160d tests=36599 receipt=x.txt by anon-");
    expect(sent).not.toMatch(/credits=|tokens=181234|used=|\/home\/user/);
    expect(sent).toContain("Spent $4.10 on the probe.");
    expect(f.stderr()).toContain("note: LOW PUBLIC: public.cost LINE: ");
  });

  test("the REVIEW_LOOP line /ship puts in the body loses its token estimate, nothing else", () => {
    const loopLine = "REVIEW_LOOP: passes=2 blocking_found=0 deferred=1 noted=0 fixed=0 scope=diff-plus-blocking fix_checks=1 dispatches=1 est_input_tokens=3341";
    const f = fakeEnv({ files: { "/b": body(CLEAN + "\n\n`" + loopLine + "`") }, ghVisibility: "PUBLIC" });
    expect(run(["pr-body", "4171", "--body-file", "/b", "--replace"], f)).toBe(EXIT.posted);
    expect(f.sent()).toContain("`REVIEW_LOOP: passes=2 blocking_found=0 deferred=1 noted=0 fixed=0 scope=diff-plus-blocking fix_checks=1 dispatches=1`");
    expect(f.sent()).not.toContain("est_input_tokens");
  });

  test("a result line keeps refused=, reused= and unused= and drops only cost and token keys", () => {
    const line = "PREGATE: refused=1 reused=2 unused=0 used=5 credits=9 spend_usd=1.2 est_input_tokens=3 run=42544239075";
    const f = fakeEnv({ files: { "/b": body(CLEAN + "\n\n" + line) }, ghVisibility: "PUBLIC" });
    expect(run(["pr-body", "4180", "--body-file", "/b", "--replace"], f)).toBe(EXIT.posted);
    expect(f.sent()).toContain("PREGATE: refused=1 reused=2 unused=0 run=42544239075");
  });

  test("visibility that cannot be read uses the public form (fail closed)", () => {
    const f = fakeEnv({ files: { "/b": body(CLEAN) } });
    expect(run(["pr-body", "3964", "--body-file", "/b", "--replace"], f)).toBe(EXIT.posted);
    expect(f.stdout()).toContain("REPO_VISIBILITY: unknown");
    expect(f.sent()).not.toContain("spend_usd");
  });

  test("a private repo keeps today's form byte for byte", () => {
    const f = fakeEnv({ files: { "/b": body(CLEAN + "\n\nLog: ~/.capy/work/ship-1/gate.log, spent $12.30.") }, ghVisibility: "PRIVATE" });
    expect(run(["pr-body", "3964", "--body-file", "/b", "--replace"], f)).toBe(EXIT.posted);
    expect(f.sent()).toBe(body(CLEAN + "\n\nLog: ~/.capy/work/ship-1/gate.log, spent $12.30."));
    expect(f.stdout()).not.toContain("PUBLIC_FORM:");
  });

  test("the config override names the visibility before gh is asked", () => {
    const f = fakeEnv({ files: { "/b": body(CLEAN) }, visibility: "private", ghVisibility: "PUBLIC" });
    expect(run(["pr-body", "3964", "--body-file", "/b", "--replace"], f)).toBe(EXIT.posted);
    expect(f.sent()).toContain('"spend_usd": 2.7');
  });

  test("a merged pr-body rewrites a legacy receipt the current body still holds", () => {
    const f = fakeEnv({ files: { "/b": "## Summary\n\nNew words.\n" }, ghVisibility: "PUBLIC", current: body("## Summary\n\nOld words.") });
    expect(run(["pr-body", "3964", "--body-file", "/b"], f)).toBe(EXIT.posted);
    expect(f.sent()).toContain("New words.");
    expect(f.sent()).not.toContain("spend_usd");
    expect(f.sent()).not.toContain("/home/");
  });
});

describe("public repo: any other private detail refuses the post", () => {
  const refuses = (prose: string, rule: string, op: string[] = ["pr-comment", "12"]) => {
    const f = fakeEnv({ files: { "/b": prose + "\n" }, ghVisibility: "PUBLIC" });
    expect(run([...op, "--body-file", "/b"], f)).toBe(EXIT.refused);
    expect(f.sent()).toBe("");
    expect(f.stdout()).toContain(`PUBLIC: ${rule} LINE: `);
    expect(f.stdout()).not.toMatch(/\/home\/user|12\.30|jam_01/);
    expect(f.stderr()).toContain("nothing was posted");
    return f;
  };

  test("home paths: POSIX, macOS, ~, a code span, a Windows path, an MSYS path", () => {
    refuses("Gate log: /home/user/.capy/work/ship-3482/remote-attempt6-gate.log", "public.home_path");
    refuses("Ran from /Users/garry/git/gstack.", "public.home_path");
    refuses("Functional smoke under ~/.capy/work/ship-4145-456e024/qa/functional.", "public.home_path");
    refuses("Raw rows: `/home/user/.capy/work/fresh-pr3.tsv`", "public.home_path");
    refuses("On Windows it wrote `C:\\Users\\garry\\AppData\\Local\\gstack\\x.json`.", "public.home_path");
    refuses("Git Bash path: /c/Users/garry/gstack", "public.home_path");
    refuses("CI trace at /home/runner/work/gstack/gstack/test/x.test.ts:112", "public.home_path");
    refuses("the state root `~garry/.gstack`", "public.home_path");
    expect(refuses("Ran from /Users/garry/git/gstack.", "public.home_path").stderr()).toContain("whose visibility gh cannot read");
  });

  test("home paths nested under another folder, after an escape in raw JSON, on a diff line, and tilde state paths", () => {
    refuses("Under WSL it wrote /mnt/c/Users/garry/gstack/x.ts", "public.home_path");
    refuses("Silverblue: /var/home/garry/gstack", "public.home_path");
    refuses("FreeBSD: /usr/home/garry/gstack", "public.home_path");
    refuses("macOS data volume: /System/Volumes/Data/Users/garry/x", "public.home_path");
    refuses('{"stderr":"boom\\n/home/garry/gstack/x.ts"}', "public.home_path");
    refuses("-/home/garry/.gstack/x", "public.home_path");
    refuses("State in ~/.gstack/projects/x.json", "public.home_path");
    refuses("Scratch in ~/.capy/work/ship-1/gate.log", "public.home_path");
    refuses("Kept at ~garry/notes.md", "public.home_path");
    refuses("Windows user nina: C:\\Users\\nina\\x.json, lowercase C:\\users\\nina\\y", "public.home_path");
  });

  test("home paths glued to a prefix: file://, user@host:, bold, key: and a JSON escape (fix-check #1 on f8d0139)", () => {
    refuses("Open file:///Users/garry/x in a browser.", "public.home_path");
    refuses("Copied to garry@box:/home/garry/x first.", "public.home_path");
    refuses("The log is **/home/garry/x** now.", "public.home_path");
    refuses("cwd:/home/garry/x", "public.home_path");
    refuses("path:~/.gstack/x", "public.home_path");
    refuses("ssh box:~garry/x", "public.home_path");
    refuses('{"log":"boom\\nC:\\\\Users\\\\nina\\\\x.json"}', "public.home_path");
    refuses('{"log":"boom\\n~/.capy/work/x"}', "public.home_path");
    refuses("UNC share: \\\\box\\Users\\garry\\x", "public.home_path");
  });

  test("the detector stays linear on a big body full of candidates", () => {
    const big = "/home/garry/x and src/home/y\n".repeat(20000) + "/".repeat(200000) + "home/x\n" + "a\\n".repeat(100000);
    const t0 = performance.now();
    expect(privateDetails(big).length).toBe(20001);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("Capy ids: a bare jam id, one inside a URL, a thread link that is not the badge", () => {
    refuses(`Thread ${JAM} found it.`, "public.capy_id");
    refuses(`See https://capy.ai/thread/${JAM} for the run.`, "public.capy_id");
    refuses(`[the thread](https://example.com/?t=${JAM})`, "public.capy_id");
    refuses("Lane: https://capy.ai/thread/GSTA-256", "public.capy_id");
    refuses(`<a href="https://capy.ai/thread/${JAM}">badge-shaped but no badge image</a>`, "public.capy_id");
  });

  test("costs: dollars, a code span, USD, credits, tokens, spend keys post with a LOW note", () => {
    const notes = (prose: string) => {
      const f = fakeEnv({ files: { "/b": prose + "\n" }, ghVisibility: "PUBLIC" });
      expect(run(["pr-comment", "12", "--body-file", "/b"], f)).toBe(EXIT.posted);
      expect(f.sent()).toBe(prose + "\n");
      expect(f.stderr()).toContain("note: LOW PUBLIC: public.cost LINE: 1 PART: body");
    };
    notes("The run cost $12.30 in all.");
    notes("Budget used: `$12.30`.");
    notes("over this run's $10 eval cap");
    notes("The paid gate already spent $0 on them.");
    notes("about 2.70 USD");
    notes("The lane used 35,000 credits.");
    notes("It used 93.7M capy tokens against its cap.");
    notes("its last call rewrites 300-700k tokens");
    notes('`"spend_usd": 2.7`');
    notes("cost: €4.10");
  });

  test("the title is checked too, and pr-create and issue text go through the same rule", () => {
    const f = fakeEnv({ files: { "/t": "Fix the run that cost $12.30", "/b": CLEAN }, ghVisibility: "PUBLIC" });
    expect(run(["pr-create", "--base", "main", "--title-file", "/t", "--body-file", "/b"], f)).toBe(EXIT.posted);
    expect(f.stderr()).toContain("note: LOW PUBLIC: public.cost LINE: 1 PART: title");
    const h = fakeEnv({ files: { "/t": "Fix the leak in ~/.gstack/state", "/b": CLEAN }, ghVisibility: "PUBLIC" });
    expect(run(["pr-create", "--base", "main", "--title-file", "/t", "--body-file", "/b"], h)).toBe(EXIT.refused);
    expect(h.stdout()).toContain("PUBLIC: public.home_path LINE: 1 PART: title");
    const g = fakeEnv({ files: { "/t": "Plain title", "/b": "Logs in /home/user/x\n" }, ghVisibility: "PUBLIC" });
    expect(run(["issue-create", "--title-file", "/t", "--body-file", "/b"], g)).toBe(EXIT.refused);
    expect(g.stdout()).toContain("PUBLIC: public.home_path LINE: 1 PART: body");
  });
});

describe("public repo: ordinary prose still posts", () => {
  test("approximations, shell positionals in code, issue codes, relative paths, plain URLs and the badge", () => {
    const prose = [
      "It took ~30 minutes and ~5/10 runs passed.",
      "Use `awk '{print $2}'` and `$1` in the hook.",
      "Fixes GST-1955; see bin/gstack-post and lib/redact-engine.ts.",
      "Changed src/pages/home/index.tsx, app/users/show.ts and home/x; the route is GET /api/users/42.",
      "Also **src/home/index.ts**, ./home/x, ../Users/x, (docs/home/a.md) and src\\tests\\home\\x.",
      "Links: https://example.com/home/garry/x and http://host/Users/me/y.",
      "Install lives at ~/.claude/skills/gstack.",
      "Docs: https://github.com/garrytan/gstack/blob/main/docs/home/index.md",
      "No secrets, no costs. ~~struck~~ text.",
      "A bare base64 token stays redacted.",
      BADGE,
    ].join("\n\n");
    const f = fakeEnv({ files: { "/b": prose + "\n" }, ghVisibility: "PUBLIC" });
    expect(run(["pr-comment", "12", "--body-file", "/b"], f)).toBe(EXIT.posted);
    expect(f.sent()).toBe(prose + "\n");
  });
});
