/**
 * Drawing annotator: overlays bounding boxes and labels on images.
 * Uses sharp for image compositing.
 */

import sharp from "sharp";
import type { CheckEvidence, NormalizedPage } from "../types";
import { bboxToPixels } from "../layout/regions";

const COLORS = {
  critical: { r: 255, g: 0, b: 0, alpha: 0.35 },
  major: { r: 255, g: 140, b: 0, alpha: 0.30 },
  minor: { r: 255, g: 255, b: 0, alpha: 0.20 },
  pass: { r: 0, g: 200, b: 0, alpha: 0.15 },
};

function severityColor(severity: string): { r: number; g: number; b: number; alpha: number } {
  return COLORS[severity as keyof typeof COLORS] || COLORS.minor;
}

function createRectSvg(
  width: number,
  height: number,
  color: { r: number; g: number; b: number; alpha: number },
  label?: string,
): Buffer {
  const strokeColor = `rgba(${color.r},${color.g},${color.b},0.9)`;
  const fillColor = `rgba(${color.r},${color.g},${color.b},${color.alpha})`;

  // Escape XML special chars in label
  const safeLabel = label
    ? label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    : "";

  const labelSvg = safeLabel
    ? `<rect x="0" y="0" width="${Math.min(width, safeLabel.length * 7 + 8)}" height="16" fill="${strokeColor}"/>
       <text x="4" y="12" font-family="monospace" font-size="10" fill="white">${safeLabel.slice(0, 60)}</text>`
    : "";

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="2"/>
    ${labelSvg}
  </svg>`;

  return Buffer.from(svg);
}

export async function annotateDrawing(
  page: NormalizedPage,
  evidenceItems: CheckEvidence[],
): Promise<Buffer> {
  const bboxItems = evidenceItems.filter((e) => e.bbox && e.type === "bbox");

  if (bboxItems.length === 0) {
    // No bboxes to draw, return original
    return page.imageBuffer;
  }

  const overlays = bboxItems.map((item) => {
    const pixels = bboxToPixels(item.bbox!, page.width, page.height);
    const color = severityColor(item.severity);
    const svgBuffer = createRectSvg(pixels.width, pixels.height, color, item.description?.slice(0, 50));

    return {
      input: svgBuffer,
      left: pixels.left,
      top: pixels.top,
    };
  });

  return sharp(page.imageBuffer)
    .composite(overlays)
    .png()
    .toBuffer();
}
