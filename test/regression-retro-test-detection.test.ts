/**
 * Regression tests for the /retro test-detection + anti-fabrication fix.
 *
 * Background: a generated retro claimed "0 new tests added" and invented a
 * non-existent 5,165-file "bootstrap commit" to reconcile that zero against a
 * large total-test count. Two root causes in retro/SKILL.md(.tmpl):
 *
 *   1. The "tests changed in window" command used `grep -E '\.(test|spec)\.'`,
 *      which only matches JS/TS files (foo.test.ts / foo.spec.js). It returned 0
 *      for Python (test_*.py), Terraform (*.tftest.hcl), and Bats (*.bats) suites.
 *   2. There was no guard forbidding per-commit figures that aren't read from the
 *      commit itself, so the model fabricated a "bootstrap" narrative.
 *
 * These are static invariants against the skill body — they fail the build if the
 * language-agnostic pattern is narrowed again or the plausibility guard is removed.
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

// The test-detection pattern must recognise these representative paths.
const MUST_MATCH = [
  "tests/apps/engine_attribution/unit/test_register_tenant_context.py", // Python prefix
  "libs/foo/bar_test.py", // Python suffix
  "apps/dashboard/src/x.test.ts", // JS/TS infix
  "apps/dashboard/src/x.spec.tsx", // JS/TS spec
  "infrastructure/terraform/modules/cloud_run/tests/cloud_run_v2.tftest.hcl", // Terraform
  "tests/infrastructure/test_assert_no_cloud_run_destroy.bats", // Bats
];
// The pattern must NOT classify these production files as tests.
const MUST_NOT_MATCH = [
  "apps/engine_attribution/main.py",
  "infrastructure/terraform/environments/production/main.tf",
  "packages/components_ui/src/Button.tsx",
];

// The literal grep -iE pattern embedded in the skill (kept in sync with both files).
const TEST_RE =
  /\(\^\|\/\)test_\|_test\\\.\|\\\.test\\\.\|\\\.spec\\\.\|_spec\\\.\|\\\.tftest\\\.hcl\$\|\\\.bats\$\|\(\^\|\/\)\(tests\?\|__tests__\|spec\)\//;

describe("retro test-detection — language-agnostic pattern present in both layers", () => {
  for (const [label, read] of [
    ["template", readTmpl],
    ["compiled SKILL.md", readMd],
  ] as const) {
    test(`${label} embeds the language-agnostic TEST pattern (Python/TF/Bats, not just JS)`, () => {
      const body = read();
      expect(body).toMatch(TEST_RE);
      // belt-and-braces: the specific non-JS tokens must be there
      expect(body).toContain("tftest\\.hcl$");
      expect(body).toContain("\\.bats$");
      expect(body).toContain("(^|/)test_");
    });

    test(`${label} does NOT use the narrow JS-only grep as a counting command`, () => {
      const body = read();
      // The narrow pattern may appear ONLY inside the explanatory "Do NOT narrow" comment.
      const narrowOnCommandLine = body
        .split("\n")
        .filter((l) => l.includes("(test|spec)") && !l.includes("Do NOT narrow"));
      expect(narrowOnCommandLine).toEqual([]);
    });
  }
});

describe("retro test-detection — pattern behaviour (model the embedded regex in JS)", () => {
  // Mirror of the embedded grep -iE pattern, as a JS RegExp, case-insensitive.
  const re = /(^|\/)test_|_test\.|\.test\.|\.spec\.|_spec\.|\.tftest\.hcl$|\.bats$|(^|\/)(tests?|__tests__|spec)\//i;

  for (const p of MUST_MATCH) {
    test(`matches test file: ${p}`, () => {
      expect(re.test(p)).toBe(true);
    });
  }
  for (const p of MUST_NOT_MATCH) {
    test(`does not match production file: ${p}`, () => {
      expect(re.test(p)).toBe(false);
    });
  }
});

describe("retro anti-fabrication — Step 1.5 plausibility guard present", () => {
  for (const [label, read] of [
    ["template", readTmpl],
    ["compiled SKILL.md", readMd],
  ] as const) {
    test(`${label} has the Step 1.5 plausibility guard`, () => {
      const body = read();
      expect(body).toMatch(/### Step 1\.5: Per-commit plausibility guard/);
    });

    test(`${label} forbids inventing a bootstrap/foundation narrative`, () => {
      const body = read();
      expect(body).toMatch(/No invented "bootstrap"\/"foundation"\/"initial import" narrative/);
    });

    test(`${label} requires per-commit figures from git show --shortstat`, () => {
      const body = read();
      expect(body).toMatch(/git show --shortstat <hash>/);
    });

    test(`${label} guard sits between the command block and Step 2`, () => {
      const body = read();
      const guard = body.indexOf("### Step 1.5: Per-commit plausibility guard");
      const step2 = body.indexOf("### Step 2: Compute Metrics");
      expect(guard).toBeGreaterThan(-1);
      expect(step2).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(step2);
    });
  }
});
