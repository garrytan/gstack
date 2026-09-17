/**
 * Generated architectural artwork, one image per property.
 *
 * These properties are invented. A stock photograph of a real building
 * attached to one of them would be a fabricated fact with a picture frame
 * around it — the exact failure the truthfulness rule exists to prevent, and
 * harder to catch than a wrong number because nobody reads an image for a
 * citation.
 *
 * So the artwork is generated rather than photographed, deterministically from
 * the property's own record: its massing follows the floor count, its lit
 * windows follow the unit's position in the tower, its palette follows the
 * verdict band. It is unmistakably a drawing. It tells you which property you
 * are looking at without claiming to show you the building.
 *
 *   npx vite-node -c vitest.config.ts scripts/generate-property-art.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_PROPERTIES } from '../src/data/fixtures/properties';
import type { Property } from '../src/domain/property/types';

/** Deterministic PRNG so a property's artwork never changes between runs. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const hashOf = (s: string): number =>
  [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 99991, 7);

const W = 800;
const H = 480;

const build = (p: Property): string => {
  const rnd = seeded(hashOf(p.id));
  const floors = Math.max(6, p.totalFloors ?? 12);
  // The iris band: 218 is the logo's blue, 252 its violet. Each property
  // lands somewhere between them, so a rail of cards reads as one family.
  const hue = 218 + Math.floor(rnd() * 34);

  const parts: string[] = [];
  parts.push(
    `<defs>`,
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="hsl(${hue + 10} 42% 26%)"/>` +
      `<stop offset="55%" stop-color="hsl(${hue} 44% 16%)"/>` +
      `<stop offset="100%" stop-color="hsl(${hue - 4} 46% 10%)"/></linearGradient>`,
    `<radialGradient id="glow">` +
      `<stop offset="0%" stop-color="#6d8cf8" stop-opacity="0.55"/>` +
      `<stop offset="100%" stop-color="#6d8cf8" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="glow2">` +
      `<stop offset="0%" stop-color="#9a7cf5" stop-opacity="0.38"/>` +
      `<stop offset="100%" stop-color="#9a7cf5" stop-opacity="0"/></radialGradient>`,
    `<linearGradient id="face" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0%" stop-color="hsl(${hue} 30% 22%)"/>` +
      `<stop offset="100%" stop-color="hsl(${hue} 36% 40%)"/></linearGradient>`,
    `<linearGradient id="side" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0%" stop-color="hsl(${hue} 34% 14%)"/>` +
      `<stop offset="100%" stop-color="hsl(${hue} 32% 23%)"/></linearGradient>`,
    `</defs>`,
  );

  parts.push(`<rect width="${W}" height="${H}" fill="url(#sky)"/>`);
  parts.push(`<circle cx="${W * 0.78}" cy="${H * 0.2}" r="250" fill="url(#glow)"/>`);
  parts.push(`<circle cx="${W * 0.14}" cy="${H * 0.62}" r="200" fill="url(#glow2)"/>`);

  // Three towers: the subject in front, two neighbours receding.
  const towers = [
    { x: 96, w: 128, h: 150 + floors * 9, depth: 34, lit: 0.34 },
    { x: 300, w: 176, h: 190 + floors * 12, depth: 44, lit: 0.6 },
    { x: 540, w: 142, h: 160 + floors * 10, depth: 38, lit: 0.42 },
  ];

  const ground = H - 58;

  for (const t of towers) {
    const top = ground - t.h;
    // side face, then front face — the offset is what reads as depth
    parts.push(
      `<polygon points="${t.x + t.w},${top} ${t.x + t.w + t.depth},${top - 16} ${t.x + t.w + t.depth},${ground - 16} ${t.x + t.w},${ground}" fill="url(#side)"/>`,
    );
    parts.push(`<rect x="${t.x}" y="${top}" width="${t.w}" height="${t.h}" fill="url(#face)"/>`);

    // floor bands and windows
    const bandH = t.h / floors;
    for (let f = 0; f < floors; f += 1) {
      const y = top + f * bandH;
      parts.push(
        `<rect x="${t.x}" y="${(y + bandH - 2).toFixed(1)}" width="${t.w}" height="1.4" fill="hsl(${hue} 26% 11%)" opacity="0.55"/>`,
      );
      const cols = Math.max(3, Math.round(t.w / 30));
      for (let c = 0; c < cols; c += 1) {
        const lit = rnd() < t.lit;
        const wx = t.x + 9 + c * ((t.w - 18) / cols);
        const ww = (t.w - 18) / cols - 7;
        parts.push(
          `<rect x="${wx.toFixed(1)}" y="${(y + 5).toFixed(1)}" width="${ww.toFixed(1)}" height="${(bandH - 12).toFixed(1)}" rx="1" ` +
            `fill="${lit ? '#cfdcff' : `hsl(${hue} 30% 15%)`}" opacity="${lit ? (0.6 + rnd() * 0.4).toFixed(2) : '0.7'}"/>`,
        );
      }
    }
  }

  // ground plane and a horizon rule
  parts.push(
    `<rect x="0" y="${ground}" width="${W}" height="${H - ground}" fill="hsl(${hue} 34% 9%)"/>`,
    `<rect x="0" y="${ground}" width="${W}" height="1" fill="#6d8cf8" opacity="0.45"/>`,
  );

  // The label is part of the image: wherever it travels, it says what it is.
  parts.push(
    `<text x="20" y="${H - 18}" font-family="system-ui, sans-serif" font-size="13" fill="#eef1ff" opacity="0.62">` +
      `Generated illustration · not a photograph of this property</text>`,
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ` +
    `role="img" aria-label="Generated architectural illustration for ${p.title.replace(/[<>&"]/g, '')}">` +
    parts.join('') +
    `</svg>`
  );
};

const dir = join(process.cwd(), 'public', 'property-art');
mkdirSync(dir, { recursive: true });

let n = 0;
for (const p of DEMO_PROPERTIES) {
  writeFileSync(join(dir, `${p.id}.svg`), build(p), 'utf-8');
  n += 1;
}
process.stderr.write(`wrote ${n} illustrations to public/property-art/\n`);
