import { searchListings } from "./search-engine.js";

const form = document.querySelector("#search-form");
const input = document.querySelector("#search-input");
const resultsNode = document.querySelector("#results");
const interpretationNode = document.querySelector("#interpretation");
const resultTemplate = document.querySelector("#result-template");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  renderSearch(input.value);
});

for (const button of document.querySelectorAll("[data-query]")) {
  button.addEventListener("click", () => {
    input.value = button.dataset.query;
    renderSearch(input.value);
  });
}

renderSearch(input.value);

function renderSearch(query) {
  const { intent, results } = searchListings(query);
  interpretationNode.innerHTML = interpretationCopy(intent);
  resultsNode.replaceChildren(...results.map((result, index) => renderResult(result, index)));
}

function renderResult(result, index) {
  const node = resultTemplate.content.firstElementChild.cloneNode(true);
  const { listing, score } = result;
  node.querySelector(".rank").textContent = `#${index + 1}`;
  node.querySelector(".thumb").style.setProperty("--item-image", listing.image);
  node.querySelector(".category").textContent = listing.category;
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
  return node;
}

function interpretationCopy(intent) {
  const categories = intent.categoryHints.length ? intent.categoryHints.join(", ") : "mixed categories";
  const budget = intent.budget ? ` under ${intent.budget.max.toLocaleString()}` : "";
  const avoid = intent.mustAvoid.length ? ` Avoiding ${intent.mustAvoid.join(", ")}.` : "";

  return [
    `<strong>Interpreted as:</strong> ${intent.useCase}${budget}.`,
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

function conditionLabel(score) {
  if (score >= 84) return "very good condition";
  if (score >= 74) return "good condition";
  if (score >= 64) return "usable condition";
  return "inspect carefully";
}
