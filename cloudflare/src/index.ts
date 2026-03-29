type Env = {
  TELEGRAM_TOKEN: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  TELEGRAM_CHAT_ID?: string;
  WEBHOOK_SECRET?: string;
  PORTFOLIO?: string;
  RISK?: string;
  HORIZON?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
  };
  edited_message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat: { id: number };
    };
  };
};

function getToken(env: Env): string {
  return env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TOKEN || "";
}

function parseAllowedChatIds(env: Env): number[] {
  const raw = (env.TELEGRAM_ALLOWED_CHAT_IDS || env.TELEGRAM_CHAT_ID || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

function isAllowed(chatId: number, allowed: number[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.includes(chatId);
}

function normalizeTicker(raw: string): string {
  const t = raw.trim().toUpperCase();
  const aliases: Record<string, string> = {
    DXY: "DX-Y.NYB",
    SPX: "^GSPC",
    SP500: "^GSPC",
  };
  const aliased = aliases[t] || t;

  if (/^\d+$/.test(aliased)) {
    const n = aliased.replace(/^0+/, "");
    if (n.length > 0 && n.length <= 4) return n.padStart(4, "0") + ".HK";
    return aliased + ".HK";
  }
  return aliased;
}

function getSector(ticker: string): string {
  const t = ticker.toUpperCase();
  const map: Record<string, string> = {
    SPY: "ETF - US Equity",
    TSM: "Semiconductors",
    NVDA: "Semiconductors",
    AAPL: "Technology - Hardware",
    MSFT: "Technology - Software",
    GOOGL: "Technology - Internet",
    TCOM: "Consumer - Travel",
    MSTR: "Crypto Proxy",
    "0700.HK": "Technology - Internet",
    "9988.HK": "Technology - E-commerce",
    "1810.HK": "Technology - Hardware",
    "7226.HK": "ETF/Derivative",
  };
  return map[t] || (t.endsWith(".HK") ? "HK - Other" : "Other");
}

function parseCommand(text: string): { cmd: string; arg?: string } {
  const t = text.trim();
  if (!t.startsWith("/")) return { cmd: "ticker", arg: t };
  const parts = t.split(/\s+/);
  const cmd = parts[0].slice(1).toLowerCase();
  const arg = parts.slice(1).join(" ").trim() || undefined;
  return { cmd, arg };
}

function escapeText(s: string): string {
  return s.replace(/\u0000/g, "");
}

async function telegramApi(token: string, method: string, payload: any): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json<any>();
  if (!json.ok) throw new Error(json.description || "Telegram API error");
  return json.result;
}

type SendMessageOptions = { replyMarkup?: any };

function buildInlineActions(ticker: string) {
  const t = ticker.trim().toUpperCase();
  const summaryData = `S|${t}`.slice(0, 64);
  const fullData = `F|${t}`.slice(0, 64);
  const heatmapData = `HM|${t}`.slice(0, 64);
  return {
    inline_keyboard: [
      [
        { text: "🎯 Summary", callback_data: summaryData },
        { text: "📈 Full", callback_data: fullData },
      ],
      [{ text: "📋 Heatmap", callback_data: heatmapData }],
      [{ text: "❓ Help", callback_data: "HELP" }],
    ],
  };
}

function decodeCallbackData(data: string): string {
  const raw = (data || "").trim();
  if (!raw) return "/help";
  if (raw === "HELP") return "/help";
  if (raw === "HM") return "/heatmap";
  if (!raw.includes("|")) return raw;
  const [kind, rest] = raw.split("|");
  const payload = (rest || "").trim();
  if (kind === "S" && payload) return `/summary ${payload}`;
  if (kind === "F" && payload) return `/full ${payload}`;
  if (kind === "HM") return payload ? `/heatmap ${payload}` : "/heatmap";
  return raw;
}

async function sendMessage(token: string, chatId: number, text: string, options?: SendMessageOptions): Promise<void> {
  const chunkSize = 3900;
  for (let i = 0; i < text.length; i += chunkSize) {
    await telegramApi(token, "sendMessage", {
      chat_id: chatId,
      text: text.slice(i, i + chunkSize),
      disable_web_page_preview: true,
      ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
  }
}

type MarkSixDraw = { id: string; date: string; numbers: number[]; special: number };

function markSixColor(n: number): "R" | "B" | "G" {
  const red = new Set([1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46]);
  const blue = new Set([3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48]);
  return red.has(n) ? "R" : blue.has(n) ? "B" : "G";
}

function markSixBall(n: number): string {
  const c = markSixColor(n);
  const dot = c === "R" ? "🔴" : c === "B" ? "🔵" : "🟢";
  return `${dot}${String(n).padStart(2, "0")}`;
}

function extractMarkSixDrawsFromHtml(html: string, limit: number): MarkSixDraw[] {
  const draws: MarkSixDraw[] = [];
  const seen = new Set<string>();
  const idRe = /\b(\d{2}\/\d{3})\b/g;
  for (const m of html.matchAll(idRe)) {
    if (draws.length >= limit) break;
    const id = m[1];
    if (!id || seen.has(id)) continue;
    const start = m.index ?? 0;
    const windowText = html.slice(start, start + 2500);
    const dateMatch = windowText.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
    const date = dateMatch?.[1] || "";
    const nums: number[] = [];
    for (const nm of windowText.matchAll(/>\s*(\d{1,2})\s*</g)) {
      const n = Number(nm[1]);
      if (Number.isFinite(n) && n >= 1 && n <= 49) nums.push(n);
      if (nums.length >= 7) break;
    }
    if (!date || nums.length < 7) continue;
    const numbers = nums.slice(0, 6).sort((a, b) => a - b);
    const special = nums[6];
    if (numbers.length !== 6 || !Number.isFinite(special)) continue;
    draws.push({ id, date, numbers, special });
    seen.add(id);
  }
  return draws;
}

function formatMarkSixReport(draws: MarkSixDraw[], windowSize: number): string {
  const url = "https://lottery.hk/en/mark-six/results/";
  const window = draws.slice(0, Math.max(1, windowSize));
  const recent = draws.slice(0, 8);

  const counts = new Map<number, number>();
  for (let i = 1; i <= 49; i++) counts.set(i, 0);
  for (const d of window) {
    for (const n of d.numbers) counts.set(n, (counts.get(n) || 0) + 1);
  }

  const hot = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 8);

  const cold = Array.from(counts.entries())
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .slice(0, 8);

  const lastSeen = new Map<number, number>();
  window.forEach((d, idx) => {
    for (const n of d.numbers) {
      if (!lastSeen.has(n)) lastSeen.set(n, idx);
    }
  });
  const overdue = Array.from({ length: 49 }, (_, i) => i + 1)
    .map((n) => ({ n, miss: lastSeen.has(n) ? (lastSeen.get(n) as number) : window.length }))
    .sort((a, b) => b.miss - a.miss || a.n - b.n)
    .slice(0, 10);

  let odd = 0;
  let even = 0;
  let small = 0;
  let big = 0;
  for (const d of window) {
    for (const n of d.numbers) {
      if (n % 2 === 0) even += 1;
      else odd += 1;
      if (n >= 25) big += 1;
      else small += 1;
    }
  }
  const totalBalls = Math.max(1, odd + even);

  const pairCounts = new Map<string, number>();
  for (const d of window) {
    const ns = [...d.numbers].sort((a, b) => a - b);
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const key = `${ns[i]}-${ns[j]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  const hotPairs = Array.from(pairCounts.entries())
    .map(([k, c]) => {
      const [a, b] = k.split("-").map((x) => Number(x));
      return { a, b, c };
    })
    .sort((x, y) => y.c - x.c || x.a - y.a || x.b - y.b)
    .slice(0, 10);

  const lines: string[] = [];
  lines.push("香港六合彩 (Mark Six) 數據分析");
  lines.push(`數據來源: ${url}`);
  lines.push(`統計期數: 最近 ${window.length} 期`);
  lines.push("");
  lines.push("最新 8 期結果:");
  for (const d of recent) {
    lines.push(
      `${d.id} (${d.date}): ${d.numbers.map((n) => String(n).padStart(2, "0")).join(", ")} + ${String(d.special).padStart(2, "0")}`,
    );
  }
  lines.push("");
  lines.push("熱門開獎碼 (Top 8):");
  for (const [n, c] of hot) lines.push(`${markSixBall(n)} - 出現 ${c} 次`);
  lines.push("");
  lines.push("冷門開獎碼 (Top 8):");
  for (const [n, c] of cold) lines.push(`${markSixBall(n)} - 出現 ${c} 次`);
  lines.push("");
  lines.push("遺漏值 (最久未出 Top 10):");
  for (const r of overdue) lines.push(`${markSixBall(r.n)} - 未出 ${r.miss} 期`);
  lines.push("");
  lines.push(`奇偶 / 大小 比例 (最近 ${window.length} 期):`);
  lines.push(
    `奇: ${odd} (${((odd / totalBalls) * 100).toFixed(1)}%) | 偶: ${even} (${((even / totalBalls) * 100).toFixed(1)}%)`,
  );
  lines.push(
    `小(01-24): ${small} (${((small / totalBalls) * 100).toFixed(1)}%) | 大(25-49): ${big} (${((big / totalBalls) * 100).toFixed(1)}%)`,
  );
  lines.push("");
  lines.push("波膽 (熱門組合 Top 10):");
  for (const p of hotPairs) lines.push(`${markSixBall(p.a)} ${markSixBall(p.b)} - 出現 ${p.c} 次`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  return lines.join("\n");
}

async function fetchMarkSixReport(windowSize: number): Promise<string> {
  const url = "https://lottery.hk/en/mark-six/results/";
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const html = await res.text();
  const draws = extractMarkSixDrawsFromHtml(html, Math.max(60, windowSize));
  return formatMarkSixReport(draws, windowSize);
}

type ChartData = {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  currency: string;
  timestamps: number[];
  asOfUnix: number;
};

async function fetchYahooChart(symbol: string): Promise<ChartData> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const json = await res.json<any>();
  if (json.chart?.error) throw new Error(json.chart.error.description || "chart error");
  const r = json.chart.result[0];
  const q = r.indicators.quote[0];
  const closes = (q.close || []).filter((x: any) => x != null).map((x: any) => Number(x));
  const highs = (q.high || []).filter((x: any) => x != null).map((x: any) => Number(x));
  const lows = (q.low || []).filter((x: any) => x != null).map((x: any) => Number(x));
  const volumes = (q.volume || []).filter((x: any) => x != null).map((x: any) => Number(x));
  const timestamps = (r.timestamp || []).filter((x: any) => x != null).map((x: any) => Number(x));
  const asOfUnix =
    (r.meta?.regularMarketTime != null ? Number(r.meta.regularMarketTime) : 0) ||
    (timestamps.length ? timestamps[timestamps.length - 1] : 0) ||
    Math.floor(Date.now() / 1000);
  return { closes, highs, lows, volumes, timestamps, asOfUnix, currency: r.meta?.currency || "USD" };
}

function sma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) return values[values.length - 1];
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function computePctChange(latest: number, earlier: number): number {
  if (!Number.isFinite(latest) || !Number.isFinite(earlier) || earlier === 0) return 0;
  return ((latest - earlier) / earlier) * 100;
}

function pickBack(values: number[], back: number): number {
  const idx = values.length - 1 - back;
  if (idx < 0) return values[0] ?? 0;
  return values[idx] ?? 0;
}

function heatColor(bias: Bias, confidence: number, change1d: number): string {
  if (bias === "Bullish" && confidence >= 70) return "🟩";
  if (bias === "Bullish") return change1d >= 0 ? "🟢" : "🟨";
  if (bias === "Bearish" && confidence <= 30) return "🟥";
  if (bias === "Bearish") return change1d <= 0 ? "🟧" : "🟨";
  return "🟨";
}

function bollingerLower(values: number[], period: number, mult: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) return values[values.length - 1];
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((acc, x) => acc + (x - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return mean - mult * sd;
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) return sma(values, period);
  const k = 2 / (period + 1);
  let e = sma(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi14(values: number[]): number {
  const period = 14;
  if (values.length <= period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr14(highs: number[], lows: number[], closes: number[]): number {
  const period = 14;
  if (closes.length <= period) return 0;
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return sma(trs, period);
}

function macdHistogram(values: number[]): number {
  if (values.length < 30) return 0;
  const macdLine: number[] = [];
  for (let i = 26; i <= values.length; i++) {
    const v = values.slice(0, i);
    macdLine.push(ema(v, 12) - ema(v, 26));
  }
  const signal = ema(macdLine, 9);
  const macd = ema(values, 12) - ema(values, 26);
  return macd - signal;
}

type Bias = "Bullish" | "Neutral" | "Bearish";

type RiskTolerance = "low" | "medium" | "high";
type Horizon = "day" | "swing" | "invest";

function normalizeRisk(raw: string | undefined): RiskTolerance {
  const v = (raw || "").trim().toLowerCase();
  if (v === "low" || v === "l") return "low";
  if (v === "high" || v === "h") return "high";
  return "medium";
}

function normalizeHorizon(raw: string | undefined): Horizon {
  const v = (raw || "").trim().toLowerCase();
  if (v === "day" || v === "d" || v === "intraday") return "day";
  if (v === "invest" || v === "i" || v === "long") return "invest";
  return "swing";
}

function getProfile(env: Env): { risk: RiskTolerance; horizon: Horizon } {
  return { risk: normalizeRisk(env.RISK), horizon: normalizeHorizon(env.HORIZON) };
}

function formatFooter(profile: { risk: RiskTolerance; horizon: Horizon }, asOfUnix: number): string {
  const asOfIso = asOfUnix ? new Date(asOfUnix * 1000).toISOString() : "-";
  const generatedIso = new Date().toISOString();
  return [
    "Data: Yahoo Finance chart v8",
    "Daily: 1d/1y",
    `As-of: ${asOfIso}`,
    `Generated: ${generatedIso}`,
    `Profile: risk=${profile.risk} horizon=${profile.horizon}`,
  ].join(" | ");
}

function computeBias(
  price: number,
  d20: number,
  d200: number,
  hist: number,
  rsi: number,
  profile: { risk: RiskTolerance; horizon: Horizon },
): { bias: Bias; confidence: number } {
  const above20 = price > d20;
  const above200 = price > d200;
  const macdBull = hist > 0;
  const macdBear = hist < 0;

  const horizonWeights =
    profile.horizon === "day"
      ? { above20: 15, above200: 5, macd: 15, rsi: 5 }
      : profile.horizon === "invest"
        ? { above20: 5, above200: 20, macd: 5, rsi: 5 }
        : { above20: 10, above200: 10, macd: 10, rsi: 10 };

  let confidence = 50;
  if (above20) confidence += horizonWeights.above20;
  else confidence -= horizonWeights.above20;
  if (above200) confidence += horizonWeights.above200;
  else confidence -= horizonWeights.above200;
  if (macdBull) confidence += horizonWeights.macd;
  if (macdBear) confidence -= horizonWeights.macd;
  if (rsi >= 40 && rsi <= 70) confidence += horizonWeights.rsi;
  if (rsi < 30 || rsi > 70) confidence -= horizonWeights.rsi;
  if (profile.risk === "low") confidence -= 10;
  if (profile.risk === "high") confidence += 5;
  confidence = Math.max(0, Math.min(100, confidence));

  const bullish =
    profile.risk === "low"
      ? above200 && above20 && macdBull && rsi >= 45 && rsi <= 70
      : profile.risk === "high"
        ? above20 && macdBull && rsi >= 35
        : above20 && above200 && macdBull;

  const bearish =
    profile.risk === "low"
      ? !above200 && !above20 && macdBear && rsi <= 55
      : profile.risk === "high"
        ? !above20 && macdBear
        : !above20 && !above200 && macdBear;

  if (bullish) return { bias: "Bullish", confidence };
  if (bearish) return { bias: "Bearish", confidence };
  return { bias: "Neutral", confidence };
}

function pivotsFromPreviousDay(highs: number[], lows: number[], closes: number[]): { p: number; r1: number; s1: number } {
  if (highs.length < 2 || lows.length < 2 || closes.length < 2) return { p: 0, r1: 0, s1: 0 };
  const h = highs[highs.length - 2] || 0;
  const l = lows[lows.length - 2] || 0;
  const c = closes[closes.length - 2] || 0;
  const p = (h + l + c) / 3;
  const r1 = 2 * p - l;
  const s1 = 2 * p - h;
  return { p, r1, s1 };
}

function obvTrend(closes: number[], volumes: number[]): string {
  const n = Math.min(closes.length, volumes.length);
  if (n < 3) return "Neutral";
  let obv = 0;
  const series: number[] = [0];
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1]) obv += volumes[i] || 0;
    else if (closes[i] < closes[i - 1]) obv -= volumes[i] || 0;
    series.push(obv);
  }
  const lookback = Math.min(20, series.length - 1);
  const delta = series[series.length - 1] - series[series.length - 1 - lookback];
  if (delta > 0) return "Accumulation";
  if (delta < 0) return "Distribution";
  return "Neutral";
}

function computeInvalidation(bias: Bias, d20: number, r1: number, s1: number): number {
  if (bias === "Bullish") return Math.min(d20 || Infinity, s1 || Infinity);
  if (bias === "Bearish") return Math.max(d20 || -Infinity, r1 || -Infinity);
  return d20;
}

function formatBrief(symbol: string, data: ChartData, profile: { risk: RiskTolerance; horizon: Horizon }): string {
  const price = data.closes[data.closes.length - 1] || 0;
  const d20 = sma(data.closes, 20);
  const d200 = sma(data.closes, 200);
  const rsi = rsi14(data.closes);
  const atr = atr14(data.highs, data.lows, data.closes);
  const hist = macdHistogram(data.closes);
  const { bias, confidence } = computeBias(price, d20, d200, hist, rsi, profile);
  const { r1, s1 } = pivotsFromPreviousDay(data.highs, data.lows, data.closes);
  const invalidation = computeInvalidation(bias, d20, r1, s1);

  const lines = [
    `TRADING BRIEF: ${symbol}`,
    `Bias: ${bias} | Confidence: ${confidence}%`,
    `Price: ${price.toFixed(2)} ${data.currency} | RSI(14): ${rsi.toFixed(1)} | MACD(H): ${hist.toFixed(2)}`,
    `Daily20MA: ${d20.toFixed(2)} | Daily200MA: ${d200.toFixed(2)}`,
    `ATR(14): ${atr.toFixed(2)} | Invalidation: ${invalidation.toFixed(2)}`,
  ];
  return lines.join("\n");
}

function formatFull(symbol: string, data: ChartData, profile: { risk: RiskTolerance; horizon: Horizon }): string {
  const price = data.closes[data.closes.length - 1] || 0;
  const d20 = sma(data.closes, 20);
  const d50 = sma(data.closes, 50);
  const d200 = sma(data.closes, 200);
  const dBBLower = bollingerLower(data.closes, 20, 2);
  const rsi = rsi14(data.closes);
  const atr = atr14(data.highs, data.lows, data.closes);
  const hist = macdHistogram(data.closes);
  const { p, r1, s1 } = pivotsFromPreviousDay(data.highs, data.lows, data.closes);
  const { bias, confidence } = computeBias(price, d20, d200, hist, rsi, profile);
  const invalidation = computeInvalidation(bias, d20, r1, s1);

  const distToSupport = Math.abs(price - s1);
  const rrRatio = atr / (distToSupport || 1);
  const obv = obvTrend(data.closes, data.volumes);

  const rsiState = rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold" : "Neutral";
  const probUp = price > d20 ? 100 : 0;
  const probDown = price > d20 ? 0 : 100;

  return [
    `TRADING BRIEF: ${symbol}`,
    `Bias: ${bias} | Confidence: ${confidence}% | Invalidation: ${invalidation.toFixed(2)} ${data.currency}`,
    "",
    `${symbol} 分析`,
    `新聞輿情分析: -`,
    "",
    `${symbol} 自訂大盤特化分析`,
    `最新價格: ${price.toFixed(2)} ${data.currency}`,
    "",
    `今日上漲機率: ${probUp}%`,
    `今日下跌機率: ${probDown}%`,
    "",
    `上方壓力位 (Resistance)`,
    `  - 日線 20MA: ${d20.toFixed(2)}`,
    `  - 日線 50MA: ${d50.toFixed(2)}`,
    `  - 樞軸 R1:   ${r1.toFixed(2)}`,
    "",
    `下方支撐位 (Support)`,
    `  - 日線 布林帶下軌: ${dBBLower.toFixed(2)}`,
    `  - 樞軸 S1:         ${s1.toFixed(2)}`,
    `  - 日線 200MA:      ${d200.toFixed(2)}`,
    "",
    `GOLDMAN SACHS SECURITY ANALYSIS: ${symbol}`,
    `================================================`,
    `Current Quote: ${price.toFixed(2)} ${data.currency} | RSI(14): ${rsi.toFixed(1)}`,
    `Trend Conviction: ${confidence}%`,
    "",
    `MOMENTUM (MACD)`,
    `  - Histogram: ${hist > 0 ? "+" : ""}${hist.toFixed(2)} (${hist > 0 ? "Bullish" : "Bearish"})`,
    "",
    `VOLATILITY PROJECTIONS (1-ATR)`,
    `  - Bullish Target: ${(price + atr).toFixed(2)} ${data.currency}`,
    `  - Bearish Support: ${(price - atr).toFixed(2)} ${data.currency}`,
    "",
    `INSTITUTIONAL RISK REPORT: ${symbol}`,
    `================================================`,
    `Price: ${price.toFixed(2)} ${data.currency} | RSI: ${rsi.toFixed(1)} (${rsiState})`,
    "",
    `CAPITAL FLOW (OBV)`,
    `  - Money Flow: ${obv}`,
    "",
    `HFT PIVOT LEVELS (Floor)`,
    `  - Resistance (R1): ${r1.toFixed(2)}`,
    `  - Central Pivot (P): ${p.toFixed(2)}`,
    `  - Support (S1): ${s1.toFixed(2)}`,
    "",
    `ALPHA RISK MODEL`,
    `  - Risk/Reward: ${rrRatio.toFixed(2)}x ${rrRatio > 2 ? "ATTRACTIVE" : "UNFAVORABLE"}`,
    "",
    `LONG-TERM STRUCTURE`,
    `  - Daily 200MA: ${d200.toFixed(2)} (${price > d200 ? "Bullish Phase" : "Bearish Phase"})`,
    `  - Daily 20MA:  ${d20.toFixed(2)} (${price > d20 ? "Short-term Strength" : "Short-term Weakness"})`,
    `================================================`,
  ].join("\n");
}

async function handle(chatId: number, text: string, env: Env): Promise<string> {
  const profile = getProfile(env);
  const decoded = decodeCallbackData(text);
  const { cmd, arg } = parseCommand(decoded);
  if (cmd === "start" || cmd === "help") {
    return [
      "Commands:",
      "- Send `NVDA` (defaults to full report, no-news)",
      "- `/full NVDA`",
      "- `/summary NVDA`",
      "- `/watch NVDA,AAPL,TSLA`",
      "- `/heatmap NVDA,AAPL,TSLA`",
      "- `/marksix` (default 30 draws)",
      "- `/marksix 60`",
      "- `/portfolio`",
      "",
      "Profile (env vars): RISK=low|medium|high, HORIZON=day|swing|invest",
    ].join("\n");
  }

  if (cmd === "marksix") {
    const rawN = arg ? Number(arg.trim()) : 30;
    const windowSize = Number.isFinite(rawN) ? Math.max(10, Math.min(120, rawN)) : 30;
    return await fetchMarkSixReport(windowSize);
  }

  if (cmd === "portfolio") {
    const spec = (env.PORTFOLIO || "").trim();
    if (!spec) return "PORTFOLIO not configured in worker env. Set PORTFOLIO like: NVDA,AAPL,0700.HK";
    const tickers = spec.split(",").map((s) => normalizeTicker(s)).filter(Boolean);
    const briefs: string[] = [];
    let maxAsOf = 0;
    for (const t of tickers.slice(0, 12)) {
      const data = await fetchYahooChart(t);
      maxAsOf = Math.max(maxAsOf, data.asOfUnix || 0);
      briefs.push(formatBrief(t, data, profile));
      briefs.push("");
    }
    briefs.push(formatFooter(profile, maxAsOf));
    return briefs.join("\n");
  }

  if (cmd === "watch") {
    if (!arg) return "Usage: /watch NVDA,AAPL,TSLA";
    const tickers = arg.split(",").map((s) => normalizeTicker(s)).filter(Boolean).slice(0, 20);
    const rows: Array<{ t: string; bias: Bias; conf: number; price: number; rsi: number }> = [];
    let maxAsOf = 0;
    for (const t of tickers) {
      const data = await fetchYahooChart(t);
      maxAsOf = Math.max(maxAsOf, data.asOfUnix || 0);
      const price = data.closes[data.closes.length - 1] || 0;
      const d20 = sma(data.closes, 20);
      const d200 = sma(data.closes, 200);
      const rsi = rsi14(data.closes);
      const hist = macdHistogram(data.closes);
      const { bias, confidence } = computeBias(price, d20, d200, hist, rsi, profile);
      rows.push({ t, bias, conf: confidence, price, rsi });
    }
    rows.sort((a, b) => b.conf - a.conf);
    const lines = ["WATCHLIST (sorted by confidence):"];
    for (const r of rows) {
      lines.push(`${r.t}: ${r.bias} ${r.conf}% | ${r.price.toFixed(2)} | RSI ${r.rsi.toFixed(1)}`);
    }
    lines.push("");
    lines.push(formatFooter(profile, maxAsOf));
    return lines.join("\n");
  }

  if (cmd === "heatmap") {
    const raw = (arg || (env.PORTFOLIO || "").trim()).trim();
    if (!raw) return "Usage: /heatmap NVDA,AAPL,TSLA (or set PORTFOLIO env)";
    const tickers = raw.split(",").map((s) => normalizeTicker(s)).filter(Boolean).slice(0, 30);
    const rows: Array<{
      t: string;
      sector: string;
      price: number;
      ccy: string;
      c1: number;
      c5: number;
      cM: number;
      bias: Bias;
      conf: number;
      asOfUnix: number;
    }> = [];
    let maxAsOf = 0;
    for (const t of tickers) {
      const data = await fetchYahooChart(t);
      maxAsOf = Math.max(maxAsOf, data.asOfUnix || 0);
      const price = data.closes[data.closes.length - 1] || 0;
      const prev = pickBack(data.closes, 1);
      const back5 = pickBack(data.closes, 5);
      const back21 = pickBack(data.closes, 21);
      const c1 = computePctChange(price, prev);
      const c5 = computePctChange(price, back5);
      const cM = computePctChange(price, back21);
      const d20 = sma(data.closes, 20);
      const d200 = sma(data.closes, 200);
      const rsi = rsi14(data.closes);
      const hist = macdHistogram(data.closes);
      const { bias, confidence } = computeBias(price, d20, d200, hist, rsi, profile);
      rows.push({ t, sector: getSector(t), price, ccy: data.currency, c1, c5, cM, bias, conf: confidence, asOfUnix: data.asOfUnix });
    }

    const bySector = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.sector || "Other";
      const arr = bySector.get(key) || [];
      arr.push(r);
      bySector.set(key, arr);
    }
    const sectors = Array.from(bySector.keys()).sort((a, b) => a.localeCompare(b));
    const lines = ["股票熱力圖 (按產業分組) — 1D/5D/1M + 趨勢強度", ""];
    for (const s of sectors) {
      lines.push(`🏷️ ${s}`);
      const group = (bySector.get(s) || []).sort((a, b) => b.conf - a.conf);
      for (const r of group) {
        const block = heatColor(r.bias, r.conf, r.c1);
        const c1s = `${r.c1 >= 0 ? "+" : ""}${r.c1.toFixed(2)}%`;
        const c5s = `${r.c5 >= 0 ? "+" : ""}${r.c5.toFixed(2)}%`;
        const cMs = `${r.cM >= 0 ? "+" : ""}${r.cM.toFixed(2)}%`;
        lines.push(`${block} ${r.t}  ${c1s} (5D ${c5s}, 1M ${cMs})  ${r.bias} ${r.conf}%  ${r.price.toFixed(2)} ${r.ccy}`);
      }
      lines.push("");
    }
    lines.push(formatFooter(profile, maxAsOf));
    return lines.join("\n");
  }

  const target = cmd === "full" || cmd === "summary" ? arg : arg;
  if (!target) return "Send a ticker like NVDA, or /help";
  const ticker = normalizeTicker(target);
  const data = await fetchYahooChart(ticker);
  const body = cmd === "summary" ? formatBrief(ticker, data, profile) : formatFull(ticker, data, profile);
  return body + "\n\n" + formatFooter(profile, data.asOfUnix);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const token = getToken(env);
    if (!token) return new Response("Missing TELEGRAM_TOKEN", { status: 500 });

    const allowed = parseAllowedChatIds(env);
    const secret = (env.WEBHOOK_SECRET || "").trim();

    const url = new URL(request.url);
    const path = url.pathname;
    const expectedPrefix = secret ? `/telegram/${secret}` : "/telegram";
    if (!path.startsWith(expectedPrefix)) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    let update: TelegramUpdate;
    try {
      update = await request.json<TelegramUpdate>();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const msg = update.message || update.edited_message;
    const cb = update.callback_query;
    const chatId = cb?.message?.chat?.id || msg?.chat?.id;
    const rawText = cb?.data || msg?.text;
    if (!rawText || !chatId) return new Response("OK", { status: 200 });
    if (!isAllowed(chatId, allowed)) return new Response("OK", { status: 200 });

    if (cb?.id) {
      ctx.waitUntil(telegramApi(token, "answerCallbackQuery", { callback_query_id: cb.id }));
    }

    const text = decodeCallbackData(rawText);

    const cacheKey = new Request(`https://cache.local/${encodeURIComponent(chatId)}/${encodeURIComponent(text.trim())}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      const tickerForButtonsRaw = text.startsWith("/summary ") || text.startsWith("/full ")
        ? text.split(/\s+/)[1] || ""
        : !text.startsWith("/") ? text : "";
      const tickerForButtons = tickerForButtonsRaw.includes(",") ? tickerForButtonsRaw.split(",")[0] : tickerForButtonsRaw;
      const replyMarkup = tickerForButtons ? buildInlineActions(normalizeTicker(tickerForButtons)) : undefined;
      ctx.waitUntil(sendMessage(token, chatId, body, replyMarkup ? { replyMarkup } : undefined));
      return new Response("OK", { status: 200 });
    }

    let reply = "";
    try {
      reply = await handle(chatId, text, env);
    } catch (e: any) {
      reply = `Error: ${e?.message || String(e)}`;
    }

    reply = escapeText(reply).slice(0, 3900 * 3);
    const tickerForButtonsRaw = text.startsWith("/summary ") || text.startsWith("/full ")
      ? text.split(/\s+/)[1] || ""
      : !text.startsWith("/") ? text : "";
    const tickerForButtons = tickerForButtonsRaw.includes(",") ? tickerForButtonsRaw.split(",")[0] : tickerForButtonsRaw;
    const replyMarkup = tickerForButtons ? buildInlineActions(normalizeTicker(tickerForButtons)) : undefined;
    ctx.waitUntil(sendMessage(token, chatId, reply, replyMarkup ? { replyMarkup } : undefined));
    ctx.waitUntil(
      caches.default.put(cacheKey, new Response(reply, { headers: { "cache-control": "max-age=90" } })),
    );

    return new Response("OK", { status: 200 });
  },
};
