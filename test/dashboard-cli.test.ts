/**
 * Unit tests for lib/dashboard-cli.ts — terminal renderers.
 *
 * Uses fabricated DashboardData/OnelinerData objects to test rendering
 * in isolation — no file I/O, no network calls.
 */

import { describe, it, expect } from "bun:test";
import { renderOneliner, renderCompact, renderFull } from "../lib/dashboard-cli";
import type { OnelinerData, DashboardData } from "../lib/dashboard-data";
import { STAGE_ORDER } from "../lib/dashboard-data";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeOneliner(overrides: Partial<OnelinerData> = {}): OnelinerData {
  return {
    slug: "test-project",
    branch: "feature/test",
    version: "1.0.0.0",
    inFlightCount: 2,
    currentBranchStages: new Set(),
    currentBranchLatestStage: null,
    p1Count: 3,
    lastShipDate: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
    ...overrides,
  };
}

function makeDashboard(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    slug: "test-project",
    branch: "feature/test",
    version: "1.2.3.0",
    generatedAt: new Date("2026-01-01T12:00:00Z"),
    inFlightCount: 1,
    features: [],
    activity: [],
    velocity: { releasesThisMonth: 2, avgDaysBetween: 7.5, recentVersions: [] },
    topSkills: [],
    quality: [],
    designDocs: [],
    backlog: { P0: 0, P1: 3, P2: 5, P3: 10, P4: 2, unparsed: 0 },
    openDecisions: 2,
    ghAvailable: false,
    prMap: new Map(),
    defaultBranch: "main",
    ...overrides,
  };
}

// ─── renderOneliner ──────────────────────────────────────────────────────────

describe("renderOneliner", () => {
  it("includes branch name and version", () => {
    const line = renderOneliner(makeOneliner());
    expect(line).toContain("feature/test");
    expect(line).toContain("v1.0.0.0");
  });

  it("includes in-flight count", () => {
    const line = renderOneliner(makeOneliner({ inFlightCount: 5 }));
    expect(line).toContain("5 in-flight");
  });

  it("shows no stage section when currentBranchLatestStage is null", () => {
    const line = renderOneliner(makeOneliner({
      currentBranchLatestStage: null,
      currentBranchStages: new Set(),
    }));
    // No stage labels should appear
    expect(line).not.toContain("OH:");
    expect(line).not.toContain("Spec:");
  });

  it("shows stage progress when latestStage is set", () => {
    const line = renderOneliner(makeOneliner({
      currentBranchLatestStage: "spec",
      currentBranchStages: new Set(["office-hours", "spec"]),
    }));
    expect(line).toContain("OH:");
    expect(line).toContain("Spec:");
    // plan-review should be visible (latestIdx+2 = spec is index 1, showUpTo = min(3, 6) = 3)
    expect(line).toContain("Plan:");
  });

  it("marks reached stages with ✓ and current with ▶", () => {
    const line = renderOneliner(makeOneliner({
      currentBranchLatestStage: "spec",
      currentBranchStages: new Set(["office-hours", "spec"]),
    }));
    expect(line).toContain("OH:✓");
    expect(line).toContain("Spec:▶");
  });

  it("shows P1 count", () => {
    const line = renderOneliner(makeOneliner({ p1Count: 7 }));
    expect(line).toContain("P1:7");
  });

  it("omits P1 when p1Count is null", () => {
    const line = renderOneliner(makeOneliner({ p1Count: null }));
    expect(line).not.toContain("P1:");
  });

  it("shows 'today' when lastShipDate is today", () => {
    const today = new Date().toISOString().slice(0, 10);
    const line = renderOneliner(makeOneliner({ lastShipDate: today }));
    expect(line).toContain("shipped today");
  });

  it("omits ship date when lastShipDate is null", () => {
    const line = renderOneliner(makeOneliner({ lastShipDate: null }));
    expect(line).not.toContain("shipped");
  });
});

// ─── renderCompact ───────────────────────────────────────────────────────────

