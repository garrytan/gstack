/**
 * Local design fallback for environments without OpenAI image auth.
 *
 * These artifacts are not AI image mockups. They are deterministic SVG
 * composition boards that preserve the design-review flow: variants exist on
 * disk, compare can render them, and the user can approve a direction.
 */

import fs from "fs";
import path from "path";

const VARIANT_DIRECTIONS = [
  {
    name: "Trading Focus",
    accent: "#2be480",
    bg: "#f7f3ed",
    surface: "#ffffff",
    line: "#1a6849",
    note: "Hero price and trade action dominate the first screen.",
  },
  {
    name: "Discovery Focus",
    accent: "#1a6849",
    bg: "#f7f3ed",
    surface: "#fcfaf5",
    line: "#a8472d",
    note: "Market cards and filters get more visual weight.",
  },
  {
    name: "Brand Focus",
    accent: "#2be480",
    bg: "#fcfaf5",
    surface: "#ffffff",
    line: "#0e7a53",
    note: "Hula Na identity and trust cues are more explicit.",
  },
  {
    name: "Dense Pro",
    accent: "#0e7a53",
    bg: "#f7f3ed",
    surface: "#ffffff",
    line: "#1a1a1a",
    note: "More compact, scanner-friendly trading layout.",
  },
  {
    name: "Calm Retail",
    accent: "#2be480",
    bg: "#f8f5ef",
    surface: "#ffffff",
    line: "#8b8378",
    note: "Softer hierarchy for first-time retail users.",
  },
  {
    name: "Market Data",
    accent: "#1a6849",
    bg: "#f7f3ed",
    surface: "#ffffff",
    line: "#1a6849",
    note: "Charts, stats, and price movement are foregrounded.",
  },
  {
    name: "Mobile First",
    accent: "#2be480",
    bg: "#f7f3ed",
    surface: "#ffffff",
    line: "#a8472d",
    note: "Mobile nav and touch targets drive the composition.",
  },
];

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function briefTitle(brief: string): string {
  const normalized = brief.replace(/\s+/g, " ").trim();
  if (!normalized) return "Design fallback mockup";
  return normalized.length > 86 ? `${normalized.slice(0, 83)}...` : normalized;
}

