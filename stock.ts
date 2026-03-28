/**
 * Gstack Stock Checker (Wedge 1)
 * Simple, fast CLI to check a stock's current price and daily performance.
 * Usage: bun run stock.ts <TICKER> (e.g., bun run stock.ts TSLA)
 */

const ticker = (process.argv[2] || "AAPL").toUpperCase();

async function getStockPrice(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
  
  try {
    const response = await fetch(url);
    const data: any = await response.json();
    
    if (data.chart.error) {
      throw new Error(data.chart.error.description);
    }

    const result = data.chart.result[0];
    const meta = result.meta;
    const currentPrice = meta.regularMarketPrice;
    const previousClose = meta.previousClose;
    const change = currentPrice - previousClose;
    const changePercent = (change / previousClose) * 100;

    const color = change >= 0 ? "\x1b[32m" : "\x1b[31m"; // Green or Red
    const reset = "\x1b[0m";

    console.log(`\n📊 STOCK: ${symbol}`);
    console.log(`=========================`);
    console.log(`Current Price:  $${currentPrice.toFixed(2)}`);
    console.log(`Daily Change:   ${color}${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePercent.toFixed(2)}%)${reset}`);
    console.log(`Previous Close: $${previousClose.toFixed(2)}`);
    console.log(`=========================\n`);
    
  } catch (error: any) {
    console.error(`\n❌ Error fetching ${symbol}: ${error.message}\n`);
  }
}

getStockPrice(ticker);
