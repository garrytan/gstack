/**
 * Gstack Stock Checker (Pro Version)
 * Custom Market Analysis matching the user-provided image.
 * Usage: bun run stock.ts <TICKER> (e.g., bun run stock.ts SPY)
 */

import { join } from "path";
import { homedir } from "os";
import { appendFile } from "fs/promises";

const ticker = (process.argv[2] || "SPY").toUpperCase();

async function logToAnalytics(symbol: string) {
  const logDir = join(homedir(), ".gstack", "analytics");
  const logPath = join(logDir, "skill-usage.jsonl");
  const entry = JSON.stringify({
    skill: "stock-analysis",
    ts: new Date().toISOString(),
    repo: "gstack",
    ticker: symbol
  }) + "\n";
  try {
    await appendFile(logPath, entry);
  } catch (e) {
    // Silent fail if analytics dir doesn't exist
  }
}

interface ChartData {
  prices: number[];
  timestamps: number[];
}

async function fetchHistoricalData(symbol: string, interval: string, range: string): Promise<ChartData> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const response = await fetch(url);
  const data: any = await response.json();
  
  if (data.chart.error) {
    throw new Error(data.chart.error.description);
  }

  const result = data.chart.result[0];
  const prices = result.indicators.quote[0].close.filter((p: any) => p !== null);
  const timestamps = result.timestamp;
  
  return { prices, timestamps };
}

// ─── Technical Analysis Helpers ───────────────────────────────────

function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) return 0;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateStandardDeviation(prices: number[], period: number): number {
  if (prices.length < period) return 0;
  const slice = prices.slice(-period);
  const mean = calculateSMA(slice, period);
  const squareDiffs = slice.map(p => Math.pow(p - mean, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / period;
  return Math.sqrt(avgSquareDiff);
}

function calculateBollingerLower(prices: number[], period: number, stdDev: number = 2): number {
  const sma = calculateSMA(prices, period);
  const sd = calculateStandardDeviation(prices, period);
  return sma - (stdDev * sd);
}

// ─── Probability Heuristic ─────────────────────────────────────────
// Simple trend-based "probability" based on price vs 20MA
function estimateProbability(price: number, ma20: number): { up: number; down: number } {
  if (price < ma20) return { up: 0, down: 100 };
  return { up: 100, down: 0 };
}

async function runAnalysis(symbol: string) {
  try {
    console.log(`📡 正在分析標普 500 (${symbol}) 綜合日線與 4 小時線數據，請稍候...`);

    // Log this analysis to gstack streak analytics
    await logToAnalytics(symbol);

    // Fetch Daily (1d) and 1h (to aggregate into 4h)
    const [dailyData, hourlyData] = await Promise.all([
      fetchHistoricalData(symbol, "1d", "1y"),
      fetchHistoricalData(symbol, "1h", "2mo")
    ]);

    // Aggregate 1h data into 4h candles
    const prices4h: number[] = [];
    for (let i = 0; i < hourlyData.prices.length; i += 4) {
      prices4h.push(hourlyData.prices[i]);
    }

    const currentPrice = dailyData.prices[dailyData.prices.length - 1];
    
    // Indicators (Daily)
    const d20MA = calculateSMA(dailyData.prices, 20);
    const d200MA = calculateSMA(dailyData.prices, 200);
    const dBB_Lower = calculateBollingerLower(dailyData.prices, 20);

    // Indicators (4H)
    const h20MA = calculateSMA(prices4h, 20);
    const h50MA = calculateSMA(prices4h, 50);
    const hBB_Lower = calculateBollingerLower(prices4h, 20);

    const prob = estimateProbability(currentPrice, d20MA);

    // Format output
    console.log(`\n📊 ${symbol} (S&P 500) 自訂大盤特化分析 📊`);
    console.log(`最新價格: $${currentPrice.toFixed(2)}`);
    console.log(`\n📈 今日上漲機率: ${prob.up}%`);
    console.log(`📉 今日下跌機率: ${prob.down}%`);

    console.log(`\n🧱 上方壓力位 (Resistance)`);
    console.log(`  └ 4H 20MA: $${h20MA.toFixed(2)}`);
    console.log(`  └ 日線 20MA: $${d20MA.toFixed(2)}`);
    console.log(`  └ 4H 50MA: $${h50MA.toFixed(2)}`);

    console.log(`\n🛡️ 下方支撐位 (Support)`);
    console.log(`  └ 日線 布林帶下軌: $${dBB_Lower.toFixed(2)}`);
    console.log(`  └ 4H 布林帶下軌: $${hBB_Lower.toFixed(2)}`);
    console.log(`  └ 日線 200MA: $${d200MA.toFixed(2)}\n`);

  } catch (error: any) {
    console.error(`\n❌ Error analyzing ${symbol}: ${error.message}\n`);
  }
}

runAnalysis(ticker);
