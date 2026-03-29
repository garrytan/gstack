import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import fs from "fs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const REPORTS_DIR = join(REPO_ROOT, "reports");

type CacheEntry = { ts: number; outPath: string; brief: string };
const CACHE_TTL_MS = 90_000;
const cache = new Map<string, CacheEntry>();

type PendingAction = "full" | "summary" | "watch" | "heatmap" | "portfolio";
const pendingByChat = new Map<number, PendingAction>();

function isAllowedChat(chatId: number): boolean {
  if (TELEGRAM_ALLOWED_CHAT_IDS.length === 0) return true;
  return TELEGRAM_ALLOWED_CHAT_IDS.includes(chatId);
}

function normalizeTickerAlias(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  const aliases: Record<string, string> = {
    DXY: "DX-Y.NYB",
    SPX: "^GSPC",
    SP500: "^GSPC",
  };
  return aliases[t] || t;
}

function normalizeUserInputToTicker(text: string): string | null {
  const t = text.trim();
  if (!t) return null;

  if (t.startsWith("/")) {
    const cmd = t.slice(1).trim();
    if (!cmd) return null;
    const parts = cmd.split(/\s+/);
    const first = parts[0].toLowerCase();
    if (first === "portfolio" || first === "help" || first === "start" || first === "watch" || first === "full" || first === "summary" || first === "heatmap") return null;
    return normalizeTickerAlias(parts[0]);
  }

  if (/^[A-Za-z0-9.^-]{1,15}$/.test(t)) return normalizeTickerAlias(t);
  return null;
}

async function apiCall(method: string, payload: any): Promise<any> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || "Telegram API error");
  return json.result;
}

type SendMessageOptions = {
  replyMarkup?: any;
  parseMode?: "Markdown" | "HTML";
};

