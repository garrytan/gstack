import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { readFile } from "fs/promises";
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
      [{ text: "🎰 六合彩 Mark6" }],
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
        { text: "🎯 Summary", callback_data: summaryData.slice(0, 64) },
        { text: "📈 Full", callback_data: fullData.slice(0, 64) },
      ],
      [{ text: "📋 Heatmap", callback_data: heatmapData.slice(0, 64) }],
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
        "- `/marksix` (default 30 draws)",
        "- `/marksix 60`",
        "- `/portfolio` (uses `portfolio.json`)",
        "",
        "- Profile (env): `GSTOCK_RISK=low|medium|high`, `GSTOCK_HORIZON=day|swing|invest`",
      ].join("\n"),
      { replyMarkup: buildMainKeyboard() },
    );
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
