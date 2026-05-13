import { readFile } from "node:fs/promises";
import { inferCategoryFromText, normalizeCategory } from "./listing-mapper.js";

const DEFAULT_HEADERS = {
  "user-agent": "TradeoffSearchBot/0.1 (+https://example.com; beta ingestion)",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
};

export function createIngestionService({ env = process.env, fetchImpl = fetch, repository } = {}) {
  const adapters = [
    createOlxAdapter(env, fetchImpl),
    createMobil123Adapter(env, fetchImpl),
    createManualCsvAdapter(env),
    createEbayAdapter(env, fetchImpl),
    createRumah123PartnerAdapter(env, fetchImpl),
  ];

  return {
    adapters,

    async run({ only = null } = {}) {
      const selected = only ? adapters.filter((adapter) => adapter.key === only) : adapters;
      const summaries = [];

      for (const adapter of selected) {
        if (!adapter.enabled) {
          summaries.push({ sourceKey: adapter.key, status: "skipped", fetchedCount: 0, upsertedCount: 0 });
          continue;
        }

        let run = null;
        try {
          run = repository ? await repository.startIngestionRun(adapter.key, adapter.metadata || {}) : null;
          const listings = await adapter.fetchListings();
          const upserted = repository ? await repository.upsertListings(adapter, listings) : listings;
          if (repository && run) {
            await repository.finishIngestionRun(run.id, {
              status: "complete",
              fetched_count: listings.length,
              upserted_count: upserted.length,
            });
          }
          summaries.push({
            sourceKey: adapter.key,
            status: "complete",
            fetchedCount: listings.length,
            upsertedCount: upserted.length,
          });
        } catch (error) {
          if (repository && run) {
            await repository.finishIngestionRun(run.id, {
              status: "failed",
              error_message: error.message,
            });
          }
          summaries.push({ sourceKey: adapter.key, status: "failed", error: error.message });
        }
      }

      return summaries;
    },
  };
}

export function normalizeOlxHtml(html, sourceUrl) {
  return extractJsonLdItems(html)
    .map((item) => normalizeGenericMarketplaceItem(item, {
      sourceName: "OLX Indonesia",
      sourceUrlFallback: sourceUrl,
    }))
    .filter(Boolean);
}

export function normalizeMobil123Html(html, sourceUrl) {
  return extractJsonLdItems(html)
    .map((item) => normalizeGenericMarketplaceItem(item, {
      sourceName: "Mobil123",
      sourceUrlFallback: sourceUrl,
      category: "car",
    }))
    .filter(Boolean);
}

export function normalizeEbayItems(payload) {
  const items = payload?.itemSummaries || payload?.items || [];
  return items.map((item) => {
    const price = Number(item.price?.value || item.currentBidPrice?.value || 0);
    if (!item.itemWebUrl || !item.title || !price) return null;
    const category = inferCategoryFromText(`${item.title} ${item.categories?.map((cat) => cat.categoryName).join(" ") || ""}`);
    return {
      id: item.itemId,
      sourceListingId: item.itemId,
      sourceName: "eBay",
      sourceUrl: item.itemAffiliateWebUrl || item.itemWebUrl,
      title: item.title,
      description: item.shortDescription || "",
      category,
      price: Math.round(price),
      currency: item.price?.currency || "USD",
      location: [item.itemLocation?.city, item.itemLocation?.country].filter(Boolean).join(", ") || "Online",
      condition: conditionFromText(item.condition),
      sellerRisk: item.seller?.feedbackPercentage ? Math.max(8, 100 - Number(item.seller.feedbackPercentage)) : 26,
      imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || "",
      attributes: {
        conditionLabel: item.condition,
        buyingOptions: item.buyingOptions || [],
      },
      rawRecord: item,
    };
  }).filter(Boolean);
}

export function normalizeCsv(text, sourceName = "Manual import") {
  const rows = parseCsv(text);
  return rows.map((row) => {
    const price = parsePrice(row.price);
    if (!row.source_url || !row.title || !price) return null;
    return {
      sourceListingId: row.source_listing_id || row.id || row.source_url,
      sourceName: row.source_name || sourceName,
      sourceUrl: row.source_url,
      title: row.title,
      description: row.description || "",
      category: normalizeCategory(row.category || inferCategoryFromText(row.title)),
      price,
      currency: row.currency || "Rp",
      location: row.location || "Indonesia",
      condition: Number(row.condition || 72),
      sellerRisk: Number(row.seller_risk || 24),
      marketLow: Number(row.market_low || Math.round(price * 0.92)),
      marketHigh: Number(row.market_high || Math.round(price * 1.16)),
      imageUrl: row.image_url || "",
      attributes: compactObject({
        year: numeric(row.year),
        mileageKm: numeric(row.mileage_km),
        bedrooms: numeric(row.bedrooms),
        bathrooms: numeric(row.bathrooms),
        areaM2: numeric(row.area_m2),
        maintenanceCost: row.maintenance_cost || undefined,
      }),
      rawRecord: row,
    };
  }).filter(Boolean);
}

