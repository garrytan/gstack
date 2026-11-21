/**
 * Convert non-PNG raster image payloads (JPEG / WebP from Gemini image models)
 * to PNG bytes so all downstream design commands and callers receive real PNGs.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export function normalizeImageMime(mimeType: string): string {
  const clean = mimeType.split(";")[0].trim().toLowerCase();
  return clean === "image/jpg" ? "image/jpeg" : clean;
}

export function isSupportedImageMime(mimeType: string): boolean {
  return SUPPORTED_MIMES.has(mimeType.split(";")[0].trim().toLowerCase());
}

export function isPngBuffer(buf: Buffer): boolean {
  return buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

/**
 * In-process sharp works when running under bun/node with node_modules nearby.
 * The variable module name keeps `bun build --compile` from trying to bundle
 * sharp's native addon into the standalone binary.
 */
async function trySharpInProcess(input: Buffer): Promise<Buffer | null> {
  try {
    const pkg = "sharp";
    const mod: any = await import(pkg);
    const sharpFn = mod.default ?? mod;
    if (typeof sharpFn !== "function") return null;
    const out = await sharpFn(input).png().toBuffer();
    return Buffer.isBuffer(out) && isPngBuffer(out) ? out : null;
  } catch {
    return null;
  }
}

function findSharpEntry(): string | null {
  const candidates = [
    path.resolve(path.dirname(process.execPath), "..", ".."),
    process.cwd(),
  ];
  for (const root of candidates) {
    const entry = path.join(root, "node_modules", "sharp", "lib", "index.js");
    if (fs.existsSync(entry)) return entry;
  }
  return null;
}

/**
 * Compiled `design/dist/design` cannot load external native `.node` addons
 * from disk via dynamic import, so fall back to `bun` + gstack's installed
 * `node_modules/sharp` when both exist.
 */
function trySharpViaBunSubprocess(input: Buffer): Buffer | null {
  const sharpEntry = findSharpEntry();
  if (!sharpEntry) return null;
  const bunBin = process.env.GSTACK_BUN || "bun";
  const script = [
    `import sharp from ${JSON.stringify(pathToFileURL(sharpEntry).href)};`,
    "const chunks = [];",
    "for await (const c of process.stdin) chunks.push(c);",
    "const out = await sharp(Buffer.concat(chunks)).png().toBuffer();",
    "process.stdout.write(out);",
  ].join(" ");
  const res = spawnSync(bunBin, ["-e", script], { input, maxBuffer: 50 * 1024 * 1024, timeout: 15_000 });
  if (res.status === 0 && res.stdout && isPngBuffer(res.stdout)) return res.stdout;
  return null;
}

function tryCliConverter(input: Buffer, ext: string): Buffer | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-png-"));
  const inPath = path.join(tmpDir, `input.${ext}`);
  const outPath = path.join(tmpDir, "output.png");
  const tools: Array<[string, string[]]> = [];
  if (process.platform === "darwin") {
    tools.push(["/usr/bin/sips", ["-s", "format", "png", inPath, "--out", outPath]]);
  }
  tools.push(["magick", [inPath, `png:${outPath}`]]);
  tools.push(["ffmpeg", ["-y", "-v", "error", "-i", inPath, "-frames:v", "1", outPath]]);

  try {
    fs.writeFileSync(inPath, input);
    for (const [cmd, args] of tools) {
      const r = spawnSync(cmd, args, { timeout: 15_000, stdio: "ignore" });
      if (r.status === 0 && fs.existsSync(outPath)) {
        const out = fs.readFileSync(outPath);
        if (isPngBuffer(out)) return out;
      }
    }
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Convert base64-encoded image bytes to PNG base64.
 * Fast-paths existing PNG payloads without modifying bytes.
 */
export async function convertImageToPngBase64(imageData: string, mimeType: string): Promise<string> {
  const norm = normalizeImageMime(mimeType);
  const input = Buffer.from(imageData, "base64");
  if (norm === "image/png" || isPngBuffer(input)) return imageData;
  if (!isSupportedImageMime(norm)) {
    throw new Error(`Unsupported image type ${mimeType}`);
  }

  const ext = norm === "image/webp" ? "webp" : "jpg";
  const converted =
    (await trySharpInProcess(input)) ??
    trySharpViaBunSubprocess(input) ??
    tryCliConverter(input, ext);

  if (!converted) {
    throw new Error(`Could not convert ${norm} image to PNG (no sharp, sips, magick, or ffmpeg available)`);
  }
  return converted.toString("base64");
}

