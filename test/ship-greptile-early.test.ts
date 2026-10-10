/**
 * /ship's early Greptile PR wiring (B2: CEO-8, DX-10, ENG-20 and the gate
 * decision). The helper's behavior is in test/greptile-early*.test.ts; this
 * pins where /ship calls it and what each outcome does.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const skeleton = read("ship/SKILL.md.tmpl");
const early = read("ship/sections/greptile-early.md.tmpl");
const step10 = read("ship/sections/greptile.md.tmpl");
const prBody = read("ship/sections/pr-body.md.tmpl");
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("/ship Step 6.5 early Greptile PR", () => {
  test("it runs after the tests section and before coverage, and the section index lists it", () => {
    const at = (m: string) => skeleton.indexOf(m);
    expect(at("{{SECTION:tests}}")).toBeLessThan(at("{{SECTION:greptile-early}}"));
    expect(at("{{SECTION:greptile-early}}")).toBeLessThan(at("{{SECTION:test-coverage}}"));
    expect(skeleton).toContain("including 6.5, 11.5 and 14.5");
    expect(read("ship/SKILL.md")).toContain("| opening the PR early for a parallel Greptile review after the free tests pass (Step 6.5) | `sections/greptile-early.md` |");
  });

  test("detect decides; off continues, ask asks once with remembered consent, on pushes and opens", () => {
    const s = flat(early);
    expect(early).toContain("~/.claude/skills/gstack/bin/gstack-greptile-early detect");
    expect(s).toContain("**`GREPTILE_EARLY: off`** — print the reason");
    expect(s).toContain("**`GREPTILE_EARLY: ask`** (a public repo");
    expect(s).toContain("gstack-greptile-early consent yes` (A) or `consent no` (B)");
    expect(s).toContain("show the user the printed `Greptile: found …` line");
    const push = early.indexOf("git push -u origin <branch-name>");
    const title = early.indexOf("{{FREE_TEXT_FILE:TITLE_FILE=early-title}}");
    const open = early.indexOf('gstack-greptile-early open --base <base> --title-file "$TITLE_FILE"');
    expect(push).toBeGreaterThan(0);
    expect(title).toBeGreaterThan(push);
    expect(open).toBeGreaterThan(title);
    expect(s).toContain("Add `--ready` only when the user asked for a non-draft PR");
    expect(s).toContain("Save the printed `EARLY_PR` and `EARLY_PR_OPENED_AT`");
  });

  test("a stopped /ship leaves the draft open with one comment through gstack-post (ENG-20)", () => {
    const s = flat(early);
    expect(s).toContain("leave the draft open (never close or force-push it) and post one comment saying /ship stopped and why");
    expect(early).toContain("gstack-post pr-comment <pr-number> --body-file <that file>");
    expect(flat(skeleton)).toContain("**An early Greptile PR stays up.** A stop after Step 6.5 opened it leaves the draft open with one comment saying why");
  });
});

describe("/ship Step 10 waits for the early review", () => {
  test("the wait runs after the PR check and before the dispatch, bounded, with an honest timeout", () => {
    const check = step10.indexOf("Only `PR: exists` dispatches.");
    const wait = step10.indexOf("gstack-greptile-early wait <pr-number> --since <opened-at>");
    const dispatch = step10.indexOf("Dispatch a subagent through Agent");
    expect(check).toBeGreaterThan(0);
    expect(wait).toBeGreaterThan(check);
    expect(dispatch).toBeGreaterThan(wait);
    const s = flat(step10.slice(wait, dispatch));
    expect(s).toContain("Rerun on `GREPTILE_REVIEW: pending`");
    expect(s).toContain("`timeout` or `unavailable` takes the Unavailable triage route with that line as the reason, never a claim of zero comments");
    expect(s).toContain("triaged against the current diff");
  });
});

describe("/ship Steps 18-19 finish the early PR", () => {
  test("the provisional title is replaced and the draft is marked ready unless a draft was asked for", () => {
    expect(flat(prBody)).toContain("For an existing open PR/MR (not Step 6.5's early PR, which takes item 2)");
    // Gate integrity (HONEST_WORK_GATE_INTEGRITY W3): the early draft is marked
    // ready only when the user did not ask for a draft AND no gate finding is open.
    const ready = flat(prBody).slice(flat(prBody).indexOf('Then resolve the draft state'), flat(prBody).indexOf('**No open PR/MR:**'));
    expect(ready).toContain('`gh pr ready <pr-number>`');
    expect(ready).toMatch(/Step 6\.5 opened[^.]*did not ask for a draft[^.]*no gate finding is `open`[^.]*gh pr ready/);
  });
});
