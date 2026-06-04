/**
 * Cross-skill taxonomy alignment. The canonical taxonomy lives in
 * lib/redact-patterns.ts (single source of truth). /spec and /cso both reference
 * it by pointer rather than inlining the full catalog (size discipline). This
 * test guards that the recognizable HIGH-tier prefixes stay present in /cso's
 * archaeology prose and that the resolver-generated table stays derived from the
 * lib (no drift between the generator and the pattern source).
 */
import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { generateRedactTaxonomyTable } from "../scripts/resolvers/redact-doc";
import { HOST_PATHS } from "../scripts/resolvers/types";
import { PATTERNS } from "../lib/redact-patterns";

const ROOT = path.resolve(import.meta.dir, "..");
const CSO = fs.readFileSync(path.join(ROOT, "cso", "SKILL.md"), "utf-8");
const ctx = { skillName: "cso", tmplPath: "", host: "claude" as const, paths: HOST_PATHS["claude"] };

describe("cso/spec taxonomy alignment", () => {
  test("cso archaeology names the recognizable HIGH-tier prefixes", () => {
    for (const s of ["AKIA", "ghp_", "sk-ant-", "BEGIN"]) {
      expect(CSO).toContain(s);
    }
  });

  test("cso points to lib/redact-patterns.ts as the single source of truth", () => {
    expect(CSO).toContain("lib/redact-patterns.ts");
  });

  test("the generated taxonomy table is derived from lib (every pattern id present)", () => {
    const table = generateRedactTaxonomyTable(ctx);
    for (const p of PATTERNS) {
      expect(table).toContain(`\`${p.id}\``);
    }
  });

  test("cso keeps its git-history archaeology (different use case, not replaced)", () => {
    expect(CSO).toContain("git log -p --all");
    expect(CSO).toContain("Secrets Archaeology");
  });
});
