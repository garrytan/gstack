/**
 * jsonl-store — shared plumbing for gstack's append-only JSONL stores in
 * lib/ and bin/. (browse/src keeps its own appenders by design — the
 * compiled-binary surface has different logging semantics and its own
 * secure-append helper.)
 *
 * The three things a JSONL store must get right:
 *   1. Injection screening — SEE THE CONTRACT BELOW: appendJsonl does NOT
 *      screen; callers that store free text MUST pre-check with
 *      hasInjection()/firstInjectionMatch() and reject. Enforcing callers
 *      today: bin/gstack-learnings-log, bin/gstack-decision-log (via
 *      lib/gstack-decision.ts), bin/gstack-question-log.
 *   2. Atomic single-line append (concurrent agents must not corrupt the file).
 *   3. Tolerant read (a partially-written tail or one corrupt line must not
 *      take down the whole read).
 *
 * Extracted from `bin/gstack-learnings-log` (D2A) so the learnings/decision/
 * question stores share ONE audited path — a new injection pattern or a
 * write-atomicity fix lands in all at once.
 */

import { appendFileSync, readFileSync, existsSync } from "fs";

/**
 * Prompt-injection patterns. If any matches a free-text field (insight, rationale,
 * decision), the record is REJECTED at write time — these strings could otherwise
 * be replayed into a future agent's context as instructions when the record is
 * resurfaced. Keep this list the ONLY copy (callers import it; do not re-declare).
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?previous\s+(instructions|context|rules)/i,
  /you\s+are\s+now\s+/i,
  /always\s+output\s+no\s+findings/i,
  /skip\s+(all\s+)?(security|review|checks)/i,
  /\boverride\s+(all\s+)?(previous|prior|above|the\s+(rules|instructions|system\s+prompt))/i,
  /\bsystem\s*:/i,
  /\bassistant\s*:/i,
  /\buser\s*:/i,
  /\bhuman\s*:/i, // Claude's native turn prefix — bypassed the denylist AND datamark
  /disregard\s+(all\s+)?(previous|above|prior)/i,
  /from\s+now\s+on\b/i,
  /do\s+not\s+(report|flag|mention)/i,
  /approve\s+(all|every|this)/i,
];

/** True if `text` contains an instruction-like injection pattern. */
export function hasInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

/** Returns the first injection pattern that matches, or null. For actionable errors. */
export function firstInjectionMatch(text: string): RegExp | null {
  return INJECTION_PATTERNS.find((p) => p.test(text)) ?? null;
}

/**
 * Atomic single-line append of `obj` as one JSON line.
 *
 * Concurrency: opens with `a` (O_APPEND); a single write under PIPE_BUF (>=512,
 * 4096+ on macOS/Linux) is atomic across processes, so concurrent agents appending
 * never interleave. Records MUST serialize to a single line (no embedded newline) —
 * we throw rather than risk a multi-line record breaking the one-record-per-line
 * invariant the tolerant reader relies on.
 *
 * Caveat: a record larger than PIPE_BUF loses the cross-process atomicity guarantee.
 * Keep records line-bounded; very large free-text should be truncated by the caller.
 */
export function appendJsonl(path: string, obj: unknown, opts: { mode?: number } = {}): void {
  const line = JSON.stringify(obj);
  if (line.includes("\n")) {
    throw new Error("jsonl-store: record serialized to multiple lines (embedded newline)");
  }
  // `mode` applies only when the append CREATES the file (POSIX open(2)
  // semantics) — pass 0o600 for stores holding sensitive content so the
  // file never exists world-readable.
  if (opts.mode !== undefined) {
    appendFileSync(path, line + "\n", { encoding: "utf-8", mode: opts.mode });
  } else {
    appendFileSync(path, line + "\n", { encoding: "utf-8" });
  }
}

/**
 * Tolerant reader: parse each line, SKIP malformed ones (partial-write tail, a
 * corrupt line, a non-JSON line) rather than throwing. A broken line never takes
 * down the whole read. Missing file → empty array. Unknown fields are preserved
 * (forward-compatible: a schema bump on the writer doesn't break older readers).
 */
export function readJsonl<T = unknown>(path: string): T[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Malformed line (partial tail / corruption) — skip, keep reading.
    }
  }
  return out;
}
