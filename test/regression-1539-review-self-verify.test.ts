/**
 * Regression tests for #1539 — /review false positive rate on mature
 * frameworks (Django, 4/8 FPs).
 *
 * The fix extends the Confidence Calibration resolver with a Pre-emit
 * verification gate: every finding must quote the specific code line that
 * motivates it; unverified findings are forced to confidence 4-5 so the
 * existing suppression rule auto-fires.
 *
 * Tests pin:
 *   - The resolver emits the gate text
 *   - The regenerated SKILL.md files for all consumers carry the gate
 *   - The framework-meta nudge is present
 *   - The deferred-design-doc reference is present (T-Codex-2 split)
 *   - Each named FP class from the issue has an explicit row in the gate
 *
 * No paid eval. The static invariants are the durable guarantees that the
 * FP-killing mechanism doesn't regress — the LLM behavior under it is
 * separately measured via E2E review evals when this branch is run with
 * EVALS=1.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { generateConfidenceCalibration } from "../scripts/resolvers/confidence";

const ROOT = path.resolve(import.meta.dir, "..");

describe("#1539 confidence resolver — pre-emit verification gate present", () => {
  test("resolver text includes the gate header", () => {
    const out = generateConfidenceCalibration({} as never);
    expect(out).toMatch(/Pre-emit verification gate/);
    expect(out).toMatch(/#1539/);
  });

  test("gate requires quoted code snippet (file:line + verbatim text)", () => {
    const out = generateConfidenceCalibration({} as never);
    expect(out).toMatch(/Quote the specific code line/);
    expect(out).toMatch(/file:line/);
    expect(out).toMatch(/verbatim text/);
  });

  test("unverified findings auto-suppressed via existing confidence rule", () => {
    const out = generateConfidenceCalibration({} as never);
    // The gate must hook the existing "<7 -> suppress" rule rather than
    // invent new mechanism. Look for both forcing-to-4-5 AND a reference
    // to suppression.
    expect(out).toMatch(/Force its confidence to 4-5/);
    expect(out).toMatch(/suppress/i);
  });

  test("framework-meta nudge present for Django/Rails/SQLAlchemy/TypeORM/Sequelize/Prisma", () => {
    const out = generateConfidenceCalibration({} as never);
    expect(out).toMatch(/Framework-meta nudge/);
    expect(out).toMatch(/Django/);
    expect(out).toMatch(/Rails/);
    expect(out).toMatch(/SQLAlchemy/);
    expect(out).toMatch(/TypeORM/);
    expect(out).toMatch(/Sequelize/);
    expect(out).toMatch(/Prisma/);
  });

  test("references the deferred design doc for framework-aware verification (T-Codex-2)", () => {
    const out = generateConfidenceCalibration({} as never);
    expect(out).toMatch(/1539-framework-aware-review\.md/);
  });

  test("enumerates the four FP classes the gate kills (#1539 named cases)", () => {
    const out = generateConfidenceCalibration({} as never);
    expect(out).toMatch(/field doesn't exist on model/);
    expect(out).toMatch(/dict\.get\(\) might be None/);
    expect(out).toMatch(/save\(\) might lose fields/);
    expect(out).toMatch(/update_fields might miss/);
  });
});

describe("#1539 generated SKILL.md files — gate propagated to all consumers", () => {
  const consumers = [
    "review/SKILL.md",
    "cso/SKILL.md",
    "plan-eng-review/SKILL.md",
    "ship/SKILL.md",
  ];

  for (const rel of consumers) {
    test(`${rel} carries the Pre-emit verification gate`, () => {
      const body = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      expect(body).toMatch(/Pre-emit verification gate/);
      expect(body).toMatch(/Quote the specific code line/);
    });
  }
});

describe("#1539 confidence suppression rule unchanged (regression on existing behavior)", () => {
  test("confidence 3-4 row still says 'Suppress from main report'", () => {
    const out = generateConfidenceCalibration({} as never);
    expect(out).toMatch(/3-4[\s\S]{0,200}Suppress from main report/);
  });

  test("confidence 9-10 row preserves 'Show normally' behavior", () => {
    const out = generateConfidenceCalibration({} as never);
    expect(out).toMatch(/9-10[\s\S]{0,200}Show normally/);
  });
});
