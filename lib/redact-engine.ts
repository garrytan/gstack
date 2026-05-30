/**
 * redact-engine — pure scanning + auto-redaction over the shared taxonomy.
 *
 * No I/O. Deterministic. The CLI shim (`bin/gstack-redact`), the pre-push hook
 * (`bin/gstack-redact-prepush`), and tests all import from here.
 *
 * Key behaviors (locked in /plan-eng-review + two Codex passes):
 *   - Normalization BEFORE matching (NFKC + strip zero-width + decode a small
 *     set of HTML entities) so Unicode-confusable / zero-width evasion fails.
 *     Findings map back to ORIGINAL offsets via an index map.
 *   - ReDoS safety: a hard input-size cap that fails CLOSED (oversize input
 *     returns a single synthetic HIGH "input too large to scan safely" finding,
 *     so callers block rather than skip). Patterns are linear-time (lint-tested).
 *   - NO visibility-based tier mutation. `repoVisibility` is recorded on each
 *     finding (drives sterner AUQ wording in the skill) but never promotes a
 *     MEDIUM to HIGH. (TENSION-2-followup.)
 *   - Placeholder suppression is per-matched-span.
 *   - Tool-attributed fences (``` ```codex-review ``` / ``` ```greptile ```)
 *     degrade credential findings to a non-blocking WARN — UNLESS the span is a
 *     live-format credential the doc-example heuristic can't excuse. No nonce,
 *     no trust exemption (the marker scheme was dropped as theater).
 */

import {
  PATTERNS,
  PATTERNS_BY_ID,
  isPlaceholderSpan,
  type RedactPattern,
  type Tier,
  type Category,
} from "./redact-patterns";

export type RepoVisibility = "public" | "private" | "unknown";

/** A WARN is a finding that does not block but is surfaced (tool-fence degrade). */
export type Severity = Tier | "WARN";

export interface Finding {
  id: string;
  tier: Tier;
  /** Effective severity after tool-fence degrade. HIGH/MEDIUM/LOW or WARN. */
  severity: Severity;
  category: Category;
  description: string;
  /** 1-based line in the ORIGINAL (un-normalized) text. */
  line: number;
  /** 1-based column in the ORIGINAL text. */
  col: number;
  /** Safe-masked preview (never more than 4 leading chars of the secret). */
  preview: string;
  /** Whether this finding offers one-keystroke auto-redact (PII subset). */
  autoRedactable: boolean;
  /** Repo visibility at scan time — drives sterner AUQ wording, not the tier. */
  repoVisibility: RepoVisibility;
  /** True when degraded to WARN because it sat in a tool-attributed fence. */
  toolFenceDegraded?: boolean;
}

export interface ScanOptions {
  repoVisibility?: RepoVisibility;
  /** Extra allowlist entries (exact strings) that suppress a matched span. */
  allowlist?: string[];
  /** The invoking user's own email (from `git config user.email`) — allowlisted. */
  selfEmail?: string;
  /**
   * Emails already public in the repo (git log authors, package.json, CODEOWNERS).
   * Suppressed for `pii.email` since they're not a new leak.
   */
  repoPublicEmails?: string[];
  /** Hard byte cap. Oversize input fails CLOSED. Default 1 MiB. */
  maxBytes?: number;
}