function createOlxAdapter(env, fetchImpl) {
  const urls = splitList(env.OLX_SEARCH_URLS || "https://www.olx.co.id/items/q-mobil-bekas,https://www.olx.co.id/items/q-motor-bekas,https://www.olx.co.id/items/q-laptop-bekas");
  return {
    key: "olx_indonesia",
    name: "OLX Indonesia",
    adapter: "public-html",
    homepageUrl: "https://www.olx.co.id/",
    termsUrl: "https://help.olx.co.id/hc/id/articles/206444513-Ketentuan-Umum",
    enabled: env.INGEST_OLX_ENABLED === "1",
    crawlDelaySeconds: Number(env.OLX_CRAWL_DELAY_SECONDS || 12),
    async fetchListings() {
      const listings = [];
      for (const url of urls) {
        const html = await fetchText(url, fetchImpl);
        listings.push(...normalizeOlxHtml(html, url));
        await delay(this.crawlDelaySeconds * 1000);
      }
      return dedupeBySourceUrl(listings);
    },
  };
}

function createMobil123Adapter(env, fetchImpl) {
  const urls = splitList(env.MOBIL123_SEARCH_URLS || "https://www.mobil123.com/mobil-dijual/indonesia");
  return {
    key: "mobil123",
    name: "Mobil123",
    adapter: "public-html",
    homepageUrl: "https://www.mobil123.com/",
    enabled: env.INGEST_MOBIL123_ENABLED === "1",
    crawlDelaySeconds: Number(env.MOBIL123_CRAWL_DELAY_SECONDS || 12),
    async fetchListings() {
      const listings = [];
      for (const url of urls) {
        const html = await fetchText(url, fetchImpl);
        listings.push(...normalizeMobil123Html(html, url));
        await delay(this.crawlDelaySeconds * 1000);
      }
      return dedupeBySourceUrl(listings);
    },
  };
}

function createManualCsvAdapter(env) {
  return {
    key: "manual_csv",
    name: "Manual CSV",
    adapter: "csv",
    enabled: Boolean(env.MANUAL_IMPORT_CSV_PATH),
    crawlDelaySeconds: 0,
    async fetchListings() {
      const text = await readFile(env.MANUAL_IMPORT_CSV_PATH, "utf8");
      return normalizeCsv(text, "Manual CSV");
    },
  };
}

function createEbayAdapter(env, fetchImpl) {
  return {
    key: "ebay_browse",
    name: "eBay Browse API",
    adapter: "official-api",
    homepageUrl: "https://developer.ebay.com/api-docs/buy/browse/overview.html",
    enabled: Boolean(env.EBAY_ACCESS_TOKEN),
    crawlDelaySeconds: 2,
    async fetchListings() {
      const queries = splitList(env.EBAY_SEARCH_QUERIES || "used laptop,used sofa,used motorcycle accessories");
      const listings = [];
      for (const query of queries) {
        const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
        url.searchParams.set("q", query);
        url.searchParams.set("filter", "conditions:{USED|LIKE_NEW|VERY_GOOD|GOOD}");
        url.searchParams.set("limit", env.EBAY_SEARCH_LIMIT || "25");
        const response = await fetchImpl(url, {
          headers: {
            authorization: `Bearer ${env.EBAY_ACCESS_TOKEN}`,
            accept: "application/json",
          },
        });
        if (!response.ok) throw new Error(`eBay Browse API failed with HTTP ${response.status}`);
        listings.push(...normalizeEbayItems(await response.json()));
        await delay(this.crawlDelaySeconds * 1000);
      }
      return dedupeBySourceUrl(listings);
    },
  };
}

function createRumah123PartnerAdapter(env, fetchImpl) {
  return {
    key: "rumah123_partner",
    name: "Rumah123 Partner API",
    adapter: "partner-api",
    homepageUrl: "https://www.rumah123.com/",
    termsUrl: "https://www.rumah123.com/en/terms-of-use/",
    enabled: Boolean(env.RUMAH123_PARTNER_FEED_URL && env.RUMAH123_PARTNER_TOKEN),
    crawlDelaySeconds: 5,
    async fetchListings() {
      const response = await fetchImpl(env.RUMAH123_PARTNER_FEED_URL, {
        headers: {
          authorization: `Bearer ${env.RUMAH123_PARTNER_TOKEN}`,
          accept: "application/json",
        },
      });
      if (!response.ok) throw new Error(`Rumah123 partner feed failed with HTTP ${response.status}`);
      const payload = await response.json();
      const items = payload.items || payload.listings || [];
      return items.map((item) => normalizeGenericMarketplaceItem(item, {
        sourceName: "Rumah123 Partner",
        category: "house",
      })).filter(Boolean);
    },
  };
}

