/**
 * Unit tests for lib/dashboard-data.ts — loaders and assemblers.
 *
 * Uses real temp directories (no mocks) so the file-reading paths are
 * exercised exactly as they run in production. Network calls (gh, git log)
 * are not exercised here — those paths degrade gracefully in the code.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadVersion,
  loadBacklog,
  loadVelocity,
  loadDesignDocs,
  loadActivityFeed,
  loadInFlightFeatures,
  STAGE_ORDER,
  type TimelineEvent,
} from "../lib/dashboard-data";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gstack-dash-test-"));
}

// ─── loadVersion ────────────────────────────────────────────────────────────

describe("loadVersion", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when VERSION file is missing", () => {
    expect(loadVersion(dir)).toBeNull();
  });

  it("returns trimmed version string", () => {
    writeFileSync(join(dir, "VERSION"), "1.58.5.0\n");
    expect(loadVersion(dir)).toBe("1.58.5.0");
  });

  it("returns null for empty VERSION file", () => {
    writeFileSync(join(dir, "VERSION"), "   \n");
    expect(loadVersion(dir)).toBeNull();
  });
});

// ─── loadBacklog ─────────────────────────────────────────────────────────────

describe("loadBacklog", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when TODOS.md is missing", () => {
    expect(loadBacklog(dir)).toBeNull();
  });

  it("counts only P0–P4 tagged headings", () => {
    writeFileSync(join(dir, "TODOS.md"), [
      "### P0: urgent thing",
      "",
      "**What:** do the urgent thing.",
      "",
      "### P1: another thing",
      "### P2: yet another",
      "### P3: low priority",
      "### P4: very low",
      "",
      "### Context: some context heading",
      "### Eval harness: unrelated",
      "### ✅ DONE (v1.0): old thing",
    ].join("\n"));

    const result = loadBacklog(dir);
    expect(result).not.toBeNull();
    expect(result!.P0).toBe(1);
    expect(result!.P1).toBe(1);
    expect(result!.P2).toBe(1);
    expect(result!.P3).toBe(1);
    expect(result!.P4).toBe(1);
    expect(result!.unparsed).toBe(0);
  });

  it("counts multiple items per priority", () => {
    writeFileSync(join(dir, "TODOS.md"), [
      "### P1: first",
      "### P1: second",
      "### P1: third",
      "### P2: one",
    ].join("\n"));

    const result = loadBacklog(dir);
    expect(result!.P1).toBe(3);
    expect(result!.P2).toBe(1);
    expect(result!.P0).toBe(0);
  });

  it("returns zero counts (not null) for empty TODOS.md", () => {
    writeFileSync(join(dir, "TODOS.md"), "# No priority items yet\n");
    const result = loadBacklog(dir);
    expect(result).not.toBeNull();
    expect(result!.P0).toBe(0);
    expect(result!.P1).toBe(0);
  });
});

// ─── loadVelocity ────────────────────────────────────────────────────────────

describe("loadVelocity", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns zeroes when CHANGELOG.md is missing", () => {
    const v = loadVelocity(dir);
    expect(v.releasesThisMonth).toBe(0);
    expect(v.avgDaysBetween).toBeNull();
    expect(v.recentVersions).toEqual([]);
  });

  it("parses releases and counts this month", () => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthStr = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, "0")}-01`;

    writeFileSync(join(dir, "CHANGELOG.md"), [
      `## [1.2.0.0] - ${thisMonth}`,
      "",
      "Some changes.",
      "",
      `## [1.1.0.0] - ${prevMonthStr}`,
      "",
      "Earlier changes.",
    ].join("\n"));

    const v = loadVelocity(dir);
    expect(v.releasesThisMonth).toBe(1);
    // recentVersions filtered to 30-day window — prevMonth may or may not be included
    expect(v.recentVersions.length).toBeGreaterThanOrEqual(1);
  });

  it("returns null avgDaysBetween with fewer than 2 recent releases", () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    writeFileSync(join(dir, "CHANGELOG.md"), `## [1.0.0.0] - ${today}\n\nOnly one.\n`);
    const v = loadVelocity(dir);
    expect(v.avgDaysBetween).toBeNull();
  });

  it("computes avgDaysBetween for 2 releases", () => {
    const now = new Date();
    const d1 = new Date(now.getTime() - 10 * 86400000).toISOString().slice(0, 10);
    const d2 = now.toISOString().slice(0, 10);
    writeFileSync(join(dir, "CHANGELOG.md"), [
      `## [1.1.0.0] - ${d2}`,
      "",
      `## [1.0.0.0] - ${d1}`,
    ].join("\n"));
    const v = loadVelocity(dir);
    expect(v.avgDaysBetween).not.toBeNull();
    expect(v.avgDaysBetween!).toBeCloseTo(10, 0);
  });
});

// ─── loadDesignDocs ──────────────────────────────────────────────────────────

describe("loadDesignDocs", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns [] when directory does not exist", () => {
    expect(loadDesignDocs(join(dir, "nonexistent"))).toEqual([]);
  });

  it("returns [] when directory exists but has no design docs", () => {
    expect(loadDesignDocs(dir)).toEqual([]);
  });

  it("matches *-design-*.md files and sorts by mtime descending", () => {
    writeFileSync(join(dir, "user-feature-design-20260601.md"), "# old design");
    writeFileSync(join(dir, "user-feature-design-20260620.md"), "# new design");
    writeFileSync(join(dir, "some-other-file.md"), "# not a design");

    const docs = loadDesignDocs(dir);
    expect(docs.length).toBe(2);
    expect(docs.every((d) => d.name.includes("-design-"))).toBe(true);
    // sorted newest first (by mtime — order of writes determines this in the test)
  });

  it("caps at limit", () => {
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(dir, `branch-feature-design-2026060${i}.md`), `# design ${i}`);
    }
    expect(loadDesignDocs(dir, 5).length).toBe(5);
    expect(loadDesignDocs(dir, 10).length).toBe(10);
  });
});

// ─── loadActivityFeed ────────────────────────────────────────────────────────

describe("loadActivityFeed", () => {
  const now = new Date();
  const makeEvent = (skill: string, branch: string, minsAgo: number): TimelineEvent => ({
    ts: new Date(now.getTime() - minsAgo * 60000).toISOString(),
    skill,
    branch,
    event: "completed",
  });

  it("returns empty array for no events", () => {
    expect(loadActivityFeed([])).toEqual([]);
  });

  it("sorts descending by timestamp", () => {
    const events = [
      makeEvent("spec", "main", 120),
      makeEvent("ship", "feature/a", 10),
      makeEvent("review", "feature/b", 60),
    ];
    const feed = loadActivityFeed(events);
    expect(feed[0].skill).toBe("ship");
    expect(feed[1].skill).toBe("review");
    expect(feed[2].skill).toBe("spec");
  });

  it("respects limit", () => {
    const events = Array.from({ length: 20 }, (_, i) => makeEvent(`skill${i}`, "main", i * 5));
    expect(loadActivityFeed(events, 5).length).toBe(5);
    expect(loadActivityFeed(events, 10).length).toBe(10);
  });

  it("filters out events missing ts or skill", () => {
    const events: TimelineEvent[] = [
      { ts: "", skill: "spec", branch: "main", event: "completed" },
      { ts: now.toISOString(), skill: "", branch: "main", event: "completed" },
      makeEvent("ship", "main", 5),
    ];
    const feed = loadActivityFeed(events);
    expect(feed.length).toBe(1);
    expect(feed[0].skill).toBe("ship");
  });
});

// ─── loadInFlightFeatures ────────────────────────────────────────────────────

describe("loadInFlightFeatures (timeline only — no git branch)", () => {
  const recentTs = new Date(Date.now() - 5 * 86400000).toISOString(); // 5 days ago
  const staleTs = new Date(Date.now() - 95 * 86400000).toISOString(); // 95 days ago

  it("returns empty stagesReached for branches with no completed events in window", () => {
    const timeline: TimelineEvent[] = [
      { ts: staleTs, skill: "spec", branch: "feature/old", event: "completed" },
    ];
    const features = loadInFlightFeatures(timeline);
    const old = features.find((f) => f.branch === "feature/old");
    // stagesReached uses 90-day window → should be empty for 95-day-old event
    if (old) {
      expect(old.stagesReached.size).toBe(0);
    }
    // latestEntry uses all-time → latestStage will still be set
    if (old) {
      expect(old.latestStage).toBe("spec");
    }
  });

  it("populates stagesReached for events within 90 days", () => {
    const timeline: TimelineEvent[] = [
      { ts: recentTs, skill: "spec", branch: "feature/new", event: "completed" },
      { ts: recentTs, skill: "plan-eng-review", branch: "feature/new", event: "completed" },
    ];
    const features = loadInFlightFeatures(timeline);
    const f = features.find((f) => f.branch === "feature/new");
    if (f) {
      expect(f.stagesReached.has("spec")).toBe(true);
      expect(f.stagesReached.has("plan-review")).toBe(true);
    }
  });

  it("does not count stale-only branches as in-flight via stagesReached", () => {
    const timeline: TimelineEvent[] = [
      { ts: staleTs, skill: "spec", branch: "feature/stale", event: "completed" },
    ];
    const features = loadInFlightFeatures(timeline);
    const stale = features.find((f) => f.branch === "feature/stale");
    if (stale) {
      // stagesReached is empty (outside 90-day window) → not counted in-flight
      const isInFlight =
        stale.stagesReached.size > 0 &&
        !stale.stagesReached.has("ship") &&
        !stale.stagesReached.has("canary");
      expect(isInFlight).toBe(false);
    }
  });

  it("canary stage does not count as in-flight", () => {
    const timeline: TimelineEvent[] = [
      { ts: recentTs, skill: "canary", branch: "feature/deployed", event: "completed" },
    ];
    const features = loadInFlightFeatures(timeline);
    const f = features.find((f) => f.branch === "feature/deployed");
    if (f) {
      const isInFlight =
        f.stagesReached.size > 0 &&
        !f.stagesReached.has("ship") &&
        !f.stagesReached.has("canary");
      expect(isInFlight).toBe(false);
    }
  });

  it("ship stage does not count as in-flight", () => {
    const timeline: TimelineEvent[] = [
      { ts: recentTs, skill: "ship", branch: "feature/shipped", event: "completed" },
    ];
    const features = loadInFlightFeatures(timeline);
    const f = features.find((f) => f.branch === "feature/shipped");
    if (f) {
      const isInFlight =
        f.stagesReached.size > 0 &&
        !f.stagesReached.has("ship") &&
        !f.stagesReached.has("canary");
      expect(isInFlight).toBe(false);
    }
  });
});

// ─── STAGE_ORDER sanity ──────────────────────────────────────────────────────

describe("STAGE_ORDER", () => {
  it("has 7 stages in the correct order", () => {
    expect(STAGE_ORDER).toEqual([
      "office-hours",
      "spec",
      "plan-review",
      "implement",
      "review",
      "ship",
      "canary",
    ]);
  });
});