export interface ScanResult {
  findings: Finding[];
  counts: { HIGH: number; MEDIUM: number; LOW: number; WARN: number };
  repoVisibility: RepoVisibility;
  /** True when the input-size cap tripped (caller should BLOCK). */
  oversize: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

const EMAIL_ALLOW_DOMAINS = [/@example\.(com|org|net)$/i, /@example\.[a-z]{2,}$/i];
const EMAIL_ALLOW_LOCALPARTS = [/^noreply@/i, /^no-reply@/i, /^donotreply@/i];

// ── Normalization ─────────────────────────────────────────────────────────────

const ZERO_WIDTH = /[​‌‍⁠﻿]/g;
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Normalize text for matching while producing an index map back to the original.
 * Returns the normalized string and a function mapping a normalized offset to
 * the corresponding original offset.
 *
 * Strategy: walk the original char-by-char, applying NFKC per char, dropping
 * zero-width chars, and expanding a small fixed set of HTML entities. Each
 * emitted normalized char records the original offset it came from. This keeps
 * the map exact for the transformations we apply (which are all local).
 */
export function normalizeWithMap(input: string): {
  normalized: string;
  map: number[];
} {
  const out: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i < input.length) {
    // HTML entity expansion (fixed small set; longest first).
    let matchedEntity = false;
    for (const ent in HTML_ENTITIES) {
      if (input.startsWith(ent, i)) {
        const rep = HTML_ENTITIES[ent];
        for (const ch of rep) {
          out.push(ch);
          map.push(i);
        }
        i += ent.length;
        matchedEntity = true;
        break;
      }
    }
    if (matchedEntity) continue;

    const ch = input[i];
    if (ZERO_WIDTH.test(ch)) {
      ZERO_WIDTH.lastIndex = 0;
      i += 1;
      continue;
    }
    ZERO_WIDTH.lastIndex = 0;

    const norm = ch.normalize("NFKC");
    for (const nch of norm) {
      out.push(nch);
      map.push(i);
    }
    i += 1;
  }
  // Sentinel so an offset == length maps to the original length.
  map.push(input.length);
  return { normalized: out.join(""), map };
}

// ── Offset → line/col on the ORIGINAL text ────────────────────────────────────

function lineColAt(original: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < original.length; i++) {
    if (original[i] === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

// ── Safe preview masking ──────────────────────────────────────────────────────

/** Show ≤4 leading chars, mask the rest. Never reconstructable. */
export function maskPreview(span: string): string {
  const visible = span.slice(0, 4);
  const masked = span.length > 4 ? "*".repeat(Math.min(span.length - 4, 8)) : "";
  return `${visible}${masked}${span.length > 12 ? "…" : ""}`;
}

// ── Tool-attributed fence detection ───────────────────────────────────────────

const TOOL_FENCE_INFO = /^```(codex-review|greptile|eval|codex|tool-output)\b/;

/**
 * Returns a sorted list of [start, end) offset ranges (in normalized text) that
 * sit inside a tool-attributed fenced code block. Credential findings inside
 * these ranges degrade to WARN (unless the doc-example heuristic says the span
 * is live-format and must still block).
 */
function toolFenceRanges(normalized: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = normalized.split("\n");
  let offset = 0;
  let inFence = false;
  let fenceStart = 0;
  for (const ln of lines) {
    const isFenceMarker = ln.startsWith("```");
    if (isFenceMarker) {
      if (!inFence && TOOL_FENCE_INFO.test(ln)) {
        inFence = true;
        fenceStart = offset + ln.length + 1; // content starts after this line
      } else if (inFence) {
        ranges.push([fenceStart, offset]); // up to start of closing fence
        inFence = false;
      }
    }
    offset += ln.length + 1; // +1 for the \n
  }
  if (inFence) ranges.push([fenceStart, normalized.length]); // unterminated → still degrade its own body
  return ranges;
}

function inRanges(offset: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) if (offset >= s && offset < e) return true;
  return false;
}

/**
 * Doc-example heuristic: a credential span inside a tool fence still BLOCKS if
 * it looks like a LIVE credential (not an obvious placeholder/example). We only
 * downgrade-to-WARN spans that are clearly illustrative.
 */
function isObviousDocExample(span: string): boolean {
  return isPlaceholderSpan(span);
}

// ── Proximity check ───────────────────────────────────────────────────────────

function hasNear(
  normalized: string,
  matchStart: number,
  matchEnd: number,
  nearRegex: RegExp,
  window: number,
): boolean {
  const from = Math.max(0, matchStart - window);
  const to = Math.min(normalized.length, matchEnd + window);
  const slice = normalized.slice(from, to);
  const re = new RegExp(nearRegex.source, nearRegex.flags.replace(/g/g, ""));
  return re.test(slice);
}

// ── Email allowlist ───────────────────────────────────────────────────────────

