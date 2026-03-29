type Env = {
  TELEGRAM_TOKEN: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  TELEGRAM_CHAT_ID?: string;
  WEBHOOK_SECRET?: string;
  PORTFOLIO?: string;
  PORTFOLIO_POSITIONS?: string;
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
        { text: "🎯 重點", callback_data: summaryData },
        { text: "📈 完整", callback_data: fullData },
      ],
      [{ text: "📋 熱力圖", callback_data: heatmapData }],
      [{ text: "❓ 說明", callback_data: "HELP" }],
    ],
  };
}

function buildHelpMenu() {
  return {
    inline_keyboard: [
      [
        { text: "1️⃣ 完整報告", callback_data: "M|FULL" },
        { text: "2️⃣ 重點", callback_data: "M|SUMMARY" },
      ],
      [
        { text: "3️⃣ 觀察清單", callback_data: "M|WATCH" },
        { text: "4️⃣ 熱力圖", callback_data: "M|HEATMAP" },
      ],
      [
        { text: "5️⃣ 投資組合", callback_data: "M|PORTFOLIO" },
        { text: "6️⃣ 六合彩", callback_data: "M|MARKSIX" },
      ],
      [{ text: "7️⃣ 宏觀 (Macro)", callback_data: "M|MACRO" }],
      [{ text: "✖️ 取消/清除等待", callback_data: "M|CANCEL" }],
    ],
  };
}

type PendingAction = "full" | "summary" | "watch" | "heatmap" | "portfolio";

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

async function sendDocument(token: string, chatId: number, params: { filename: string; content: string; caption?: string }): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (params.caption) form.set("caption", params.caption);
  form.set("document", new Blob([params.content], { type: "text/plain; charset=utf-8" }), params.filename);
  const res = await fetch(url, { method: "POST", body: form });
  const json = await res.json<any>();
  if (!json.ok) throw new Error(json.description || "Telegram sendDocument error");
}

