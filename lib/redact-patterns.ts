/**
 * redact-patterns — the canonical redaction taxonomy.
 *
 * Single source of truth shared by `lib/redact-engine.ts`, `bin/gstack-redact`,
 * `bin/gstack-redact-prepush`, and (via `scripts/resolvers/redact-doc.ts`) the
 * generated SKILL.md docs for /spec, /ship, /cso, /document-release, and
 * /document-generate.
 *
 * Design notes (locked in /plan-eng-review + two Codex passes):
 *
 *   - Three tiers. HIGH = genuinely-secret credentials (block). MEDIUM = PII,
 *     legal/damaging, internal-leak, plus credential-shaped patterns that have
 *     high false-positive rates (confirm via AskUserQuestion). LOW = surface only.
 *   - NO wholesale MEDIUM->HIGH promotion on public repos (TENSION-2-followup).
 *     Public repos get sterner per-finding confirmation, not auto-block. The
 *     engine never mutates a finding's tier based on visibility.
 *   - Tier-1 calibration: a gate that cries wolf gets ignored. Stripe
 *     publishable keys, Google AIza keys, JWTs, and env-style KV are MEDIUM, not
 *     HIGH (they are context-variable / high-FP). Only genuinely-secret
 *     credentials block.
 *   - ReDoS safety: every pattern here MUST be linear-time (no nested unbounded
 *     quantifiers). `test/redact-pattern-lint.test.ts` fails CI on a catastrophic
 *     form. The engine also enforces a hard input-size cap that fails CLOSED.
 *   - Placeholder suppression is per-matched-span, not per-line.
 *
 * Pattern matching contract: every `regex` is used with the global+multiline
 * flags the engine applies (`g`, `m`). Capture group 1, when present, is the
 * "secret span" the engine masks and (for proximity rules) anchors on; when
 * absent, match[0] is the span.
 */

export type Tier = "HIGH" | "MEDIUM" | "LOW";

export type Category =
  | "secret"
  | "pii"
  | "legal"
  | "internal"
  | "hygiene";

export interface RedactPattern {
  /** Stable dotted id, e.g. "aws.access_key". Used in findings + tests. */
  id: string;
  tier: Tier;
  category: Category;
  /** Human-readable one-liner for the findings table + docs. */
  description: string;
  /**
   * The detection regex. Linter-enforced linear-time. The engine adds the
   * `gm` flags; do not bake `g`/`m` into the source here (keeps `.source`
   * clean for the docs table and avoids double-global bugs).
   */
  regex: RegExp;
  /**
   * Patterns whose redaction is unambiguous enough to offer one-keystroke
   * auto-redact at MEDIUM tier (email / phone / ssn / cc). The engine wires
   * the `<REDACTED-*>` replacement token from `redactToken`.
   */
  autoRedactable?: boolean;
  /** Replacement token for auto-redact, e.g. "<REDACTED-EMAIL>". */
  redactToken?: string;
  /**
   * Extra validators run AFTER the regex matches, ALL must pass for the match
   * to count. Used for Luhn (credit cards), entropy (env-KV), checksum
   * (crypto wallets), RFC1918-exclusion (public IPs), etc. Receives the
   * matched secret span (group 1 or match[0]) and the full match array.
   */
  validate?: (span: string, match: RegExpExecArray, opts?: { sourcePath?: string }) => boolean;
  /**
   * Proximity requirement: the pattern only counts if `nearRegex` also matches
   * within `nearWindow` chars of the match. Used for AWS secret keys (need
   * `aws_secret_access_key` nearby) and Twilio auth tokens (need an SID nearby).
   */
  nearRegex?: RegExp;
  nearWindow?: number;
}

// ── Validators ──────────────────────────────────────────────────────────────

/** Luhn checksum — credit-card validity. Strips spaces/dashes first. */
export function luhnValid(span: string): boolean {
  const digits = span.replace(/[ \-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Shannon entropy in bits/char. Used to gate env-style KV (skip placeholders). */
export function shannonEntropy(s: string): number {
  if (!s.length) return 0;
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
  let h = 0;
  for (const ch in freq) {
    const p = freq[ch] / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// env.kv name-shape calibration: the regex's zero-or-more-prefix net matches
// ANY identifier ending in a credential suffix, so `cacheKey:`, `sortKey:`,
// `partitionKey:`, `hotkey:`, even `monkey:` with an 8+-char entropic value
// all hit a MEDIUM confirm prompt — a gate that cries wolf gets ignored.
// A matched name only counts when its shape is credential-semantic:
//   (i)   suffix separated from the prefix by _ / - / .  (api_key, x-access-key,
//         AUTH.TOKEN)
//   (ii)  the whole name IS the bare suffix              (key:, token:)
//   (iii) the name is ALL-CAPS env style                 (APIKEY=, MY_APIKEY=)
//   (iv)  a lowercase/camel compound whose prefix ends in a credential word
//         (apiKey, authToken, clientSecret, stripeApiKey) — cacheKey/sortKey/
//         monkey have no credential prefix and are rejected.
const ENV_KV_NAME =
  /^(?:[ +-]?\+|[ +-]?-(?! [^ \t]))?[ \t]*(?:export[ \t]+)?["']?([A-Za-z0-9_.-]*?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|DSN|AUTH|COOKIE|SESSION|PRIVATE))["']?[ \t]*[:=]/i;
const ENV_KV_SUFFIX =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|DSN|AUTH|COOKIE|SESSION|PRIVATE)$/i;
const ENV_KV_CRED_PREFIX =
  /(api|auth|access|secret|private|app|client|server|master|admin|signing|encryption|session|csrf|jwt|oauth|bearer)$/i;

/** True when the full env.kv match starts with a credential-shaped name. */
export function isCredentialShapedEnvName(fullMatch: string): boolean {
  const nameMatch = ENV_KV_NAME.exec(fullMatch);
  if (!nameMatch) return false;
  const name = nameMatch[1];
  const suffixMatch = ENV_KV_SUFFIX.exec(name);
  if (!suffixMatch) return false;
  const prefix = name.slice(0, name.length - suffixMatch[1].length);
  if (prefix === "") return true; // (ii) bare suffix
  if (/[_.\-]$/.test(prefix)) return true; // (i) separator before suffix
  if (!/[a-z]/.test(name)) return true; // (iii) ALL-CAPS env style
  return ENV_KV_CRED_PREFIX.test(prefix); // (iv) credential-semantic compound
}

/** True when an IPv4 string is a public address (not RFC1918/loopback/etc). */
export function isPublicIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1, 5).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 127) return false; // loopback
  if (a === 0) return false; // this-network
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
  if (a >= 224) return false; // multicast / reserved
  return true;
}

// EIP-55 checksum is out of scope (heavy); we require a length+charset match and
// reject all-same-char vanity strings to cut the worst FPs.
function looksLikeWallet(span: string): boolean {
  if (/^0x[a-fA-F0-9]{40}$/.test(span)) {
    // reject 0x000...0 / 0xfff...f style
    const body = span.slice(2).toLowerCase();
    return !/^(.)\1{39}$/.test(body);
  }
  // bech32 / base58 — length sanity only
  return span.length >= 26 && span.length <= 62;
}

// Compact log/backup stamps (`20260727202423` = YYYYMMDDHHMMSS) are bare digit
// runs that the phone regex happily eats. Only a SEPARATOR-FREE 14-digit span
// qualifies: E.164 tops out at 15 digits and real numbers carry a + or spacing,
// so rejecting this shape costs no phone coverage.
function looksLikeCompactTimestamp(span: string): boolean {
  if (!/^\d{14}$/.test(span)) {
    return false;
  }
  const n = (from: number, to: number) => Number(span.slice(from, to));
  const [year, month, day, hour, minute, second] = [
    n(0, 4),
    n(4, 6),
    n(6, 8),
    n(8, 10),
    n(10, 12),
    n(12, 14),
  ];
  return (
    year >= 1900 &&
    year <= 2999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

/**
 * Bare integers that programs print as constants: 2^30 through 2^49 and each
 * one minus one (`4294967296`, `2147483647`), and the 32-bit multipliers,
 * offsets and primes of common hashes and PRNGs (Knuth's multiplicative hash,
 * the golden-ratio constant, the glibc and Numerical Recipes LCGs, FNV-1a,
 * MurmurHash2 and 3, the MT19937 seeder, the largest 32-bit prime). pii.phone.e164
 * reads each as a bare 10-15 digit number. Only the exact separator-free value
 * is exempt: the same digits with a `+`, spaces, dashes or dots still report,
 * so an E.164 number, which carries its `+`, is never exempt.
 */
const NUMERIC_CONSTANTS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 20 }, (_, i) => 2n ** BigInt(30 + i)).flatMap((p) => [String(p), String(p - 1n)]),
  "2654435761",
  "2654435769",
  "1103515245",
  "1013904223",
  "2166136261",
  "1540483477",
  "3432918353",
  "2246822507",
  "3266489909",
  "1812433253",
  "4294967291",
]);

