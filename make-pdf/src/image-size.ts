/**
 * Intrinsic image dimensions from raw bytes. Pure, no DOM, no deps.
 *
 * The diagram pre-pass probes every local image it inlines (eng-review D1:
 * "dimensions are probed from the bytes") so the width policy and landscape
 * detector never need a browser round-trip. Formats: PNG, JPEG, GIF, WebP
 * (VP8/VP8L/VP8X), and SVG (attribute/viewBox best-effort).
 *
 * Returns null when the format is unrecognized or the header is truncated —
 * callers treat unknown dimensions as "no policy applied", never an error.
 */

export interface ImageDims {
  width: number;
  height: number;
  mime: string;
}

export function imageDims(buf: Buffer): ImageDims | null {
  if (buf.length < 12) return null;
  return pngDims(buf) ?? jpegDims(buf) ?? gifDims(buf) ?? webpDims(buf) ?? svgDims(buf);
}

function pngDims(b: Buffer): ImageDims | null {
  // 8-byte signature, then IHDR chunk: length(4) "IHDR"(4) width(4) height(4)
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), mime: "image/png" };
}

function jpegDims(b: Buffer): ImageDims | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    // Standalone markers without length payload
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0-SOF15 except DHT(C4)/JPGA(C8)/DAC(CC) carry dimensions
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 >= b.length) return null;
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), mime: "image/jpeg" };
    }
    i += 2 + len;
  }
  return null;
}

function gifDims(b: Buffer): ImageDims | null {
  const sig = b.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), mime: "image/gif" };
}

function webpDims(b: Buffer): ImageDims | null {
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const fmt = b.toString("ascii", 12, 16);
  if (fmt === "VP8X" && b.length >= 30) {
    // 24-bit little-endian width-1 / height-1 at offsets 24 / 27
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width: w, height: h, mime: "image/webp" };
  }
  if (fmt === "VP8 " && b.length >= 30) {
    // Lossy: dimensions at offset 26, 14 bits each, little-endian
    return {
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
      mime: "image/webp",
    };
  }
  if (fmt === "VP8L" && b.length >= 25) {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      mime: "image/webp",
    };
  }
  return null;
}

/**
 * SVG: parse width/height attributes (px or unitless) off the root element,
 * falling back to viewBox. CSS-unit widths (em, %, pt) are ignored — the
 * width policy treats them as "no intrinsic size".
 */
function svgDims(b: Buffer): ImageDims | null {
  const head = b.toString("utf8", 0, Math.min(b.length, 4096));
  const dims = svgTagDims(head);
  return dims ? { ...dims, mime: "image/svg+xml" } : null;
}

/**
 * CSS-px dimensions of the first <svg> element in a markup string: explicit
 * width/height attributes (px or unitless) first, else viewBox. Shared by the
 * byte prober above and image-policy's diagram-figure measurements — one
 * regex, no drift.
 */
export function svgTagDims(markup: string): { width: number; height: number } | null {
  const tag = markup.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const attr = (name: string): number | null => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)(px)?\\s*["']`, "i"));
    return m ? parseFloat(m[1]) : null;
  };
  const w = attr("width");
  const h = attr("height");
  if (w && h) return { width: w, height: h };
  const vb = tag.match(/\bviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i);
  if (vb) return { width: parseFloat(vb[1]), height: parseFloat(vb[2]) };
  return null;
}
