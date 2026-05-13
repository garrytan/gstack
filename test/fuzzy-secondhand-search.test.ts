import { describe, expect, test } from "bun:test";
import { createApiHandler } from "../demos/fuzzy-secondhand-search/src/api.js";
import {
  normalizeCsv,
  normalizeEbayItems,
  normalizeMobil123Html,
  normalizeOlxHtml,
} from "../demos/fuzzy-secondhand-search/src/ingestion.js";
import {
  parseQuery,
  searchListings,
} from "../demos/fuzzy-secondhand-search/src/search-engine.js";
import { listings } from "../demos/fuzzy-secondhand-search/src/data.js";

describe("fuzzy second-hand search demo", () => {
  test("extracts natural-language budget and category hints", () => {
    const intent = parseQuery("cheap family car low maintenance under 100k");

    expect(intent.budget?.max).toBe(100000);
    expect(intent.categoryHints).toContain("car");
    expect(intent.mustAvoid).toContain("high maintenance");
    expect(intent.useCase).toBe("family daily use");
  });

  test("returns exactly five results with tradeoff receipts", () => {
    const { results } = searchListings("cheap family car low maintenance under 100k", listings);

    expect(results).toHaveLength(5);
    expect(results[0].listing.category).toBe("car");
    expect(results[0].score.tradeoff.length).toBeGreaterThan(20);
    expect(results[0].score.reasons.length).toBeGreaterThanOrEqual(3);
  });

  test("does not rank raw cheapest over acceptable daily fit", () => {
    const { results } = searchListings("daily motorbike for college student, fuel efficient", listings);

    expect(results[0].listing.id).toBe("moto-vario-2021");
    expect(results.findIndex((result) => result.listing.id === "moto-beat-2019")).toBeGreaterThan(0);
  });

  test("uses house-specific location logic for school and market requests", () => {
    const { results } = searchListings("small house near school and market", listings);

    expect(results[0].listing.category).toBe("house");
    expect(results[0].score.locationFit).toBeGreaterThan(70);
    expect(results[0].score.reasons.join(" ")).toContain("school");
  });

  test("routes design-work laptop queries to electronics", () => {
    const { results } = searchListings("used laptop for design work but lowest possible price", listings);

    expect(results[0].listing.category).toBe("electronics");
    expect(results[0].score.needFit).toBeGreaterThan(70);
  });

  test("normalizes OLX and Mobil123 JSON-LD records", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "2019 Honda Vario 125",
      url: "/item/vario",
      image: "https://img.example/vario.jpg",
      offers: { price: "16800000", priceCurrency: "IDR" },
      description: "Motor bekas terawat",
    })}</script>`;

    const [olx] = normalizeOlxHtml(html, "https://www.olx.co.id/items/q-motor-bekas");
    const [mobil123] = normalizeMobil123Html(html, "https://www.mobil123.com/mobil-dijual/indonesia");

    expect(olx.category).toBe("motorcycle");
    expect(olx.price).toBe(16800000);
    expect(mobil123.category).toBe("car");
  });

  test("normalizes manual CSV imports", () => {
    const rows = normalizeCsv([
      "source_url,title,category,price,location,year,mileage_km",
      "https://seller.test/a,2017 Toyota Avanza G,car,92.000.000,South Jakarta,2017,82000",
      "https://seller.test/b,2019 Honda Brio,car,\"88,000,000\",Depok,2019,64000",
    ].join("\n"));

    expect(rows).toHaveLength(2);
    expect(rows[0].price).toBe(92000000);
    expect(rows[1].price).toBe(88000000);
    expect(rows[0].attributes.year).toBe(2017);
    expect(rows[0].attributes.mileageKm).toBe(82000);
  });

  test("normalizes eBay Browse API items", () => {
    const rows = normalizeEbayItems({
      itemSummaries: [{
        itemId: "v1|123",
        title: "Used ThinkPad T14 laptop",
        itemWebUrl: "https://www.ebay.com/itm/123",
        price: { value: "250", currency: "USD" },
        condition: "Used",
        seller: { feedbackPercentage: "98.5" },
      }],
    });

    expect(rows[0].category).toBe("electronics");
    expect(rows[0].sellerRisk).toBeLessThan(10);
  });

  test("search API rejects unauthenticated users", async () => {
    const handler = createApiHandler({
      repository: {},
      ingestion: { run: async () => [] },
      env: {},
    });

    const response = await handler(new Request("http://localhost/api/search?q=car"));

    expect(response.status).toBe(401);
  });

  test("search API rejects authenticated users without beta invite", async () => {
    const handler = createApiHandler({
      repository: {
        verifyAccessToken: async () => ({ id: "user-1", email: "blocked@example.com" }),
        claimBetaInvite: async () => {
          const error = new Error("Beta invite required.");
          error.status = 403;
          throw error;
        },
      },
      ingestion: { run: async () => [] },
      env: {},
    });

    const response = await handler(new Request("http://localhost/api/search?q=car", {
      headers: { authorization: "Bearer token" },
    }));

    expect(response.status).toBe(403);
  });

  test("search API returns five database-backed ranked results for beta users", async () => {
    const handler = createApiHandler({
      repository: {
        verifyAccessToken: async () => ({ id: "user-1", email: "beta@example.com" }),
        claimBetaInvite: async () => ({ email: "beta@example.com" }),
        searchableListings: async () => listings,
        recordSearchEvent: async () => undefined,
      },
      ingestion: { run: async () => [] },
      env: {},
    });

    const response = await handler(new Request("http://localhost/api/search?q=cheap%20family%20car", {
      headers: { authorization: "Bearer token" },
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results).toHaveLength(5);
    expect(payload.results[0].listing.category).toBe("car");
  });

  test("ingest API rejects invalid admin token", async () => {
    const handler = createApiHandler({
      repository: {},
      ingestion: { run: async () => [{ sourceKey: "manual_csv", status: "complete" }] },
      env: { INGEST_ADMIN_TOKEN: "secret" },
    });

    const response = await handler(new Request("http://localhost/api/ingest/run", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    }));

    expect(response.status).toBe(401);
  });
});
