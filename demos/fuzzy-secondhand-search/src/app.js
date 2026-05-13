import { searchListings } from "./search-engine.js";
import { listings as demoListings } from "./data.js";

const form = document.querySelector("#search-form");
const input = document.querySelector("#search-input");
const resultsNode = document.querySelector("#results");
const interpretationNode = document.querySelector("#interpretation");
const resultTemplate = document.querySelector("#result-template");
const authForm = document.querySelector("#auth-form");
const emailInput = document.querySelector("#email-input");
const authStatus = document.querySelector("#auth-status");
const appStatus = document.querySelector("#app-status");
const saveSearchButton = document.querySelector("#save-search");

const session = loadSession();
const config = await loadConfig();

if (config.authEnabled && !session.accessToken) {
  setLockedState("Sign in with an invited email to search live listings.");
} else {
  setUnlockedState();
  renderSearch(input.value);
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await requestLogin(emailInput.value);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  renderSearch(input.value);
});

saveSearchButton.addEventListener("click", async () => {
  await saveSearch(input.value);
});

for (const button of document.querySelectorAll("[data-query]")) {
  button.addEventListener("click", () => {
    input.value = button.dataset.query;
    renderSearch(input.value);
  });
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Config unavailable");
    return await response.json();
  } catch {
    return { authEnabled: false };
  }
}

async function requestLogin(email) {
  const value = String(email || "").trim().toLowerCase();
  authStatus.textContent = "Checking invite...";
  try {
    const response = await fetch("/api/auth/request-otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: value, redirectTo: window.location.origin }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Login failed.");
    authStatus.textContent = "Magic link sent. Open it, then paste the Supabase access token into local storage for this beta build.";
  } catch (error) {
    authStatus.textContent = error.message;
  }
}

async function renderSearch(query) {
  setBusy(true);
  try {
    const payload = config.authEnabled ? await liveSearch(query) : searchListings(query, demoListings);
    interpretationNode.innerHTML = interpretationCopy(payload.intent, config.authEnabled);
    if (payload.results.length === 0) {
      resultsNode.replaceChildren(emptyState("No fresh listings match yet. Try a broader query or run ingestion."));
    } else {
      resultsNode.replaceChildren(...payload.results.map((result, index) => renderResult(result, index)));
    }
  } catch (error) {
    interpretationNode.textContent = error.message;
    resultsNode.replaceChildren(emptyState("Search is unavailable. Check login, Supabase env vars, or ingestion status."));
  } finally {
    setBusy(false);
  }
}

async function liveSearch(query) {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`/api/search?${params}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${session.accessToken}`,
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Search failed.");
  return payload;
}

async function saveSearch(query) {
  if (!config.authEnabled) {
    appStatus.textContent = "Saved searches require Supabase live mode.";
    return;
  }

  try {
    const response = await fetch("/api/saved-searches", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({ query, cadence: "daily" }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not save search.");
    appStatus.textContent = "Saved. Daily alerts can use this query.";
  } catch (error) {
    appStatus.textContent = error.message;
  }
}

function renderResult(result, index) {
  const node = resultTemplate.content.firstElementChild.cloneNode(true);
  const { listing, score } = result;
  node.querySelector(".rank").textContent = `#${index + 1}`;
  node.querySelector(".thumb").style.setProperty("--item-image", listing.image);
  node.querySelector(".category").textContent = `${listing.category}${listing.sourceName ? ` • ${listing.sourceName}` : ""}`;
  node.querySelector("h2").textContent = listing.title;
  node.querySelector(".score-pill").textContent = `${score.total}/100`;
  node.querySelector(".meta-row").replaceChildren(
    meta(`${listing.currency} ${listing.price.toLocaleString()}`),
    meta(listing.location),
    meta(conditionLabel(listing.condition)),
  );
  node.querySelector(".tradeoff").textContent = score.tradeoff;
  node.querySelector(".chips").replaceChildren(
    chip("Price", score.priceFit),
    chip("Need", score.needFit),
    chip("Risk", score.riskFit),
    chip("Deal", score.dealFit),
  );
  node.querySelector(".reasons").replaceChildren(...score.reasons.map((reason) => reasonItem(reason)));
  const sourceLink = node.querySelector(".source-link");
  if (listing.sourceUrl) {
    sourceLink.href = listing.sourceUrl;
    sourceLink.textContent = "View source";
  } else {
    sourceLink.remove();
  }
  return node;
}

function interpretationCopy(intent, liveMode) {
  const categories = intent.categoryHints.length ? intent.categoryHints.join(", ") : "mixed categories";
  const budget = intent.budget ? ` under ${intent.budget.max.toLocaleString()}` : "";
  const avoid = intent.mustAvoid.length ? ` Avoiding ${intent.mustAvoid.join(", ")}.` : "";
  const mode = liveMode ? "Live Supabase listings" : "Demo seed listings";

  return [
    `<strong>${mode} interpreted as:</strong> ${intent.useCase}${budget}.`,
    `Scoring ${categories} by cheapest acceptable fit, then explaining the tradeoff behind each rank.`,
    avoid,
  ].join(" ");
}

function chip(label, value) {
  const node = document.createElement("div");
  node.className = "chip";
  node.innerHTML = `<strong>${Math.round(value)}</strong>${label}`;
  return node;
}

function meta(text) {
  const node = document.createElement("span");
  node.textContent = text;
  return node;
}

function reasonItem(text) {
  const node = document.createElement("li");
  node.textContent = text;
  return node;
}

function emptyState(text) {
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = text;
  return node;
}

function conditionLabel(score) {
  if (score >= 84) return "very good condition";
  if (score >= 74) return "good condition";
  if (score >= 64) return "usable condition";
  return "inspect carefully";
}

function loadSession() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("access_token")
    || window.localStorage.getItem("tradeoff_access_token")
    || "";
  if (token) window.localStorage.setItem("tradeoff_access_token", token);
  return { accessToken: token };
}

function setLockedState(message) {
  form.querySelector("button").disabled = true;
  input.disabled = true;
  saveSearchButton.disabled = true;
  appStatus.textContent = message;
  interpretationNode.textContent = "Invite-only beta access protects the first 100-user rollout.";
  resultsNode.replaceChildren(emptyState("Sign in before searching live second-hand listings."));
}

function setUnlockedState() {
  form.querySelector("button").disabled = false;
  input.disabled = false;
  saveSearchButton.disabled = false;
  appStatus.textContent = config.authEnabled ? "Live mode: Supabase-backed beta search." : "Demo mode: configure Supabase env vars for live beta search.";
}

function setBusy(isBusy) {
  form.querySelector("button").disabled = isBusy || (config.authEnabled && !session.accessToken);
  saveSearchButton.disabled = isBusy || (config.authEnabled && !session.accessToken);
}
