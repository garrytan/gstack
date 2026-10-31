/**
 * gstack-review-bots (#3122): /review and /ship triage every configured review bot, not only
 * Greptile. Drives lib/review-bots.ts in process with a fake gh, so it runs in the Windows lane too.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { botOwning } from "../lib/pr-wait";
import { parseHistory, patternMatches, runReviewBots, type BotComment, type ReviewBotsEnv } from "../lib/review-bots";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-bots-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const NOW = Date.parse("2026-10-31T12:00:00Z");
const bot = (login: string) => ({ login, type: "Bot" });
const human = (login: string) => ({ login, type: "User" });

interface Fixture {
  config?: string;
  /** Each endpoint's pages; a string fails that call with the string as stderr. */
  line?: unknown[][] | string;
  top?: unknown[][] | string;
  reviews?: unknown[][] | string;
  history?: Record<string, string>;
  prView?: { status: number; stdout?: string; stderr?: string };
  authFails?: boolean;
  /** Raw stdout for the reviews call, as gh would print it. */
  rawReviews?: string;
  repoFails?: boolean;
  /** stderr for a repo lookup that fails for another reason (network, rate limit). */
  repoError?: string;
}

function run(opts: Fixture, ...argv: string[]) {
  const state = fs.mkdtempSync(path.join(tmp, "state-"));
  if (opts.config) fs.writeFileSync(path.join(state, "config.yaml"), opts.config);
  for (const [name, text] of Object.entries(opts.history ?? {})) {
    fs.mkdirSync(path.dirname(path.join(state, name)), { recursive: true });
    fs.writeFileSync(path.join(state, name), text);
  }
  const out: string[] = [];
  const calls: string[][] = [];
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
  const page = (p: unknown[][] | string | undefined) => typeof p === "string" ? { status: 1, stdout: "", stderr: p + "\n" } : ok((p ?? [[]]).flat().map(i => JSON.stringify(i) + "\n").join(""));
  const env: ReviewBotsEnv = {
    vars: { GSTACK_HOME: state },
    binDir: "/opt/gstack/bin",
    tmpDir: tmp,
    now: () => NOW,
    out: t => { out.push(t); },
    err: t => { out.push(t); },
    run(cmd, args) {
      calls.push([cmd, ...args]);
      const joined = args.join(" ");
      if (cmd.endsWith("gstack-slug")) return ok("acme-widget\n");
      if (cmd === "gh" && args.includes("--slurp")) return { status: 1, stdout: "", stderr: "unknown flag: --slurp (gh 2.45)\n" };
      if (cmd === "gh" && args[0] === "auth" && opts.authFails) return { status: 1, stdout: "", stderr: "not logged in\n" };
      if (cmd === "gh" && args[0] === "repo" && opts.repoFails) return { status: 1, stdout: "", stderr: "no git remotes found\n" };
      if (cmd === "gh" && args[0] === "repo" && opts.repoError) return { status: 1, stdout: "", stderr: opts.repoError + "\n" };
      if (cmd === "gh" && (args[0] === "--version" || args[0] === "auth")) return ok("");
      if (cmd === "gh" && args[0] === "repo") return ok("acme/widget\n");
      if (cmd === "gh" && args[0] === "pr") return { stdout: "", stderr: "", ...(opts.prView ?? { status: 0, stdout: "12\n" }) };
      if (cmd === "gh" && joined.includes("/pulls/12/comments")) return page(opts.line);
      if (cmd === "gh" && joined.includes("/issues/12/comments")) return page(opts.top);
      if (cmd === "gh" && joined.includes("/pulls/12/reviews")) return opts.rawReviews !== undefined ? ok(opts.rawReviews) : page(opts.reviews);
      return { status: 1, stdout: "", stderr: `unexpected ${cmd} ${joined}` };
    },
  };
  const code = runReviewBots(argv, env);
  const text = out.join("");
  const dir = /^REVIEW_BOTS_DIR: (.+)$/m.exec(text)?.[1];
  const records: BotComment[] = dir ? fs.readFileSync(path.join(dir, "comments.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  return { code, text, records, calls, state };
}

describe("botOwning", () => {
  test("a bot owns the logins that start with its name, nothing else", () => {
    expect(botOwning("greptile-apps[bot]", ["greptile", "coderabbit"])).toBe("greptile");
    expect(botOwning("CodeRabbitAI[bot]", ["greptile", "coderabbit"])).toBe("coderabbit");
    expect(botOwning("notgreptile", ["greptile"])).toBeNull();
    expect(botOwning(null, ["greptile"])).toBeNull();
    expect(botOwning("", ["greptile"])).toBeNull();
    expect(botOwning("copilot-swe[bot]", ["copilot", "copilot-swe"])).toBe("copilot-swe");
    expect(botOwning("coderabbitai[bot]", ["code", "coderabbit"])).toBe("coderabbit");
  });
});

describe("fetch", () => {
  test("reads every configured bot across pages, root comments only, newest review body per bot", () => {
    const r = run({
      line: [
        [{ id: 1, user: bot("greptile-apps[bot]"), path: "a.ts", line: 3, position: 3, html_url: "u1", body: "race" }],
        [
          { id: 2, user: bot("coderabbitai[bot]"), path: "b.ts", line: 9, position: 9, html_url: "u2", body: "null" },
          { id: 3, user: bot("coderabbitai[bot]"), path: "b.ts", line: 9, position: 9, in_reply_to_id: 2, html_url: "u3", body: "still null" },
          { id: 4, user: bot("greptile-apps[bot]"), path: "c.ts", line: 1, position: null, html_url: "u4", body: "outdated" },
        ],
      ],
      top: [[{ id: 5, user: bot("greptile-apps[bot]"), html_url: "u5", body: "summary" }, { id: 6, user: human("alice"), html_url: "u6", body: "lgtm" }]],
      reviews: [[
        { id: 7, user: bot("coderabbitai[bot]"), submitted_at: "2026-10-30T00:00:00Z", html_url: "u7", body: "old walkthrough" },
        { id: 8, user: bot("coderabbitai[bot]"), submitted_at: "2026-10-31T00:00:00Z", html_url: "u8", body: "new walkthrough" },
        { id: 9, user: bot("greptile-apps[bot]"), submitted_at: "2026-10-31T00:00:00Z", html_url: "u9", body: "" },
      ]],
    }, "fetch");
    expect(r.code).toBe(0);
    expect(r.records.map(c => [c.id, c.bot, c.source])).toEqual([[1, "greptile", "line"], [2, "coderabbit", "line"], [5, "greptile", "top"], [8, "coderabbit", "review"]]);
    expect(r.text).toContain("REVIEW_BOTS_COUNTS: greptile=2 macroscope=0 coderabbit=2\n");
    expect(r.calls.filter(c => c[0] === "gh" && c[1] === "api").every(c => c.includes("--paginate") && !c.includes("--slurp"))).toBe(true);
  });

  test("humans named like a bot and deleted accounts are never triaged", () => {
    const r = run({ top: [[
      { id: 1, user: human("greptile-ci"), body: "fp please" },
      { id: 2, user: null, body: "ghost" },
      { id: 3, user: bot("dependabot[bot]"), body: "bump" },
    ]] }, "fetch");
    expect(r.records).toEqual([]);
    expect(r.text).toContain("REVIEW_BOTS_COUNTS: greptile=0 macroscope=0 coderabbit=0");
  });

  test("the configured lists pick the bots; none in both skips", () => {
    const only = run({ config: "pr_wait_gating_bots: coderabbit\npr_wait_advisory_bots: none\n", top: [[{ id: 1, user: bot("greptile-apps[bot]"), body: "x" }, { id: 2, user: bot("coderabbitai[bot]"), body: "y" }]] }, "fetch");
    expect(only.records.map(c => c.bot)).toEqual(["coderabbit"]);
    const off = run({ config: "pr_wait_gating_bots: none\npr_wait_advisory_bots: none\n" }, "fetch");
    expect(off.text).toBe("REVIEW_BOTS: skip (pr_wait_gating_bots and pr_wait_advisory_bots are both none)\n");
    expect(off.calls).toEqual([]);
  });

  test("no PR skips; a failed page is an error with no directory, never zero comments", () => {
    expect(run({ prView: { status: 1, stderr: "no pull requests found for branch \"x\"" } }, "fetch").text).toBe("REVIEW_BOTS: skip (no PR yet)\n");
    const failed = run({ top: "HTTP 502: Bad Gateway (page 2)" }, "fetch");
    expect(failed.text).toBe("REVIEW_BOTS: error (repos/acme/widget/issues/12/comments: HTTP 502: Bad Gateway (page 2))\n");
    expect(failed.records).toEqual([]);
    expect(run({ rawReviews: "{\"id\":1}\nnot json\n" }, "fetch").text).toBe("REVIEW_BOTS: error (repos/acme/widget/pulls/12/reviews: invalid JSON)\n");
    expect(run({ rawReviews: "[1,2]\n" }, "fetch").text).toBe("REVIEW_BOTS: error (repos/acme/widget/pulls/12/reviews: not a list of objects)\n");
  });

  test("pages are read without --slurp, so gh before 2.48 still fetches", () => {
    const r = run({ line: [[{ id: 1, user: bot("coderabbitai[bot]"), path: "a.ts", line: 1, position: 1, body: "x" }]] }, "fetch");
    expect(r.records.map(c => c.id)).toEqual([1]);
    const apiCalls = r.calls.filter(c => c[1] === "api");
    expect(apiCalls).toHaveLength(3);
    for (const c of apiCalls) expect(c).toEqual(["gh", "api", "--paginate", expect.stringMatching(/\?per_page=100$/), "--jq", ".[] | tojson"]);
  });

  test("gh not logged in or no GitHub remote skips; a non-numeric --pr is an error", () => {
    expect(run({ authFails: true }, "fetch").text).toBe("REVIEW_BOTS: skip (gh not logged in)\n");
    expect(run({ repoFails: true }, "fetch").text).toBe("REVIEW_BOTS: skip (not a GitHub remote: no git remotes found)\n");
    expect(run({ repoError: "HTTP 502: Bad Gateway" }, "fetch").text).toBe("REVIEW_BOTS: error (repository lookup failed: HTTP 502: Bad Gateway)\n");
    expect(run({ prView: { status: 1, stderr: "API rate limit exceeded" } }, "fetch").text).toBe("REVIEW_BOTS: error (PR lookup failed: API rate limit exceeded)\n");
    const bad = run({}, "fetch", "--pr", "12;rm");
    expect(bad.text).toBe("REVIEW_BOTS: error ('12;rm' is not a PR number)\n");
    expect(bad.calls.some(c => c[1] === "api")).toBe(false);
  });

  test("an empty PR is a complete fetch with zero counts", () => {
    const r = run({}, "fetch");
    expect(r.text).toContain("REVIEW_BOTS_DIR: ");
    expect(r.text).toContain("REVIEW_BOTS_COUNTS: greptile=0 macroscope=0 coderabbit=0");
  });

  test("a false positive suppresses only the same bot; old greptile-history rows are Greptile's", () => {
    const r = run({
      history: {
        "projects/acme-widget/review-bot-history.md": "2026-10-01 | acme/widget | fp | src/*.ts | race-condition | coderabbit\n2026-10-01 | other/repo | fp | src/a.ts | style | greptile\n",
        "projects/acme-widget/greptile-history.md": "2026-09-01 | acme/widget | fp | src/a.ts | null-check\n2026-09-01 | acme/widget | fix | src/a.ts | security\n",
      },
      line: [[
        { id: 1, user: bot("greptile-apps[bot]"), path: "src/a.ts", line: 1, position: 1, body: "x" },
        { id: 2, user: bot("coderabbitai[bot]"), path: "src/a.ts", line: 1, position: 1, body: "y" },
        { id: 3, user: bot("coderabbitai[bot]"), path: "src/deep/b.ts", line: 1, position: 1, body: "z" },
      ]],
    }, "fetch");
    expect(r.records.map(c => [c.id, c.suppress_candidates])).toEqual([[1, ["null-check"]], [2, ["race-condition"]], [3, []]]);
    expect(r.text).toContain("REVIEW_BOTS_SUPPRESSION_CANDIDATES: 2");
  });
});

describe("record and history", () => {
  test("record takes the bot and path from the fetched comment, so a contributor-named file never reaches a shell", () => {
    const fetched = run({
      line: [[{ id: 7, user: bot("coderabbitai[bot]"), path: "src/$(printf X).ts", line: 1, position: 1, body: "x" }, { id: 8, user: bot("coderabbitai[bot]"), path: "a | b.ts", line: 1, position: 1, body: "x" }]],
      top: [[{ id: 9, user: bot("greptile-apps[bot]"), body: "y" }]],
    }, "fetch");
    const dir = /^REVIEW_BOTS_DIR: (.+)$/m.exec(fetched.text)![1]!;
    const r = run({}, "record", "--dir", dir, "--id", "7", "--type", "fp", "--category", "style");
    expect(r.code).toBe(0);
    const row = "2026-10-31 | acme/widget | fp | src/$(printf X).ts | style | coderabbit\n";
    expect(fs.readFileSync(path.join(r.state, "projects/acme-widget/review-bot-history.md"), "utf8")).toBe(row);
    expect(fs.readFileSync(path.join(r.state, "review-bot-history.md"), "utf8")).toBe(row);
    expect(parseHistory(row)).toEqual([{ repo: "acme/widget", type: "fp", pattern: "src/$(printf X).ts", category: "style", bot: "coderabbit" }]);
    const top = run({}, "record", "--dir", dir, "--id", "9", "--type", "already-fixed", "--category", "correctness");
    expect(fs.readFileSync(path.join(top.state, "review-bot-history.md"), "utf8")).toBe("2026-10-31 | acme/widget | already-fixed | top-level | correctness | greptile\n");
    const piped = run({}, "record", "--dir", dir, "--id", "8", "--type", "fp", "--category", "style");
    expect(piped.code).toBe(1);
    expect(fs.existsSync(path.join(piped.state, "review-bot-history.md"))).toBe(false);
  });

  test("record refuses anything but a known id, type and category", () => {
    const fetched = run({ top: [[{ id: 9, user: bot("greptile-apps[bot]"), body: "y" }]] }, "fetch");
    const dir = /^REVIEW_BOTS_DIR: (.+)$/m.exec(fetched.text)![1]!;
    const rec = (extra: Fixture, ...a: string[]) => run(extra, "record", "--dir", dir, ...a);
    expect(rec({}, "--id", "9", "--type", "maybe", "--category", "style").code).toBe(64);
    expect(rec({}, "--id", "9", "--type", "fp", "--category", "$(id)").code).toBe(64);
    expect(rec({}, "--id", "9;rm", "--type", "fp", "--category", "style").code).toBe(64);
    expect(rec({}, "--id", "9", "--type", "fp").code).toBe(64);
    expect(rec({}, "--id", "10", "--type", "fp", "--category", "style").code).toBe(1);
    const noRepo = rec({ repoFails: true }, "--id", "9", "--type", "fp", "--category", "style");
    expect(noRepo.code).toBe(1);
    expect(fs.existsSync(path.join(noRepo.state, "review-bot-history.md"))).toBe(false);
  });

  test("patterns: exact, * within a directory, ** across", () => {
    expect(patternMatches("src/a.ts", "src/a.ts")).toBe(true);
    expect(patternMatches("src/*.ts", "src/deep/b.ts")).toBe(false);
    expect(patternMatches("src/**.ts", "src/deep/b.ts")).toBe(true);
    expect(patternMatches("a.(ts)", "a.ts")).toBe(false);
  });
});
