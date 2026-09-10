/** Bounded, body-free evidence from one owned PreToolUse Edit request. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
const MAX_BYTES = 1024 * 1024, MAX_LINES = 512;
// Covers ordinary 120-column crops, including combining scalars, without
// storing any request text. Overflow is explicit and supplies no crop authority.
const MAX_SUFFIX_SCALARS = 256, MAX_SUFFIX_HASHES = 8192;
type ClippedAdditions = {version: 1; status: 'overflow'} | {version: 1; status: 'complete'; startLine: number;
  lines: Array<{line: number; lineHash: string; nextLineHash: string; suffixHashes: string[]}>};
const suffixHash = (line: number, lineHash: string, nextLineHash: string, suffix: string) =>
  sha(JSON.stringify([line, lineHash, nextLineHash, suffix]));
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const autoplanEditLineHash = (line: string) => sha(line.replace(/\s/g, ''));
export interface AutoplanEditDigest {
  version: 1;
  beforeSHA256: string;
  requestSHA256: string;
  oldLineHashes: string[];
  newLineHashes: string[];
  clippedAdditions?: ClippedAdditions;
}
export function validAutoplanEditDigest(value: unknown): value is AutoplanEditDigest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const hashes = (a: unknown): a is string[] => Array.isArray(a) && a.length > 0 && a.length <= MAX_LINES &&
    Array.from(a).every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h));
  const base = Object.keys(v).length === (v.clippedAdditions === undefined ? 5 : 6) && v.version === 1 && typeof v.beforeSHA256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.beforeSHA256) && typeof v.requestSHA256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.requestSHA256) && hashes(v.oldLineHashes) && hashes(v.newLineHashes) &&
    v.oldLineHashes.length + v.newLineHashes.length <= MAX_LINES;
  if (!base) return false;
  if (v.clippedAdditions === undefined) return true;
  const c = v.clippedAdditions as Record<string, any>;
  if (!c || typeof c !== 'object' || Array.isArray(c) || c.version !== 1) return false;
  if (c.status === 'overflow') return Object.keys(c).length === 2;
  if (c.status !== 'complete' || Object.keys(c).length !== 4 || !Number.isSafeInteger(c.startLine) || c.startLine < 1 ||
      !Array.isArray(c.lines) || !c.lines.length || c.lines.length > MAX_LINES) return false;
  let count = 0, previousLine = c.startLine - 1;
  return Array.from(c.lines).every((row: any) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 4 ||
        !Number.isSafeInteger(row.line) || row.line <= previousLine || row.line < c.startLine ||
        row.line >= c.startLine + (v.newLineHashes as string[]).length ||
        row.lineHash !== (v.newLineHashes as string[])[row.line - c.startLine] ||
        typeof row.nextLineHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.nextLineHash) ||
        (row.line - c.startLine + 1 < (v.newLineHashes as string[]).length &&
          row.nextLineHash !== (v.newLineHashes as string[])[row.line - c.startLine + 1]) ||
        !hashes(row.suffixHashes) || row.suffixHashes.length > MAX_SUFFIX_SCALARS) return false;
    previousLine = row.line; count += row.suffixHashes.length;
    return count <= MAX_SUFFIX_HASHES;
  });
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
export function createAutoplanEditDigest(file: string, removed: string, added: string, clipped = true): AutoplanEditDigest | undefined {
  const oldLines = removed.split('\n'), newLines = added.split('\n');
  if (!removed || removed === added || oldLines.length + newLines.length > MAX_LINES) return undefined;
  const bytes = readAutoplanDigestFile(file); if (!bytes) return undefined;
  const before = bytes.toString('utf8'), at = before.indexOf(removed);
  // Require one exact old substring. Only complete request lines can match a
  // displayed row; partial edge lines cannot establish added-line authority.
  if (!Buffer.from(before).equals(bytes) || at < 0 || at !== before.lastIndexOf(removed)) return undefined;
  const digest: AutoplanEditDigest = { version: 1, beforeSHA256: sha(bytes), requestSHA256: sha(JSON.stringify([removed, added])),
    oldLineHashes: oldLines.map(autoplanEditLineHash), newLineHashes: newLines.map(autoplanEditLineHash) };
  const end = at + removed.length;
  if (!clipped || (at > 0 && before[at - 1] !== '\n') || (end < before.length && before[end] !== '\n')) return digest;
  if (Buffer.byteLength(added) > MAX_BYTES) { digest.clippedAdditions = {version: 1, status: 'overflow'}; return digest; }
  const startLine = before.slice(0, at).split('\n').length;
  const afterLine = end < before.length ? before.slice(end + 1).split('\n', 1)[0] : undefined;
  const originals = new Set(before.split('\n').map(autoplanEditLineHash));
  const candidates = newLines.map((text, index) => ({index, scalars: Array.from(text.replace(/\s/g, ''))}))
    .filter(row => row.scalars.length && !originals.has(digest.newLineHashes[row.index]!) &&
      !digest.oldLineHashes.includes(digest.newLineHashes[row.index]!) && (row.index + 1 < newLines.length || afterLine !== undefined));
  const count = candidates.reduce((sum, row) => sum + Math.min(row.scalars.length, MAX_SUFFIX_SCALARS), 0);
  if (count > MAX_SUFFIX_HASHES) digest.clippedAdditions = {version: 1, status: 'overflow'};
  else if (count) digest.clippedAdditions = {version: 1, status: 'complete', startLine, lines: candidates.map(row => {
    const line = startLine + row.index, lineHash = digest.newLineHashes[row.index]!;
    const nextLineHash = digest.newLineHashes[row.index + 1] ?? autoplanEditLineHash(afterLine!);
    return {line, lineHash, nextLineHash, suffixHashes: Array.from({length: Math.min(row.scalars.length, MAX_SUFFIX_SCALARS)},
      (_, index) => suffixHash(line, lineHash, nextLineHash, row.scalars.slice(-index - 1).join('')))};
  })};
  return digest;
}

/** Require complete numbered rows and the marker column of this exact diff. */
export function matchesAutoplanDigestRows(rows: string[], before: Buffer, digest: AutoplanEditDigest,
  allowReplacementReset = false): boolean {
  if (!validAutoplanEditDigest(digest) || sha(before) !== digest.beforeSHA256) return false;
  const fullRow = /^( {0,3})([1-9]\d*) ([+ -])(.*)$/;
  const first = rows.findIndex(row => fullRow.test(row));
  const leading = first > 0 ? rows.slice(0, first) : [];
  const chunks: Array<{kind: string; text: string; line: number}> = [];
  let column: number | undefined, previousLine = 0;
  let removedStart: number | undefined, replacementReset = false;
  for (const row of leading.length ? rows.slice(first) : rows) {
    const full = fullRow.exec(row);
    if (full) {
      const line = Number(full[2]), markerColumn = full[1]!.length + full[2]!.length + 1;
      const kind = full[3]!, previousKind = chunks.at(-1)?.kind;
      // The complete native replacement panel numbers the old block first,
      // then restarts additions at that block's first line. Only the caller
      // that owns this full panel opts in; all row hashes still must match.
      const reset = allowReplacementReset && !replacementReset && previousKind === '-' && kind === '+' && line === removedStart;
      if (!Number.isSafeInteger(line) || (line < previousLine && !reset) ||
          (column !== undefined && column !== markerColumn)) return false;
      if (allowReplacementReset) {
        if ((kind === '-' || kind === '+') && kind === previousKind && line !== previousLine + 1) return false;
        if (kind === '-' && previousKind !== '-') {
          if (removedStart !== undefined || chunks.some(c => c.kind === '+')) return false;
          removedStart = line;
        }
        if (previousKind === '-' && kind !== '-' && !reset) return false;
        if (kind === '+' && previousKind !== '+' && removedStart !== undefined && !reset) return false;
        if (reset) replacementReset = true;
      }
      column = markerColumn; previousLine = line;
      chunks.push({kind, text: full[4]!, line});
    } else {
      if (column === undefined || !row.startsWith(' '.repeat(column))) return false;
      const last = chunks.at(-1), kind = row[column];
      if (!last || kind !== last.kind) return false;
      last.text += row.slice(column + 1);
    }
  }
  const originals = new Set(before.toString('utf8').split('\n').map(autoplanEditLineHash));
  if (allowReplacementReset) {
    const oldRows = chunks.filter(c => c.kind !== '+').map(c => autoplanEditLineHash(c.text));
    const newRows = chunks.filter(c => c.kind !== '-').map(c => autoplanEditLineHash(c.text));
    const starts = (rows: string[], hashes: string[]) => rows.flatMap((_, index) =>
      hashes.every((hash, offset) => rows[index + offset] === hash) ? [index] : []);
    const oldStarts = starts(oldRows, digest.oldLineHashes), newStarts = starts(newRows, digest.newLineHashes);
    if (oldStarts.length !== 1 || newStarts.length !== 1 || oldStarts[0] !== newStarts[0]) return false;
    const originalLines = before.toString('utf8').split('\n').map(autoplanEditLineHash);
    const delta = digest.newLineHashes.length - digest.oldLineHashes.length;
    let oldLine = chunks[0]!.line, newLine = oldLine, added = false;
    for (const row of chunks) {
      if (row.kind !== '+') {
        if (row.line !== oldLine + (added ? delta : 0) || autoplanEditLineHash(row.text) !== originalLines[oldLine - 1]) return false;
        oldLine++;
      }
      if (row.kind !== '-' && row.line !== newLine++) return false;
      if (row.kind === '+') added = true;
    }
  }
  let authenticatedClip = false;
  if (leading.length) {
    const c = digest.clippedAdditions, next = chunks[0];
    if (!c || c.status !== 'complete' || column === undefined || !next || chunks.length < 2 ||
        leading.length > MAX_SUFFIX_SCALARS || leading.some(row =>
          !row.startsWith(' '.repeat(column)) || row[column] !== '+')) return false;
    const fragment = leading.map(row => row.slice(column + 1)).join('').replace(/\s/g, '');
    const length = Array.from(fragment).length, record = c.lines.find(row => row.line === next.line - 1);
    if (!record || !length || length > MAX_SUFFIX_SCALARS || record.nextLineHash !== autoplanEditLineHash(next.text) ||
        originals.has(record.lineHash) || digest.oldLineHashes.includes(record.lineHash) ||
        record.suffixHashes[length - 1] !== suffixHash(record.line, record.lineHash, record.nextLineHash, fragment)) return false;
    const beforeLines = before.toString('utf8').split('\n');
    if (chunks.some((row, index) => {
      if (row.line !== next.line + index || row.kind === '-') return true;
      const relative = row.line - c.startLine, hash = autoplanEditLineHash(row.text);
      if (relative < digest.newLineHashes.length) return digest.newLineHashes[relative] !== hash;
      const originalIndex = row.line - (digest.newLineHashes.length - digest.oldLineHashes.length) - 1;
      return row.kind !== ' ' || originalIndex < 0 || originalIndex >= beforeLines.length ||
        autoplanEditLineHash(beforeLines[originalIndex]!) !== hash;
    })) return false;
    authenticatedClip = true;
  }
  return chunks.length >= 2 && (authenticatedClip || chunks.some(c => c.kind === '+' && /\S/.test(c.text) &&
      !originals.has(autoplanEditLineHash(c.text)) && !digest.oldLineHashes.includes(autoplanEditLineHash(c.text)))) &&
    chunks.every(c => c.kind === '+' ? digest.newLineHashes.includes(autoplanEditLineHash(c.text)) :
      originals.has(autoplanEditLineHash(c.text)) && (c.kind !== '-' || digest.oldLineHashes.includes(autoplanEditLineHash(c.text))));
}
