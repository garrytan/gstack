import { describe, it, expect } from "bun:test";
import { findNextFeatureIndex } from "../cli";
import type { BuildState, FeatureState } from "../types";

function feature(overrides: Partial<FeatureState> = {}): FeatureState {
  return {
    index: 0,
    number: "1",
    name: "Test Feature",
    phaseIndexes: [0],
    status: "pending",
    ...overrides,
  };
}

function state(features: FeatureState[]): BuildState {
  return {
    planFile: "plan.md",
    planBasename: "plan",
    slug: "test-slug",
    branch: "main",
    startedAt: "2026-05-08T00:00:00.000Z",
    lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    currentPhaseIndex: 0,
    currentFeatureIndex: 0,
    phases: [],
    features,
    completed: false,
  } as unknown as BuildState;
}

describe("findNextFeatureIndex", () => {
  it("returns first non-committed feature", () => {
    const s = state([
      feature({
        index: 0,
        status: "committed",
        completedAt: "2026-05-08T01:00:00.000Z",
      }),
      feature({ index: 1, number: "2", status: "pending" }),
      feature({ index: 2, number: "3", status: "pending" }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(1);
  });

  it("returns -1 when all features are fully committed", () => {
    const s = state([
      feature({
        index: 0,
        status: "committed",
        completedAt: "2026-05-08T01:00:00.000Z",
      }),
      feature({
        index: 1,
        number: "2",
        status: "committed",
        completedAt: "2026-05-08T02:00:00.000Z",
      }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(-1);
  });

  it("does NOT skip a feature whose status is committed but completedAt is missing", () => {
    // Regression test: a manual JSON state patch can set status=committed
    // without going through ship+land+verify (no completedAt). The CLI
    // must re-process the feature, not silently skip it.
    const s = state([
      feature({
        index: 0,
        status: "committed",
        // no completedAt — simulates a manual patch
      }),
      feature({ index: 1, number: "2", status: "pending" }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(0);
  });

  it("skips origin_verified features when skipOriginVerified is true", () => {
    const s = state([
      feature({ index: 0, status: "origin_verified" }),
      feature({ index: 1, number: "2", status: "pending" }),
    ]);
    expect(findNextFeatureIndex(s, { skipOriginVerified: true })).toBe(1);
    expect(findNextFeatureIndex(s, { skipOriginVerified: false })).toBe(0);
  });

  it("returns the manually-patched feature even when later features are also committed", () => {
    const s = state([
      feature({
        index: 0,
        status: "committed",
        // missing completedAt — manual patch
      }),
      feature({
        index: 1,
        number: "2",
        status: "committed",
        completedAt: "2026-05-08T02:00:00.000Z",
      }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(0);
  });
});
