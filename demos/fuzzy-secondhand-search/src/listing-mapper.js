const CATEGORY_ALIASES = new Map([
  ["cars", "car"],
  ["auto", "car"],
  ["vehicle", "car"],
  ["motor", "motorcycle"],
  ["motorbike", "motorcycle"],
  ["bike", "motorcycle"],
  ["property", "house"],
  ["home", "house"],
  ["real_estate", "house"],
  ["goods", "electronics"],
]);

const FALLBACK_IMAGES = {
  car: "linear-gradient(135deg, rgba(9,77,69,.15), rgba(9,77,69,.02))",
  motorcycle: "linear-gradient(135deg, rgba(15,107,95,.18), rgba(15,107,95,.03))",
  house: "linear-gradient(135deg, rgba(49,93,155,.16), rgba(49,93,155,.02))",
  electronics: "linear-gradient(135deg, rgba(24,32,31,.13), rgba(24,32,31,.02))",
  furniture: "linear-gradient(135deg, rgba(185,109,22,.16), rgba(185,109,22,.02))",
};

export function dbRowToListing(row) {
  const category = normalizeCategory(row.category);
  const price = Number(row.price || 0);
  const marketLow = Number(row.market_low || row.marketLow || Math.round(price * 0.92));
  const marketHigh = Number(row.market_high || row.marketHigh || Math.round(price * 1.16));
  const imageUrl = row.image_url || row.imageUrl || "";
  const gradient = row.image_gradient || row.imageGradient || FALLBACK_IMAGES[category] || FALLBACK_IMAGES.electronics;

  return {
    id: String(row.id || row.source_listing_id || row.source_url),
    category,
    title: row.title || "Untitled listing",
    description: row.description || "",
    price,
    currency: row.currency || "Rp",
    location: row.location || "Indonesia",
    condition: clampNumber(row.condition, 35, 100, 72),
    sellerRisk: clampNumber(row.seller_risk ?? row.sellerRisk, 0, 100, 28),
    marketLow,
    marketHigh,
    image: imageUrl ? `${gradient}, url('${imageUrl}')` : gradient,
    sourceName: row.source_name || row.sourceName || "Internet listing",
    sourceUrl: row.source_url || row.sourceUrl || "",
    seenAt: row.seen_at || row.seenAt || null,
    staleAfter: row.stale_after || row.staleAfter || null,
    attributes: row.attributes || {},
  };
}

export function normalizedListingToDbRow(listing, sourceId = null) {
  const category = normalizeCategory(listing.category);
  const price = Math.max(0, Math.round(Number(listing.price || 0)));
  const now = new Date().toISOString();

  return {
    id: listing.id || stableListingId(listing),
    source_id: sourceId,
    source_listing_id: listing.sourceListingId || listing.id || null,
    source_url: listing.sourceUrl,
    source_name: listing.sourceName,
    category,
    title: listing.title,
    description: listing.description || null,
    price,
    currency: listing.currency || "Rp",
    location: listing.location || "Indonesia",
    condition: clampNumber(listing.condition, 35, 100, 72),
    seller_risk: clampNumber(listing.sellerRisk, 0, 100, 28),
    market_low: Math.round(Number(listing.marketLow || price * 0.92)),
    market_high: Math.round(Number(listing.marketHigh || price * 1.16)),
    image_url: listing.imageUrl || null,
    image_gradient: listing.imageGradient || FALLBACK_IMAGES[category] || FALLBACK_IMAGES.electronics,
    attributes: listing.attributes || {},
    raw_record: listing.rawRecord || {},
    status: listing.status || "active",
    seen_at: listing.seenAt || now,
    stale_after: listing.staleAfter || daysFromNow(14),
  };
}

export function normalizeCategory(category) {
  const normalized = String(category || "electronics").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliased = CATEGORY_ALIASES.get(normalized) || normalized;
  if (["car", "motorcycle", "house", "electronics", "furniture"].includes(aliased)) return aliased;
  return "electronics";
}

export function inferCategoryFromText(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(motor|motorcycle|scooter|nmax|vario|beat|yamaha|vespa)\b/.test(value)) return "motorcycle";
  if (/\b(avanza|brio|xenia|toyota|honda|daihatsu|suzuki|mobil|car|sedan|suv|mpv)\b/.test(value)) return "car";
  if (/\b(rumah|house|home|property|cluster|bedroom|kamar|tanah)\b/.test(value)) return "house";
  if (/\b(sofa|chair|table|lemari|furniture|kursi|meja)\b/.test(value)) return "furniture";
  return "electronics";
}

function stableListingId(listing) {
  const sourceUrl = String(listing.sourceUrl || "");
  const title = String(listing.title || "");
  const value = `${sourceUrl}|${title}|${listing.price || ""}`.toLowerCase();
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return `listing-${hash.toString(36)}`;
}

function daysFromNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
