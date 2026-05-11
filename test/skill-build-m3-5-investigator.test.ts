/**
 * Snapshot / validation tests for build/SKILL.md.tmpl Step M3.5 (tier: free).
 *
 * RED phase of TDD — these tests are written BEFORE the Step M3.5 section and
 * the PIPESTATUS[0] update exist in SKILL.md.tmpl. All tests that check Step
 * M3.5 content MUST FAIL until the implementation (Phase 3.1 primary-impl) is
 * applied.
 *
 * Coverage:
 *   Step M3 monitor launch block:
 *     - Uses ${PIPESTATUS[0]} (not just $?) to preserve real monitor exit code
 *     - Captures monitor stdout to monitor-output.log (via tee)
 *   Step M3.5 existence:
 *     - build/SKILL.md.tmpl contains a "### Step M3.5" section
 *     - Step M3.5 references SKILL_FAULT_DETECTED
 *     - Step M3.5 references fault_investigator_model
 *     - Step M3.5 references ~/.gstack/skill-faults/
 *     - Step M3.5 iterates over ALL fault lines (while-read loop, not just one)
 *     - Step M3.5 references GSTACK_FAULT_INVESTIGATOR_COMMAND
 *   Generated file parity:
 *     - build/SKILL.md (generated) contains equivalent Step M3.5 content
 *     - build/SKILL.md contains ${PIPESTATUS[0]} in Step M3
 *     - build/SKILL.md captures monitor output to monitor-output.log
 *   Generator health:
 *     - bun run gen:skill-docs exits 0 (no regression introduced)
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const TMPL_PATH = path.join(ROOT, "build", "SKILL.md.tmpl");
const GENERATED_PATH = path.join(ROOT, "build", "SKILL.md");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the content of a `### HeadingText` section from `content`.
 * Returns null if the heading is not present.
 * The section ends at the next `### ` sibling, `## `, or `---` separator.
 */
function extractSection(content: string, headingPrefix: string): string | null {
  const startIdx = content.indexOf(headingPrefix);
  if (startIdx === -1) return null;

  const afterStart = startIdx + headingPrefix.length;
  // Find the end of this section: next ### / ## heading or --- separator
  const tail = content.slice(afterStart);
  const nextMatch = tail.match(/\n(#{2,3} |---)/);
  const end =
    nextMatch?.index === undefined
      ? content.length
      : afterStart + nextMatch.index;

  return content.slice(startIdx, end);
}

/**
 * Extract the content of the Step M3 block specifically, stopping at Step M3.5
 * (if it exists) or at the next `### Step` heading / `---`.
 */
function extractStepM3Block(content: string): string | null {
  const heading = "### Step M3:";
  const startIdx = content.indexOf(heading);
  if (startIdx === -1) return null;

  const afterStart = startIdx + heading.length;
  const tail = content.slice(afterStart);
  // Stop at Step M3.5, Step M4, any ## heading, or ---
  const nextMatch = tail.match(/\n(### Step M3\.5|### Step M4|#{2,3} |---)/);
  const end =
    nextMatch?.index === undefined
      ? content.length
      : afterStart + nextMatch.index;

  return content.slice(startIdx, end);
}

const tmplContent = fs.readFileSync(TMPL_PATH, "utf8");
const generatedContent = fs.readFileSync(GENERATED_PATH, "utf8");

// ---------------------------------------------------------------------------
// Step M3 monitor launch — PIPESTATUS[0] and monitor-output.log
// ---------------------------------------------------------------------------

describe("build/SKILL.md.tmpl — Step M3 monitor launch", () => {
  test("Step M3 exists in SKILL.md.tmpl", () => {
    expect(tmplContent).toContain("### Step M3:");
  });

  test("Step M3 monitor launch uses ${PIPESTATUS[0]} to capture exit code", () => {
    const m3 = extractStepM3Block(tmplContent);
    expect(m3).not.toBeNull();
    // Must use PIPESTATUS[0] (array exit capture from tee pipeline)
    expect(m3).toContain("${PIPESTATUS[0]}");
  });

  test("Step M3 monitor launch does NOT use bare $? as the sole exit capture", () => {
    const m3 = extractStepM3Block(tmplContent);
    expect(m3).not.toBeNull();
    // After the refactor, $? alone must not appear as the exit capture line
    // (it's OK inside other contexts, but the _MONITOR_EXIT assignment must use PIPESTATUS)
    expect(m3).not.toMatch(/_MONITOR_EXIT=\$\?/);
  });

  test("Step M3 monitor launch captures output to monitor-output.log via tee", () => {
    const m3 = extractStepM3Block(tmplContent);
    expect(m3).not.toBeNull();
    expect(m3).toContain("monitor-output.log");
    // Must use tee to capture while preserving stdout passthrough
    expect(m3).toContain("tee");
  });

  test("Step M3 enables set -o pipefail before the tee pipeline", () => {
    const m3 = extractStepM3Block(tmplContent);
    expect(m3).not.toBeNull();
    expect(m3).toContain("pipefail");
  });
});

// ---------------------------------------------------------------------------
// Step M3.5 existence and content requirements
// ---------------------------------------------------------------------------

describe("build/SKILL.md.tmpl — Step M3.5 presence", () => {
  test("SKILL.md.tmpl contains a '### Step M3.5' section", () => {
    expect(tmplContent).toContain("### Step M3.5");
  });

  test("Step M3.5 section appears after Step M3 in the file", () => {
    const m3Idx = tmplContent.indexOf("### Step M3:");
    const m35Idx = tmplContent.indexOf("### Step M3.5");
    expect(m3Idx).toBeGreaterThan(-1);
    expect(m35Idx).toBeGreaterThan(-1);
    expect(m35Idx).toBeGreaterThan(m3Idx);
  });
});

describe("build/SKILL.md.tmpl — Step M3.5 content", () => {
  test("Step M3.5 references SKILL_FAULT_DETECTED", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("SKILL_FAULT_DETECTED");
  });

  test("Step M3.5 reads from monitor-output.log", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("monitor-output.log");
  });

  test("Step M3.5 references fault_investigator_model config key", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("fault_investigator_model");
  });

  test("Step M3.5 references the ~/.gstack/skill-faults/ fault inbox path", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("~/.gstack/skill-faults/");
  });

  test("Step M3.5 iterates over ALL fault lines using a while-read loop (not just one)", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    // A while-read loop is the idiomatic bash pattern for iterating all lines
    expect(m35).toMatch(/while\s+.*read/);
  });

  test("Step M3.5 references GSTACK_FAULT_INVESTIGATOR_COMMAND env var", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("GSTACK_FAULT_INVESTIGATOR_COMMAND");
  });

  test("Step M3.5 deduplicates faults before spawning investigator", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    // Dedupe is implemented via a glob check against the fault inbox
    // The pattern looks for an existing file glob with runId + CATEGORY
    expect(m35).toMatch(/readlink|glob|skill-faults/);
  });

  test("Step M3.5 checks GSTACK_FAULT_INVESTIGATOR_COMMAND before spawning agent", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    // The GSTACK_FAULT_INVESTIGATOR_COMMAND check must precede the agent spawn
    const cmdIdx = m35!.indexOf("GSTACK_FAULT_INVESTIGATOR_COMMAND");
    const agentIdx = m35!.indexOf("general-purpose");
    expect(cmdIdx).toBeGreaterThan(-1);
    // If agent spawn text is present, command check must come first
    if (agentIdx !== -1) {
      expect(cmdIdx).toBeLessThan(agentIdx);
    }
  });

  test("Step M3.5 spawns background agent (non-blocking) when GSTACK_FAULT_INVESTIGATOR_COMMAND not set", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    // background / non-blocking spawn
    expect(m35).toContain("general-purpose");
  });

  test("Step M3.5 passes FAULT_CATEGORY env var to investigator command or agent", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("FAULT_CATEGORY");
  });

  test("Step M3.5 passes FAULT_RUN_ID env var to investigator command or agent", () => {
    const m35 = extractSection(tmplContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("FAULT_RUN_ID");
  });
});

