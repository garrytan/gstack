/**
 * Regression tests for #1834 — /retro generated "3 Things to Improve" as
 * throwaway prose and never persisted them, so the next run had no structured
 * record of what it recommended and could not detect follow-through. A week
 * spent acting on retro feedback got mischaracterized as a generic metric swing.
 *
 * The fix lives in retro/SKILL.md.tmpl:
 *   - Step 13 snapshot schema gains a `recommendations` array (always written).
 *   - Step 13 prose mandates populating it from the "3 Things to Improve" items.
 *   - Step 12 reads a prior snapshot's `recommendations` back and classifies each
 *     as addressed / partial / open, with a backward-compat skip for older
 *     snapshots that predate the field.
 *   - The "3 Things to Improve" narrative is wired to the persisted array.
 *
 * These are static invariants against the template body (and the regenerated
 * SKILL.md). They fail the build if any leg of the persist → read-back loop is
 * dropped, so the follow-through capability can't silently regress.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const RETRO_TMPL = path.join(ROOT, "retro", "SKILL.md.tmpl");
const RETRO_MD = path.join(ROOT, "retro", "SKILL.md");

function readTmpl(): string {
  return fs.readFileSync(RETRO_TMPL, "utf-8");
}

function readMd(): string {
  return fs.readFileSync(RETRO_MD, "utf-8");
}

describe("#1834 retro recommendations — Step 13 snapshot persists them", () => {
  test("schema block carries a recommendations array with category + text shape", () => {
    const body = readTmpl();
    const schemaStart = body.indexOf("Use the Write tool to save the JSON file with this schema:");
    expect(schemaStart).toBeGreaterThan(-1);
    // The recommendations array must live inside the Step 13 JSON schema, not
    // somewhere else in the doc.
    const schema = body.slice(schemaStart, schemaStart + 2000);
    expect(schema).toMatch(/"recommendations"\s*:\s*\[/);
    expect(schema).toMatch(/"category"\s*:/);
    expect(schema).toMatch(/"text"\s*:/);
  });

  test("recommendations are mandatory, not optional like greptile/backlog/test_health", () => {
    const body = readTmpl();
    expect(body).toMatch(/\*\*Always include the `recommendations` array\.\*\*/);
  });

  test("Step 13 ties the array to the 3 Things to Improve items", () => {
    const body = readTmpl();
    const anchor = body.indexOf("**Always include the `recommendations` array.**");
    expect(anchor).toBeGreaterThan(-1);
    const para = body.slice(anchor, anchor + 700);
    expect(para).toMatch(/3 Things to Improve/);
    expect(para).toMatch(/follow-through/i);
  });
});

describe("#1834 retro recommendations — Step 12 reads them back and scores follow-through", () => {
  test("Step 12 has a Recommendation follow-through block before Step 13", () => {
    const body = readTmpl();
    const follow = body.indexOf("**Recommendation follow-through.**");
    const step13 = body.indexOf("### Step 13: Save Retro History");
    expect(follow).toBeGreaterThan(-1);
    expect(step13).toBeGreaterThan(-1);
    expect(follow).toBeLessThan(step13);
  });

  test("follow-through classifies each prior recommendation addressed/partial/open", () => {
    const body = readTmpl();
    const follow = body.indexOf("**Recommendation follow-through.**");
    const block = body.slice(follow, follow + 1400);
    expect(block).toMatch(/`addressed`/);
    expect(block).toMatch(/`partial`/);
    expect(block).toMatch(/`open`/);
  });

  test("follow-through is backward compatible with snapshots that predate the field", () => {
    const body = readTmpl();
    const follow = body.indexOf("**Recommendation follow-through.**");
    const block = body.slice(follow, follow + 600);
    // Older snapshots have no recommendations array — the block must skip, not crash.
    expect(block).toMatch(/if it's absent, skip this block/i);
  });
});

describe("#1834 retro recommendations — 3 Things to Improve narrative persists the loop", () => {
  test("narrative instructs recording the 3 items into the snapshot array", () => {
    const body = readTmpl();
    const heading = body.indexOf("### 3 Things to Improve");
    expect(heading).toBeGreaterThan(-1);
    const section = body.slice(heading, heading + 900);
    expect(section).toMatch(/recommendations` array/);
  });
});

describe("#1834 retro recommendations — regenerated SKILL.md carries the loop", () => {
  test("generated SKILL.md is not stale relative to the template", () => {
    const md = readMd();
    expect(md).toMatch(/\*\*Always include the `recommendations` array\.\*\*/);
    expect(md).toMatch(/\*\*Recommendation follow-through\.\*\*/);
    expect(md).toMatch(/"recommendations"\s*:\s*\[/);
  });
});
