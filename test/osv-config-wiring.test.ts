/**
 * OSV scanner config wiring (#2679-wave / v1.78.0.0).
 *
 * The suppression file was inert from v1.65.0.0 to v1.78.0.0: OSV-Scanner
 * only auto-discovers configs named `osv-scanner.toml` (no leading dot) and
 * applies them PER-DIRECTORY — a repo-root config never covers
 * lib/diagram-render/bun.lock. The workflow must therefore pass an explicit
 * global `--config` naming the file that actually exists. These tests pin
 * that three-way agreement (workflow flag ↔ file on disk ↔ entry hygiene) so
 * the filename and the flag can never drift apart silently again.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "osv-scanner.yml");
const CONFIG = path.join(ROOT, ".osv-scanner.toml");

describe("osv-scanner config wiring", () => {
  test("workflow passes an explicit --config (auto-discovery never covers nested lockfiles)", () => {
    const wf = fs.readFileSync(WORKFLOW, "utf-8");
    const m = wf.match(/--config=(\S+)/);
    expect(m).not.toBeNull();
    // The flag must name a file that exists at repo root.
    expect(fs.existsSync(path.join(ROOT, m![1]))).toBe(true);
  });

  test("every IgnoredVulns entry has id, reason, and an ignoreUntil expiry", () => {
    const cfg = fs.readFileSync(CONFIG, "utf-8");
    const entries = cfg.split("[[IgnoredVulns]]").slice(1);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatch(/^id = "GHSA-/m);
      expect(entry).toMatch(/^reason = ".{20,}/m);
      // Suppressions must expire — a permanent exception is a silent hole.
      expect(entry).toMatch(/^ignoreUntil = \d{4}-\d{2}-\d{2}/m);
    }
  });

  test("ignoreUntil dates are TOML datetimes the scanner can parse (not strings)", () => {
    const cfg = fs.readFileSync(CONFIG, "utf-8");
    // TOML datetime is unquoted; a quoted date silently parses as a string
    // and (depending on scanner version) may be ignored.
    expect(cfg).not.toMatch(/ignoreUntil = "/);
  });
});
