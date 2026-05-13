import { describe, expect, test } from "bun:test";
import {
  parseQuery,
  searchListings,
} from "../demos/fuzzy-secondhand-search/src/search-engine.js";

describe("fuzzy second-hand search demo", () => {
  test("extracts natural-language budget and category hints", () => {
    const intent = parseQuery("cheap family car low maintenance under 100k");

    expect(intent.budget?.max).toBe(100000);
    expect(intent.categoryHints).toContain("car");
    expect(intent.mustAvoid).toContain("high maintenance");
    expect(intent.useCase).toBe("family daily use");
  });

  test("returns exactly five results with tradeoff receipts", () => {
    const { results } = searchListings("cheap family car low maintenance under 100k");

    expect(results).toHaveLength(5);
    expect(results[0].listing.category).toBe("car");
    expect(results[0].score.tradeoff.length).toBeGreaterThan(20);
    expect(results[0].score.reasons.length).toBeGreaterThanOrEqual(3);
  });

  test("does not rank raw cheapest over acceptable daily fit", () => {
    const { results } = searchListings("daily motorbike for college student, fuel efficient");

    expect(results[0].listing.id).toBe("moto-vario-2021");
    expect(results.findIndex((result) => result.listing.id === "moto-beat-2019")).toBeGreaterThan(0);
  });

  test("uses house-specific location logic for school and market requests", () => {
    const { results } = searchListings("small house near school and market");

    expect(results[0].listing.category).toBe("house");
    expect(results[0].score.locationFit).toBeGreaterThan(70);
    expect(results[0].score.reasons.join(" ")).toContain("school");
  });

  test("routes design-work laptop queries to electronics", () => {
    const { results } = searchListings("used laptop for design work but lowest possible price");

    expect(results[0].listing.category).toBe("electronics");
    expect(results[0].score.needFit).toBeGreaterThan(70);
  });
});