async function fetchFredLatest(seriesId: string): Promise<number | null> {
  const cacheKey = new Request(`https://cache.local/fred/${encodeURIComponent(seriesId)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const t = await cached.text();
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

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
    await caches.default.put(cacheKey, new Response(String(n), { headers: { "cache-control": "max-age=300" } }));
    return n;
  }
  return null;
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

function fmtPct(x: number): string {
  const s = `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
  return s;
}

async function formatMacroDashboard(profile: { risk: RiskTolerance; horizon: Horizon }): Promise<string> {
  const btc = await fetchYahooChart("BTC-USD");
  const btcPrice = btc.closes[btc.closes.length - 1] || 0;
  const rsiD = rsi14(btc.closes);
  const wCloses = weeklyCloses(btc.timestamps, btc.closes);
  const rsiW = rsi14(wCloses);
  const s30 = sharpe30d(btc.closes);
  const d20 = sma(btc.closes, 20);
  const d200 = sma(btc.closes, 200);

  const rules: Array<{ name: string; ok: boolean }> = [
    { name: "RSI(日) <= 40", ok: rsiD <= 40 },
    { name: "RSI(週) >= 45", ok: rsiW >= 45 },
    { name: "站上 20MA", ok: btcPrice >= d20 },
    { name: "站上 200MA", ok: btcPrice >= d200 },
    { name: "30D Sharpe > 0", ok: s30 > 0 },
    { name: "回撤 < 20%", ok: (() => { const hi = Math.max(...btc.closes.slice(-60)); return hi ? (btcPrice / hi - 1) > -0.2 : true; })() },
    { name: "波動(ATR%) < 6%", ok: (() => { const atr = atr14(btc.highs, btc.lows, btc.closes); return btcPrice ? (atr / btcPrice) * 100 < 6 : true; })() },
  ];
  const met = rules.filter((r) => r.ok).length;
  const signal = met >= 5 ? "買入" : met >= 4 ? "偏買" : met >= 3 ? "觀望" : "避險";
  const pos = met >= 5 ? "5–10%" : met >= 4 ? "2–5%" : "0–2%";

  const vix = await fetchYahooChart("^VIX");
  const spx = await fetchYahooChart("^GSPC");
  const gold = await fetchYahooChart("GC=F");
  const wti = await fetchYahooChart("CL=F");
  const dxy = await fetchYahooChart("DX-Y.NYB");
  const tnx = await fetchYahooChart("^TNX");

  const pVix = vix.closes[vix.closes.length - 1] || 0;
  const pSpx = spx.closes[spx.closes.length - 1] || 0;
  const pGold = gold.closes[gold.closes.length - 1] || 0;
  const pWti = wti.closes[wti.closes.length - 1] || 0;
  const pDxy = dxy.closes[dxy.closes.length - 1] || 0;
  const pTnx = tnx.closes[tnx.closes.length - 1] || 0;

  const chg = (series: ChartData) => {
    const last = series.closes[series.closes.length - 1] || 0;
    const prev = pickBack(series.closes, 1);
    return computePctChange(last, prev);
  };

  const hyOas = await fetchFredLatest("BAMLH0A0HYM2");
  const igOas = await fetchFredLatest("BAMLC0A0CM");
  const sofr = await fetchFredLatest("SOFR");

  const walcl = await fetchFredLatest("WALCL");
  const rrp = await fetchFredLatest("RRPONTSYD");
  const tga = await fetchFredLatest("WTREGEN");
  const netLiquidity =
    walcl != null && rrp != null && tga != null ? walcl - rrp - tga : null;

  const regime = pVix >= 20 || (hyOas != null && hyOas >= 4.0) ? "RISK-OFF" : "RISK-ON";
  const liquidityStatus =
    netLiquidity != null && sofr != null && sofr < 6 ? "正常" : "偏緊";

  const parts: string[] = [];
  parts.push("🌍 全球宏觀儀表板 (Macro)");
  parts.push("");
  parts.push("🧡 比特幣 (BTC) 分析");
  parts.push(`- 訊號: ${signal}`);
  parts.push(`- 建議倉位: ${pos}`);
  parts.push(`- 現價: ${btcPrice.toFixed(0)} USD`);
  parts.push(`- RSI(日): ${rsiD.toFixed(1)} | RSI(週): ${rsiW.toFixed(1)}`);
  parts.push(`- 30D Sharpe: ${s30.toFixed(2)}`);
  parts.push(`- 分數: ${met}/7`);
  parts.push("");
  parts.push("🌐 全球 Macro 看板");
  parts.push(`- Regime: ${regime}`);
  parts.push(`- VIX: ${pVix.toFixed(2)} (${fmtPct(chg(vix))})`);
  parts.push(`- S&P 500: ${pSpx.toFixed(0)} (${fmtPct(chg(spx))})`);
  parts.push(`- Gold (GC=F): ${pGold.toFixed(2)} (${fmtPct(chg(gold))})`);
  parts.push(`- WTI (CL=F): ${pWti.toFixed(2)} (${fmtPct(chg(wti))})`);
  if (hyOas != null) parts.push(`- HY OAS: ${hyOas.toFixed(2)}% (${Math.round(hyOas * 100)} bps)`);
  if (igOas != null) parts.push(`- IG OAS: ${igOas.toFixed(2)}% (${Math.round(igOas * 100)} bps)`);
  parts.push(`- DXY: ${pDxy.toFixed(2)} (${fmtPct(chg(dxy))})`);
  parts.push(`- US 10Y (^TNX): ${(pTnx / 10).toFixed(2)}%`);
  parts.push("");
  parts.push("💧 流動性狀態");
  if (netLiquidity != null) parts.push(`- Net Liquidity (WALCL-RRP-TGA): ${netLiquidity.toFixed(2)}B`);
  if (sofr != null) parts.push(`- SOFR: ${sofr.toFixed(2)}%`);
  parts.push(`- 狀態: ${liquidityStatus}`);
  parts.push("");
  parts.push(`Generated: ${new Date().toISOString()} | 偏好: 風險=${riskLabelZh(profile.risk)} 週期=${horizonLabelZh(profile.horizon)}`);
  return parts.join("\n");
}

function stateKey(chatId: number) {
  return new Request(`https://state.local/pending/${chatId}`);
}

async function getPending(chatId: number): Promise<PendingAction | null> {
  const res = await caches.default.match(stateKey(chatId));
  if (!res) return null;
  try {
    const json = await res.json<any>();
    const v = String(json?.pending || "");
    if (v === "full" || v === "summary" || v === "watch" || v === "heatmap" || v === "portfolio") return v;
    return null;
  } catch {
    return null;
  }
}

async function setPending(chatId: number, pending: PendingAction | null): Promise<void> {
  if (!pending) {
    await caches.default.delete(stateKey(chatId));
    return;
  }
  await caches.default.put(
    stateKey(chatId),
    new Response(JSON.stringify({ pending }), {
      headers: { "content-type": "application/json", "cache-control": "max-age=300" },
    }),
  );
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

type Position = { ticker: string; quantity: number; costBasis?: number };

function biasLabelZh(b: Bias): string {
  if (b === "Bullish") return "偏多";
  if (b === "Bearish") return "偏空";
  return "中性";
}

function riskLabelZh(r: RiskTolerance): string {
  if (r === "low") return "低";
  if (r === "high") return "高";
  return "中";
}

function horizonLabelZh(h: Horizon): string {
  if (h === "day") return "當沖";
  if (h === "invest") return "投資";
  return "波段";
}

function parsePositionsSpec(spec: string): Position[] {
  const raw = spec.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [lhs, rhsRaw] = part.split(":");
      const rawTicker = (lhs || "").trim();
      if (!rawTicker) return null;
      const rhs = (rhsRaw || "").trim();
      const m = rhs.match(/^(\d+(?:\.\d+)?)(?:@(\d+(?:\.\d+)?))?$/);
      if (!m) return null;
      const quantity = Number(m[1]);
      const costBasis = m[2] != null ? Number(m[2]) : undefined;
      if (!Number.isFinite(quantity) || quantity <= 0) return null;
      if (costBasis != null && (!Number.isFinite(costBasis) || costBasis <= 0)) return null;
      return { ticker: normalizeTicker(rawTicker), quantity, costBasis };
    })
    .filter((x): x is Position => Boolean(x));
}

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
    "資料: Yahoo Finance chart v8",
    "日線: 1d/1y",
    `資料時間: ${asOfIso}`,
    `產生時間: ${generatedIso}`,
    `偏好: 風險=${riskLabelZh(profile.risk)} 週期=${horizonLabelZh(profile.horizon)}`,
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
    `交易簡報: ${symbol}`,
    `趨勢偏向: ${biasLabelZh(bias)} | 信心度: ${confidence}%`,
    `現價: ${price.toFixed(2)} ${data.currency} | RSI(14): ${rsi.toFixed(1)} | MACD(H): ${hist.toFixed(2)}`,
    `日線20MA: ${d20.toFixed(2)} | 日線200MA: ${d200.toFixed(2)}`,
    `ATR(14): ${atr.toFixed(2)} | 失效點(Inval): ${invalidation.toFixed(2)}`,
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

  const prev = pickBack(data.closes, 1);
  const back5 = pickBack(data.closes, 5);
  const back21 = pickBack(data.closes, 21);
  const change1d = computePctChange(price, prev);
  const change5d = computePctChange(price, back5);
  const change1m = computePctChange(price, back21);

  const above20 = price > d20;
  const above200 = price > d200;
  const macdBull = hist > 0;

  const rsiState =
    rsi >= 70 ? "Overbought" : rsi >= 60 ? "Near-overbought" : rsi <= 30 ? "Oversold" : rsi <= 40 ? "Near-oversold" : "Neutral";
  const atrPct = price > 0 ? (atr / price) * 100 : 0;

  const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
  const verdict =
    bias === "Bullish" && confidence >= 70
      ? "偏多（順勢）"
      : bias === "Bearish" && confidence <= 30
        ? "偏空／防守"
        : "等待確認";

  const suggestedAction =
    bias === "Bullish"
      ? profile.risk === "low"
        ? "觀望/持有；站回20MA後再考慮加碼"
        : "持有/逢回加碼；以失效點作停損"
      : bias === "Bearish"
        ? profile.risk === "high"
          ? "避免加碼；可考慮戰術性避險/短打（嚴格停損）"
          : "避免加碼；等待趨勢收復"
        : "持有觀望；等待突破/確認";

  const driverLines = [
    `短線趨勢: ${above20 ? "站上20MA ✅" : "跌破20MA ❌"} | 20MA ${d20.toFixed(2)}`,
    `長線結構: ${above200 ? "站上200MA ✅" : "跌破200MA ❌"} | 200MA ${d200.toFixed(2)}`,
    `動能: MACD(H) ${hist > 0 ? "+" : ""}${hist.toFixed(2)} (${macdBull ? "偏多" : "偏空"})`,
    `資金流: OBV ${obv}`,
    `均值狀態: RSI(14) ${rsi.toFixed(1)} (${rsiState})`,
  ];

  const planLines =
    bias === "Bearish"
      ? [
          "交易計劃（下一步）:",
          `- 防守為主：先看能否收復並站穩20MA（${d20.toFixed(2)}）`,
          `- 下方觀察：S1 ${s1.toFixed(2)}；ATR(14) ${atr.toFixed(2)}（約${atrPct.toFixed(1)}%）`,
          `- 失效點（風控停損參考）: ${invalidation.toFixed(2)} ${data.currency}`,
        ]
      : bias === "Bullish"
        ? [
            "交易計劃（下一步）:",
            `- 優先策略：站上20MA（${d20.toFixed(2)}）後回踩不破再布局`,
            `- 上方觀察：R1 ${r1.toFixed(2)}；1-ATR 目標 ${(price + atr).toFixed(2)}`,
            `- 失效點（風控停損參考）: ${invalidation.toFixed(2)} ${data.currency}`,
          ]
        : [
            "交易計劃（下一步）:",
            `- 中性：等突破站穩20MA（${d20.toFixed(2)}）或回測S1（${s1.toFixed(2)}）止跌`,
            `- 失效點參考: ${invalidation.toFixed(2)} ${data.currency}`,
          ];

  return [
    `交易簡報: ${symbol}`,
    `趨勢偏向: ${biasLabelZh(bias)} | 信心度: ${confidence}% | 結論: ${verdict}`,
    `現價: ${price.toFixed(2)} ${data.currency} | 1日 ${fmtPct(change1d)} | 5日 ${fmtPct(change5d)} | 1月 ${fmtPct(change1m)}`,
    `失效點(Inval): ${invalidation.toFixed(2)} ${data.currency} | ATR(14): ${atr.toFixed(2)}（${atrPct.toFixed(1)}%） | R/R: ${rrRatio.toFixed(2)}x`,
    `建議: ${suggestedAction}`,
    "",
    "訊號驅動（為何如此判斷）",
    ...driverLines.map((l) => `- ${l}`),
    "",
    ...planLines,
    "",
    "關鍵價位",
    "",
    `上方壓力`,
    `  - 樞軸 R1:   ${r1.toFixed(2)}`,
    `  - 日線 20MA: ${d20.toFixed(2)}`,
    `  - 日線 50MA: ${d50.toFixed(2)}`,
    "",
    `下方支撐`,
    `  - 布林下軌(BB20,2): ${dBBLower.toFixed(2)}`,
    `  - 樞軸 S1:           ${s1.toFixed(2)}`,
    `  - 日線 200MA:        ${d200.toFixed(2)}`,
    "",
    `GOLDMAN SACHS 證券分析: ${symbol}`,
    `================================================`,
    `現價: ${price.toFixed(2)} ${data.currency} | RSI(14): ${rsi.toFixed(1)}（${rsiState}）`,
    `趨勢信心: ${confidence}% | 偏好: 風險=${riskLabelZh(profile.risk)} 週期=${horizonLabelZh(profile.horizon)}`,
    "",
    `動能 (MACD)`,
    `  - 柱狀圖: ${hist > 0 ? "+" : ""}${hist.toFixed(2)}（${hist > 0 ? "偏多" : "偏空"}）`,
    "",
    `波動推演 (1-ATR)`,
    `  - 上方目標: ${(price + atr).toFixed(2)} ${data.currency}`,
    `  - 下方支撐: ${(price - atr).toFixed(2)} ${data.currency}`,
    "",
    `機構風險報告: ${symbol}`,
    `================================================`,
    `現價: ${price.toFixed(2)} ${data.currency} | RSI: ${rsi.toFixed(1)}（${rsiState}） | ATR%: ${atrPct.toFixed(1)}%`,
    "",
    `資金流 (OBV)`,
    `  - 狀態: ${obv}`,
    "",
    `樞軸位 (Floor Pivot)`,
    `  - 壓力 (R1): ${r1.toFixed(2)}`,
    `  - 樞軸 (P):  ${p.toFixed(2)}`,
    `  - 支撐 (S1): ${s1.toFixed(2)}`,
    "",
    `風險報酬模型`,
    `  - R/R: ${rrRatio.toFixed(2)}x ${rrRatio > 2 ? "具吸引力" : "不理想"}`,
    "",
    `長短線結構`,
    `  - 日線 200MA: ${d200.toFixed(2)}（${price > d200 ? "多頭區" : "空頭區"}）`,
    `  - 日線 20MA:  ${d20.toFixed(2)}（${price > d20 ? "短線轉強" : "短線偏弱"}）`,
    `================================================`,
  ].join("\n");
}