describe("renderCompact", () => {
  it("includes slug, version, in-flight, ships/mo in header", () => {
    const out = renderCompact(makeDashboard());
    expect(out).toContain("test-project");
    expect(out).toContain("v1.2.3.0");
    expect(out).toContain("1 in-flight");
    expect(out).toContain("2 ships/mo");
  });

  it("shows 'no tracked branches yet' when no tracked features", () => {
    const out = renderCompact(makeDashboard({ features: [] }));
    expect(out).toContain("no tracked branches yet");
  });

  it("shows untracked count when branches have no stage activity", () => {
    const features = [
      {
        branch: "feature/untracked",
        stagesReached: new Set() as Set<import("../lib/dashboard-data").Stage>,
        latestStage: null,
        latestTs: null,
        latestSkill: null,
      },
      {
        branch: "feature/also-untracked",
        stagesReached: new Set() as Set<import("../lib/dashboard-data").Stage>,
        latestStage: null,
        latestTs: null,
        latestSkill: null,
      },
    ];
    const out = renderCompact(makeDashboard({ features }));
    expect(out).toContain("(+2 untracked");
  });

  it("shows ◀ marker for current branch", () => {
    const features = [
      {
        branch: "feature/test",
        stagesReached: new Set(["spec"]) as Set<import("../lib/dashboard-data").Stage>,
        latestStage: "spec" as import("../lib/dashboard-data").Stage,
        latestTs: new Date().toISOString(),
        latestSkill: "spec",
      },
    ];
    const out = renderCompact(makeDashboard({ features }));
    expect(out).toContain("◀");
  });

  it("shows PR badge when prMap has entry", () => {
    const features = [
      {
        branch: "feature/test",
        stagesReached: new Set(["spec"]) as Set<import("../lib/dashboard-data").Stage>,
        latestStage: "spec" as import("../lib/dashboard-data").Stage,
        latestTs: new Date().toISOString(),
        latestSkill: "spec",
      },
    ];
    const prMap = new Map([["feature/test", { number: 42, state: "open" }]]);
    const out = renderCompact(makeDashboard({ features, prMap }));
    expect(out).toContain("#42");
  });

  it("shows 'no activity yet' when activity is empty", () => {
    const out = renderCompact(makeDashboard({ activity: [] }));
    expect(out).toContain("no activity yet");
  });

  it("shows avg days/release in header when available", () => {
    const out = renderCompact(makeDashboard());
    expect(out).toContain("avg 7.5d");
  });

  it("includes P1 backlog count in header", () => {
    const out = renderCompact(makeDashboard());
    expect(out).toContain("P1:3");
  });
});

// ─── renderFull ──────────────────────────────────────────────────────────────

describe("renderFull", () => {
  it("includes all section headers", () => {
    const out = renderFull(makeDashboard());
    expect(out).toContain("PIPELINE");
    expect(out).toContain("ACTIVITY FEED");
    expect(out).toContain("TOP SKILLS");
    expect(out).toContain("QUALITY SCORES");
    expect(out).toContain("RELEASE VELOCITY");
    expect(out).toContain("TODOS BACKLOG");
  });

  it("shows open decisions in header", () => {
    const out = renderFull(makeDashboard({ openDecisions: 5 }));
    expect(out).toContain("decisions:5");
  });

  it("shows — when openDecisions is null", () => {
    const out = renderFull(makeDashboard({ openDecisions: null }));
    expect(out).toContain("decisions:—");
  });

  it("shows 'no local branches found' when features is empty", () => {
    const out = renderFull(makeDashboard({ features: [] }));
    expect(out).toContain("no local branches found");
  });

  it("shows 'no TODOS.md found' when backlog is null", () => {
    const out = renderFull(makeDashboard({ backlog: null }));
    expect(out).toContain("no TODOS.md found");
  });

  it("shows backlog priority counts", () => {
    const out = renderFull(makeDashboard());
    expect(out).toContain("P1: 3");
    expect(out).toContain("P2: 5");
  });

  it("skips ACTIVE DESIGN DOCS section when designDocs is empty", () => {
    const out = renderFull(makeDashboard({ designDocs: [] }));
    expect(out).not.toContain("ACTIVE DESIGN DOCS");
  });

  it("shows ACTIVE DESIGN DOCS section when docs exist", () => {
    const docs = [{ name: "user-feature-design-2026.md", fullPath: "/tmp/foo.md", mtime: Date.now() }];
    const out = renderFull(makeDashboard({ designDocs: docs }));
    expect(out).toContain("ACTIVE DESIGN DOCS");
    expect(out).toContain("user-feature-design-2026.md");
  });

  it("shows 'no releases in the last 30 days' when recentVersions is empty", () => {
    const dashboard = makeDashboard({
      velocity: { releasesThisMonth: 0, avgDaysBetween: null, recentVersions: [] },
    });
    const out = renderFull(dashboard);
    expect(out).toContain("no releases in the last 30 days");
  });
});
