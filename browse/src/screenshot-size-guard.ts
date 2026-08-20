/**
 * Screenshot size guard — keep full-page screenshots ≤ 2000px max-dim.
 *
 * The Anthropic vision API rejects images whose longest dimension exceeds
 * 2000 image-pixels (post deviceScaleFactor). Full-page screenshots of long
 * pages routinely exceed that, silently bricking the session: the agent
 * burns turns on a base64 blob that errors model-side with no useful
 * stderr surfacing on the browse side.
 *
 * This module centralizes the "after page.screenshot, check dimensions and
 * downscale if too big" path so every full-page caller in browse/src can
 * share the same enforcement. The cap is image-pixels, not CSS pixels,
 * matching the Anthropic API's own threshold.
 *
 * Used by: snapshot.ts (annotated, heatmap), meta-commands.ts (screenshot),
 * write-commands.ts (prettyscreenshot). See test/snapshot-meta-write-guard.test.ts.
 *
 * Closes #1214.
 */

import { writeFileSync, readFileSync } from "fs";

const MAX_DIMENSION_PX = 2000;

export interface SizeGuardResult {
  /** True if the input image exceeded MAX_DIMENSION_PX and was downscaled. */
  resized: boolean;
  /** Final width and height (pixels) of the image as written/returned. */
  width: number;
  height: number;
  /** Original dimensions before any downscale. */
  originalWidth: number;
  originalHeight: number;
}

/**
 * Inspect an image buffer and downscale if its longest side exceeds the
 * 2000px Anthropic vision API cap. Preserves aspect ratio. Encodes back
 * to PNG. Returns the resulting buffer plus a diagnostic shape.
 *
 * Imports sharp lazily so the module load cost only hits screenshot paths
 * (sharp's native binding is non-trivial to initialize).
 */
export async function guardScreenshotBuffer(input: Buffer): Promise<{ buffer: Buffer; result: SizeGuardResult }> {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default ?? sharpModule;
  const image = sharp(input);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const longest = Math.max(width, height);
  if (longest <= MAX_DIMENSION_PX) {
    return {
      buffer: input,
      result: {
        resized: false,
        width,
        height,
        originalWidth: width,
        originalHeight: height,
      },
    };
  }

  const scale = MAX_DIMENSION_PX / longest;
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);

  const resized = await image
    .resize(newWidth, newHeight, { fit: "inside" })
    .png()
    .toBuffer();

  process.stderr.write(
    `[screenshot-size-guard] image ${width}x${height} exceeded ${MAX_DIMENSION_PX}px max-dim; ` +
      `downscaled to ${newWidth}x${newHeight} to fit Anthropic vision API\n`,
  );

  return {
    buffer: resized,
    result: {
      resized: true,
      width: newWidth,
      height: newHeight,
      originalWidth: width,
      originalHeight: height,
    },
  };
}

/**
 * File-mode variant: read the image at the given path, downscale if
 * needed, and write the result back to the same path. Returns the
 * diagnostic shape. Use this after `await page.screenshot({ path, ... })`.
 */
export async function guardScreenshotPath(filePath: string): Promise<SizeGuardResult> {
  const input = readFileSync(filePath);
  const { buffer, result } = await guardScreenshotBuffer(input);
  if (result.resized) {
    writeFileSync(filePath, buffer);
  }
  return result;
}

export const SCREENSHOT_MAX_DIMENSION_PX = MAX_DIMENSION_PX;