async function handle(chatId: number, text: string, env: Env): Promise<string> {
  const profile = getProfile(env);
  const decoded = decodeCallbackData(text);
  const { cmd, arg } = parseCommand(decoded);
  if (cmd === "start" || cmd === "help") {
    return [
      "指令（Commands）:",
      "- 直接輸入 `NVDA`（預設回覆：完整報告、無新聞）",
      "- `/full NVDA`（完整）",
      "- `/summary NVDA`（重點）",
      "- `/watch NVDA,AAPL,TSLA`（觀察清單掃描）",
      "- `/heatmap NVDA,AAPL,TSLA`（熱力圖）",
      "- `/macro`（宏觀儀表板）",
      "- `/marksix`（預設 30 期）",
      "- `/marksix 60`",
      "- `/portfolio NVDA,AAPL,0700.HK`（臨時投資組合）",
      "- `/portfolio NVDA:15@167.52,0700.HK:100@493.4`（含數量/成本）",
      "- `/portfolio`（使用 Worker env：PORTFOLIO_POSITIONS 或 PORTFOLIO）",
      "",
      "快捷選單：直接回覆 1/2/3/4/5/6 也可以（會提示你輸入代號）",
      "",
      "偏好設定（env vars）: RISK=low|medium|high, HORIZON=day|swing|invest",
      "投資組合（env vars）: PORTFOLIO_POSITIONS=NVDA:15@167.52,0700.HK:100@493.4 或 PORTFOLIO=NVDA,AAPL,0700.HK",
    ].join("\n");
  }

  if (cmd === "macro") {
    return await formatMacroDashboard(profile);
  }

  if (cmd === "marksix") {
    const rawN = arg ? Number(arg.trim()) : 30;
    const windowSize = Number.isFinite(rawN) ? Math.max(10, Math.min(120, rawN)) : 30;
    return await fetchMarkSixReport(windowSize);
  }

  if (cmd === "portfolio") {
    const spec = (arg || (env.PORTFOLIO_POSITIONS || env.PORTFOLIO || "").trim()).trim();
    if (!spec) {
      return "尚未設定投資組合。\n請輸入：/portfolio NVDA,AAPL,0700.HK\n或含數量成本：/portfolio NVDA:15@167.52,0700.HK:100@493.4\n（或在 Worker env 設定 PORTFOLIO）";
    }

    if (spec.includes(":")) {
      const positions = parsePositionsSpec(spec).slice(0, 25);
      if (positions.length === 0) {
        return "格式錯誤。範例：/portfolio NVDA:15@167.52,0700.HK:100@493.4";
      }

      const rows: Array<{
        ticker: string;
        qty: number;
        cost?: number;
        price: number;
        mv: number;
        ccy: string;
        pnlPct?: number;
        bias: Bias;
        conf: number;
        rsi: number;
        inval: number;
        asOfUnix: number;
      }> = [];

      let maxAsOf = 0;
      for (const p of positions) {
        const data = await fetchYahooChart(p.ticker);
        maxAsOf = Math.max(maxAsOf, data.asOfUnix || 0);
        const price = data.closes[data.closes.length - 1] || 0;
        const mv = price * p.quantity;
        const d20 = sma(data.closes, 20);
        const d200 = sma(data.closes, 200);
        const rsi = rsi14(data.closes);
        const hist = macdHistogram(data.closes);
        const { r1, s1 } = pivotsFromPreviousDay(data.highs, data.lows, data.closes);
        const { bias, confidence } = computeBias(price, d20, d200, hist, rsi, profile);
        const inval = computeInvalidation(bias, d20, r1, s1);
        const pnlPct =
          p.costBasis != null && p.costBasis > 0 ? ((price - p.costBasis) / p.costBasis) * 100 : undefined;
        rows.push({
          ticker: p.ticker,
          qty: p.quantity,
          cost: p.costBasis,
          price,
          mv,
          ccy: data.currency,
          pnlPct,
          bias,
          conf: confidence,
          rsi,
          inval,
          asOfUnix: data.asOfUnix,
        });
      }

      const totalsByCcy = new Map<string, number>();
      for (const r of rows) totalsByCcy.set(r.ccy, (totalsByCcy.get(r.ccy) || 0) + r.mv);

      const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
      const lines: string[] = [];
      lines.push("📌 投資組合摘要（含持倉/成本）");
      lines.push("");
      lines.push("🧾 PORTFOLIO SUMMARY（按幣別，不換匯）");
      for (const [ccy, mv] of Array.from(totalsByCcy.entries()).sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${ccy}: ${mv.toFixed(2)}`);
      }
      lines.push("");
      lines.push("📋 PORTFOLIO POSITIONS");

      const rowsByCcy = new Map<string, typeof rows>();
      for (const r of rows) {
        const arr = rowsByCcy.get(r.ccy) || [];
        arr.push(r);
        rowsByCcy.set(r.ccy, arr);
      }

      for (const ccy of Array.from(rowsByCcy.keys()).sort((a, b) => a.localeCompare(b))) {
        const group = (rowsByCcy.get(ccy) || []).sort((a, b) => b.mv - a.mv);
        const totalMv = totalsByCcy.get(ccy) || 1;
        lines.push("");
        lines.push(`幣別: ${ccy}`);
        lines.push("Ticker | Qty | Cost | Price | MV | Weight | PnL% | Bias | Conf | RSI | Inval");
        for (const r of group) {
          const w = (r.mv / totalMv) * 100;
          const cost = r.cost != null ? r.cost.toFixed(2) : "-";
          const pnl = r.pnlPct != null ? fmtPct(r.pnlPct) : "-";
          lines.push(
            `${r.ticker} | ${r.qty} | ${cost} | ${r.price.toFixed(2)} | ${r.mv.toFixed(2)} | ${w.toFixed(1)}% | ${pnl} | ${biasLabelZh(r.bias)} | ${r.conf}% | ${r.rsi.toFixed(1)} | ${r.inval.toFixed(2)}`,
          );
        }
      }

      lines.push("");
      lines.push(formatFooter(profile, maxAsOf));
      return lines.join("\n");
    }

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
    if (!arg) return "用法: /watch NVDA,AAPL,TSLA";
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
    const lines = ["觀察清單（按信心度排序）:"];
    for (const r of rows) {
      lines.push(`${r.t}: ${biasLabelZh(r.bias)} ${r.conf}% | ${r.price.toFixed(2)} | RSI ${r.rsi.toFixed(1)}`);
    }
    lines.push("");
    lines.push(formatFooter(profile, maxAsOf));
    return lines.join("\n");
  }

  if (cmd === "heatmap") {
    const raw = (arg || (env.PORTFOLIO || "").trim()).trim();
    if (!raw) return "用法: /heatmap NVDA,AAPL,TSLA（或設定 PORTFOLIO env）";
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
    const lines = ["股票熱力圖（按產業分組）— 1日/5日/1月 + 趨勢強度", ""];
    for (const s of sectors) {
      lines.push(`🏷️ ${s}`);
      const group = (bySector.get(s) || []).sort((a, b) => b.conf - a.conf);
      for (const r of group) {
        const block = heatColor(r.bias, r.conf, r.c1);
        const c1s = `${r.c1 >= 0 ? "+" : ""}${r.c1.toFixed(2)}%`;
        const c5s = `${r.c5 >= 0 ? "+" : ""}${r.c5.toFixed(2)}%`;
        const cMs = `${r.cM >= 0 ? "+" : ""}${r.cM.toFixed(2)}%`;
        lines.push(`${block} ${r.t}  ${c1s}（5日 ${c5s}，1月 ${cMs}）  ${biasLabelZh(r.bias)} ${r.conf}%  ${r.price.toFixed(2)} ${r.ccy}`);
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

    const raw = String(rawText).trim();

    if (raw.startsWith("M|")) {
      const sel = raw.slice(2).trim().toUpperCase();
      if (sel === "CANCEL") {
        await setPending(chatId, null);
        ctx.waitUntil(sendMessage(token, chatId, "✅ 已清除等待狀態。", { replyMarkup: buildHelpMenu() }));
        return new Response("OK", { status: 200 });
      }

      if (sel === "FULL" || sel === "SUMMARY") {
        await setPending(chatId, sel === "FULL" ? "full" : "summary");
        ctx.waitUntil(sendMessage(token, chatId, "請輸入股票代號（例如：NVDA 或 0700.HK）。", { replyMarkup: buildHelpMenu() }));
        return new Response("OK", { status: 200 });
      }

      if (sel === "WATCH" || sel === "HEATMAP") {
        await setPending(chatId, sel === "WATCH" ? "watch" : "heatmap");
        ctx.waitUntil(sendMessage(token, chatId, "請輸入清單（例如：NVDA,AAPL,TSLA）。", { replyMarkup: buildHelpMenu() }));
        return new Response("OK", { status: 200 });
      }

      if (sel === "PORTFOLIO") {
        const spec = (env.PORTFOLIO_POSITIONS || env.PORTFOLIO || "").trim();
        if (!spec) {
          await setPending(chatId, "portfolio");
          ctx.waitUntil(sendMessage(token, chatId, "尚未設定 PORTFOLIO。請輸入投資組合清單（例如：NVDA,AAPL,0700.HK）。", { replyMarkup: buildHelpMenu() }));
          return new Response("OK", { status: 200 });
        }
        await setPending(chatId, null);
        const body = await handle(chatId, "/portfolio", env);
        ctx.waitUntil(sendMessage(token, chatId, body, { replyMarkup: buildHelpMenu() }));
        return new Response("OK", { status: 200 });
      }

      if (sel === "MARKSIX") {
        await setPending(chatId, null);
        const body = await handle(chatId, "/marksix", env);
        ctx.waitUntil(sendMessage(token, chatId, body, { replyMarkup: buildHelpMenu() }));
        return new Response("OK", { status: 200 });
      }

      if (sel === "MACRO") {
        await setPending(chatId, null);
        const body = await handle(chatId, "/macro", env);
        ctx.waitUntil(sendMessage(token, chatId, body, { replyMarkup: buildHelpMenu() }));
        return new Response("OK", { status: 200 });
      }
    }

    const pending = await getPending(chatId);
    let text = decodeCallbackData(raw);

    const numeric = text.trim();
    if (!numeric.startsWith("/") && /^[1-7]$/.test(numeric)) {
      const map: Record<string, string> = {
        "1": "M|FULL",
        "2": "M|SUMMARY",
        "3": "M|WATCH",
        "4": "M|HEATMAP",
        "5": "M|PORTFOLIO",
        "6": "M|MARKSIX",
        "7": "M|MACRO",
      };
      const cmd = map[numeric];
      if (cmd) {
        const fake = cmd;
        const sel = fake.slice(2).trim().toUpperCase();
        if (sel === "FULL" || sel === "SUMMARY") {
          await setPending(chatId, sel === "FULL" ? "full" : "summary");
          ctx.waitUntil(sendMessage(token, chatId, "請輸入股票代號（例如：NVDA 或 0700.HK）。", { replyMarkup: buildHelpMenu() }));
          return new Response("OK", { status: 200 });
        }
        if (sel === "WATCH" || sel === "HEATMAP") {
          await setPending(chatId, sel === "WATCH" ? "watch" : "heatmap");
          ctx.waitUntil(sendMessage(token, chatId, "請輸入清單（例如：NVDA,AAPL,TSLA）。", { replyMarkup: buildHelpMenu() }));
          return new Response("OK", { status: 200 });
        }
        if (sel === "PORTFOLIO") {
          const spec = (env.PORTFOLIO_POSITIONS || env.PORTFOLIO || "").trim();
          if (!spec) {
            await setPending(chatId, "portfolio");
            ctx.waitUntil(sendMessage(token, chatId, "尚未設定 PORTFOLIO。請輸入投資組合清單（例如：NVDA,AAPL,0700.HK）。", { replyMarkup: buildHelpMenu() }));
            return new Response("OK", { status: 200 });
          }
          await setPending(chatId, null);
          const body = await handle(chatId, "/portfolio", env);
          ctx.waitUntil(sendMessage(token, chatId, body, { replyMarkup: buildHelpMenu() }));
          return new Response("OK", { status: 200 });
        }
        if (sel === "MARKSIX") {
          await setPending(chatId, null);
          const body = await handle(chatId, "/marksix", env);
          ctx.waitUntil(sendMessage(token, chatId, body, { replyMarkup: buildHelpMenu() }));
          return new Response("OK", { status: 200 });
        }
        if (sel === "MACRO") {
          await setPending(chatId, null);
          const body = await handle(chatId, "/macro", env);
          ctx.waitUntil(sendMessage(token, chatId, body, { replyMarkup: buildHelpMenu() }));
          return new Response("OK", { status: 200 });
        }
      }
    }

    if (pending && !text.trim().startsWith("/")) {
      const payload = text.trim();
      if (pending === "full") text = `/full ${payload}`;
      else if (pending === "summary") text = `/summary ${payload}`;
      else if (pending === "watch") text = `/watch ${payload}`;
      else if (pending === "heatmap") text = `/heatmap ${payload}`;
      else if (pending === "portfolio") text = `/portfolio ${payload}`;
      await setPending(chatId, null);
    }

    const cacheKey = new Request(`https://cache.local/${encodeURIComponent(chatId)}/${encodeURIComponent(text.trim())}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      const tickerForButtonsRaw = text.startsWith("/summary ") || text.startsWith("/full ")
        ? text.split(/\s+/)[1] || ""
        : !text.startsWith("/") ? text : "";
      const tickerForButtons = tickerForButtonsRaw.includes(",") ? tickerForButtonsRaw.split(",")[0] : tickerForButtonsRaw;
      const replyMarkup = tickerForButtons ? buildInlineActions(normalizeTicker(tickerForButtons)) : undefined;
      if (text.startsWith("/portfolio")) {
        const preview = body.split("\n").slice(0, 26).join("\n") + "\n\n（完整報告已輸出附件檔）";
        ctx.waitUntil(sendMessage(token, chatId, preview, { replyMarkup: buildHelpMenu() }));
        const filename = `portfolio_${new Date().toISOString().slice(0, 10)}.txt`;
        ctx.waitUntil(sendDocument(token, chatId, { filename, content: body, caption: "Portfolio report" }));
      } else if (text === "/help" || text === "/start") {
        ctx.waitUntil(sendMessage(token, chatId, body, { replyMarkup: buildHelpMenu() }));
      } else {
        ctx.waitUntil(sendMessage(token, chatId, body, replyMarkup ? { replyMarkup } : undefined));
      }
      return new Response("OK", { status: 200 });
    }

    if (text === "/portfolio" && !(env.PORTFOLIO_POSITIONS || env.PORTFOLIO || "").trim()) {
      await setPending(chatId, "portfolio");
      const prompt =
        "尚未設定 PORTFOLIO。\n請直接輸入投資組合清單（例如：NVDA,AAPL,0700.HK），或用 `/portfolio NVDA,AAPL,0700.HK`。";
      ctx.waitUntil(sendMessage(token, chatId, prompt, { replyMarkup: buildHelpMenu() }));
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
    if (text.startsWith("/portfolio")) {
      const preview = reply.split("\n").slice(0, 26).join("\n") + "\n\n（完整報告已輸出附件檔）";
      ctx.waitUntil(sendMessage(token, chatId, preview, { replyMarkup: buildHelpMenu() }));
      const filename = `portfolio_${new Date().toISOString().slice(0, 10)}.txt`;
      ctx.waitUntil(sendDocument(token, chatId, { filename, content: reply, caption: "Portfolio report" }));
    } else if (text === "/help" || text === "/start") {
      ctx.waitUntil(sendMessage(token, chatId, reply, { replyMarkup: buildHelpMenu() }));
    } else {
      ctx.waitUntil(sendMessage(token, chatId, reply, replyMarkup ? { replyMarkup } : undefined));
    }
    ctx.waitUntil(
      caches.default.put(cacheKey, new Response(reply, { headers: { "cache-control": "max-age=90" } })),
    );

    return new Response("OK", { status: 200 });
  },
};
