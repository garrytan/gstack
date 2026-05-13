import { listings } from "./data.js";

const CATEGORY_WORDS = {
  car: ["car", "mobil", "family car", "avanza", "brio", "xenia", "vehicle"],
  motorcycle: ["motorcycle", "motorbike", "bike", "scooter", "motor", "moto", "college", "commute"],
  house: ["house", "home", "rumah", "bedroom", "br", "school", "market", "near"],
  electronics: ["laptop", "macbook", "thinkpad", "computer", "design work", "electronics"],
  furniture: ["sofa", "furniture", "chair", "table", "home goods"],
};

const PRIORITY_WORDS = [
  { words: ["cheap", "cheapest", "lowest", "budget", "under", "below"], key: "price", boost: 0.38 },
  { words: ["deal", "undervalued", "below market"], key: "deal", boost: 0.24 },
  { words: ["safe", "reliable", "low risk", "inspection"], key: "risk", boost: 0.28 },
  { words: ["condition", "clean", "newer", "renovated"], key: "condition", boost: 0.24 },
  { words: ["near", "nearby", "close", "school", "market"], key: "location", boost: 0.24 },
  { words: ["family", "daily", "college", "commute", "design work", "fuel efficient", "low maintenance"], key: "need", boost: 0.34 },
];

const DEFAULT_WEIGHTS = {
  needFit: 0.28,
  priceFit: 0.24,
  dealFit: 0.18,
  conditionFit: 0.14,
  riskFit: 0.1,
  locationFit: 0.06,
};

export function searchListings(query, source = listings) {
  const intent = parseQuery(query);
  const scored = source
    .map((listing) => scoreListing(listing, intent))
    .sort((a, b) => b.score.total - a.score.total || a.listing.price - b.listing.price)
    .slice(0, 5);

  return {
    intent,
    results: scored,
  };
}

export function parseQuery(query) {
  const raw = String(query || "").trim();
  const normalized = raw.toLowerCase();
  const budget = extractBudget(normalized);
  const categoryHints = Object.entries(CATEGORY_WORDS)
    .filter(([, words]) => words.some((word) => normalized.includes(word)))
    .map(([category]) => category);
  const priorities = {
    price: normalized ? 0.55 : 0.45,
    deal: 0.45,
    need: normalized ? 0.62 : 0.5,
    condition: 0.48,
    risk: 0.46,
    location: 0.36,
  };

  for (const priority of PRIORITY_WORDS) {
    if (priority.words.some((word) => normalized.includes(word))) {
      priorities[priority.key] += priority.boost;
    }
  }

  const useCase = inferUseCase(normalized);
  const mustAvoid = [];
  if (normalized.includes("low maintenance")) mustAvoid.push("high maintenance");
  if (normalized.includes("low mileage")) mustAvoid.push("high mileage");
  if (normalized.includes("fuel efficient")) mustAvoid.push("poor fuel economy");
  if (normalized.includes("safe")) mustAvoid.push("high risk sellers");

  return {
    raw,
    normalized,
    budget,
    categoryHints,
    priorities: normalizePriorityObject(priorities),
    useCase,
    mustAvoid,
  };
}

export function scoreListing(listing, intent) {
  const scorer = getCategoryScorer(listing.category);
  const parts = scorer(listing, intent);
  const weights = weightsForIntent(intent);
  const baseTotal = Math.round(
    parts.needFit * weights.needFit +
      parts.priceFit * weights.priceFit +
      parts.dealFit * weights.dealFit +
      parts.conditionFit * weights.conditionFit +
      parts.riskFit * weights.riskFit +
      parts.locationFit * weights.locationFit,
  );
  const total = baseTotal + categoryTotalAdjustment(listing, intent);

  return {
    listing,
    score: {
      ...parts,
      total: clamp(total),
    },
  };
}

function categoryTotalAdjustment(listing, intent) {
  if (intent.categoryHints.length === 0) return 0;
  return intent.categoryHints.includes(listing.category) ? 8 : -24;
}

function getCategoryScorer(category) {
  if (category === "car") return scoreCar;
  if (category === "motorcycle") return scoreMotorcycle;
  if (category === "house") return scoreHouse;
  return scoreGeneralGoods;
}

