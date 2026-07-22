import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Injectable output sink for the canonical GStack 2 generator. In normal mode
 * every emit()/purge() hits disk exactly as before. During a non-mutating
 * `--check`, captureGeneration() swaps in an in-memory capture so the generator
 * runs end to end (same deterministic logic, same throws) while touching zero
 * tracked files. The captured intent is then compared against the working tree.
 */
export interface CaptureResult {
  /** Absolute path -> intended file bytes. */
  files: Map<string, Buffer>;
  /** Absolute paths the generator would destructively remove before rewriting. */
  cleaned: string[];
}

let capture: CaptureResult | null = null;

/** Write a generated file, or capture its intended bytes during a check. */
export function emit(file: string, content: string | Uint8Array): void {
  const bytes = Buffer.from(content as Uint8Array);
  if (capture) {
    capture.files.set(path.resolve(file), bytes);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

/** Destructively remove a generated tree/file, or record the root during a check. */
export function purge(target: string, recursive = false): void {
  if (capture) {
    capture.cleaned.push(path.resolve(target));
    return;
  }
  fs.rmSync(target, { recursive, force: true });
}

/** Run `generate` with all emit()/purge() calls captured in memory, writing nothing. */
export function captureGeneration(generate: () => void): CaptureResult {
  const prior = capture;
  const result: CaptureResult = { files: new Map(), cleaned: [] };
  capture = result;
  try {
    generate();
  } finally {
    capture = prior;
  }
  return result;
}
