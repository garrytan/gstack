/** Bounded, body-free evidence from one owned PreToolUse Edit request. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
const MAX_BYTES = 1024 * 1024, MAX_LINES = 512;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const autoplanEditLineHash = (line: string) => sha(line.replace(/\s/g, ''));
export interface AutoplanEditDigest {
  version: 1;
  beforeSHA256: string;
  requestSHA256: string;
  oldLineHashes: string[];
  newLineHashes: string[];
}
export function validAutoplanEditDigest(value: unknown): value is AutoplanEditDigest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const hashes = (a: unknown): a is string[] => Array.isArray(a) && a.length > 0 && a.length <= MAX_LINES &&
    Array.from(a).every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h));
  return Object.keys(v).length === 5 && v.version === 1 && typeof v.beforeSHA256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.beforeSHA256) && typeof v.requestSHA256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.requestSHA256) && hashes(v.oldLineHashes) && hashes(v.newLineHashes) &&
    v.oldLineHashes.length + v.newLineHashes.length <= MAX_LINES;
}
/** The caller must validate the owned path before this capped, no-follow read. */
export function readAutoplanDigestFile(file: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const initial = fs.fstatSync(fd);
    if (!initial.isFile() || initial.size > MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break; length += n;
    }
    const final = fs.fstatSync(fd);
    if (length > MAX_BYTES || length !== initial.size || final.size !== initial.size ||
        final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) return undefined;
    return buffer.subarray(0, length);
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function createAutoplanEditDigest(file: string, removed: string, added: string): AutoplanEditDigest | undefined {
  const oldLines = removed.split('\n'), newLines = added.split('\n');
  if (!removed || removed === added || oldLines.length + newLines.length > MAX_LINES) return undefined;
  const bytes = readAutoplanDigestFile(file); if (!bytes) return undefined;
  const before = bytes.toString('utf8'), at = before.indexOf(removed);
  // Require one exact old substring. Only complete request lines can match a
  // displayed row; partial edge lines cannot establish added-line authority.
  if (!Buffer.from(before).equals(bytes) || at < 0 || at !== before.lastIndexOf(removed)) return undefined;
  return { version: 1, beforeSHA256: sha(bytes), requestSHA256: sha(JSON.stringify([removed, added])),
    oldLineHashes: oldLines.map(autoplanEditLineHash), newLineHashes: newLines.map(autoplanEditLineHash) };
}

/** Require complete numbered rows and the marker column of this exact diff. */
export function matchesAutoplanDigestRows(rows: string[], before: Buffer, digest: AutoplanEditDigest): boolean {
  if (!validAutoplanEditDigest(digest) || sha(before) !== digest.beforeSHA256) return false;
  const chunks: Array<{kind: string; text: string}> = [];
  let column: number | undefined, previousLine = 0;
  for (const row of rows) {
    const full = /^( {0,3})([1-9]\d*) ([+ -])(.*)$/.exec(row);
    if (full) {
      const line = Number(full[2]), markerColumn = full[1]!.length + full[2]!.length + 1;
      if (!Number.isSafeInteger(line) || line < previousLine ||
          (column !== undefined && column !== markerColumn)) return false;
      column = markerColumn; previousLine = line;
      chunks.push({kind: full[3]!, text: full[4]!});
    } else {
      if (column === undefined || !row.startsWith(' '.repeat(column))) return false;
      const last = chunks.at(-1), kind = row[column];
      if (!last || kind !== last.kind) return false;
      last.text += row.slice(column + 1);
    }
  }
  const originals = new Set(before.toString('utf8').split('\n').map(autoplanEditLineHash));
  return chunks.length >= 2 && chunks.some(c => c.kind === '+' && /\S/.test(c.text) &&
      !originals.has(autoplanEditLineHash(c.text)) && !digest.oldLineHashes.includes(autoplanEditLineHash(c.text))) &&
    chunks.every(c => c.kind === '+' ? digest.newLineHashes.includes(autoplanEditLineHash(c.text)) :
      originals.has(autoplanEditLineHash(c.text)) && (c.kind !== '-' || digest.oldLineHashes.includes(autoplanEditLineHash(c.text))));
}