function scoreCar(listing, intent) {
  const attrs = listing.attributes;
  const priceFit = scorePrice(listing, intent);
  const dealFit = scoreDeal(listing);
  const mileageScore = inverseScale(attrs.mileageKm, 35000, 150000);
  const maintenanceScore = maintenanceScoreFor(attrs.maintenanceCost);
  const categoryBoost = categoryBoostFor(listing, intent);
  const needFit = average([
    attrs.reliability,
    attrs.fuelEfficiency,
    maintenanceScore,
    intent.normalized.includes("family") ? attrs.familyFit : 72,
    intent.normalized.includes("family") ? scale(attrs.seats, 4, 7) : 70,
    categoryBoost,
  ]);
  const conditionFit = average([listing.condition, mileageScore, scale(attrs.year, 2012, 2022)]);
  const riskFit = average([100 - listing.sellerRisk, maintenanceScore, mileageScore]);
  const locationFit = locationScore(listing, intent);
  const reasons = [
    `${attrs.seats} seats and ${attrs.maintenanceCost} maintenance fit the buyer need better than a raw-cheapest car.`,
    `${formatMoney(listing)} sits ${dealFit >= 75 ? "below" : "near"} the seeded market estimate.`,
    `${attrs.mileageKm.toLocaleString()} km keeps the condition score at ${Math.round(conditionFit)}, so inspection still matters.`,
  ];

  return {
    priceFit,
    needFit,
    conditionFit,
    riskFit,
    locationFit,
    dealFit,
    tradeoff:
      conditionFit < 76
        ? "Cheaper family fit, but age and mileage create the main inspection risk."
        : "Best compromise between family utility, maintenance cost, and staying near budget.",
    reasons,
  };
}

function scoreMotorcycle(listing, intent) {
  const attrs = listing.attributes;
  const priceFit = scorePrice(listing, intent);
  const dealFit = scoreDeal(listing);
  const maintenanceScore = maintenanceScoreFor(attrs.maintenanceCost);
  const categoryBoost = categoryBoostFor(listing, intent);
  const needFit = average([
    attrs.commuteFit,
    attrs.fuelEfficiency,
    maintenanceScore,
    attrs.engineHealth,
    categoryBoost,
  ]);
  const mileageScore = inverseScale(attrs.mileageKm, 12000, 52000);
  const conditionFit = average([listing.condition, attrs.engineHealth, mileageScore]);
  const riskFit = average([
    100 - listing.sellerRisk,
    attrs.paperwork === "complete" ? 90 : 50,
    attrs.engineHealth,
  ]);
  const locationFit = locationScore(listing, intent);
  const reasons = [
    `${attrs.fuelEfficiency}/100 fuel fit is strong for daily commuting.`,
    `${attrs.maintenanceCost} maintenance protects the total cost after purchase.`,
    `${attrs.paperwork} paperwork keeps the ownership-risk score at ${Math.round(riskFit)}.`,
  ];

  return {
    priceFit,
    needFit,
    conditionFit,
    riskFit,
    locationFit,
    dealFit,
    tradeoff:
      listing.price > 20000
        ? "More expensive than the cheapest scooters, but safer for daily use."
        : "Very cheap commute fit, with engine condition as the tradeoff to inspect.",
    reasons,
  };
}

function scoreHouse(listing, intent) {
  const attrs = listing.attributes;
  const priceFit = scorePrice(listing, intent);
  const dealFit = scoreDeal(listing);
  const nearSchool = inverseScale(attrs.schoolDistanceKm, 0.2, 2.5);
  const nearMarket = inverseScale(attrs.marketDistanceKm, 0.2, 2.5);
  const spaceFit = average([scale(attrs.bedrooms, 1, 3), scale(attrs.areaM2, 45, 110), attrs.familyFit]);
  const needFit = average([
    spaceFit,
    intent.normalized.includes("school") ? nearSchool : 65,
    intent.normalized.includes("market") ? nearMarket : 65,
    categoryBoostFor(listing, intent),
  ]);
  const conditionFit = average([listing.condition, 100 - attrs.renovationRisk]);
  const riskFit = average([100 - listing.sellerRisk, 100 - attrs.floodRisk, 100 - attrs.renovationRisk]);
  const locationFit = average([nearSchool, nearMarket]);
  const reasons = [
    `${attrs.bedrooms}BR and ${attrs.areaM2} m2 score as a practical starter-home fit.`,
    `${attrs.schoolDistanceKm} km to school and ${attrs.marketDistanceKm} km to market support the location request.`,
    `Renovation risk is ${attrs.renovationRisk}/100, which is the main sacrifice behind the price.`,
  ];

  return {
    priceFit,
    needFit,
    conditionFit,
    riskFit,
    locationFit,
    dealFit,
    tradeoff:
      attrs.renovationRisk > 35
        ? "Lowest housing price, but repair risk explains why it is cheap."
        : "Good livability for the price, with location doing most of the ranking work.",
    reasons,
  };
}

