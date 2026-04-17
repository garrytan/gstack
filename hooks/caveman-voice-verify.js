#!/usr/bin/env node

// hooks/caveman-voice-verify.ts
import * as fs2 from "fs";
import * as path2 from "path";
import * as os from "os";
import { fileURLToPath } from "url";

// scripts/lib/voice-density.ts
import * as fs from "fs";
import * as path from "path";
var VERBOSE_PHRASES = [
  ["in order to", "to"],
  ["it is important to note", "note:"],
  ["it is worth noting", "note:"],
  ["please note that", "note:"],
  ["the purpose of", "why:"],
  ["this approach allows", "this lets"],
  ["this ensures that", "ensures"],
  ["this will allow", "lets"],
  ["as mentioned earlier", "(remove)"],
  ["as mentioned above", "(remove)"],
  ["in this section", "(remove)"],
  ["implement a solution for", "fix"],
  ["I would recommend", "recommend:"],
  ["it is recommended that", "recommend:"],
  ["you can use", "use"],
  ["we will", "will"],
  ["we can", "can"],
  ["the following", "these"],
  ["comprehensive", "full"],
  ["straightforward", "simple"],
  ["leverage", "use"],
  ["utilize", "use"],
  ["facilitate", "enable"],
  ["robust", "solid"],
  ["crucial", "key"],
  ["nuanced", "subtle"],
  ["delve", "dig"],
  ["in the event that", "if"],
  ["prior to", "before"],
  ["subsequent to", "after"],
  ["at this point in time", "now"],
  ["due to the fact that", "because"],
  ["for the purpose of", "for"],
  ["in the context of", "in"],
  ["with respect to", "about"],
  ["on a regular basis", "regularly"],
  ["take into consideration", "consider"],
  ["a significant number of", "many"]
];
var ARTICLES = /(?<![-`])\b(a|an|the)\b(?![-`])/gi;
var FILLERS = /\b(just|really|basically|actually|simply|very|quite|rather|somewhat|perhaps|certainly|sure|of course|happy to|I'd be happy)\b/gi;
var HEDGES = /\b(might|could|perhaps|consider|may want to|you might want|it is possible|potentially)\b/gi;
function computeDensity(prose, startLine = 0, lineMap = new Map) {
  const words = prose.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  if (wordCount === 0) {
    return {
      wordCount: 0,
      articlesPerHundred: 0,
      fillersPerHundred: 0,
      hedgesPerHundred: 0,
      verbosePhraseCount: 0,
      flaggedItems: []
    };
  }
  const flagged = [];
  const proseLines = prose.split(`
`);
  const scan = (pattern, type) => {
    let count = 0;
    for (let i = 0;i < proseLines.length; i++) {
      const matches = proseLines[i].match(pattern) || [];
      count += matches.length;
      for (const m of matches) {
        flagged.push({
          line: startLine + (lineMap.get(i) ?? i),
          type,
          match: m,
          context: proseLines[i].trim().substring(0, 80)
        });
      }
    }
    return count;
  };
  const articleCount = scan(ARTICLES, "article");
  const fillerCount = scan(FILLERS, "filler");
  const hedgeCount = scan(HEDGES, "hedge");
  let verboseCount = 0;
  const lowerProse = prose.toLowerCase();
  for (const [verbose] of VERBOSE_PHRASES) {
    const regex = new RegExp(verbose.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = lowerProse.match(regex) || [];
    verboseCount += matches.length;
    if (matches.length > 0) {
      for (let i = 0;i < proseLines.length; i++) {
        if (proseLines[i].toLowerCase().includes(verbose)) {
          flagged.push({
            line: startLine + (lineMap.get(i) ?? i),
            type: "verbose-phrase",
            match: verbose,
            context: proseLines[i].trim().substring(0, 80)
          });
        }
      }
    }
  }
  const per100 = (count) => count / wordCount * 100;
  return {
    wordCount,
    articlesPerHundred: per100(articleCount),
    fillersPerHundred: per100(fillerCount),
    hedgesPerHundred: per100(hedgeCount),
    verbosePhraseCount: verboseCount,
    flaggedItems: flagged
  };
}
function checkThresholds(metrics, thresholds) {
  const failed = [];
  if (metrics.articlesPerHundred > thresholds.articlesPerHundred) {
    failed.push({ metric: "articlesPerHundred", actual: metrics.articlesPerHundred, floor: thresholds.articlesPerHundred });
  }
  if (metrics.fillersPerHundred > thresholds.fillersPerHundred) {
    failed.push({ metric: "fillersPerHundred", actual: metrics.fillersPerHundred, floor: thresholds.fillersPerHundred });
  }
  if (metrics.hedgesPerHundred > thresholds.hedgesPerHundred) {
    failed.push({ metric: "hedgesPerHundred", actual: metrics.hedgesPerHundred, floor: thresholds.hedgesPerHundred });
  }
  if (metrics.verbosePhraseCount > thresholds.verbosePhraseMax) {
    failed.push({ metric: "verbosePhraseCount", actual: metrics.verbosePhraseCount, floor: thresholds.verbosePhraseMax });
  }
  return { pass: failed.length === 0, failedMetrics: failed };
}
function extractNonFloorText(text) {
  const lines = text.split(`
`);
  const kept = [];
  let inCode = false;
  let inFrontmatter = false;
  const tableLines = new Set;
  for (let i = 1;i < lines.length - 1; i++) {
    const sep = lines[i].trim();
    if (/^\|[\s\-:|]+\|$/.test(sep) && /-/.test(sep)) {
      tableLines.add(i - 1);
      tableLines.add(i);
      for (let j = i + 1;j < lines.length; j++) {
        if (/^\s*\|/.test(lines[j]))
          tableLines.add(j);
        else
          break;
      }
    }
  }
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === "---")
        inFrontmatter = false;
      continue;
    }
    if (/^```/.test(trimmed)) {
      inCode = !inCode;
      continue;
    }
    if (inCode)
      continue;
    if (/^<!--.*-->$/.test(trimmed))
      continue;
    if (tableLines.has(i))
      continue;
    kept.push(line.replace(/`[^`]*`/g, ""));
  }
  return kept.join(`
`);
}
function loadProfile(name, cavestackRoot) {
  try {
    const profilePath = path.join(cavestackRoot, "voices", `${name}.json`);
    if (!fs.existsSync(profilePath))
      return null;
    const content = fs.readFileSync(profilePath, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed.name || !parsed.directive)
      return null;
    return parsed;
  } catch {
    return null;
  }
}

