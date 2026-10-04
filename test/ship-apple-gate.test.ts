/**
 * R2 pin (fork port wave 2): the Apple release adapter loads BEFORE ship's
 * branch gate, and the non-Apple gate is byte-unchanged.
 *
 * Two failure modes this prevents: a future ship-template refactor that
 * re-blocks store releases behind "ship from a feature branch" (the exact
 * live failure the fork hit — a solo dev with a clean tree on main shipping
 * to TestFlight got aborted over branch topology), and the reverse — the
 * Apple path accidentally weakening the branch gate for normal
 * repository-landing ships.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { expectMentions } from './helpers/prompt-structure';

const ROOT = join(import.meta.dir, "..");
const SKELETON = readFileSync(join(ROOT, "ship", "SKILL.md"), "utf-8");

const GATE_TEXT =
  'If on the base branch or the repo\'s default branch, **abort**: "You\'re on the base branch. Ship from a feature branch."';

describe("ship Apple gate ordering (R2)", () => {
  test("the section index requires a store-distribution request, not merely an Apple repository", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "ship", "sections", "manifest.json"), "utf-8"));
    const apple = manifest.sections.find((section: { id: string }) => section.id === "apple-release");
    expect(SKELETON).toContain("is App Store/TestFlight distribution");
  });

  test("the Apple adapter read directive precedes the branch gate", () => {
    const appleRead = SKELETON.indexOf("sections/apple-release.md");
    const gate = SKELETON.indexOf(GATE_TEXT);
    expect(appleRead).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(appleRead).toBeLessThan(gate);
  });

  test("store distribution explicitly bypasses the branch/PR ceremony", () => {
    expect(SKELETON).toContain("Store distribution proceeds");
    expectMentions(SKELETON, [['only', 'repository-landing', 'pipeline']], 'SKELETON');
  });

  test("the non-Apple branch gate is byte-unchanged and appears exactly once", () => {
    const first = SKELETON.indexOf(GATE_TEXT);
    expect(first).toBeGreaterThan(-1);
    expect(SKELETON.indexOf(GATE_TEXT, first + 1)).toBe(-1);
  });

  test("the adapter section exists in the union with its battle-tested spine", () => {
    const section = readFileSync(join(ROOT, "ship", "sections", "apple-release.md"), "utf-8");
    for (const anchor of ["one authorization moment", "fastlane spaceauth", "iris/v1/apiKeys", "appPriceSchedules"]) {
      expect(section).toContain(anchor);
    }
    expectMentions(section, [['before', 'credentials', 'classify']], 'section');
    expectMentions(section, [['never', 'topology', 'release']], 'section');
  });

  test("routine interaction limits cannot waive blocking documentation or safety decisions", () => {
    for (const name of ["apple-release.md.tmpl", "apple-release.md"]) {
      const section = readFileSync(join(ROOT, "ship", "sections", name), "utf-8").replace(/\s+/g, " ");
      expect(section).toMatch(/two routine interactions/i);
      expectMentions(section, [['stop', 'authorization', 'decision']], 'section');
      expect(section).not.toContain("two permitted interactions");
      expect(section.indexOf("**Documentation preflight:**")).toBeLessThan(section.indexOf("## The one authorization moment"));
      expect(section).toContain("`read-only` mode");
      expectMentions(section, [['before', 'documentation-risk', 'distribution']], 'section');
    }
  });
});
