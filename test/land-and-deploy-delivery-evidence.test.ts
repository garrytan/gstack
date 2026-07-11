import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TEMPLATE = path.join(ROOT, "land-and-deploy", "SKILL.md.tmpl");

test("land-and-deploy reuses only explicit reusable delivery evidence", () => {
  const content = fs.readFileSync(TEMPLATE, "utf8");

  expect(content).toContain("delivery:verify-landing");
  expect(content).toContain('"status":"reusable"');
  expect(content).toContain("--pr");
  expect(content).toContain("--output json");
  expect(content).toContain("DELIVERY_EVIDENCE_HOOK_FAILED");
  expect(content).toContain("Do not fall back to the normal test command");
  expect(content).toContain("legacy test behavior");
});
