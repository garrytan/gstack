/**
 * CI tripwire for the silent-skip class (#audit-2026-08: the 9 make-pdf e2e
 * gate tests self-skipped on Linux for their entire life because the
 * free-tests lane never built the binaries they probe — exit 0, no signal).
 *
 * Every sibling gate file guards itself with test.skipIf(!prerequisitesAvailable()),
 * which is correct for LOCAL runs (a contributor without a build shouldn't
 * fail) but is exactly how CI green stopped meaning "ran". This file inverts
 * the polarity in CI: when GSTACK_EXPECT_BINARIES=1 (set by free-tests.yml's
 * "Run free suite" step), the prerequisites are ASSERTED, so dropping the
 * gate-build step or poppler from the workflow fails the required lane
 * instead of quietly skipping the gates.
 *
 * Not set locally → the whole file self-skips, same as the gates.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolvePdftotext } from "../../src/pdftotext";

const ROOT = path.resolve(__dirname, "../../..");
const EXPECT_BINARIES = process.env.GSTACK_EXPECT_BINARIES === "1";

describe("gate prerequisites (CI tripwire)", () => {
  test.skipIf(!EXPECT_BINARIES)("gate artifacts and tools exist when the lane promises them", () => {
    const missing: string[] = [];
    for (const rel of [
      "make-pdf/dist/pdf",
      "browse/dist/browse",
      "lib/diagram-render/dist/diagram-render.html",
    ]) {
      if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
    }
    try {
      resolvePdftotext();
    } catch (err: any) {
      missing.push(`pdftotext (${err?.message ?? "unresolvable"})`);
    }
    // One assertion naming everything missing beats N opaque ones: the fix
    // is always "restore the build:gates step / apt packages in free-tests.yml".
    expect(missing).toEqual([]);
  });
});
