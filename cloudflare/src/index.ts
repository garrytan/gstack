type Env = {
  TELEGRAM_TOKEN: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  TELEGRAM_CHAT_ID?: string;
  WEBHOOK_SECRET?: string;
  PORTFOLIO?: string;
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

async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  const chunkSize = 3900;
  for (let i = 0; i < text.length; i += chunkSize) {
    await telegramApi(token, "sendMessage", {
      chat_id: chatId,
      text: text.slice(i, i + chunkSize),
      disable_web_page_preview: true,
    });
  }
}

type ChartData = {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  currency: string;
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
  return { closes, highs, lows, volumes, currency: r.meta?.currency || "USD" };
}

function sma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) return values[values.length - 1];
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
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

function computeBias(price: number, d20: number, d200: number, hist: number, rsi: number): { bias: Bias; confidence: number } {
  const above20 = price > d20;
  const above200 = price > d200;
  const macdBull = hist > 0;
  const macdBear = hist < 0;
  let confidence = 50;
  if (above20) confidence += 10;
  else confidence -= 10;
  if (above200) confidence += 10;
  else confidence -= 10;
  if (macdBull) confidence += 10;
  if (macdBear) confidence -= 10;
  if (rsi >= 40 && rsi <= 70) confidence += 5;
  if (rsi < 30 || rsi > 70) confidence -= 5;
  confidence = Math.max(0, Math.min(100, confidence));
  if (above20 && above200 && macdBull) return { bias: "Bullish", confidence };
  if (!above20 && !above200 && macdBear) return { bias: "Bearish", confidence };
  return { bias: "Neutral", confidence };
}

function formatBrief(symbol: string, data: ChartData): string {
  const price = data.closes[data.closes.length - 1] || 0;
  const d20 = sma(data.closes, 20);
  const d200 = sma(data.closes, 200);
  const rsi = rsi14(data.closes);
  const atr = atr14(data.highs, data.lows, data.closes);
  const hist = macdHistogram(data.closes);
  const { bias, confidence } = computeBias(price, d20, d200, hist, rsi);
  const invalidation = bias === "Bullish" ? Math.min(d20, price - atr) : bias === "Bearish" ? Math.max(d20, price + atr) : d20;

  const lines = [
    `TRADING BRIEF: ${symbol}`,
    `Bias: ${bias} | Confidence: ${confidence}%`,
    `Price: ${price.toFixed(2)} ${data.currency} | RSI(14): ${rsi.toFixed(1)} | MACD(H): ${hist.toFixed(2)}`,
    `Daily20MA: ${d20.toFixed(2)} | Daily200MA: ${d200.toFixed(2)}`,
    `ATR(14): ${atr.toFixed(2)} | Invalidation: ${invalidation.toFixed(2)}`,
  ];
  return lines.join("\n");
}

async function handle(chatId: number, text: string, env: Env): Promise<string> {
  const { cmd, arg } = parseCommand(text);
  if (cmd === "start" || cmd === "help") {
    return [
      "Commands:",
      "- Send `NVDA` (defaults to summary brief)",
      "- `/full NVDA`",
      "- `/summary NVDA`",
      "- `/watch NVDA,AAPL,TSLA`",
      "- `/portfolio`",
    ].join("\n");
  }

  if (cmd === "portfolio") {
    const spec = (env.PORTFOLIO || "").trim();
    if (!spec) return "PORTFOLIO not configured in worker env. Set PORTFOLIO like: NVDA,AAPL,0700.HK";
    const tickers = spec.split(",").map((s) => normalizeTicker(s)).filter(Boolean);
    const briefs: string[] = [];
    for (const t of tickers.slice(0, 12)) {
      const data = await fetchYahooChart(t);
      briefs.push(formatBrief(t, data));
      briefs.push("");
    }
    return briefs.join("\n");
  }

  if (cmd === "watch") {
    if (!arg) return "Usage: /watch NVDA,AAPL,TSLA";
    const tickers = arg.split(",").map((s) => normalizeTicker(s)).filter(Boolean).slice(0, 20);
    const rows: Array<{ t: string; bias: Bias; conf: number; price: number; rsi: number }> = [];
    for (const t of tickers) {
      const data = await fetchYahooChart(t);
      const price = data.closes[data.closes.length - 1] || 0;
      const d20 = sma(data.closes, 20);
      const d200 = sma(data.closes, 200);
      const rsi = rsi14(data.closes);
      const hist = macdHistogram(data.closes);
      const { bias, confidence } = computeBias(price, d20, d200, hist, rsi);
      rows.push({ t, bias, conf: confidence, price, rsi });
    }
    rows.sort((a, b) => b.conf - a.conf);
    const lines = ["WATCHLIST (sorted by confidence):"];
    for (const r of rows) {
      lines.push(`${r.t}: ${r.bias} ${r.conf}% | ${r.price.toFixed(2)} | RSI ${r.rsi.toFixed(1)}`);
    }
    return lines.join("\n");
  }

  const target = cmd === "full" || cmd === "summary" ? arg : arg;
  if (!target) return "Send a ticker like NVDA, or /help";
  const ticker = normalizeTicker(target);
  const data = await fetchYahooChart(ticker);
  return formatBrief(ticker, data);
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
    const text = msg?.text;
    const chatId = msg?.chat?.id;
    if (!text || !chatId) return new Response("OK", { status: 200 });
    if (!isAllowed(chatId, allowed)) return new Response("OK", { status: 200 });

    const cacheKey = new Request(`https://cache.local/${encodeURIComponent(chatId)}/${encodeURIComponent(text.trim())}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      ctx.waitUntil(sendMessage(token, chatId, body));
      return new Response("OK", { status: 200 });
    }

    let reply = "";
    try {
      reply = await handle(chatId, text, env);
    } catch (e: any) {
      reply = `Error: ${e?.message || String(e)}`;
    }

    reply = escapeText(reply).slice(0, 3900 * 3);
    ctx.waitUntil(sendMessage(token, chatId, reply));
    ctx.waitUntil(
      caches.default.put(cacheKey, new Response(reply, { headers: { "cache-control": "max-age=90" } })),
    );

    return new Response("OK", { status: 200 });
  },
};