// hooks/caveman-voice-verify.ts
var MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
var RETRY_TIMESTAMP_WINDOW_MS = 5000;
var WORD_COUNT_MIN = 20;
function resolveCavestackRoot() {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    return path2.resolve(path2.dirname(selfPath), "..");
  } catch {
    const dn = globalThis.__dirname;
    if (dn)
      return path2.resolve(dn, "..");
    return process.cwd();
  }
}
function getActiveVoiceName() {
  const envVoice = process.env.CAVESTACK_VOICE;
  if (envVoice && envVoice.trim())
    return envVoice.trim();
  const home = os.homedir();
  const configPaths = [
    path2.join(process.env.XDG_CONFIG_HOME || path2.join(home, ".config"), "cavestack", "config.json"),
    path2.join(home, ".cavestack", "config.yaml")
  ];
  for (const p of configPaths) {
    try {
      const content = fs2.readFileSync(p, "utf-8");
      const match = content.match(/["']?voice["']?\s*[:=]\s*["']?([a-z0-9-]+)["']?/);
      if (match)
        return match[1];
    } catch {}
  }
  return "caveman-full";
}
function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve2(data));
    process.stdin.on("error", () => resolve2(""));
    setTimeout(() => resolve2(data), 500);
  });
}
function parseInput(raw) {
  if (!raw.trim())
    return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function extractTextFromContent(content) {
  if (!content)
    return "";
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join(`

`);
}
function findLastAssistantMessages(transcriptPath) {
  if (!fs2.existsSync(transcriptPath))
    return { last: null, previous: null };
  const stat = fs2.statSync(transcriptPath);
  if (stat.size > MAX_TRANSCRIPT_BYTES)
    return { last: null, previous: null };
  const content = fs2.readFileSync(transcriptPath, "utf-8");
  const lines = content.split(`
`);
  const found = [];
  for (let i = lines.length - 1;i >= 0 && found.length < 2; i--) {
    const line = lines[i].trim();
    if (!line)
      continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const role = event.message?.role || event.role;
    if (role !== "assistant")
      continue;
    const content2 = event.message?.content ?? event.content;
    const text = extractTextFromContent(content2);
    if (!text.trim())
      continue;
    const ts = event.timestamp ? Date.parse(event.timestamp) : Date.now();
    found.push({ text, timestamp: Number.isNaN(ts) ? Date.now() : ts });
  }
  return {
    last: found[0] ?? null,
    previous: found[1] ?? null
  };
}
function isRetry(input, previous) {
  if (input.stop_hook_active === true)
    return true;
  if (previous && previous.timestamp) {
    const age = Date.now() - previous.timestamp;
    if (age >= 0 && age < RETRY_TIMESTAMP_WINDOW_MS)
      return true;
  }
  return false;
}
function formatBlockReason(metrics, result) {
  const lines = ["Voice density failed. Metrics over floor:"];
  for (const failed of result.failedMetrics) {
    const actual = failed.metric === "verbosePhraseCount" ? String(Math.round(failed.actual)) : failed.actual.toFixed(1);
    const floor = failed.metric === "verbosePhraseCount" ? String(failed.floor) : failed.floor.toFixed(1);
    const prefix = `  ${failed.metric}: ${actual} (floor: ${floor})`;
    const typeMap = {
      articlesPerHundred: "article",
      fillersPerHundred: "filler",
      hedgesPerHundred: "hedge",
      verbosePhraseCount: "verbose-phrase"
    };
    const itemType = typeMap[failed.metric];
    if (itemType) {
      const offenders = metrics.flaggedItems.filter((f) => f.type === itemType).map((f) => f.match.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
      if (offenders.length > 0) {
        lines.push(`${prefix} — top offenders: ${offenders.map((o) => `"${o}"`).join(", ")}`);
      } else {
        lines.push(prefix);
      }
    } else {
      lines.push(prefix);
    }
  }
  lines.push("Rewrite. Drop articles, filler, hedges. Code/commits/PRs exempt.");
  return lines.join(`
`);
}
function formatRetryMarker(result) {
  const failed = result.failedMetrics.map((f) => f.metric).join(", ");
  return `[voice: over-floor, shipped as-is — ${failed}]`;
}
async function main() {
  if (process.env.CAVESTACK_VOICE_VERIFY === "0")
    return 0;
  const raw = await readStdin();
  const input = parseInput(raw);
  if (!input.transcript_path)
    return 0;
  const root = resolveCavestackRoot();
  const voiceName = getActiveVoiceName();
  if (voiceName === "none" || !voiceName.startsWith("caveman"))
    return 0;
  const profile = loadProfile(voiceName, root);
  if (!profile)
    return 0;
  if (!profile.density_thresholds)
    return 0;
  const { last, previous } = findLastAssistantMessages(input.transcript_path);
  if (!last)
    return 0;
  const nonFloorText = extractNonFloorText(last.text);
  const wordCount = nonFloorText.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount < WORD_COUNT_MIN)
    return 0;
  const metrics = computeDensity(nonFloorText);
  const check = checkThresholds(metrics, profile.density_thresholds);
  if (check.pass)
    return 0;
  const retry = isRetry(input, previous);
  if (retry) {
    process.stdout.write(formatRetryMarker(check));
    return 0;
  }
  const reason = formatBlockReason(metrics, check);
  const decision = { decision: "block", reason };
  process.stdout.write(JSON.stringify(decision));
  return 2;
}
main().then((code) => process.exit(code)).catch((err) => {
  if (process.env.CAVESTACK_VOICE_VERIFY_DEBUG === "1") {
    process.stderr.write(`voice-verify error: ${err && err.message ? err.message : String(err)}
`);
  }
  process.exit(0);
});