export function isNumericConstant(span: string): boolean {
  return NUMERIC_CONSTANTS.has(span);
}

/** Context window for pairing a normalized parcel ID with its punctuated form. */
const PARCEL_CONTEXT_CHARS = 400;

/**
 * County tax-map parcel ID (APN). Ohio's dominant form is NN-NNNNNNN.NNN, and
 * some counties use a hyphen before the 3-4 digit suffix instead of a dot.
 */
const PARCEL_PUNCT_RE = /\b\d{2}-\d{4,8}[.\-]\d{3,4}\b/g;

/**
 * A parcel ID reads as a national-format phone number to pii.phone.e164 — the
 * same collision class as the digit-only UUID that `insideUuid` already guards.
 * Land/title repos carry these by the hundred, so the false positives are not
 * incidental: they arrive on every branch that touches title, and a guardrail
 * that cries wolf on the domain's primary identifier trains people to wave the
 * warning through, which is how a real HIGH finding eventually gets ignored.
 *
 * Deliberately narrow, in two tiers:
 *
 * 1. The DOTTED form is exempt on its own shape. No phone convention places a
 *    dot before a trailing 3-4 digit group after a 4-8 digit middle, so this
 *    cannot swallow a real number. The hyphen-only variants (22-0001-000) are
 *    NOT exempted by shape — those genuinely are phone-shaped.
 *
 * 2. A DIGITS-ONLY span is phone-shaped in isolation, so it earns the exemption
 *    only by evidence: it must be the exact digit-normalization of a punctuated
 *    parcel ID within the surrounding window. Fixtures and marts always carry
 *    the pair ({parcel_id: "12-3456789.000", norm: "123456789000"}), and a bare
 *    phone number has no such twin nearby — so this reads the document's own
 *    evidence rather than guessing from digits.
 */
export function looksLikeParcelId(span: string, match: RegExpExecArray): boolean {
  if (/^\d{2}-\d{4,8}\.\d{3,4}$/.test(span)) return true;
  if (!/^\d{10,14}$/.test(span)) return false;

  const input = match.input ?? "";
  const spanStartInMatch = match[1] !== undefined ? match[0].indexOf(match[1]) : 0;
  const spanStart = match.index + Math.max(0, spanStartInMatch);
  const spanEnd = spanStart + span.length;
  const window = input.slice(
    Math.max(0, spanStart - PARCEL_CONTEXT_CHARS),
    spanEnd + PARCEL_CONTEXT_CHARS,
  );

  PARCEL_PUNCT_RE.lastIndex = 0;
  let p: RegExpExecArray | null;
  while ((p = PARCEL_PUNCT_RE.exec(window)) !== null) {
    if (p[0].replace(/\D/g, "") === span) return true;
  }
  return false;
}

/**
 * Vector geometry reads as a phone number to pii.phone.e164 (#2885, #2827).
 * The pattern accepts `.` as a group separator, so a single float
 * (`viewBox="0 0 581.66796875 695.65625"`) parses as 581 · 6679 · 6875, and a
 * run of path coordinates (`37.6188 101.694`, `100 64.5326 100`) as four
 * spaced groups. One rendered /diagram SVG carried 18 of these; a Figma icon
 * carries dozens per path.
 *
 * Phone conventions put a separator between EVERY group, so a token with
 * digits, one dot and digits is a decimal number, never a dotted phone
 * (415.555.0123 has two dots in one token and stays flagged). Exempt a span
 * whose space-separated tokens include at least one decimal and none with two
 * dots. A leading `+` is the E.164 marker, so a span starting with it is a
 * phone context and never exempt.
 */
export function looksLikeDecimalCoordinates(span: string): boolean {
  if (span.startsWith("+")) return false;
  const tokens = span.split(" ");
  if (tokens.some((t) => t.split(".").length > 2)) return false;
  return tokens.some((t) => /^\d+\.\d+$/.test(t));
}

/** Span start/end in `match.input`, derived exactly as redact-engine.ts does. */
function spanBounds(match: RegExpExecArray): { start: number; end: number } {
  const spanStartInMatch = match[1] !== undefined ? match[0].indexOf(match[1]) : 0;
  const start = match.index + Math.max(0, spanStartInMatch);
  return { start, end: start + (match[1] ?? match[0]).length };
}

/**
 * True when a digit span is one side of a decimal number: `<digit>.` sits
 * immediately before it or `.<digit>` immediately after. pii.cc's `\b` stops
 * at the dot, so the 14-digit fraction of `492.34399999999994` in an
 * .excalidraw scene is a Luhn candidate, and a random digit run passes Luhn
 * about one time in ten (#2827). A card number in prose is never glued to a
 * decimal point; a sentence-ending period has no digit after it and stays
 * flagged.
 */
export function insideDecimalNumber(match: RegExpExecArray): boolean {
  const input = match.input ?? "";
  const { start, end } = spanBounds(match);
  const digit = (i: number) => i >= 0 && i < input.length && input[i] >= "0" && input[i] <= "9";
  return (input[start - 1] === "." && digit(start - 2)) || (input[end] === "." && digit(end + 1));
}

/**
 * JSON keys whose unquoted integer value is a random seed, nonce or epoch
 * timestamp. Excalidraw writes three per element (`"seed":1808177121`,
 * `"versionNonce":1365644783`, `"updated":1791059590857`), and pii.phone.e164
 * reads each as a bare 10-13 digit number: 92 per /diagram scene (#2827).
 */
const NUMERIC_METADATA_KEY =
  /"[A-Za-z0-9_]*(?:seed|nonce|updated|created|timestamp)(?:at|_at|ms|_ms)?"[ \t]*:[ \t]*$/i;

