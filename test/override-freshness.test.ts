/**
 * Override freshness gate.
 *
 * `.osv-scanner.toml` forces every SUPPRESSED advisory to expire. Nothing
 * forced the same discipline on the pins in package.json `overrides`, and an
 * exact pin is the one dependency shape that cannot drift forward on its own:
 * Dependabot will not move it, and dependency-review.yml only inspects newly
 * ADDED dependencies. On 2026-09-14 the weekly OSV cron went red on
 * sharp@0.35.0 and adm-zip@0.6.0, days after the advisories landed, with no
 * PR-time signal in between.
 *
 * These tests pin the three-way agreement between the overrides block, the
 * rationale ledger, and the clock, so a stale pin fails a gate a human is
 * already reading instead of a cron nobody watches.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const PKG = path.join(ROOT, "package.json");
const PINS = path.join(ROOT, ".override-pins.json");

const overrides: Record<string, string> = JSON.parse(fs.readFileSync(PKG, "utf-8")).overrides ?? {};
const pins: Record<string, { reason?: string; reviewBy?: string }> =
  JSON.parse(fs.readFileSync(PINS, "utf-8")).pins ?? {};

describe("override freshness", () => {
  test("every override carries a rationale entry", () => {
    const missing = Object.keys(overrides).filter((name) => !(name in pins));
    expect(missing).toEqual([]);
  });

  test("no orphan rationale entries for overrides that were removed", () => {
    const orphans = Object.keys(pins).filter((name) => !(name in overrides));
    expect(orphans).toEqual([]);
  });

  test("every rationale explains the pin in more than a word", () => {
    for (const [name, pin] of Object.entries(pins)) {
      expect(`${name}: ${pin.reason ?? ""}`.length).toBeGreaterThan(name.length + 40);
    }
  });

  test("every pin has an unexpired reviewBy date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const expired: string[] = [];
    for (const [name, pin] of Object.entries(pins)) {
      // A pin with no expiry is a permanent exception, which is the hole.
      expect(pin.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (pin.reviewBy! < today) expired.push(`${name} (reviewBy ${pin.reviewBy})`);
    }
    // Re-check the advisory state and upstream releases, bump the pin if it
    // has fallen behind, then push reviewBy forward in .override-pins.json.
    expect(expired).toEqual([]);
  });

  test("an exact pin is never left behind the range its dependents ask for", () => {
    // Exact pins (no ^ or ~) are the ones that silently rot; they must at
    // least be a version the lockfile actually resolved to.
    const lock = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf-8");
    for (const [name, spec] of Object.entries(overrides)) {
      if (/^[\^~><=*]/.test(spec)) continue;
      expect(lock).toContain(`"${name}@${spec}"`);
    }
  });
});