function wrapWords(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

function parseSize(size: string | undefined): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(size || "");
  if (!match) return { width: 1536, height: 1024 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

function labelForIndex(index: number): string {
  return String.fromCharCode(65 + index);
}

function renderSvg(brief: string, index: number, size?: string): string {
  const { width, height } = parseSize(size);
  const direction = VARIANT_DIRECTIONS[index % VARIANT_DIRECTIONS.length];
  const label = labelForIndex(index);
  const isMobile = height > width;
  const margin = Math.round(Math.min(width, height) * 0.05);
  const heroW = isMobile ? width - margin * 2 : Math.round(width * 0.66);
  const railX = margin + heroW + 28;
  const railW = width - railX - margin;
  const heroH = isMobile ? Math.round(height * 0.48) : Math.round(height * 0.58);
  const cardY = margin + heroH + 28;
  const cardW = isMobile ? width - margin * 2 : Math.round((width - margin * 2 - 32) / 3);
  const lines = wrapWords(briefTitle(brief), isMobile ? 34 : 58, 3);

  const cards = [0, 1, 2].map((n) => {
    const x = isMobile ? margin : margin + n * (cardW + 16);
    const y = isMobile ? cardY + n * 126 : cardY;
    const w = isMobile ? width - margin * 2 : cardW;
    return `
      <g>
        <rect x="${x}" y="${y}" width="${w}" height="104" rx="14" fill="${direction.surface}" stroke="#e5dfd2"/>
        <text x="${x + 18}" y="${y + 28}" font-size="13" font-weight="700" fill="${direction.accent}">POLITICS</text>
        <text x="${x + 18}" y="${y + 54}" font-size="18" font-weight="700" fill="#1a1a1a">Market ${n + 1} question</text>
        <rect x="${x + 18}" y="${y + 72}" width="${Math.max(90, w - 36)}" height="14" rx="7" fill="#8fe5c4"/>
        <rect x="${x + Math.max(90, w - 36) * 0.58}" y="${y + 72}" width="${Math.max(60, w * 0.32)}" height="14" rx="7" fill="#f4a990"/>
      </g>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(26,26,26,0.055)" stroke-width="1"/>
    </pattern>
    <linearGradient id="chart" x1="0" x2="1">
      <stop offset="0%" stop-color="${direction.line}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${direction.line}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="${direction.bg}"/>
  <rect width="100%" height="100%" fill="url(#grid)"/>
  <text x="${margin}" y="${margin - 14}" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#1a1a1a">Local fallback mockup - Option ${label}</text>
  <rect x="${margin}" y="${margin}" width="${isMobile ? width - margin * 2 : heroW}" height="${heroH}" rx="18" fill="${direction.surface}" stroke="#e5dfd2"/>
  <circle cx="${margin + 32}" cy="${margin + 34}" r="14" fill="${direction.accent}"/>
  <text x="${margin + 54}" y="${margin + 41}" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="800" fill="#1a1a1a">Hula <tspan fill="${direction.accent}">Na!</tspan></text>
  <text x="${margin + 32}" y="${margin + 88}" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="700" fill="${direction.accent}">LIVE / EVENT MARKETS</text>
  ${lines.map((line, i) => `<text x="${margin + 32}" y="${margin + 130 + i * 34}" font-family="Inter, Arial, sans-serif" font-size="${isMobile ? 26 : 32}" font-weight="800" fill="#1a1a1a">${escapeXml(line)}</text>`).join("\n")}
  <text x="${margin + 32}" y="${margin + (isMobile ? 250 : 270)}" font-family="Inter, Arial, sans-serif" font-size="${isMobile ? 78 : 116}" font-weight="800" fill="#1a1a1a">63<tspan font-size="${isMobile ? 42 : 62}" fill="#8b8378">c</tspan></text>
  <text x="${margin + 36}" y="${margin + (isMobile ? 300 : 335)}" font-family="IBM Plex Mono, monospace" font-size="20" font-weight="700" fill="${direction.line}">+0c / 63% implied probability</text>
  <path d="M ${margin + 32} ${margin + heroH - 170} C ${margin + heroW * 0.22} ${margin + heroH - 220}, ${margin + heroW * 0.42} ${margin + heroH - 110}, ${margin + heroW * 0.58} ${margin + heroH - 155} S ${margin + heroW * 0.82} ${margin + heroH - 115}, ${margin + heroW - 38} ${margin + heroH - 145}" fill="none" stroke="${direction.line}" stroke-width="5"/>
  <path d="M ${margin + 32} ${margin + heroH - 170} C ${margin + heroW * 0.22} ${margin + heroH - 220}, ${margin + heroW * 0.42} ${margin + heroH - 110}, ${margin + heroW * 0.58} ${margin + heroH - 155} S ${margin + heroW * 0.82} ${margin + heroH - 115}, ${margin + heroW - 38} ${margin + heroH - 145} L ${margin + heroW - 38} ${margin + heroH - 70} L ${margin + 32} ${margin + heroH - 70} Z" fill="url(#chart)"/>
  <rect x="${margin + 32}" y="${margin + heroH - 52}" width="${isMobile ? 140 : 270}" height="46" rx="23" fill="${direction.accent}"/>
  <text x="${margin + (isMobile ? 72 : 116)}" y="${margin + heroH - 23}" font-family="Inter, Arial, sans-serif" font-size="17" font-weight="800" fill="#061a10">Buy YES / 63c</text>
  <rect x="${margin + (isMobile ? 190 : 320)}" y="${margin + heroH - 52}" width="${isMobile ? 140 : 270}" height="46" rx="23" fill="#fde8e2"/>
  <text x="${margin + (isMobile ? 224 : 400)}" y="${margin + heroH - 23}" font-family="Inter, Arial, sans-serif" font-size="17" font-weight="800" fill="#a8472d">Buy NO / 37c</text>
  ${!isMobile ? `<rect x="${railX}" y="${margin}" width="${railW}" height="${heroH}" rx="18" fill="#fcfaf5" stroke="#e5dfd2"/>
  <text x="${railX + 22}" y="${margin + 42}" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#1a1a1a">Top movers</text>
  ${[0,1,2,3,4].map((n) => `<text x="${railX + 22}" y="${margin + 92 + n * 84}" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="700" fill="#1a1a1a">Live market row ${n + 1}</text><text x="${railX + railW - 70}" y="${margin + 92 + n * 84}" font-family="IBM Plex Mono, monospace" font-size="18" font-weight="800" fill="#1a1a1a">${60 + n}c</text><line x1="${railX + 22}" y1="${margin + 118 + n * 84}" x2="${railX + railW - 22}" y2="${margin + 118 + n * 84}" stroke="#e5dfd2"/>`).join("")}` : ""}
  ${cards}
  <text x="${margin}" y="${height - margin + 18}" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="700" fill="#4a4a4a">${escapeXml(direction.name)} - ${escapeXml(direction.note)}</text>
</svg>`;
}

export function writeLocalFallbackMockup(
  brief: string,
  outputPath: string,
  index = 0,
  size?: string,
): { outputPath: string; bytes: number } {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const svg = renderSvg(brief, index, size);
  fs.writeFileSync(outputPath, svg);
  const svgPath = outputPath.replace(/\.[^.]+$/, ".svg");
  if (svgPath !== outputPath) fs.writeFileSync(svgPath, svg);
  return { outputPath, bytes: Buffer.byteLength(svg) };
}

export function writeLocalFallbackManifest(
  outputDir: string,
  data: Record<string, unknown>,
): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "fallback.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedBy: "gstack-design-local-fallback",
    generatedAt: new Date().toISOString(),
    ...data,
  }, null, 2));
  return manifestPath;
}