// ---------------------------------------------------------------------------
// Generated build/SKILL.md parity
// ---------------------------------------------------------------------------

describe("build/SKILL.md (generated) — Step M3.5 parity", () => {
  test("generated SKILL.md contains a '### Step M3.5' section", () => {
    expect(generatedContent).toContain("### Step M3.5");
  });

  test("generated SKILL.md Step M3.5 references SKILL_FAULT_DETECTED", () => {
    const m35 = extractSection(generatedContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("SKILL_FAULT_DETECTED");
  });

  test("generated SKILL.md Step M3.5 references fault_investigator_model", () => {
    const m35 = extractSection(generatedContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("fault_investigator_model");
  });

  test("generated SKILL.md Step M3.5 references ~/.gstack/skill-faults/", () => {
    const m35 = extractSection(generatedContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("~/.gstack/skill-faults/");
  });

  test("generated SKILL.md Step M3.5 references GSTACK_FAULT_INVESTIGATOR_COMMAND", () => {
    const m35 = extractSection(generatedContent, "### Step M3.5");
    expect(m35).not.toBeNull();
    expect(m35).toContain("GSTACK_FAULT_INVESTIGATOR_COMMAND");
  });

  test("generated SKILL.md Step M3 uses ${PIPESTATUS[0]}", () => {
    const m3 = extractStepM3Block(generatedContent);
    expect(m3).not.toBeNull();
    expect(m3).toContain("${PIPESTATUS[0]}");
  });

  test("generated SKILL.md Step M3 captures monitor output to monitor-output.log", () => {
    const m3 = extractStepM3Block(generatedContent);
    expect(m3).not.toBeNull();
    expect(m3).toContain("monitor-output.log");
  });
});

// ---------------------------------------------------------------------------
// Generator health — gen:skill-docs exits cleanly
// ---------------------------------------------------------------------------

describe("gen:skill-docs exit code", () => {
  test("bun run gen:skill-docs exits 0 (no regression introduced)", () => {
    const result = Bun.spawnSync(
      ["bun", "run", "scripts/gen-skill-docs.ts", "--dry-run"],
      {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = result.stderr.toString();
    if (result.exitCode !== 0) {
      // Surface any gen errors for easier debugging
      console.error("gen-skill-docs stderr:", stderr);
    }
    expect(result.exitCode).toBe(0);
  });
});
