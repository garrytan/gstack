# Design Doc: Gstack Stock Checker (Wedge 1)

## 1. Demand Reality
- **User**: Individual investor (you) who wants to quickly check a stock's price and daily performance without opening a browser or a heavy app.
- **Pain**: Opening a browser, searching for a ticker, and navigating through ads/popups just to see a single number is high friction.

## 2. Status Quo
- Manual search on Google/Yahoo Finance. It takes ~30-60 seconds and constant context switching.

## 3. Desperate Specificity
- The single most painful part is getting a "clean" price and a "Up/Down" indicator in the terminal.

## 4. Narrowest Wedge
- A Bun script: `stock.ts`.
- It takes a ticker symbol as a command-line argument (e.g., `bun run stock.ts AAPL`).
- It uses a free, no-auth API (like `query1.finance.yahoo.com`) to fetch real-time data.
- It prints: `Ticker`, `Price`, `Change (%)`, and a `Color-coded indicator` (Green for up, Red for down).

## 5. Observation
- We know it's working if `bun run stock.ts TSLA` returns a valid price in < 2 seconds.

## 6. Future-Fit
- This evolves into a full "Portfolio Watcher" that can alert you via terminal notifications or even use `/browse` to scrape sentiment from news sites.

---

## Technical Implementation Plan
1. Use `fetch()` to call Yahoo Finance's v8 chart API.
2. Parse the JSON response for `regularMarketPrice` and `previousClose`.
3. Calculate the percentage change.
4. Use ANSI colors for the output.