function normalizeGenericMarketplaceItem(item, options = {}) {
  const title = item.name || item.title || item.headline;
  const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  const price = parsePrice(offer?.price || item.price || item.priceSpecification?.price);
  const sourceUrl = absoluteUrl(item.url || item.itemUrl || item.link, options.sourceUrlFallback);
  if (!title || !price || !sourceUrl) return null;

  const category = normalizeCategory(options.category || item.category || inferCategoryFromText(`${title} ${item.description || ""}`));
  const location = typeof item.address === "string"
    ? item.address
    : [item.address?.addressLocality, item.address?.addressRegion, item.itemLocation?.city].filter(Boolean).join(", ");

  return {
    sourceListingId: item.sku || item.productID || item.id || sourceUrl,
    sourceName: options.sourceName || "Internet listing",
    sourceUrl,
    title,
    description: item.description || "",
    category,
    price,
    currency: offer?.priceCurrency || item.priceCurrency || "Rp",
    location: location || "Indonesia",
    condition: conditionFromText(item.itemCondition || item.condition || item.description),
    sellerRisk: 28,
    imageUrl: Array.isArray(item.image) ? item.image[0] : item.image || "",
    attributes: attributesFromText(`${title} ${item.description || ""}`, category),
    rawRecord: item,
  };
}

function extractJsonLdItems(html) {
  const scripts = [...String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const items = [];
  for (const [, raw] of scripts) {
    const parsed = safeJson(stripHtmlEntities(raw));
    collectJsonLdItems(parsed, items);
  }
  return items;
}

function collectJsonLdItems(value, items) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdItems(item, items);
    return;
  }
  if (value["@graph"]) collectJsonLdItems(value["@graph"], items);
  if (value.itemListElement) collectJsonLdItems(value.itemListElement, items);
  if (value.item) collectJsonLdItems(value.item, items);
  const type = Array.isArray(value["@type"]) ? value["@type"].join(" ") : value["@type"];
  if (value.name && (value.offers || /product|vehicle|house|offer/i.test(String(type || "")))) {
    items.push(value);
  }
}

function attributesFromText(text, category) {
  const value = String(text || "").toLowerCase();
  const year = Number(value.match(/\b(20\d{2}|19\d{2})\b/)?.[1]);
  const mileageKm = Number(value.match(/\b(\d{2,3}(?:[.,]\d{3})?)\s*(?:km|kilometer)\b/)?.[1]?.replace(/[.,]/g, ""));
  const bedrooms = Number(value.match(/\b(\d+)\s*(?:br|bedroom|kamar)\b/)?.[1]);
  const areaM2 = Number(value.match(/\b(\d{2,4})\s*(?:m2|m²|meter)\b/)?.[1]);
  const base = compactObject({ year, mileageKm, bedrooms, areaM2 });
  if (category === "car") return { ...base, maintenanceCost: "medium", seats: value.includes("mpv") ? 7 : 5 };
  if (category === "motorcycle") return { ...base, maintenanceCost: "low", paperwork: "unknown" };
  if (category === "house") return { ...base, bathrooms: 1 };
  return base;
}

function conditionFromText(text) {
  const value = String(text || "").toLowerCase();
  if (/like new|excellent|very good|terawat|mulus|renovated/.test(value)) return 86;
  if (/good|baik|normal|used/.test(value)) return 76;
  if (/repair|rusak|minus|parts/.test(value)) return 48;
  return 72;
}

function parseCsv(text) {
  const rows = [];
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return rows;
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
  }
  return rows;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function parsePrice(value) {
  if (typeof value === "number") return Math.round(value);
  const raw = String(value || "").toLowerCase().replace(/rp|idr|usd|\$|\s/g, "");
  const normalized = normalizeNumericText(raw);
  const match = normalized.match(/(\d+(?:\.\d+)?)(jt|juta|m|k)?/);
  if (!match) return 0;
  const suffix = match[2] || "";
  const multiplier = suffix === "jt" || suffix === "juta" || suffix === "m" ? 1000000 : suffix === "k" ? 1000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function normalizeNumericText(value) {
  const suffix = value.match(/(jt|juta|m|k)$/)?.[1] || "";
  const numeric = suffix ? value.slice(0, -suffix.length) : value;
  const separators = [...numeric.matchAll(/[.,]/g)].map((match) => match[0]);
  if (separators.length > 1) {
    return `${numeric.replace(/[.,]/g, "")}${suffix}`;
  }
  if (separators.length === 1) {
    const separator = separators[0];
    const [left, right] = numeric.split(separator);
    if (right?.length === 3 && left.length > 1) {
      return `${left}${right}${suffix}`;
    }
    return `${left}.${right || ""}${suffix}`;
  }
  return `${numeric}${suffix}`;
}

function splitList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripHtmlEntities(text) {
  return String(text || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) throw new Error(`${url} failed with HTTP ${response.status}`);
  return response.text();
}

function absoluteUrl(value, fallback) {
  if (!value) return fallback || "";
  try {
    return new URL(value, fallback || "https://www.olx.co.id/").toString();
  } catch {
    return String(value);
  }
}

function dedupeBySourceUrl(listings) {
  const seen = new Set();
  return listings.filter((listing) => {
    if (!listing.sourceUrl || seen.has(listing.sourceUrl)) return false;
    seen.add(listing.sourceUrl);
    return true;
  });
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "" && !Number.isNaN(entry)));
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
