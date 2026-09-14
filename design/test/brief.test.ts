/**
 * briefToPrompt carries the catalog's generation-time slop guard.
 *
 * The "Never:" line is built from MOCKUP_NEVER_NAMES (lib/design-catalog.ts),
 * so the image model is told up front what not to reach for. The catalog test
 * owns the "exactly ten ids" invariant; this one pins the prompt shape.
 */
import { describe, expect, test } from "bun:test";
import { briefToPrompt, type DesignBrief } from "../src/brief";
import { MOCKUP_NEVER_NAMES } from "../../lib/design-catalog";

const brief: DesignBrief = {
  goal: "Dashboard for a coding assessment tool",
  audience: "Technical users",
  style: "Dark theme, minimal",
  elements: ["builder name", "score badge"],
  screenType: "desktop-dashboard",
};

describe("briefToPrompt", () => {
  test("carries a Never-by-default line listing every MOCKUP_NEVER_NAMES entry, before the fixed tail", () => {
    const prompt = briefToPrompt(brief);
    const never = `Never by default (unless the brief above asks for it): ${MOCKUP_NEVER_NAMES.join(", ")}.`;
    expect(prompt).toContain(never);
    expect(MOCKUP_NEVER_NAMES.length).toBeGreaterThanOrEqual(8);
    for (const name of MOCKUP_NEVER_NAMES) expect(prompt).toContain(name);
    expect(prompt.indexOf(never)).toBeLessThan(prompt.indexOf("The mockup should look like a real production UI"));
    expect(prompt.indexOf(never)).toBeGreaterThan(prompt.indexOf("Required elements:"));
  });

  test("names are plain English: no hyphenated rule ids leak into the prompt", () => {
    const prompt = briefToPrompt(brief);
    expect(prompt).not.toMatch(/\b[a-z]+(-[a-z]+)+\b(?=[,.])/);
    for (const name of MOCKUP_NEVER_NAMES) expect(name).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
  });

  test("optional fields still render around the guard", () => {
    const prompt = briefToPrompt({ ...brief, constraints: "Max width 1024px", reference: "DESIGN.md excerpt" });
    expect(prompt).toContain("Constraints: Max width 1024px.");
    expect(prompt).toContain("Design reference: DESIGN.md excerpt");
    expect(prompt).toContain("Never by default (unless the brief above asks for it): ");
    expect(prompt.endsWith("1536x1024 pixels.")).toBe(true);
  });
});