function emailAllowed(email: string, opts: ScanOptions): boolean {
  const lower = email.toLowerCase();
  if (opts.selfEmail && lower === opts.selfEmail.toLowerCase()) return true;
  if (opts.repoPublicEmails?.some((e) => e.toLowerCase() === lower)) return true;
  if (EMAIL_ALLOW_DOMAINS.some((re) => re.test(email))) return true;
  if (EMAIL_ALLOW_LOCALPARTS.some((re) => re.test(email))) return true;
  return false;
}

// ── The scan ──────────────────────────────────────────────────────────────────

export function scan(input: string, opts: ScanOptions = {}): ScanResult {
  const repoVisibility: RepoVisibility = opts.repoVisibility ?? "unknown";
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // Fail CLOSED on oversize input. Check byte length BEFORE heavy work.
  const byteLen = Buffer.byteLength(input, "utf8");
  if (byteLen > maxBytes) {
    const finding: Finding = {
      id: "engine.input_too_large",
      tier: "HIGH",
      severity: "HIGH",
      category: "secret",
      description: `Input too large to scan safely (${byteLen} > ${maxBytes} bytes) — blocking fail-closed`,
      line: 1,
      col: 1,
      preview: "",
      autoRedactable: false,
      repoVisibility,
    };
    return {
      findings: [finding],
      counts: { HIGH: 1, MEDIUM: 0, LOW: 0, WARN: 0 },
      repoVisibility,
      oversize: true,
    };
  }

  const { normalized, map } = normalizeWithMap(input);
  const fenceRanges = toolFenceRanges(normalized);
  const allow = new Set(opts.allowlist ?? []);

  const findings: Finding[] = [];
  // Dedup by (id, original-offset) so overlapping global matches don't double-count.
  const seen = new Set<string>();

  for (const pat of PATTERNS) {
    const re = new RegExp(pat.regex.source, withFlags(pat.regex.flags));
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized)) !== null) {
      // Guard against zero-width matches looping forever.
      if (m.index === re.lastIndex) re.lastIndex++;

      const span = m[1] ?? m[0];
      const spanStartInMatch = m[1] !== undefined ? m[0].indexOf(m[1]) : 0;
      const normOffset = m.index + Math.max(0, spanStartInMatch);

      // Per-span placeholder suppression.
      if (isPlaceholderSpan(span)) continue;
      if (allow.has(span)) continue;

      // Pattern-specific validators (Luhn, entropy, RFC1918, etc).
      if (pat.validate && !pat.validate(span, m)) continue;

      // Proximity requirement.
      if (
        pat.nearRegex &&
        !hasNear(normalized, m.index, m.index + m[0].length, pat.nearRegex, pat.nearWindow ?? 100)
      ) {
        continue;
      }

      // Email allowlist (layered on top of the pattern).
      if (pat.id === "pii.email" && emailAllowed(span, opts)) continue;

      const origOffset = map[Math.min(normOffset, map.length - 1)] ?? 0;
      const key = `${pat.id}:${origOffset}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { line, col } = lineColAt(input, origOffset);

      // Tool-fence degrade: only credential-category, only obvious doc examples.
      let severity: Severity = pat.tier;
      let toolFenceDegraded = false;
      if (
        pat.category === "secret" &&
        inRanges(normOffset, fenceRanges) &&
        isObviousDocExample(span)
      ) {
        severity = "WARN";
        toolFenceDegraded = true;
      }

      findings.push({
        id: pat.id,
        tier: pat.tier,
        severity,
        category: pat.category,
        description: pat.description,
        line,
        col,
        preview: maskPreview(span),
        autoRedactable: !!pat.autoRedactable,
        repoVisibility,
        ...(toolFenceDegraded ? { toolFenceDegraded } : {}),
      });
    }
  }

  // Stable order: by line, then col, then id.
  findings.sort((a, b) => a.line - b.line || a.col - b.col || a.id.localeCompare(b.id));

  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, WARN: 0 };
  for (const f of findings) counts[f.severity] += 1;

  return { findings, counts, repoVisibility, oversize: false };
}

function withFlags(flags: string): string {
  let f = flags;
  if (!f.includes("g")) f += "g";
  if (!f.includes("m")) f += "m";
  return f;
}

// ── Auto-redaction ────────────────────────────────────────────────────────────

export interface RedactResult {
  body: string;
  /** ASCII unified-diff preview of the substitutions. */
  diff: string;
  /** Findings that could NOT be auto-redacted (structural-corruption guard). */
  skipped: Finding[];
}

/**
 * Substitute redact tokens for the given finding ids, right-to-left so offsets
 * stay valid. Refuses to redact a span that sits inside a structural token
 * (markdown link target, JSON string value) — those fall back to `skipped` so
 * the skill drops the user to manual edit rather than silently mangling output.
 */
export function applyRedactions(
  input: string,
  findingIds: string[],
  opts: ScanOptions = {},
): RedactResult {
  const ids = new Set(findingIds);
  const { findings } = scan(input, opts);
  const targets = findings
    .filter((f) => ids.has(f.id) && f.autoRedactable)
    .map((f) => ({ f, ...locateSpan(input, f) }))
    .filter((t) => t.start >= 0);

  // Right-to-left so earlier offsets remain valid after splicing.
  targets.sort((a, b) => b.start - a.start);

  const skipped: Finding[] = [];
  const diffLines: string[] = [];
  let body = input;

  for (const t of targets) {
    const pat = PATTERNS_BY_ID[t.f.id];
    const token = pat?.redactToken ?? "<REDACTED>";
    if (inStructuralToken(body, t.start, t.end)) {
      skipped.push(t.f);
      continue;
    }
    const before = lineContaining(body, t.start);
    body = body.slice(0, t.start) + token + body.slice(t.end);
    const after = lineContaining(body, t.start);
    diffLines.push(`- ${before}`);
    diffLines.push(`+ ${after}`);
  }

  return { body, diff: diffLines.reverse().join("\n"), skipped };
}

function locateSpan(input: string, f: Finding): { start: number; end: number } {
  // Re-derive the offset from line/col on the original text.
  let offset = 0;
  let line = 1;
  while (line < f.line && offset < input.length) {
    if (input[offset] === "\n") line++;
    offset++;
  }
  offset += f.col - 1;
  const pat = PATTERNS_BY_ID[f.id];
  if (!pat) return { start: -1, end: -1 };
  const re = new RegExp(pat.regex.source, withFlags(pat.regex.flags));
  re.lastIndex = Math.max(0, offset - 2);
  const m = re.exec(input);
  if (!m) return { start: -1, end: -1 };
  const span = m[1] ?? m[0];
  const start = m.index + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0);
  return { start, end: start + span.length };
}

function inStructuralToken(body: string, start: number, end: number): boolean {
  // Markdown link target: [text](...span...). The span may sit anywhere inside
  // the parenthesized target (e.g. an email embedded in a URL). Walk backward
  // from the span: if we reach `](` before hitting `)`/whitespace, and forward
  // we reach `)` before whitespace, the span is inside a link target.
  for (let i = start - 1; i >= 0; i--) {
    const ch = body[i];
    if (ch === ")" || ch === "\n" || ch === " " || ch === "\t") break;
    if (ch === "(" && i > 0 && body[i - 1] === "]") {
      for (let j = end; j < body.length; j++) {
        const c = body[j];
        if (c === " " || c === "\t" || c === "\n") break;
        if (c === ")") return true;
      }
      break;
    }
  }
  // JSON string value: "key": "...span..."  — span is inside a quoted value.
  const before = body.slice(Math.max(0, start - 80), start);
  const after = body.slice(end, Math.min(body.length, end + 4));
  if (/:\s*"$/.test(before) && /^"/.test(after)) return true;
  return false;
}

function lineContaining(body: string, offset: number): string {
  const start = body.lastIndexOf("\n", offset - 1) + 1;
  let end = body.indexOf("\n", offset);
  if (end === -1) end = body.length;
  return body.slice(start, end);
}

// ── Exit-code helper for the CLI shim ─────────────────────────────────────────

/** 0 clean, 2 MEDIUM present (no HIGH), 3 HIGH present. WARN does not gate. */
export function exitCodeFor(result: ScanResult): 0 | 2 | 3 {
  if (result.counts.HIGH > 0) return 3;
  if (result.counts.MEDIUM > 0) return 2;
  return 0;
}