/**
 * True when a digit-only span is the unquoted JSON value of a seed, nonce or
 * timestamp key. The evidence is the key, not the digits: the same number
 * under `"phone":` still reports.
 */
export function isNumericMetadataValue(span: string, match: RegExpExecArray): boolean {
  if (!/^\d+$/.test(span)) return false;
  const input = match.input ?? "";
  const { start } = spanBounds(match);
  const lineStart = input.lastIndexOf("\n", start - 1) + 1;
  return NUMERIC_METADATA_KEY.test(input.slice(Math.max(lineStart, start - 80), start));
}

/**
 * GitHub Actions run and job ids are bare 10-12 digit integers, so
 * pii.phone.e164 reads them as phone numbers. A published eval report prints
 * the run id inside the command the reader copies
 * (`bun run eval:pass-rates --run 37235771700`), and redacting it breaks that
 * command. Only the position decides: a run/job flag (`--run 37235771700`,
 * `--job=111534615007`), a `gh run view|watch|rerun|download|cancel`
 * argument, an `actions/runs/<id>` or `/job/<id>` URL segment, or a
 * `run_id` / `job_id` key. An 11-digit id (every GitHub Actions run id since
 * 2025) also counts right after a run word on the same line, the way a ship
 * receipt, a READY block or an approval record names one (`screen 40477638211
 * GREEN`, `gate=40323989742`, `rerun passed 40287239206`, `run #19368712345`);
 * generic words (id, job, attempt, workflow) exempt nothing, since `customer id
 * 14155551234` is a number. A national number written without its `+` right
 * after a run word (`failed 14155551234`) is the accepted residual of the
 * owner's ruling that a run id is not a phone number; gstack-post's chained-id
 * allowlist reads the same position the same way. The same digits anywhere
 * else still report.
 */
