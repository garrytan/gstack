/**
 * /ship's early Greptile review (B2: CEO-8 detection and draft trigger, DX-10
 * status lines, ENG-20 public-repo consent, the gate decision that it is on by
 * default with a per-user off switch). Drives lib/greptile-early.ts in process
 * against fixture repos with a fake gh, so it runs in the Windows lane too.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EARLY_BODY, runGreptileEarly, type EarlyEnv } from "../lib/greptile-early";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "greptile-early-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const SHA = "a".repeat(7) + "b".repeat(33);
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-07T12:00:00Z");

interface Call { cmd: string; args: string[]; file?: string }

function fixture(opts: {
  files?: Record<string, string>;
  visibility?: string;
  comments?: Array<{ login: string; created: string }>;
  openPrs?: Array<{ number: number; url: string }>;
  checks?: Array<{ name: string; status: string; app: string }>;
  reviews?: Array<{ login: string; commit: string }>;
  summaries?: string[];
  config?: string;
} = {}) {
  const root = fs.mkdtempSync(path.join(tmp, "repo-"));
  const state = fs.mkdtempSync(path.join(tmp, "state-"));
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  if (opts.config) fs.writeFileSync(path.join(state, "config.yaml"), opts.config);
  const calls: Call[] = [];
  const out: string[] = [];
  let clock = NOW;
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
  const env: EarlyEnv = {
    vars: { GSTACK_HOME: state },
    binDir: "/opt/gstack/bin",
    bun: "bun",
    now: () => clock,
    sleep: ms => { clock += ms; },
    out: t => { out.push(t); },
    err: t => { out.push(t); },
    run(cmd, args) {
      const call: Call = { cmd, args };
      if (cmd === "bun") {
        const bodyFile = args[args.indexOf("--body-file") + 1]!;
        call.file = fs.readFileSync(bodyFile, "utf8");
      }
      calls.push(call);
      const joined = args.join(" ");
      if (cmd === "git" && args[0] === "rev-parse") return ok(root + "\n");
      if (cmd === "git" && args[0] === "branch") return ok("feature/x\n");
      if (cmd === "git" && args[0] === "remote") return ok("git@github.com:acme/widget.git\n");
      if (cmd.endsWith("gstack-slug")) return ok("acme-widget\n");
      if (cmd === "gh" && args[0] === "auth") return ok("");
      if (cmd === "gh" && joined.startsWith("repo view --json visibility")) return ok((opts.visibility ?? "PRIVATE") + "\n");
      if (cmd === "gh" && args[0] === "repo") return ok("{}");
      if (cmd === "gh" && joined.includes("/comments?sort=created")) return ok(JSON.stringify(joined.includes("/issues/") ? opts.comments ?? [] : []));
      if (cmd === "gh" && joined.startsWith("pr list")) return ok(JSON.stringify(opts.openPrs ?? []));
      if (cmd === "gh" && joined.startsWith("pr view")) return ok(SHA + "\n");
      if (cmd === "gh" && joined.includes("/check-runs")) return ok(JSON.stringify(opts.checks ?? []));
      if (cmd === "gh" && joined.includes("/reviews")) return ok(JSON.stringify(opts.reviews ?? []));
      if (cmd === "gh" && joined.includes("/issues/12/comments")) return ok(JSON.stringify(opts.summaries ?? []));
      if (cmd === "bun" && args[1] === "pr-create") return ok("REPO_VISIBILITY: private\nhttps://github.com/acme/widget/pull/12\nPOSTED: pr-create\n");
      if (cmd === "bun") return ok("POSTED\n");
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
  };
  const run = (...argv: string[]) => {
    out.length = 0;
    const code = runGreptileEarly(argv, env);
    return { code, out: out.join("") };
  };
  const posts = () => calls.filter(c => c.cmd === "bun").map(c => ({ op: c.args[1], args: c.args.slice(2), file: c.file }));
  return { root, state, run, posts, calls, advance: (ms: number) => { clock += ms; } };
}

const value = (out: string, key: string) => new RegExp(`^${key}: (.*)$`, "m").exec(out)?.[1];

describe("detection (CEO-8, DX-10)", () => {
  test("a .greptile/ folder wins over greptile.json, and only its triggerOnDrafts counts", () => {
    const f = fixture({ files: { ".greptile/config.json": '{"strictness": 2}', "greptile.json": '{"triggerOnDrafts": true}' } });
    const r = f.run("detect");
    expect(value(r.out, "GREPTILE_SIGNAL")).toBe("config-folder");
    expect(value(r.out, "GREPTILE_TRIGGER_ON_DRAFTS")).toBe("false");
    expect(value(r.out, "GREPTILE_EARLY")).toBe("on");
    const g = fixture({ files: { ".greptile/config.json": '{"triggerOnDrafts": true}' } });
    expect(value(g.run("detect").out, "GREPTILE_TRIGGER_ON_DRAFTS")).toBe("true");
  });

  test("greptile.json alone is a signal; a non-boolean triggerOnDrafts is not true", () => {
    const f = fixture({ files: { "greptile.json": '{"triggerOnDrafts": "true"}' } });
    const r = f.run("detect");
    expect(value(r.out, "GREPTILE_SIGNAL")).toBe("greptile.json");
    expect(value(r.out, "GREPTILE_TRIGGER_ON_DRAFTS")).toBe("false");
  });

  test("a Greptile comment counts only within 90 days", () => {
    const recent = fixture({ comments: [{ login: "greptile-apps[bot]", created: new Date(NOW - 10 * DAY).toISOString() }] });
    expect(value(recent.run("detect").out, "GREPTILE_SIGNAL")).toBe("comment");
    const old = fixture({ comments: [{ login: "greptile-apps[bot]", created: new Date(NOW - 120 * DAY).toISOString() }, { login: "octocat", created: new Date(NOW - DAY).toISOString() }] });
    const r = old.run("detect");
    expect(value(r.out, "GREPTILE_SIGNAL")).toBe("none");
    expect(value(r.out, "GREPTILE_EARLY")).toBe("off");
  });

  test("without Greptile nothing changes", () => {
    const r = fixture().run("detect");
    expect(value(r.out, "GREPTILE_EARLY")).toBe("off");
    expect(r.out).not.toContain("will push");
  });

  test("the plan line names the signal, the draft push, the wait cap and the off switch", () => {
    const r = fixture({ files: { "greptile.json": "{}" } }).run("detect");
    expect(r.out).toContain("Greptile: found greptile.json. /ship will push this branch and open a draft PR now");
    expect(r.out).toContain("wait up to 10 minutes");
    expect(r.out).toContain("Turn this off: /opt/gstack/bin/gstack-config set ship_greptile_early false");
  });

  test("ship_greptile_early false turns it off and says how to turn it back on", () => {
    const r = fixture({ files: { "greptile.json": "{}" }, config: "ship_greptile_early: false\n" }).run("detect");
    expect(value(r.out, "GREPTILE_EARLY")).toBe("off");
    expect(r.out).toContain("/opt/gstack/bin/gstack-config set ship_greptile_early true");
  });
});

describe("public-repo consent (ENG-20)", () => {
  test("a public repo asks once; the answer is remembered per repo", () => {
    const f = fixture({ files: { "greptile.json": "{}" }, visibility: "PUBLIC" });
    let r = f.run("detect");
    expect(value(r.out, "GREPTILE_CONSENT")).toBe("ask");
    expect(value(r.out, "GREPTILE_EARLY")).toBe("ask");
    expect(f.run("consent", "yes").out).toContain("GREPTILE_CONSENT: granted");
    expect(JSON.parse(fs.readFileSync(path.join(f.state, "projects/acme-widget/ship-greptile-early.json"), "utf8")).consent).toBe("yes");
    r = f.run("detect");
    expect(value(r.out, "GREPTILE_CONSENT")).toBe("granted");
    expect(value(r.out, "GREPTILE_EARLY")).toBe("on");
    f.run("consent", "no");
    r = f.run("detect");
    expect(value(r.out, "GREPTILE_EARLY")).toBe("off");
    expect(value(r.out, "GREPTILE_EARLY_REASON")).toContain("declined");
  });

  test("unknown visibility asks like public; a private repo needs no consent", () => {
    expect(value(fixture({ files: { "greptile.json": "{}" }, visibility: "" }).run("detect").out, "GREPTILE_CONSENT")).toBe("ask");
    expect(value(fixture({ files: { "greptile.json": "{}" } }).run("detect").out, "GREPTILE_CONSENT")).toBe("not-needed");
  });
});

describe("opening the early PR (CEO-8)", () => {
  test("a draft gets one @greptileai comment through gstack-post when Greptile skips drafts", () => {
    const f = fixture({ files: { "greptile.json": "{}" } });
    const r = f.run("open", "--base", "main", "--title-file", "/t");
    expect(r.code).toBe(0);
    expect(value(r.out, "EARLY_PR")).toBe("12");
    expect(value(r.out, "EARLY_PR_OPENED_AT")).toBe(String(NOW / 1000));
    expect(value(r.out, "GREPTILE_TRIGGER")).toBe("posted");
    const [create, comment] = f.posts();
    expect(create).toMatchObject({ op: "pr-create", file: EARLY_BODY });
    expect(create!.args).toEqual(["--base", "main", "--title-file", "/t", "--body-file", expect.any(String), "--draft"]);
    expect(comment).toMatchObject({ op: "pr-comment", file: "@greptileai\n" });
    expect(comment!.args[0]).toBe("12");
    expect(fs.readdirSync(path.join(f.root, ".gstack/tmp"))).toEqual([]);
  });

  for (const [name, files] of [["greptile.json", { "greptile.json": '{"triggerOnDrafts": true}' }], [".greptile/ folder", { ".greptile/config.json": '{"triggerOnDrafts": true}' }]] as const) {
    test(`triggerOnDrafts: true in ${name} posts no trigger comment`, () => {
      const f = fixture({ files });
      const r = f.run("open", "--base", "main", "--title-file", "/t");
      expect(value(r.out, "GREPTILE_TRIGGER")).toBe("not needed (triggerOnDrafts: true)");
      expect(f.posts().map(p => p.op)).toEqual(["pr-create"]);
    });
  }

  test("a ready PR is not a draft and needs no trigger", () => {
    const f = fixture({ files: { "greptile.json": "{}" } });
    f.run("open", "--base", "main", "--title-file", "/t", "--ready");
    expect(f.posts()).toHaveLength(1);
    expect(f.posts()[0]!.args).not.toContain("--draft");
  });

  test("an already open PR is left alone", () => {
    const f = fixture({ files: { "greptile.json": "{}" }, openPrs: [{ number: 5, url: "https://github.com/acme/widget/pull/5" }] });
    const r = f.run("open", "--base", "main", "--title-file", "/t");
    expect(r.code).toBe(0);
    expect(r.out).toContain("EARLY_PR: none (PR 5 is already open");
    expect(f.posts()).toEqual([]);
  });
});

describe("waiting for the review (CEO-8 completion signal)", () => {
  const since = String(NOW / 1000);
  test("a completed Greptile check run on the head commit completes the wait", () => {
    const r = fixture({ checks: [{ name: "Greptile Review", status: "completed", app: "greptile-apps" }] }).run("wait", "12", "--since", since);
    expect(r.out).toContain("GREPTILE_REVIEW: complete (check run on aaaaaaa)");
  });

  test("a Greptile review of the head commit, or a summary naming it, completes the wait", () => {
    expect(fixture({ reviews: [{ login: "greptile-apps[bot]", commit: SHA }] }).run("wait", "12", "--since", since).out).toContain("complete (review");
    expect(fixture({ summaries: ["Greptile Summary ... Last reviewed commit: aaaaaaab"] }).run("wait", "12", "--since", since).out).toContain("complete (summary comment");
  });

  test("an in-progress check, an older head's review or another bot's comment does not count", () => {
    const f = fixture({
      checks: [{ name: "Greptile Review", status: "in_progress", app: "greptile-apps" }, { name: "ci", status: "completed", app: "github-actions" }],
      reviews: [{ login: "greptile-apps[bot]", commit: "c".repeat(40) }],
      summaries: ["Greptile Summary for an older commit"],
    });
    const r = f.run("wait", "12", "--since", since);
    expect(r.out).toContain("GREPTILE_REVIEW: pending");
    expect(r.out).toContain("Greptile: waiting for its review of aaaaaaa (");
    expect(r.out).toContain("Turn early review off: /opt/gstack/bin/gstack-config set ship_greptile_early false");
  });

  test("each call returns within its budget, and the wait times out 10 minutes after the PR opened", () => {
    const f = fixture();
    const polls = () => f.calls.filter(c => c.args.join(" ").includes("/check-runs")).length;
    f.run("wait", "12", "--since", since);
    expect(polls()).toBe(4); // at 0, 30, 60 and 90 seconds
    f.advance(9 * 60_000);
    const r = f.run("wait", "12", "--since", since);
    expect(r.out).toContain("GREPTILE_REVIEW: timeout");
    expect(r.out).not.toContain("GREPTILE_REVIEW: complete");
  });
});
