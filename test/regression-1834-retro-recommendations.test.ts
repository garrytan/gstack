/**
 * Regression tests for #1834: /retro wrote "3 Things to Improve" as prose only,
 * so the next retro could not tell whether last week's recommendations were
 * acted on. The Step 13 snapshot now saves them and Step 12 scores them.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SKILL = fs.readFileSync(path.join(ROOT, "retro", "SKILL.md"), "utf-8");
const REPORT = fs.readFileSync(path.join(ROOT, "retro", "sections", "report-format.md"), "utf-8");

function step(heading: string, next: string): string {
  const start = SKILL.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SKILL.indexOf(next, start + heading.length);
  expect(end).toBeGreaterThan(start);
  return SKILL.slice(start, end);
}

describe("#1834 retro persists recommendations and detects follow-through", () => {
  const step12 = step("### Step 12: Load History & Compare", "### Step 13:");
  const step13 = step("### Step 13: Save Retro History", "### Step 14:");

  test("Step 13 schema always saves the 3 Things to Improve as recommendations", () => {
    const schema = step13.match(/```json\n(\{[\s\S]*?\n\})\n```/)?.[1] ?? "";
    const parsed = JSON.parse(schema);
    expect(Array.isArray(parsed.recommendations)).toBe(true);
    expect(Object.keys(parsed.recommendations[0]).sort()).toEqual(["category", "text"]);
    expect(step13).toContain("**Always include `recommendations`:**");
    expect(step13).toContain("Write `[]` when there are none");
    expect(step13).toContain('draft the tweetable summary and the "3 Things to Improve" items');
  });

  test("Step 12 scores prior recommendations and skips older snapshots silently", () => {
    expect(step12).toContain("**Recommendation follow-through:**");
    expect(step12).toMatch(/`addressed`, `partial` or `open`/);
    expect(step12).toContain("2 of 3 prior recommendations addressed");
    expect(step12).toContain("If the snapshot has no `recommendations` key, skip this silently.");
  });

  test("report format ties the 3 Things to Improve to the saved items", () => {
    const improve = REPORT.slice(REPORT.indexOf("### 3 Things to Improve"), REPORT.indexOf("### 3 Habits for Next Week"));
    expect(improve).toContain("saved as `recommendations` in the Step 13 snapshot");
    expect(REPORT).toContain("Include the Recommendation follow-through line when Step 12 produced one.");
  });

  test("global mode snapshot is unchanged", () => {
    expect(step("## Global Retrospective Mode", "## Compare Mode")).not.toContain("recommendations");
  });
});