function scoreGeneralGoods(listing, intent) {
  const attrs = listing.attributes;
  const priceFit = scorePrice(listing, intent);
  const dealFit = scoreDeal(listing);
  const designFit = attrs.designWorkFit || 55;
  const homeFit = attrs.homeFit || 55;
  const ageFit = inverseScale(attrs.ageYears || 4, 1, 8);
  const categoryBoost = categoryBoostFor(listing, intent);
  const needFit = average([
    intent.normalized.includes("design") ? designFit : attrs.usefulness || homeFit,
    attrs.performance || attrs.usefulness || homeFit,
    attrs.portability || 60,
    categoryBoost,
  ]);
  const conditionFit = average([listing.condition, attrs.batteryHealth || 78, 100 - (attrs.cosmeticWear || 18), ageFit]);
  const riskFit = average([100 - listing.sellerRisk, attrs.warranty ? 88 : 66, conditionFit]);
  const locationFit = locationScore(listing, intent);
  const reasons = [
    `${Math.round(needFit)}/100 need fit comes from category-specific usefulness, not keyword match alone.`,
    `${formatMoney(listing)} is ${dealFit >= 75 ? "meaningfully below" : "close to"} the market estimate.`,
    `${Math.round(riskFit)}/100 risk score reflects condition, seller risk, and warranty weakness.`,
  ];

  return {
    priceFit,
    needFit,
    conditionFit,
    riskFit,
    locationFit,
    dealFit,
    tradeoff:
      listing.category === "electronics"
        ? "Better work fit than cheaper devices, but battery and warranty are the tradeoff."
        : "Strong discount for the home-use fit, but pickup effort keeps it from being perfect.",
    reasons,
  };
}

function weightsForIntent(intent) {
  const weights = { ...DEFAULT_WEIGHTS };
  weights.priceFit += intent.priorities.price * 0.08;
  weights.dealFit += intent.priorities.deal * 0.05;
  weights.needFit += intent.priorities.need * 0.07;
  weights.conditionFit += intent.priorities.condition * 0.04;
  weights.riskFit += intent.priorities.risk * 0.04;
  weights.locationFit += intent.priorities.location * 0.05;

  const sum = Object.values(weights).reduce((total, value) => total + value, 0);
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / sum]));
}

function scorePrice(listing, intent) {
  if (!intent.budget) {
    return clamp(72 + scoreDeal(listing) * 0.18 - listing.price / Math.max(listing.marketHigh, listing.price) * 12);
  }

  if (listing.price <= intent.budget.max) {
    const headroom = (intent.budget.max - listing.price) / intent.budget.max;
    return clamp(72 + headroom * 32);
  }

  const over = (listing.price - intent.budget.max) / intent.budget.max;
  return clamp(68 - over * 85);
}

function scoreDeal(listing) {
  const midpoint = (listing.marketLow + listing.marketHigh) / 2;
  const discount = (midpoint - listing.price) / midpoint;
  return clamp(58 + discount * 190);
}

function categoryBoostFor(listing, intent) {
  if (intent.categoryHints.length === 0) return 64;
  if (intent.categoryHints.includes(listing.category)) return 100;
  if (listing.category === "electronics" && intent.categoryHints.includes("furniture")) return 28;
  if (listing.category === "furniture" && intent.categoryHints.includes("electronics")) return 28;
  return 34;
}

function locationScore(listing, intent) {
  if (!intent.normalized.includes("near") && !intent.normalized.includes("jakarta")) return 62;
  if (intent.normalized.includes("jakarta") && listing.location.toLowerCase().includes("jakarta")) return 88;
  return 68;
}

function extractBudget(text) {
  const underMatch = text.match(/\b(?:under|below|max|budget)\s*(?:rp|idr|\$)?\s*(\d+(?:[.,]\d+)?)(k|m|jt|juta)?\b/i);
  const looseMatch = text.match(/\b(\d+(?:[.,]\d+)?)(k|m|jt|juta)\b/i);
  const match = underMatch || looseMatch;
  if (!match) return null;

  const value = Number(match[1].replace(",", "."));
  const suffix = (match[2] || "").toLowerCase();
  let multiplier = 1;
  if (suffix === "k") multiplier = 1000;
  if (suffix === "m" || suffix === "jt" || suffix === "juta") multiplier = 1000000;

  return {
    max: Math.round(value * multiplier),
    strictness: underMatch ? 0.85 : 0.55,
  };
}

function inferUseCase(text) {
  if (!text) return "balanced second-hand deal";
  if (text.includes("family")) return "family daily use";
  if (text.includes("college") || text.includes("commute") || text.includes("daily")) return "daily commute";
  if (text.includes("school") || text.includes("market")) return "livable location";
  if (text.includes("design")) return "design work";
  if (text.includes("cheap") || text.includes("lowest")) return "lowest acceptable price";
  return "balanced second-hand deal";
}

function normalizePriorityObject(values) {
  const max = Math.max(...Object.values(values));
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round(value / max, 2)]));
}

function formatMoney(listing) {
  return `${listing.currency} ${listing.price.toLocaleString()}`;
}

function maintenanceScoreFor(level) {
  if (level === "low") return 92;
  if (level === "medium") return 68;
  return 42;
}

function average(values) {
  return clamp(values.reduce((total, value) => total + value, 0) / values.length);
}

function scale(value, min, max) {
  return clamp(((value - min) / (max - min)) * 100);
}

function inverseScale(value, best, worst) {
  return clamp(100 - ((value - best) / (worst - best)) * 100);
}

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
