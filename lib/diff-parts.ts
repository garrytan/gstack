/**
 * diff-parts — one `git diff` read with no output buffer to fill (GST-4003).
 *
 * A pipe read with spawnSync stops at its maxBuffer: harness-evals#616's added lines came to 255.7 MB against the secrets
 * scan's 256 MiB, so a slightly larger results PR could not be scanned at all. Here git writes to a private file (mode
 * 0600 in a 0700 directory, removed afterwards), and the caller gets it back in parts of about `partBytes`, each ending
 * where the next `diff --` header starts. Inside a hunk every line starts with ' ', '+', '-', '\\' or '@@', and git quotes
 * a name holding a newline, so a line starting `diff --` is always a file header: each file's section arrives whole in one
 * part, and the parts joined are git's output byte for byte. A per-file parser fed every part in order therefore sees
 * what it saw on the whole text.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from './spawn-sync';

export const DIFF_PART_BYTES = 64 * 1024 * 1024;
const HEADER = Buffer.from('\ndiff --');

export interface DiffRun { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }
export type DiffRead = { ok: true } | { ok: false; why: string };

/** Run `git <args>` and hand each part of its stdout to `each` in order; a git that did not finish (an exit, a kill, a timeout) is not ok. */
export function gitDiffInParts(args: readonly string[], run: DiffRun, each: (part: string) => void, partBytes = DIFF_PART_BYTES): DiffRead {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-diff-'));
  try {
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'out.diff');
    const fd = fs.openSync(file, 'w', 0o600);
    let r: ReturnType<typeof spawnSync>;
    try { r = spawnSync('git', [...args], { cwd: run.cwd, env: run.env, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: run.timeout }); } finally { fs.closeSync(fd); }
    if (r.error || r.status !== 0) return { ok: false, why: r.error?.message ?? (r.status === null ? `killed by ${r.signal}` : `exit ${r.status}: ${String(r.stderr ?? '').trim().split('\n').pop() ?? ''}`) };
    const input = fs.openSync(file, 'r');
    try {
      const pending: Buffer[] = [];
      let held = 0;
      let tail = Buffer.alloc(0);
      for (;;) {
        const chunk = Buffer.alloc(Math.max(1, partBytes));
        const n = fs.readSync(input, chunk, 0, chunk.length, null);
        if (n <= 0) break;
        const read = chunk.subarray(0, n);
        const seen = Buffer.concat([tail, read]);
        let cut = -1;
        for (let at = seen.indexOf(HEADER); at >= 0; at = seen.indexOf(HEADER, at + 1)) cut = held - tail.length + at + 1;
        pending.push(read);
        held += n;
        tail = Buffer.from(seen.subarray(Math.max(0, seen.length - HEADER.length + 1)));
        if (cut <= 0) continue;
        const all = Buffer.concat(pending, held);
        each(all.subarray(0, cut).toString('utf8'));
        pending.splice(0, pending.length, Buffer.from(all.subarray(cut)));
        held -= cut;
      }
      if (held) each(Buffer.concat(pending, held).toString('utf8'));
    } finally { fs.closeSync(input); }
    return { ok: true };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Fold per-part maps from a per-file parser into one, in the order the whole text would have built it. */
export function mergeParts<T>(into: Map<string, T[]>, part: Map<string, T[]>): void {
  for (const [k, v] of part) { const have = into.get(k); if (have) for (const x of v) have.push(x); else into.set(k, v); }
}