const CI_ID_POSITION_BEFORE =
  /(?:--(?:run|job)(?:-id)?(?:[ \t]+|[ \t]*=[ \t]*)|\bgh[ \t]+run[ \t]+(?:view|watch|rerun|download|cancel)[ \t]+|\/actions\/runs\/|\/jobs?\/|(?:run|job)_id["']?[ \t]*[:=][ \t]*["']?)$/i;
/** A run word with an optional ':' '#' '=' right before an 11-digit token; shared with gstack-post's chained-id allowlist. */
export const CI_RUN_WORD_BEFORE = /\b(?:runs?|screens?|gates?|backstop|bisect|rerun|dispatch(?:ed)?|failed|passed)\s*[:#=]?\s*$/i;
export function isCiRunIdentifier(span: string, match: RegExpExecArray): boolean {
  if (!/^\d+$/.test(span)) return false;
  const input = match.input ?? "";
  const { start } = spanBounds(match);
  const lineStart = input.lastIndexOf("\n", start - 1) + 1;
  const before = input.slice(Math.max(lineStart, start - 80), start);
  return CI_ID_POSITION_BEFORE.test(before) || (span.length === 11 && CI_RUN_WORD_BEFORE.test(before));
}

/**
 * A four-part version (MAJOR.MINOR.PATCH.BUILD: .NET assembly versions,
 * gstack's own VERSION) is byte-for-byte a dotted quad, and `1.128.1.0` is a
 * public address, so `"version": "1.128.1.0"` raised pii.ip_public on every
 * release (#2784). The value cannot decide it, so only the declaration
 * immediately before it on the same line can: a `version` key or word
 * (`"version": "`, `app_version = `, `<Version>`, `AssemblyVersion("`,
 * `version `), or a Keep a Changelog heading `## [1.2.3.4]`. The same digits
 * after `host:`, `server = ` or in prose that merely mentions a version still
 * report, and the pre-push hook's VERSION-file rule (#2856) is unchanged.
 */
const VERSION_DECLARATION_BEFORE =
  /(?:\b[Vv]ersion|\bVERSION|[a-z0-9_]Version|[_-][Vv]ersion|_VERSION)["'\]]?(?:[ \t]*[:=(>][ \t]*|[ \t]+)["']?$/;
const CHANGELOG_HEADING_BEFORE = /^#{1,6}[ \t]+\[$/;
export function isDeclaredVersion(match: RegExpExecArray): boolean {
  const input = match.input ?? "";
  const { start, end } = spanBounds(match);
  const lineStart = input.lastIndexOf("\n", start - 1) + 1;
  if (VERSION_DECLARATION_BEFORE.test(input.slice(Math.max(lineStart, start - 48), start))) return true;
  return CHANGELOG_HEADING_BEFORE.test(input.slice(lineStart, start)) && input[end] === "]";
}

// ── Placeholder suppression (per-matched-span, NOT per-line) ─────────────────

/**
 * A finding is suppressed only if the MATCHED SPAN itself is a placeholder
 * form — not merely co-located on a line with the word EXAMPLE. This is the
 * tightened rule from the Codex review (line-based suppression was dangerous).
 */
// Structural placeholder forms — apply to ANY span (including URLs).
const PLACEHOLDER_STRUCTURAL = [
  /^your[_-]/i,
  /^<[^>]*>$/, // <REDACTED-FOO>, <your-key>
  /^\*+$/, // all-asterisks mask
  /^x{6,}$/i, // xxxxxx mask
];

// Substring placeholder words (example/test/dummy/...). These are NOT applied to
// compound spans containing `://` or `@`, because a legit URL/host can contain
// "example" (e.g. db.example.com) without being a placeholder secret. AWS docs
// keys like AKIAIOSFODNN7EXAMPLE are bare tokens, so the guard still catches them.
const PLACEHOLDER_SUBSTRING = [
  /example/i, // AKIAIOSFODNN7EXAMPLE etc — AWS docs convention
  /^pass(word)?$/i, // literal PASSWORD/pass in URL-format doc comments
  /^changeme$/i,
  /^redacted/i,
  /^placeholder/i,
  /^dummy/i,
  /^fake/i,
  /test[_-]?(key|token|secret)/i,
];

export function isPlaceholderSpan(span: string): boolean {
  if (PLACEHOLDER_STRUCTURAL.some((re) => re.test(span))) return true;
  const isCompound = span.includes("://") || span.includes("@");
  if (!isCompound && PLACEHOLDER_SUBSTRING.some((re) => re.test(span))) return true;
  return false;
}

/** Canonical 8-4-4-4-12 hex UUID. Global: a line may hold several. */
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** How far either side of a span to look for an enclosing UUID. A UUID is 36
 * chars, so 40 covers one that starts immediately before the span. Bounded so
 * this stays cheap on a multi-megabyte buffer. */
const UUID_CONTEXT_CHARS = 40;

/**
 * True when an `internal.hostname` span is really the tail of a dotenv
 * FILENAME (`.env.local`, `.env.staging`, `.env.prod`) rather than a host.
 *
 * The hostname pattern ends in `.local|.prod|.staging|…`, so `.env.local`
 * matches on `env.local` — a false positive on one of the most commonly
 * committed filenames there is. It arrives via npm scripts
 * (`--env-file=.env.local`), READMEs, `.gitignore` and setup docs, i.e. on
 * ordinary branches that leak nothing, which is the noise that teaches people
 * to skim past MEDIUM findings.
 *
 * Deliberately narrow, in the same spirit as `insideUuid`: it exempts ONLY a
 * span beginning `env.` that is immediately preceded by a dot — the literal
 * `.env.<suffix>` form. A real host still reports, `api.corp` and
 * `build-7.internal` included, and so does `myenv.local`, which is not a
 * dotenv file.
 */
export function isDotenvFilename(match: RegExpExecArray): boolean {
  const input = match.input ?? "";
  const span = match[1] ?? match[0];
  if (!/^env\./i.test(span)) return false;
  // Mirror the engine: capture group 1 when present, else the whole match.
  const spanStartInMatch = match[1] !== undefined ? match[0].indexOf(match[1]) : 0;
  const spanStart = match.index + Math.max(0, spanStartInMatch);
  return spanStart > 0 && input[spanStart - 1] === ".";
}

/** A trailing run of file extensions that are not top-level domains (checked
 * against the IANA root zone list, 2026-10-28). Extensions that are also TLDs
 * (`.md`, `.py`, `.sh`, `.rs`, `.so`, `.zip`, `.mov`, `.map`) are left out on
 * purpose. */
const NON_TLD_EXTENSIONS = /(?:\.(?:json|jsonc|jsonl|ndjson|ya?ml|toml|lock|txt|csv|tsv|log|ini|cfg|conf|xml|html?|[mc]?js|jsx|tsx?|tgz|gz|tar|bz2|xz|zst|whl|jar|gem|nupkg|deb|rpm|wasm|svg|png|jpe?g|pdf|patch|diff))+$/i;

/**
 * True when a pii.email span is a filename with an `@` in it rather than an
 * address: `terminal-bench@2.0.json`, `lodash@4.17.21.tgz`,
 * `eslint-config@next.yaml`. The package@version convention puts a version or
 * tag after the `@`, so either sign decides: the "domain" ends in file
 * extensions no TLD uses and what precedes them cannot be a domain (one dotless
 * label or a dotted version), or it is a dotted version (two or more all-digit
 * labels) followed by an extension that doubles as a TLD (`a@1.2.md`). A file
 * named after an address (`jane@acme.com.json`), `user@163.com`,
 * `alice@1.2.com` and an address at a TLD that doubles as an extension
 * (`dev@acme.sh`, `ops@acme.md`) still report.
 */
export function looksLikeAtFilename(span: string): boolean {
  const domain = span.slice(span.lastIndexOf("@") + 1);
  const stem = domain.replace(NON_TLD_EXTENSIONS, "");
  if (stem !== domain) return !/\.[A-Za-z]{2,}$/.test(stem);
  return /^\d+(?:\.\d+)+\.(?:md|py|sh|rs|so|zip|mov|map)$/i.test(domain);
}

/** Extensions that mark a `<name>.local.<ext>` span as a file. Closed on
 * purpose: `.md` is also Moldova's TLD, but no internal suffix sits in front
 * of a public one, so after `.local` it can only be an extension. */
const LOCAL_CONFIG_EXTENSIONS = /^\.(?:md|json|jsonc|ya?ml|toml|ini|conf|txt)\b/i;

/**
 * True when an `internal.hostname` span is the stem of a per-machine config
 * FILENAME (`CLAUDE.local.md`, `settings.local.json`, `values.staging.yaml`)
 * rather than a host (#2962). The pattern's `\b` stops at the dot before the
 * extension, so `CLAUDE.local.md` reported `CLAUDE.local`. Claude Code's own
 * per-user files are named this way, so any decision or doc that mentions
 * them failed closed in the non-interactive stores.
 *
 * Exempts ONLY a span immediately followed by `.<known extension>` and a word
 * boundary. `printer.local.` at the end of a sentence still reports, and so
 * do `printer.local`, `printer.local/md` and `printer.local.mdx`.
 */
export function isLocalConfigFilename(match: RegExpExecArray): boolean {
  const { end } = spanBounds(match);
  return LOCAL_CONFIG_EXTENSIONS.test((match.input ?? "").slice(end, end + 8));
}

/**
 * True when the matched span sits ENTIRELY inside a UUID.
 *
 * Digit-only UUIDs — `00000000-0000-0000-0000-000000000000`,
 * `11111111-1111-…` — are the standard fixture shape in test suites, and their
 * digit runs collide with both the credit-card and phone patterns: a 16-digit
 * slice of one is Luhn-valid often enough to matter, and the hyphen groups read
 * as national phone formatting. Observed live: 14 of 21 MEDIUM findings on one
 * ordinary branch were this, all from test files. That volume is what stops
 * people reading MEDIUM output at all, so it costs real detection elsewhere.
 *
 * Containment must be TOTAL, deliberately. A span merely adjacent to or
 * overlapping a UUID still reports — suppression is the exception, so it may
 * only fire when the whole match is demonstrably UUID interior.
 *
 * Takes the match (not just the span) because the decision needs surrounding
 * context; span offset is derived exactly as redact-engine.ts derives it, so
 * the two cannot disagree about where the span begins.
 */
export function insideUuid(match: RegExpExecArray): boolean {
  const input = match.input ?? "";
  // Mirror the engine: capture group 1 when present, else the whole match.
  const spanStartInMatch = match[1] !== undefined ? match[0].indexOf(match[1]) : 0;
  const spanStart = match.index + Math.max(0, spanStartInMatch);
  const spanEnd = spanStart + (match[1] ?? match[0]).length;

  const from = Math.max(0, spanStart - UUID_CONTEXT_CHARS);
  const window = input.slice(from, spanEnd + UUID_CONTEXT_CHARS);

  UUID_RE.lastIndex = 0;
  let u: RegExpExecArray | null;
  while ((u = UUID_RE.exec(window)) !== null) {
    const uuidStart = from + u.index;
    const uuidEnd = uuidStart + u[0].length;
    if (spanStart >= uuidStart && spanEnd <= uuidEnd) return true;
  }
  return false;
}

// ── The taxonomy ─────────────────────────────────────────────────────────────

/**
 * URL-embedded passwords that are interpolation forms, not credentials:
 * `${identifier}` (bash or JS template, any case) or bare `$UPPER_SNAKE`
 * (shell convention). Bare lowercase `$word` stays BLOCKED — a real password
 * that merely starts with `$` (e.g. `$` + a dictionary word) must not slip
 * through the HIGH gate just because it looks vaguely variable-shaped.
 * Shared by db.url_with_password and creds.basic_auth_url so the two
 * validators cannot drift.
 */
// Fully-braced `${...}` spanning the whole password segment is template code
// regardless of content — `${dbPass}` and `${encodeURIComponent(dbPass)}`
// alike (the identifier-only form flagged the DSN-encoding call site as a
// pushed secret). Bare `$word` stays uppercase-only: `$hunter2` must block.
const INTERPOLATED_PASSWORD_RE = /^(\$\{.+\}|\$[A-Z_][A-Z0-9_]*)$/;
// URL-password placeholders are matched by EXACT token, never by shape or
// substring. A shape rule (`/^[A-Z][A-Z0-9_]*$/`) waved through real all-caps
// secrets like `PROD2026SECRET`; a substring rule would let `PROD2026SECRET`
// slip because it contains `SECRET`. So this is an anchored, hand-curated set
// of the doc-comment conventions (postgres://USER:PASSWORD@host) only. Compared
// case-sensitively against the raw span: the convention is ALL CAPS, and a
// lowercase `password`/`pass` at this position is a real (terrible) credential
// that must still block.
export const URL_PASSWORD_PLACEHOLDER_WORDS = new Set([
  "PASSWORD",
  "PASS",
  "PASSWD",
  "YOUR_PASSWORD",
  "DB_PASSWORD",
  "MY_PASSWORD",
  "CHANGEME",
  "CHANGE_ME",
  "PLACEHOLDER",
  "REDACTED",
  "EXAMPLE",
]);
function urlPasswordIsPlaceholder(span: string): boolean {
  const m = span.match(/:\/\/[^:]+:([^@]+)@/);
  const pw = m?.[1] ?? "";
  if (pw === "") return true;
  if (INTERPOLATED_PASSWORD_RE.test(pw)) return true;
  if (URL_PASSWORD_PLACEHOLDER_WORDS.has(pw)) return true;
  return PLACEHOLDER_STRUCTURAL.some((re) => re.test(pw));
}

/**
 * #2913: `postgres:postgres` is the official postgres image's default pair,
 * committed in compose files and CI DATABASE_URLs. It is exempt only on a
 * loopback host (`localhost` or `127.0.0.1`, optional port), never on a
 * single-label host such as `db`: a compose service name says nothing about
 * where the same URL is also deployed, and a weak default on a reachable host
 * is exactly the leak to report. Exact user and password, case-sensitive;
 * the host must end at a port, path, query, quote or the span's end.
 */
const POSTGRES_LOOPBACK_DEFAULT =
  /^postgres(?:ql)?:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?![\w.:@%-])/;

/** A value span that is only an environment-variable read expression (#2912). */
const ENV_READ_SPAN =
  /^(?:os\.environ\[|os\.environ\.get\(|os\.getenv\(|getenv\(|ENV\[|process\.env\.[A-Za-z_$][\w$]*[;,)]?)$/;
function isBareEnvRead(span: string, match: RegExpExecArray): boolean {
  if (!ENV_READ_SPAN.test(span)) return false;
  return !carriesSecretLiteral(match.input.slice(match.index + match[0].length).split("\n", 1)[0]);
}

/** True when `text` holds a quoted, non-placeholder, high-entropy literal. */
function carriesSecretLiteral(text: string): boolean {
  for (const [, literal] of text.matchAll(/["']([^\s'"]{8,})["']/g))
    if (!isPlaceholderSpan(literal) && shannonEntropy(literal) >= 3.0) return true;
  return false;
}

/**
 * #2899: the value capture is any non-space run, so it swallows code:
 * `session = _FlakySession(responses=[...])`, `token = make_token(user,`,
 * `password = getpass.getpass()`. A bare credential name plus mixed-case code
 * clears the entropy gate. The span alone cannot tell `Abc123(xyz` (a real
 * password) from a call, so the exemption needs the line's evidence: the
 * value is unquoted, starts with an identifier or dotted path followed by
 * `(`, and that call closes on the line or opens a multi-line argument list.
 * A quoted value is a literal, and a call whose arguments carry a
 * high-entropy literal (`decrypt("<secret>")`) still reports.
 */
const CALL_SHAPED_VALUE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/;

/**
 * #3208: a catalog or schema entry `"input_key": "expected_media_rate_bits"`
 * names a field, it holds no credential. Exempt only when both sides say so:
 * the whole name is one lowercase data-model word plus `_key` (no further
 * prefix, so `cosmosdb_primary_key` and `api_cache_key` still fire), and the
 * value is two or more lowercase identifier words joined by `_`, `-` or `.`.
 * A random key is mixed-case or one unbroken run, so it never takes this shape.
 */
const SCHEMA_FIELD_NAME =
  /^(?:[ +-]?\+|[ +-]?-(?! [^ \t]))?[ \t]*["']?(?:input|output|field|column|lookup|cache|sort|partition|range|index|row|group|join|property|metric|catalog|schema|translation|idempotency|dedup)[_.-]key["']?[ \t]*[:=]/;
const SCHEMA_FIELD_VALUE = /^[a-z][a-z0-9]*(?:[_.-][a-z][a-z0-9]*)+$/;
function isSchemaFieldIdentifier(span: string, match: RegExpExecArray): boolean {
  return SCHEMA_FIELD_NAME.test(match[0]) && SCHEMA_FIELD_VALUE.test(span);
}
function isCallExpression(span: string, match: RegExpExecArray): boolean {
  if (!CALL_SHAPED_VALUE.test(span)) return false;
  const { start } = spanBounds(match);
  if (match.input[start - 1] === '"' || match.input[start - 1] === "'") return false;
  const call = match.input.slice(start + span.indexOf("(")).split("\n", 1)[0];
  if (!call.includes(")") && call.trim() !== "(") return false;
  return !carriesSecretLiteral(call);
}

/**
 * #3048: in a TypeScript/JSX file, an unquoted value after `:` is a type or an
 * expression, never a string literal (`session: SessionState,`), and a JSX
 * brace holding only names and property reads joined by + ?? || or &&
 * (`key={turn.requestId + turn.role}`, `key={item.id ?? index}`, #3605) is an
 * expression. Decided by file context, not by how the value looks:
 * `API_KEY=VelvetRiverOrbitSunset;` in a .env or YAML file is still a literal.
 * #3630 (#3418, #3419): Dart and Python (.py, .pyi) qualify on the same grammar
 * fact, no unquoted string literal, so `'password': request.password` and
 * `session: HttpSession,` are names. Python's `=` forms
 * (`password=request.password`) still fire: the separator must be `:`.
 * Without a known source path nothing is exempt.
 */
const CODE_SOURCE = /\.(?:[cm]?tsx?|jsx|dart|pyi?)$/i;
const CODE_NAME_CHAIN = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*(?:<[\w$.,\s<>[\]|]*>)?(?:\[\])*$/;

/**
 * #3418: a `password:` pair inside a string is text in an embedded config,
 * not a dict entry or annotation, so the name exemption must not reach it.
 * In Python and Dart (no regex literals, so every quote is a string's), one
 * linear pass per input (a scan validates many candidates against the same
 * text) records every string's content span: a `'''`/`"""` block, or a
 * `'`/`"` string that ends at its line unless a backslash continues it.
 * Comments are skipped (`#` in Python; `//` and nested `/* *\/` in Dart), so a
 * delimiter inside one opens nothing; a backslash escapes the next character, except in a Dart raw
 * string (`r'''…'''`). The exemption needs the
 * whole file to see a block's opener: pregate passes Dart and Python files
 * whole, and the pre-push hook, which scans added lines alone, passes them
 * without their path.
 */
const STRING_SPAN_SOURCE = /\.(?:dart|pyi?)$/i;
let stringSpansCache: { text: string; lang: string; spans: Array<[number, number]> } | null = null;

/** Drops the cached text once a scan ends, so a long-lived process holds no scanned input. */
export function clearStringSpanCache(): void {
  stringSpansCache = null;
}

function stringSpans(text: string, lang: "py" | "dart"): Array<[number, number]> {
  if (stringSpansCache?.text === text && stringSpansCache.lang === lang) return stringSpansCache.spans;
  const spans: Array<[number, number]> = [];
  const n = text.length;
  for (let i = 0; i < n; ) {
    const c = text[i]!;
    if (lang === "py" ? c === "#" : text.startsWith("//", i)) {
      const eol = text.indexOf("\n", i);
      i = eol < 0 ? n : eol;
      continue;
    }
    if (lang === "dart" && text.startsWith("/*", i)) {
      let depth = 1;
      for (i += 2; i < n && depth > 0; ) {
        if (text.startsWith("/*", i)) { depth += 1; i += 2; }
        else if (text.startsWith("*/", i)) { depth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }
    if (c !== '"' && c !== "'") { i += 1; continue; }
    const close = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
    const multiline = close.length === 3;
    const raw = lang === "dart" && text[i - 1] === "r" && !/[\w$]/.test(text[i - 2] ?? "");
    let j = i + close.length;
    while (j < n && !text.startsWith(close, j) && (multiline || text[j] !== "\n")) j += !raw && text[j] === "\\" ? 2 : 1;
    spans.push([i + close.length, Math.min(j, n)]);
    i = j + close.length;
  }
  stringSpansCache = { text, lang, spans };
  return spans;
}

function insideString(text: string, offset: number, sourcePath: string): boolean {
  if (!STRING_SPAN_SOURCE.test(sourcePath)) return false;
  const spans = stringSpans(text, /\.dart$/i.test(sourcePath) ? "dart" : "py");
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < spans[mid]![0]) hi = mid - 1;
    else if (offset >= spans[mid]![1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** The rest of a name's expression on its line, up to the comma, semicolon, bracket or comment that ends it; null when it continues on the next line. */
function expressionTail(line: string, comment: string): string | null {
  let rest = line;
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i]!;
    if (rest.startsWith(comment, i)) { rest = rest.slice(0, i); break; }
    if (c === '"' || c === "'" || c === "`") {
      const close = rest.indexOf(c, i + 1);
      if (close < 0) return null;
      i = close;
    } else if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) { if (--depth < 0) return rest.slice(0, i); }
    else if ((c === "," || c === ";") && depth === 0) return rest.slice(0, i);
  }
  return depth > 0 || /(?:[=+\\]|\?\?|\|\||&&|\b(?:or|and))\s*$/.test(rest) ? null : rest;
}

function isSourceExpression(span: string, match: RegExpExecArray, sourcePath: string | undefined): boolean {
  if (!sourcePath || !CODE_SOURCE.test(sourcePath)) return false;
  const { start, end } = spanBounds(match);
  const before = match.input[start - 1];
  if (before === '"' || before === "'" || before === "`") return false;
  if (span.startsWith("{")) {
    const line = match.input.slice(start + 1).split("\n", 1)[0];
    const close = line.indexOf("}");
    if (close < 0 || /["'`]/.test(line.slice(0, close))) return false;
    if (!line.slice(0, close).split(/\+|\?\?|\|\||&&/).every(term => CODE_NAME_CHAIN.test(term.trim()))) return false;
  } else {
    const head = match[0].slice(0, match[0].length - span.length).trimEnd();
    const separator = head.slice(-1);
    if (separator !== ":" || !CODE_NAME_CHAIN.test(span.replace(/[,;)=|]+$/, ""))) return false;
    const rest = (span.endsWith("=") ? "=" : "") + match.input.slice(end).split("\n", 1)[0];
    if (!/[,;]$/.test(span)) {
      const tail = expressionTail(rest, /\.pyi?$/i.test(sourcePath) ? "#" : "//");
      if (tail === null || carriesSecretLiteral(tail)) return false;
    }
  }
  return !insideString(match.input, start, sourcePath);
}

export const PATTERNS: RedactPattern[] = [
  // ===== HIGH — genuinely-secret credentials (block) =====
  {
    id: "aws.access_key",
    tier: "HIGH",
    category: "secret",
    description: "AWS access key ID (AKIA…)",
    regex: /\b(AKIA[0-9A-Z]{16})\b/,
  },
  {
    id: "aws.secret_key",
    tier: "HIGH",
    category: "secret",
    description: "AWS secret access key (with aws_secret_access_key nearby)",
    regex: /\b([A-Za-z0-9/+=]{40})\b/,
    nearRegex: /aws.{0,3}secret.{0,3}access.{0,3}key/i,
    nearWindow: 100,
  },
  {
    id: "github.pat",
    tier: "HIGH",
    category: "secret",
    description: "GitHub personal access token (classic)",
    regex: /\b(ghp_[A-Za-z0-9]{36})\b/,
  },
  {
    id: "github.oauth",
    tier: "HIGH",
    category: "secret",
    description: "GitHub OAuth token",
    regex: /\b(gho_[A-Za-z0-9]{36})\b/,
  },
  {
    id: "github.server",
    tier: "HIGH",
    category: "secret",
    description: "GitHub server-to-server token",
    regex: /\b(ghs_[A-Za-z0-9]{36})\b/,
  },
  {
    id: "github.fine_grained",
    tier: "HIGH",
    category: "secret",
    description: "GitHub fine-grained PAT",
    regex: /\b(github_pat_[A-Za-z0-9_]{82})\b/,
  },
  {
    id: "gitlab.token",
    tier: "HIGH",
    category: "secret",
    description: "GitLab token (personal/pipeline-trigger/deploy)",
    // glpat- personal access, glptt- pipeline trigger, gldt- deploy token.
    // gstack drives glab first-class — these were a coverage gap (#1946).
    regex: /\b(gl(?:pat|ptt|dt)-[A-Za-z0-9_-]{20,})\b/,
  },
  {
    id: "groq.key",
    tier: "HIGH",
    category: "secret",
    description: "Groq API key",
    regex: /\b(gsk_[A-Za-z0-9]{20,})\b/,
  },
  {
    id: "tavily.key",
    tier: "HIGH",
    category: "secret",
    description: "Tavily API key (incl. tvly-dev-/tvly-prod-)",
    // Explicit environment infixes rather than a globally-optional segment,
    // which would also match separator-less tvly-devabc… (same reasoning as
    // openai.key above).
    regex: /\b(tvly-(?:dev-|prod-)?[A-Za-z0-9]{16,})\b/,
  },
  {
    id: "notion.token",
    tier: "HIGH",
    category: "secret",
    description: "Notion integration token (ntn_ current, secret_ legacy)",
    // Two explicit shapes. The legacy `secret_` form keeps a high {40,} floor
    // because the prefix is an ordinary English word — the length is what makes
    // it a credential rather than prose.
    regex: /\b(ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{40,})\b/,
  },
  {
    id: "huggingface.token",
    tier: "HIGH",
    category: "secret",
    description: "HuggingFace access token",
    regex: /\b(hf_[A-Za-z0-9]{30,})\b/,
  },
  {
    id: "npm.token",
    tier: "HIGH",
    category: "secret",
    description: "npm granular access token",
    regex: /\b(npm_[A-Za-z0-9]{36})\b/,
  },
  {
    id: "digitalocean.token",
    tier: "HIGH",
    category: "secret",
    description: "DigitalOcean personal access token",
    regex: /\b(dop_v1_[a-f0-9]{64})\b/,
  },
  {
    id: "gcp.service_account",
    tier: "HIGH",
    category: "secret",
    description: "GCP service-account JSON private key",
    // The JSON-escaped form ("private_key": "-----BEGIN PRIVATE KEY-----\n...)
    // dodges pem.private_key's literal-block match when minified to one line.
    // Proximity to "private_key_id" confirms the GCP service-account shape.
    regex: /("private_key"\s*:\s*"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/,
    nearRegex: /"private_key_id"/,
    nearWindow: 300,
  },
  {
    id: "anthropic.key",
    tier: "HIGH",
    category: "secret",
    description: "Anthropic API key",
    regex: /\b(sk-ant-[A-Za-z0-9_\-]{20,})\b/,
  },
  {
    id: "openai.key",
    tier: "HIGH",
    category: "secret",
    description: "OpenAI API key (incl. sk-proj-/sk-svcacct-/sk-admin-)",
    // Two explicit shapes (NOT a globally-optional prefix, which would match
    // malformed sk--... or separator-less sk-projabc...):
    //   prefixed: sk-{proj,svcacct,admin}- + base64url-ish body (allows -_)
    //   bare:     sk- + contiguous alphanumeric run (legacy), keeps {32,} floor
    regex:
      /\b(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,})\b/,
  },
  {
    id: "sendgrid.key",
    tier: "HIGH",
    category: "secret",
    description: "SendGrid API key",
    regex: /\b(SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43})\b/,
  },
  {
    id: "stripe.secret",
    tier: "HIGH",
    category: "secret",
    description: "Stripe live SECRET key",
    regex: /\b(sk_live_[A-Za-z0-9]{24,})\b/,
  },
  {
    id: "slack.token",
    tier: "HIGH",
    category: "secret",
    description: "Slack token (bot/user/app)",
    regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
  {
    id: "slack.webhook",
    tier: "HIGH",
    category: "secret",
    description: "Slack incoming webhook URL",
    regex: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{24})/,
  },
  {
    id: "discord.webhook",
    tier: "HIGH",
    category: "secret",
    description: "Discord webhook URL",
    regex: /(https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_\-]{60,})/,
  },
  {
    id: "twilio.auth_token",
    tier: "HIGH",
    category: "secret",
    description: "Twilio auth token (32 hex, with an Account SID nearby)",
    regex: /\b([a-f0-9]{32})\b/,
    nearRegex: /\bAC[a-f0-9]{32}\b/,
    nearWindow: 200,
  },
  {
    id: "google.oauth_client_secret",
    tier: "HIGH",
    category: "secret",
    // Distinct from google.api_key (MEDIUM): an AIza key is often a public
    // client key, but a GOCSPX- client secret is never publishable — leaking
    // it lets anyone impersonate the OAuth app's token exchange.
    description: "Google OAuth client secret (GOCSPX-…)",
    regex: /\b(GOCSPX-[A-Za-z0-9_-]{20,40})(?![A-Za-z0-9_-])/,
    validate: (span) => !isPlaceholderSpan(span),
  },
  {
    id: "telegram.bot_token",
    tier: "HIGH",
    category: "secret",
    description: "Telegram bot token (<bot-id>:AA…)",
    regex: /\b([0-9]{6,16}:A[A-Za-z0-9_-]{34})(?![A-Za-z0-9_-])/,
    validate: (span) => !isPlaceholderSpan(span),
  },
  {
    id: "pem.private_key",
    tier: "HIGH",
    category: "secret",
    description: "PEM private key block",
    regex: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----)/,
  },
  {
    id: "db.url_with_password",
    tier: "HIGH",
    category: "secret",
    description: "Database URL with embedded password",
    regex: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:[^@\s/]+@[^\s/]+)/,
    // Skip when the password segment is itself a placeholder/interpolation,
    // or the URL is postgres's default pair on a loopback host.
    validate: (span) => !urlPasswordIsPlaceholder(span) && !POSTGRES_LOOPBACK_DEFAULT.test(span),
  },
  {
    id: "creds.basic_auth_url",
    tier: "HIGH",
    category: "secret",
    description: "HTTP(S) URL with embedded basic-auth credentials",
    regex: /(https?:\/\/[^:\s/@]+:[^@\s/]+@[^\s/]+)/,
    // Skip when the password segment is itself a placeholder/interpolation.
    validate: (span) => !urlPasswordIsPlaceholder(span),
  },

  // ===== MEDIUM — demoted credential-shaped (high-FP / context-variable) =====
  {
    id: "stripe.publishable",
    tier: "MEDIUM",
    category: "secret",
    description: "Stripe live publishable key (often intentionally public)",
    regex: /\b(pk_live_[A-Za-z0-9]{24,})\b/,
  },
  {
    id: "google.api_key",
    tier: "MEDIUM",
    category: "secret",
    description: "Google API key (AIza…; sometimes a public client key)",
    regex: /\b(AIza[0-9A-Za-z\-_]{35})\b/,
  },
  {
    id: "jwt",
    tier: "MEDIUM",
    category: "secret",
    description: "JSON Web Token (3-segment base64url)",
    regex: /\b(eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,})\b/,
  },
  {
    id: "env.kv",
    tier: "MEDIUM",
    category: "secret",
    description: "Secret-named assignment (env/YAML/JSON) with high-entropy value",
    // #1946 gap 3: the original shape required an UPPERCASE name and an `=`
    // assignment, so `api_key=…`, `apiKey: "…"`, and `password: …` (YAML/JSON
    // colon form) produced NO finding at all — a detection fail-open on the
    // most common config shapes. Now case-insensitive with `:` or `=`
    // assignment and optional quotes around the key (JSON). Still MEDIUM and
    // entropy-gated: this is the calibrated generic net, not a blocker.
    // The name part is `[A-Za-z0-9_.-]*` + suffix (zero-or-more prefix, not
    // one-or-more): a mandatory first char would swallow the suffix's own
    // first letter and bare names like `password:` / `key:` would never match.
    // The wide net is then calibrated by isCredentialShapedEnvName in
    // validate — without it, any identifier that merely ENDS in a suffix
    // (cacheKey:, sortKey:, monkey:) fires a MEDIUM confirm on entropic
    // values. The value must stay capture group 1 (the engine masks group 1),
    // so name-shape checking lives in validate, not in a second group.
    // GST-543: an optional leading `+` or `-` is a unified-diff line marker
    // (`git diff | gstack-redact`, a diff fence in a PR body), and one more
    // column before it (`++`, ` +`, `+-`) is a combined (merge) diff. Without
    // them the line anchor stopped at the marker, so an added or removed credential
    // went unreported (`-` alone matched only as a name character, never
    // before indentation or `export`). A `-` followed by exactly one space
    // and text is a Markdown bullet or YAML list item, not a marker, so those
    // read as they did before. ENV_KV_NAME and SCHEMA_FIELD_NAME take the same
    // marker so the name-shape and schema exemptions hold on a diff line.
    regex: /^(?:[ +-]?\+|[ +-]?-(?! [^ \t]))?[ \t]*(?:export[ \t]+)?["']?[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|DSN|AUTH|COOKIE|SESSION|PRIVATE)["']?[ \t]*[:=][ \t]*["']?([^\s'"]{8,})["']?/i,
    // Only fire on credential-shaped names with high-entropy values — kills
    // `FOO_KEY=changeme` and `cacheKey: <entropic-id>` FPs. #2912: a value
    // that is exactly an environment read (`os.environ["X"]`,
    // `os.getenv("X")`, `process.env.X`, `ENV["X"]`) names a secret without
    // holding one, unless the rest of its line carries a high-entropy quoted
    // literal (`os.getenv("X", "<secret>")`). A literal appended to the read
    // itself (`process.env.X||"…"`) is not an exact read and still fires.
    // #2899: a function call assigned to the name is code, not a value (see
    // isCallExpression). #3048, #3630: so is a TS/JSX/Dart/Python type or expression (isSourceExpression).
    // #3208: so is a schema field identifier (isSchemaFieldIdentifier).
    validate: (span, match, opts) =>
      isCredentialShapedEnvName(match[0]) &&
      !isPlaceholderSpan(span) &&
      !/^\$\{?[A-Za-z_]/.test(span) &&
      !isBareEnvRead(span, match) &&
      !isCallExpression(span, match) &&
      !isSourceExpression(span, match, opts?.sourcePath) &&
      !isSchemaFieldIdentifier(span, match) &&
      shannonEntropy(span) >= 3.0,
  },
  {
    id: "auth.bearer",
    tier: "MEDIUM",
    category: "secret",
    description: "Authorization Bearer token (high-entropy, header context)",
    // FP-prone shape (docs and examples are full of "Bearer <token>"), so:
    // MEDIUM tier, requires "authorization" nearby, and the same entropy
    // recipe as env.kv to kill Bearer YOUR_TOKEN_HERE placeholders.
    regex: /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{20,})\b/,
    nearRegex: /authorization/i,
    nearWindow: 80,
    validate: (span) =>
      !isPlaceholderSpan(span) &&
      !/^\$\{?[A-Za-z_]/.test(span) &&
      shannonEntropy(span) >= 3.0,
  },

  // ===== MEDIUM — PII (auto-redactable subset) =====
  {
    id: "pii.email",
    tier: "MEDIUM",
    category: "pii",
    description: "Email address",
    regex: /\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/,
    autoRedactable: true,
    redactToken: "<REDACTED-EMAIL>",
    validate: (span) => !looksLikeAtFilename(span),
    // Engine layers the email allowlist (example.com, noreply@, user's own,
    // repo-public authors) on top of this — see redact-engine.ts.
  },
  {
    id: "pii.phone.e164",
    tier: "MEDIUM",
    category: "pii",
    description: "Phone number (E.164 / common national formats; US/EU-biased)",
    regex: /(?<![\w.])(\+?[1-9]\d{0,2}[ \-.]?\(?\d{2,4}\)?[ \-.]?\d{3,4}[ \-.]?\d{3,4})(?![\w.])/,
    autoRedactable: true,
    redactToken: "<REDACTED-PHONE>",
    // A digit-only UUID's hyphen groups read as national phone formatting, and
    // so do a county tax-map parcel ID (see looksLikeParcelId), vector
    // coordinates (looksLikeDecimalCoordinates) and seed/nonce/timestamp JSON
    // values (isNumericMetadataValue), GitHub Actions run and job ids in
    // their id positions (isCiRunIdentifier), and bare powers of two and
    // hash/PRNG constants (isNumericConstant).
    validate: (span, match) =>
      !insideUuid(match) &&
      span.replace(/\D/g, "").length >= 10 &&
      !looksLikeCompactTimestamp(span) &&
      !isNumericConstant(span) &&
      !looksLikeParcelId(span, match) &&
      !looksLikeDecimalCoordinates(span) &&
      !isNumericMetadataValue(span, match) &&
      !isCiRunIdentifier(span, match),
  },
  {
    id: "pii.ssn",
    tier: "MEDIUM",
    category: "pii",
    description: "US Social Security Number",
    regex: /\b(\d{3}-\d{2}-\d{4})\b/,
    autoRedactable: true,
    redactToken: "<REDACTED-SSN>",
    // Reject the all-zero-octet placeholders SSNs never use.
    validate: (span) => {
      const [a, b, c] = span.split("-");
      return a !== "000" && b !== "00" && c !== "0000" && a !== "666" && a[0] !== "9";
    },
  },
  {
    id: "pii.cc",
    tier: "MEDIUM",
    category: "pii",
    description: "Credit-card number (Luhn-valid)",
    regex: /\b((?:\d[ \-]?){13,19})\b/,
    autoRedactable: true,
    redactToken: "<REDACTED-CC>",
    // A 13-19 digit slice of a digit-only UUID or of a decimal number passes
    // Luhn often enough to matter, and so does a compact YYYYMMDDHHMMSS stamp
    // (an autoplan run id); the only 14-digit cards start with 3, a stamp with
    // 1 or 2. All three context checks run before Luhn.
    validate: (span, match) =>
      !insideUuid(match) && !insideDecimalNumber(match) && !looksLikeCompactTimestamp(span.replace(/[ -]$/, "")) && luhnValid(span),
  },
  {
    id: "pii.ip_public",
    tier: "MEDIUM",
    category: "pii",
    description: "Public IPv4 address",
    regex: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/,
    validate: (span, match) => isPublicIPv4(span) && !isDeclaredVersion(match),
  },
  {
    id: "pii.wallet",
    tier: "MEDIUM",
    category: "pii",
    description: "Crypto wallet address (ETH/BTC)",
    regex: /\b(0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,39}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,
    validate: (span) => looksLikeWallet(span),
  },

  // ===== MEDIUM — internal-leak =====
  {
    id: "internal.hostname",
    tier: "MEDIUM",
    category: "internal",
    description: "Internal hostname (*.internal/.corp/.local/.prod/.staging)",
    regex: /\b([a-z0-9][a-z0-9\-]*\.(?:internal|corp|local|lan|prod|staging))\b/i,
    // `.env.local`, `CLAUDE.local.md` and friends are filenames, not hosts.
    // See isDotenvFilename and isLocalConfigFilename.
    validate: (_span, match) => !isDotenvFilename(match) && !isLocalConfigFilename(match),
  },
  {
    id: "internal.url_private",
    tier: "MEDIUM",
    category: "internal",
    description: "localhost URL with a non-trivial path",
    regex: /(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}\/[^\s)]+)/,
  },

  // ===== MEDIUM — legal / damaging =====
  {
    id: "legal.nda_marker",
    tier: "MEDIUM",
    category: "legal",
    description: "Confidentiality / NDA marker",
    regex: /\b(CONFIDENTIAL|UNDER NDA|ATTORNEY[- ]CLIENT|PRIVILEGED|DO NOT DISTRIBUTE|EYES ONLY)\b/,
  },
  {
    id: "legal.named_criticism",
    tier: "MEDIUM",
    category: "legal",
    description: "Negative judgment near a capitalized full name (semantic pass is primary)",
    regex: /\b(incompetent|negligent|fraudulent|fraud|fired|terminated|harassed|underperforming)\b/i,
    // Require a Capitalized Two-Word name within the window.
    nearRegex: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/,
    nearWindow: 80,
  },

  // ===== LOW — surface only =====
  {
    id: "internal.user_path",
    tier: "LOW",
    category: "internal",
    description: "Absolute path under a user home dir",
    regex: /(\/(?:Users|home)\/[a-z][a-z0-9_\-]+\/[^\s)]*)/,
  },
  {
    id: "hygiene.todo",
    tier: "LOW",
    category: "hygiene",
    description: "TODO(owner) marker carried into the artifact",
    regex: /\b(TODO\([^)]+\))/,
  },
];

/** Lookup by id. */
export const PATTERNS_BY_ID: Record<string, RedactPattern> = Object.fromEntries(
  PATTERNS.map((p) => [p.id, p]),
);