function buildMainKeyboard() {
  return {
    keyboard: [
      [{ text: "📌 新手完全指南" }, { text: "📋 股票熱力圖" }],
      [{ text: "🧾 投資組合" }, { text: "👀 Watchlist 掃描" }],
      [{ text: "🌍 宏觀 Macro" }, { text: "🎰 六合彩 Mark6" }],
      [{ text: "📈 /full NVDA" }, { text: "🎯 /summary NVDA" }],
      [{ text: "⚙️ Profile 設定" }, { text: "❓ /help" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: "輸入 NVDA / 00700 / 或點選下方快捷鍵",
  };
}

function buildInlineActions(params: { ticker?: string; list?: string }) {
  const t = (params.ticker || "").trim().toUpperCase();
  const list = (params.list || "").trim();
  const summaryData = t ? `S|${t}` : "HELP";
  const fullData = t ? `F|${t}` : "HELP";
  const heatmapData = t ? `HM|${t}` : list ? `HM|${list}` : "HM";
  return {
    inline_keyboard: [
      [
        { text: "🎯 重點", callback_data: summaryData.slice(0, 64) },
        { text: "📈 完整", callback_data: fullData.slice(0, 64) },
      ],
      [{ text: "📋 熱力圖", callback_data: heatmapData.slice(0, 64) }],
      [{ text: "❓ 說明", callback_data: "HELP" }],
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

async function sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<void> {
  const chunkSize = 3800;
  for (let i = 0; i < text.length; i += chunkSize) {
    const part = text.slice(i, i + chunkSize);
    await apiCall("sendMessage", {
      chat_id: chatId,
      text: part,
      parse_mode: options?.parseMode || "Markdown",
      disable_web_page_preview: true,
      ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
  }
}

async function sendDocument(chatId: number, filePath: string, caption?: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
  const data = await readFile(filePath);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption);
  form.set("document", new Blob([data]), filePath.split(/[\\/]/).pop() || "report.txt");
  const res = await fetch(url, { method: "POST", body: form });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || "Telegram sendDocument error");
}

function runStockCommand(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("bun", ["run", "stock.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, GSTOCK_NO_OPEN: "1" },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").toString(),
    stderr: (result.stderr || "").toString(),
  };
}

function escapeMarkdown(s: string): string {
  return s.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function extractBrief(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  const idx = lines.findIndex((l) => l.includes("TRADING BRIEF"));
  if (idx >= 0) {
    out.push(lines[idx]);
    if (lines[idx + 1]) out.push(lines[idx + 1]);
    if (lines[idx + 2] && !lines[idx + 2].includes("===")) out.push(lines[idx + 2]);
  }
  const news = lines.find((l) => l.includes("新聞輿情分析"));
  if (news) out.push(news);
  return out.slice(0, 6).join("\n");
}

function extractPortfolioBrief(text: string): string {
  const lines = text.split(/\r?\n/);
  const clean = lines.map((l) => l.replace(/\s+$/g, ""));
  const out: string[] = [];

  const findSection = (needle: string) => clean.findIndex((l) => l.includes(needle));
  const pushBlock = (startIdx: number, maxLines: number) => {
    if (startIdx < 0) return;
    for (let i = startIdx; i < clean.length && out.length < maxLines; i++) {
      const s = clean[i];
      out.push(s);
      if (i > startIdx && s.trim() === "") break;
    }
  };

  pushBlock(findSection("PORTFOLIO SUMMARY"), 18);
  if (out.length) out.push("");
  pushBlock(findSection("PORTFOLIO VERDICT"), 14);
  if (out.length) out.push("");
  const posIdx = findSection("PORTFOLIO POSITIONS");
  if (posIdx >= 0) out.push("PORTFOLIO POSITIONS（請看附件完整表格）");

  return out.map((l) => l.trimEnd()).join("\n").trim();
}

type MarkSixCache = { ts: number; text: string };
const marksixCache = new Map<number, MarkSixCache>();
const MARKSIX_CACHE_TTL_MS = 60_000;

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
  lines.push("🎰 香港六合彩 (Mark Six) 數據分析");
  lines.push(`📌 數據來源: ${url}`);
  lines.push(`📈 統計期數: 最近 ${window.length} 期`);
  lines.push("");
  lines.push("📋 最新 8 期結果:");
  for (const d of recent) {
    lines.push(
      `${d.id} (${d.date}): ${d.numbers.map((n) => String(n).padStart(2, "0")).join(", ")} + ${String(d.special).padStart(2, "0")}`,
    );
  }
  lines.push("");
  lines.push("🔥 熱門開獎碼 (Top 8):");
  for (const [n, c] of hot) {
    lines.push(`${markSixBall(n)} - 出現 ${c} 次`);
  }
  lines.push("");
  lines.push("❄️ 冷門開獎碼 (Top 8):");
  for (const [n, c] of cold) {
    lines.push(`${markSixBall(n)} - 出現 ${c} 次`);
  }
  lines.push("");
  lines.push("⏳ 遺漏值 (最久未出 Top 10):");
  for (const r of overdue) {
    lines.push(`${markSixBall(r.n)} - 未出 ${r.miss} 期`);
  }
  lines.push("");
  lines.push("⚖️ 奇偶 / 大小 比例 (最近 " + window.length + " 期):");
  lines.push(
    `奇: ${odd} (${((odd / totalBalls) * 100).toFixed(1)}%) | 偶: ${even} (${((even / totalBalls) * 100).toFixed(1)}%)`,
  );
  lines.push(
    `小(01-24): ${small} (${((small / totalBalls) * 100).toFixed(1)}%) | 大(25-49): ${big} (${((big / totalBalls) * 100).toFixed(1)}%)`,
  );
  lines.push("");
  lines.push("🎯 波膽 (熱門組合 Top 10):");
  for (const p of hotPairs) {
    lines.push(`${markSixBall(p.a)} ${markSixBall(p.b)} - 出現 ${p.c} 次`);
  }
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  return lines.join("\n");
}

async function fetchMarkSixReport(windowSize: number): Promise<string> {
  const now = Date.now();
  const cached = marksixCache.get(windowSize);
  if (cached && now - cached.ts <= MARKSIX_CACHE_TTL_MS) return cached.text;

  const url = "https://lottery.hk/en/mark-six/results/";
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const html = await res.text();
  const draws = extractMarkSixDrawsFromHtml(html, Math.max(60, windowSize));
  const out = formatMarkSixReport(draws, windowSize);
  marksixCache.set(windowSize, { ts: now, text: out });
  return out;
}

async function fetchFredLatest(seriesId: string): Promise<number | null> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const csv = await res.text();
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(",");
    if (parts.length < 2) continue;
    const v = parts[1].trim();
    if (!v || v === ".") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    return n;
  }
  return null;
}

async function fetchFredLastTwo(seriesId: string): Promise<{ latest: number; prev: number | null } | null> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const csv = await res.text();
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const values: number[] = [];
  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(",");
    if (parts.length < 2) continue;
    const v = parts[1].trim();
    if (!v || v === ".") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    values.push(n);
    if (values.length >= 2) break;
  }
  if (values.length === 0) return null;
  return { latest: values[0], prev: values.length > 1 ? values[1] : null };
}

async function fetchTreasuryYieldCurveLastTwo(year: number): Promise<{
  asOfDate: string;
  latest: { y2: number; y10: number; y30: number };
  prev: { y2: number; y10: number; y30: number };
} | null> {
  const url =
    `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${encodeURIComponent(String(year))}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const xml = await res.text();

  const pull = (tag: string) => {
    const re = new RegExp(`<d:${tag}\\\\b[^>]*>([^<]*)</d:${tag}>`, "g");
    const out: string[] = [];
    for (const m of xml.matchAll(re)) out.push((m[1] || "").trim());
    return out;
  };

  const dates = pull("NEW_DATE");
  const y2s = pull("BC_2YEAR");
  const y10s = pull("BC_10YEAR");
  const y30s = pull("BC_30YEAR");
  const n = Math.min(dates.length, y2s.length, y10s.length, y30s.length);
  if (n < 2) return null;

  const asOfDate = dates[n - 1];
  const latest = { y2: Number(y2s[n - 1]), y10: Number(y10s[n - 1]), y30: Number(y30s[n - 1]) };
  const prev = { y2: Number(y2s[n - 2]), y10: Number(y10s[n - 2]), y30: Number(y30s[n - 2]) };
  if (![latest.y2, latest.y10, latest.y30, prev.y2, prev.y10, prev.y30].every((x) => Number.isFinite(x))) return null;
  return { asOfDate, latest, prev };
}

function weeklyCloses(timestamps: number[], closes: number[]): number[] {
  const n = Math.min(timestamps.length, closes.length);
  const out: number[] = [];
  let lastKey = "";
  for (let i = 0; i < n; i++) {
    const ts = timestamps[i] * 1000;
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const week = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000 / 7);
    const key = `${y}-W${week}`;
    if (key !== lastKey) {
      out.push(closes[i]);
      lastKey = key;
    } else {
      out[out.length - 1] = closes[i];
    }
  }
  return out;
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

function sma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
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

function sharpe30d(closes: number[]): number {
  if (closes.length < 35) return 0;
  const rs: number[] = [];
  for (let i = closes.length - 31; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!prev || !cur) continue;
    rs.push((cur - prev) / prev);
  }
  if (rs.length < 10) return 0;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / Math.max(1, rs.length - 1);
  const sd = Math.sqrt(variance);
  if (!sd) return 0;
  return (mean / sd) * Math.sqrt(252);
}

function computePctChange(latest: number, earlier: number): number {
  if (!Number.isFinite(latest) || !Number.isFinite(earlier) || earlier === 0) return 0;
  return ((latest - earlier) / earlier) * 100;
}

function pickBack(prices: number[], back: number): number {
  const idx = prices.length - 1 - back;
  if (idx < 0) return prices[0] ?? 0;
  return prices[idx] ?? 0;
}

async function fetchYahooChart(symbol: string): Promise<{ closes: number[]; highs: number[]; lows: number[]; timestamps: number[]; currency: string }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const json = await res.json();
  if (json.chart?.error) throw new Error(json.chart.error.description || "chart error");
  const r = json.chart.result[0];
  const q = r.indicators.quote[0];
  const closes = (q.close || []).filter((x: any) => x != null).map((x: any) => Number(x));
  const highs = (q.high || []).filter((x: any) => x != null).map((x: any) => Number(x));
  const lows = (q.low || []).filter((x: any) => x != null).map((x: any) => Number(x));
  const timestamps = (r.timestamp || []).filter((x: any) => x != null).map((x: any) => Number(x));
  return { closes, highs, lows, timestamps, currency: r.meta?.currency || "USD" };
}

async function formatMacroDashboard(): Promise<string> {
  const btc = await fetchYahooChart("BTC-USD");
  const btcPrice = btc.closes[btc.closes.length - 1] || 0;
  const rsiD = rsi14(btc.closes);
  const rsiW = rsi14(weeklyCloses(btc.timestamps, btc.closes));
  const s30 = sharpe30d(btc.closes);
  const d20 = sma(btc.closes, 20);
  const d200 = sma(btc.closes, 200);
  const atr = atr14(btc.highs, btc.lows, btc.closes);
  const atrPct = btcPrice ? (atr / btcPrice) * 100 : 0;

  const rules: Array<{ ok: boolean }> = [
    { ok: rsiD <= 40 },
    { ok: rsiW >= 45 },
    { ok: btcPrice >= d20 },
    { ok: btcPrice >= d200 },
    { ok: s30 > 0 },
    { ok: (() => { const hi = Math.max(...btc.closes.slice(-60)); return hi ? (btcPrice / hi - 1) > -0.2 : true; })() },
    { ok: atrPct < 6 },
  ];
  const met = rules.filter((r) => r.ok).length;
  const signal = met >= 5 ? "買入" : met >= 4 ? "偏買" : met >= 3 ? "觀望" : "避險";
  const pos = met >= 5 ? "5–10%" : met >= 4 ? "2–5%" : "0–2%";

  const vix = await fetchYahooChart("^VIX");
  const spx = await fetchYahooChart("^GSPC");
  const gold = await fetchYahooChart("GC=F");
  const wti = await fetchYahooChart("CL=F");
  const dxy = await fetchYahooChart("DX-Y.NYB");

  const chg = (series: { closes: number[] }) => {
    const last = series.closes[series.closes.length - 1] || 0;
    const prev = pickBack(series.closes, 1);
    return computePctChange(last, prev);
  };

  const hyOas = await fetchFredLatest("BAMLH0A0HYM2");
  const igOas = await fetchFredLatest("BAMLC0A0CM");
  const sofr = await fetchFredLatest("SOFR");

  const year = new Date().getUTCFullYear();
  const yc = (await fetchTreasuryYieldCurveLastTwo(year)) || (await fetchTreasuryYieldCurveLastTwo(year - 1));

  const walcl = await fetchFredLatest("WALCL");
  const rrp = await fetchFredLatest("RRPONTSYD");
  const tga = await fetchFredLatest("WTREGEN");
  const netLiquidity =
    walcl != null && rrp != null && tga != null ? walcl - rrp - tga : null;

  const pVix = vix.closes[vix.closes.length - 1] || 0;
  const regime = pVix >= 20 || (hyOas != null && hyOas >= 4.0) ? "RISK-OFF" : "RISK-ON";
  const liquidityStatus = netLiquidity != null && sofr != null && sofr < 6 ? "正常" : "偏緊";

  const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;

  const parts: string[] = [];
  parts.push("🌍 **Global Macro Dashboard**");
  parts.push("");
  parts.push("🧡 **Bitcoin Analysis**");
  parts.push(`- 訊號: ${signal}`);
  parts.push(`- 建議倉位: ${pos}`);
  parts.push(`- 現價: ${btcPrice.toFixed(0)} USD`);
  parts.push(`- RSI(日): ${rsiD.toFixed(1)} | RSI(週): ${rsiW.toFixed(1)}`);
  parts.push(`- 30D Sharpe: ${s30.toFixed(2)} | ATR%: ${atrPct.toFixed(1)}%`);
  parts.push(`- 分數: ${met}/7`);
  parts.push("");
  parts.push("🌐 **Global Macro**");
  parts.push(`- Regime: ${regime}`);
  parts.push(`- VIX: ${(vix.closes[vix.closes.length - 1] || 0).toFixed(2)} (${fmtPct(chg(vix))})`);
  parts.push(`- S&P 500: ${(spx.closes[spx.closes.length - 1] || 0).toFixed(0)} (${fmtPct(chg(spx))})`);
  parts.push(`- Gold: ${(gold.closes[gold.closes.length - 1] || 0).toFixed(2)} (${fmtPct(chg(gold))})`);
  parts.push(`- WTI: ${(wti.closes[wti.closes.length - 1] || 0).toFixed(2)} (${fmtPct(chg(wti))})`);
  if (hyOas != null) parts.push(`- HY OAS: ${hyOas.toFixed(2)}% (${Math.round(hyOas * 100)} bps)`);
  if (igOas != null) parts.push(`- IG OAS: ${igOas.toFixed(2)}% (${Math.round(igOas * 100)} bps)`);
  parts.push(`- DXY: ${(dxy.closes[dxy.closes.length - 1] || 0).toFixed(2)} (${fmtPct(chg(dxy))})`);
  const fmtBps = (d: number | null) => (d == null ? "Δ N/A" : `${d >= 0 ? "+" : ""}${d.toFixed(0)} bps`);
  if (yc) {
    parts.push(`- US 2Y: ${yc.latest.y2.toFixed(2)}% (${fmtBps((yc.latest.y2 - yc.prev.y2) * 100)})`);
    parts.push(`- US 10Y: ${yc.latest.y10.toFixed(2)}% (${fmtBps((yc.latest.y10 - yc.prev.y10) * 100)})`);
    parts.push(`- US 30Y: ${yc.latest.y30.toFixed(2)}% (${fmtBps((yc.latest.y30 - yc.prev.y30) * 100)})`);
  } else {
    const us2y = await fetchFredLastTwo("DGS2");
    const us10y = await fetchFredLastTwo("DGS10");
    const us30y = await fetchFredLastTwo("DGS30");
    if (us2y) parts.push(`- US 2Y: ${us2y.latest.toFixed(2)}% (${fmtBps(us2y.prev != null ? (us2y.latest - us2y.prev) * 100 : null)})`);
    if (us10y) parts.push(`- US 10Y: ${us10y.latest.toFixed(2)}% (${fmtBps(us10y.prev != null ? (us10y.latest - us10y.prev) * 100 : null)})`);
    if (us30y) parts.push(`- US 30Y: ${us30y.latest.toFixed(2)}% (${fmtBps(us30y.prev != null ? (us30y.latest - us30y.prev) * 100 : null)})`);
  }
  parts.push("");
  parts.push("💧 **Liquidity Status**");
  if (netLiquidity != null) parts.push(`- Net liquidity: ${netLiquidity.toFixed(2)}B`);
  if (sofr != null) parts.push(`- SOFR: ${sofr.toFixed(2)}%`);
  parts.push(`- 狀態: ${liquidityStatus}`);
  parts.push("");
  parts.push(`Generated: ${new Date().toISOString()}`);
  return parts.join("\n");
}

async function runCached(key: string, run: () => Promise<{ outPath: string; stdout: string; stderr: string; ok: boolean }>): Promise<{ hit: boolean; outPath: string; brief: string; stdout: string; stderr: string; ok: boolean }> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && now - existing.ts <= CACHE_TTL_MS) {
    return { hit: true, outPath: existing.outPath, brief: existing.brief, stdout: "", stderr: "", ok: true };
  }

  const r = await run();
  const brief = r.ok ? extractBrief(r.stdout) : "";
  if (r.ok) cache.set(key, { ts: now, outPath: r.outPath, brief });
  return { hit: false, outPath: r.outPath, brief, stdout: r.stdout, stderr: r.stderr, ok: r.ok };
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const trimmed = text.trim();
  const decoded = decodeCallbackData(trimmed);
  const effectiveText = decoded !== trimmed ? decoded : trimmed;

  if (/^[1-7]$/.test(effectiveText) && !effectiveText.startsWith("/")) {
    const n = Number(effectiveText);
    if (n === 1) {
      pendingByChat.set(chatId, "full");
      await sendMessage(chatId, "請輸入股票代號（例如：NVDA 或 0700.HK）。", { replyMarkup: buildMainKeyboard() });
      return;
    }
    if (n === 2) {
      pendingByChat.set(chatId, "summary");
      await sendMessage(chatId, "請輸入股票代號（例如：NVDA 或 0700.HK）。", { replyMarkup: buildMainKeyboard() });
      return;
    }
    if (n === 3) {
      pendingByChat.set(chatId, "watch");
      await sendMessage(chatId, "請輸入觀察清單（例如：NVDA,AAPL,TSLA）。", { replyMarkup: buildMainKeyboard() });
      return;
    }
    if (n === 4) {
      pendingByChat.set(chatId, "heatmap");
      await sendMessage(chatId, "請輸入熱力圖清單（例如：NVDA,AAPL,TSLA）。", { replyMarkup: buildMainKeyboard() });
      return;
    }
    if (n === 5) {
      pendingByChat.delete(chatId);
      await handleMessage(chatId, "/portfolio");
      return;
    }
    if (n === 6) {
      pendingByChat.delete(chatId);
      await handleMessage(chatId, "/marksix");
      return;
    }
    if (n === 7) {
      pendingByChat.delete(chatId);
      await handleMessage(chatId, "/macro");
      return;
    }
  }

  const pending = pendingByChat.get(chatId) || null;
  if (pending && !effectiveText.startsWith("/") && !effectiveText.startsWith("M|")) {
    const payload = effectiveText.trim();
    pendingByChat.delete(chatId);
    if (pending === "full") {
      await handleMessage(chatId, `/full ${payload}`);
      return;
    }
    if (pending === "summary") {
      await handleMessage(chatId, `/summary ${payload}`);
      return;
    }
    if (pending === "watch") {
      await handleMessage(chatId, `/watch ${payload}`);
      return;
    }
    if (pending === "heatmap") {
      await handleMessage(chatId, `/heatmap ${payload}`);
      return;
    }
    if (pending === "portfolio") {
      await handleMessage(chatId, `/portfolio ${payload}`);
      return;
    }
  }

  if (effectiveText === "/start" || effectiveText === "/help") {
    await sendMessage(
      chatId,
      [
        "*MyStockBot* commands:",
        "- Send a ticker like `NVDA` or `00700`",
        "- `/full NVDA` (full report)",
        "- `/summary NVDA` (brief only)",
        "- `/watch NVDA,AAPL,TSLA` (watchlist scan)",
        "- `/heatmap NVDA,AAPL,TSLA` (sector heatmap)",
        "- `/macro` (macro dashboard)",
        "- `/marksix` (default 30 draws)",
        "- `/marksix 60`",
        "- `/portfolio` (uses `portfolio.json`)",
        "- `/whoami` (show your chat id)",
        "",
        "*快捷選單（回覆數字即可）*",
        "1) 完整報告  2) 重點  3) 觀察清單  4) 熱力圖  5) 投資組合  6) 六合彩  7) 宏觀",
        "",
        "- Profile (env): `GSTOCK_RISK=low|medium|high`, `GSTOCK_HORIZON=day|swing|invest`",
      ].join("\n"),
      { replyMarkup: buildMainKeyboard() },
    );
    return;
  }

  if (effectiveText === "/whoami") {
    await sendMessage(chatId, `你的 Chat ID: \`${chatId}\``, { replyMarkup: buildMainKeyboard() });
    return;
  }

  if (effectiveText === "📌 新手完全指南") {
    await sendMessage(
      chatId,
      [
        "*快速上手*",
        "1) 直接輸入：`NVDA` / `AAPL` / `00700`",
        "2) 想看完整報告：`/full NVDA`",
        "3) 只看重點：`/summary NVDA`",
        "4) 掃描清單：`/watch NVDA,AAPL,TSLA`",
        "5) 看投資組合：`/portfolio`",
        "",
        "提示：如果你不想抓新聞情緒（更快、更穩），就用 no-news 預設（目前已啟用）。",
      ].join("\n"),
      { replyMarkup: buildMainKeyboard() },
    );
    return;
  }

  if (effectiveText === "🧾 投資組合") {
    await handleMessage(chatId, "/portfolio");
    return;
  }

  if (effectiveText === "👀 Watchlist 掃描") {
    await sendMessage(chatId, "Usage: `/watch NVDA,AAPL,TSLA`", { replyMarkup: buildMainKeyboard() });
    return;
  }

  if (effectiveText === "📋 股票熱力圖") {
    await handleMessage(chatId, "/heatmap");
    return;
  }

  if (effectiveText === "🌍 宏觀 Macro") {
    await handleMessage(chatId, "/macro");
    return;
  }

  if (effectiveText === "🎰 六合彩 Mark6") {
    await handleMessage(chatId, "/marksix");
    return;
  }

  if (effectiveText === "⚙️ Profile 設定") {
    await sendMessage(
      chatId,
      [
        "*Profile 設定（影響 Bias/Confidence/Action）*",
        "- `GSTOCK_RISK=low|medium|high`",
        "- `GSTOCK_HORIZON=day|swing|invest`",
        "",
        "你現在是透過雲端 Worker 用 bot，還是本機 polling bot？我可以幫你把 profile 設定到正確的位置。",
      ].join("\n"),
      { replyMarkup: buildMainKeyboard() },
    );
    return;
  }

  const marksixMatch = effectiveText.match(/^\/marksix(?:\s+(\d{1,3}))?$/i);
  if (marksixMatch) {
    try {
      const rawN = marksixMatch[1] ? Number(marksixMatch[1]) : 30;
      const windowSize = Number.isFinite(rawN) ? Math.max(10, Math.min(120, rawN)) : 30;
      const text = await fetchMarkSixReport(windowSize);
      await sendMessage(chatId, `\`\`\`\n${escapeMarkdown(text)}\n\`\`\``, { replyMarkup: buildMainKeyboard() });
    } catch (e: any) {
      await sendMessage(chatId, `❌ Failed: ${escapeMarkdown(String(e?.message || e))}`, { replyMarkup: buildMainKeyboard() });
    }
    return;
  }

  if (effectiveText === "/macro") {
    try {
      mkdirSync(REPORTS_DIR, { recursive: true });
      const outPath = join(REPORTS_DIR, `macro_${Date.now()}.txt`);
      const text = await formatMacroDashboard();
      await writeFile(outPath, text + "\n", "utf8");

      const preview = text.split(/\r?\n/).slice(0, 28).join("\n");
      await sendMessage(chatId, `\`\`\`\n${escapeMarkdown(preview)}\n\`\`\`\n（完整報告已輸出附件檔）`, {
        replyMarkup: buildMainKeyboard(),
      });
      await sendDocument(chatId, outPath, "Macro dashboard");
    } catch (e: any) {
      await sendMessage(chatId, `❌ Failed: ${escapeMarkdown(String(e?.message || e))}`, { replyMarkup: buildMainKeyboard() });
    }
    return;
  }

  if (effectiveText.startsWith("/portfolio")) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const key = `portfolio:summary`;
    const out = join(REPORTS_DIR, `portfolio_${Date.now()}.txt`);
    const cached = await runCached(key, async () => {
      const res = runStockCommand(["--positions", "portfolio.json", "--mode", "summary", "--no-news", "--out", out, "--no-open"]);
      return { ...res, outPath: out };
    });
    if (!cached.ok) {
      await sendMessage(chatId, `❌ Failed:\n\`\`\`\n${escapeMarkdown(cached.stderr || cached.stdout || "unknown error")}\n\`\`\``);
      return;
    }
    try {
      const fileText = (await readFile(cached.outPath)).toString();
      const brief = extractPortfolioBrief(fileText);
      if (brief) await sendMessage(chatId, `\`\`\`\n${escapeMarkdown(brief)}\n\`\`\``, { replyMarkup: buildInlineActions({}) });
    } catch {}
    await sendDocument(chatId, cached.outPath, cached.hit ? "Portfolio summary (cached)" : "Portfolio summary");
    await sendMessage(chatId, "✅ Portfolio ready.", { replyMarkup: buildInlineActions({}) });
    return;
  }

  const watchMatch = effectiveText.match(/^\/watch\s+(.+)$/i);
  if (watchMatch) {
    const list = watchMatch[1].trim();
    if (!list) {
      await sendMessage(chatId, "Usage: `/watch NVDA,AAPL,TSLA`");
      return;
    }
    mkdirSync(REPORTS_DIR, { recursive: true });
    const key = `watch:${list}`;
    const out = join(REPORTS_DIR, `watch_${Date.now()}.txt`);
    const cached = await runCached(key, async () => {
      const res = runStockCommand(["--watch", list, "--mode", "summary", "--no-news", "--out", out, "--no-open"]);
      return { ...res, outPath: out };
    });
    if (!cached.ok) {
      await sendMessage(chatId, `❌ Failed:\n\`\`\`\n${escapeMarkdown(cached.stderr || cached.stdout || "unknown error")}\n\`\`\``);
      return;
    }
    await sendDocument(chatId, cached.outPath, cached.hit ? "Watchlist scan (cached)" : "Watchlist scan");
    await sendMessage(chatId, "✅ Watchlist ready.", { replyMarkup: buildInlineActions({ list }) });
    return;
  }

  const heatmapMatch = effectiveText.match(/^\/heatmap(?:\s+(.+))?$/i);
  if (heatmapMatch) {
    const list = (heatmapMatch[1] || "").trim();
    mkdirSync(REPORTS_DIR, { recursive: true });

    if (!list) {
      const portfolioPath = join(REPO_ROOT, "portfolio.json");
      if (!fs.existsSync(portfolioPath)) {
        await sendMessage(chatId, "Usage: `/heatmap NVDA,AAPL,TSLA`", { replyMarkup: buildMainKeyboard() });
        return;
      }
      const key = `heatmap:portfolio`;
      const out = join(REPORTS_DIR, `heatmap_portfolio_${Date.now()}.txt`);
      const cached = await runCached(key, async () => {
        const res = runStockCommand(["--positions", "portfolio.json", "--mode", "heatmap", "--no-news", "--out", out, "--no-open"]);
        return { ...res, outPath: out };
      });
      if (!cached.ok) {
        await sendMessage(chatId, `❌ Failed:\n\`\`\`\n${escapeMarkdown(cached.stderr || cached.stdout || "unknown error")}\n\`\`\``, {
          replyMarkup: buildMainKeyboard(),
        });
        return;
      }
      await sendDocument(chatId, cached.outPath, cached.hit ? "Heatmap (portfolio, cached)" : "Heatmap (portfolio)");
      await sendMessage(chatId, "✅ Heatmap ready.", { replyMarkup: buildInlineActions({}) });
      return;
    }

    const key = `heatmap:${list}`;
    const out = join(REPORTS_DIR, `heatmap_${Date.now()}.txt`);
    const cached = await runCached(key, async () => {
      const res = runStockCommand(["--watch", list, "--mode", "heatmap", "--no-news", "--out", out, "--no-open"]);
      return { ...res, outPath: out };
    });
    if (!cached.ok) {
      await sendMessage(chatId, `❌ Failed:\n\`\`\`\n${escapeMarkdown(cached.stderr || cached.stdout || "unknown error")}\n\`\`\``, {
        replyMarkup: buildMainKeyboard(),
      });
      return;
    }
    await sendDocument(chatId, cached.outPath, cached.hit ? "Heatmap (cached)" : "Heatmap");
    await sendMessage(chatId, "✅ Heatmap ready.", { replyMarkup: buildInlineActions({ list }) });
    return;
  }

  const fullMatch = effectiveText.match(/^\/full\s+(\S+)/i);
  const summaryMatch = effectiveText.match(/^\/summary\s+(\S+)/i);

  let ticker: string | null = null;
  let mode: "full" | "summary" = "full";

  if (fullMatch) {
    ticker = normalizeTickerAlias(fullMatch[1]);
    mode = "full";
  } else if (summaryMatch) {
    ticker = normalizeTickerAlias(summaryMatch[1]);
    mode = "summary";
  } else {
    ticker = normalizeUserInputToTicker(effectiveText);
    mode = "full";
  }

  if (!ticker) {
    await sendMessage(chatId, "Send a ticker like `NVDA` or `/full NVDA` or `/portfolio`.");
    return;
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const out = join(REPORTS_DIR, `${ticker}_${mode}_${Date.now()}.txt`);
  const key = `ticker:${ticker}:${mode}:no-news`;
  const cached = await runCached(key, async () => {
    const res = runStockCommand([ticker!, "--mode", mode, "--no-news", "--out", out, "--no-open"]);
    return { ...res, outPath: out };
  });

  if (!cached.ok) {
    const body = escapeMarkdown(cached.stderr || cached.stdout || "unknown error");
    await sendMessage(chatId, `❌ Failed running ${ticker}:\n\`\`\`\n${body.slice(0, 3500)}\n\`\`\``);
    return;
  }

  if (cached.brief) {
    await sendMessage(chatId, `\`\`\`\n${escapeMarkdown(cached.brief)}\n\`\`\``, { replyMarkup: buildInlineActions({ ticker }) });
  }
  await sendDocument(chatId, cached.outPath, cached.hit ? `${ticker} report (${mode}, cached)` : `${ticker} report (${mode})`);
}

async function run() {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN env var");
  }

  let offset: number | undefined;

  while (true) {
    try {
      const url = new URL(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`);
      url.searchParams.set("timeout", "30");
      if (offset != null) url.searchParams.set("offset", String(offset));

      const res = await fetch(url);
      const json = await res.json();
      if (!json.ok) throw new Error(json.description || "Telegram getUpdates error");

      const updates: any[] = json.result || [];
      for (const u of updates) {
        offset = (u.update_id || 0) + 1;
        const cb = u.callback_query;
        if (cb?.data && cb?.id && cb?.message?.chat?.id) {
          const chatId = cb.message.chat.id;
          if (!isAllowedChat(chatId)) continue;
          try {
            await apiCall("answerCallbackQuery", { callback_query_id: cb.id });
          } catch {}
          await handleMessage(chatId, String(cb.data));
          continue;
        }

        const msg = u.message || u.edited_message;
        const text = msg?.text;
        const chatId = msg?.chat?.id;
        if (!text || !chatId) continue;
        if (!isAllowedChat(chatId)) continue;
        await handleMessage(chatId, text);
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

run().catch((e) => {
  process.stderr.write(String(e?.message || e) + "\n");
  process.exit(1);
});
