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
  validate?: (span: string, match: RegExpExecArray) => boolean;
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

// ── The taxonomy ─────────────────────────────────────────────────────────────

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
    // Skip when the password segment is itself a placeholder.
    validate: (span) => {
      const m = span.match(/:\/\/[^:]+:([^@]+)@/);
      const pw = m?.[1] ?? "";
      return !isPlaceholderSpan(pw) && pw !== "" && !/^\$\{?[A-Z_]+\}?$/.test(pw);
    },
  },
  {
    id: "creds.basic_auth_url",
    tier: "HIGH",
    category: "secret",
    description: "HTTP(S) URL with embedded basic-auth credentials",
    regex: /(https?:\/\/[^:\s/@]+:[^@\s/]+@[^\s/]+)/,
    validate: (span) => {
      const m = span.match(/:\/\/[^:]+:([^@]+)@/);
      const pw = m?.[1] ?? "";
      return !isPlaceholderSpan(pw) && pw !== "" && !/^\$\{?[A-Z_]+\}?$/.test(pw);
    },
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
    description: "Env-style SECRET assignment with high-entropy value",
    regex: /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|DSN|AUTH|COOKIE|SESSION|PRIVATE)[ \t]*=[ \t]*['"]?([^\s'"]{8,})['"]?/,
    // Only fire on high-entropy values — kills `FOO_KEY=changeme` FPs.
    validate: (span) =>
      !isPlaceholderSpan(span) &&
      !/^\$\{?[A-Za-z_]/.test(span) &&
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
    validate: (span) => span.replace(/\D/g, "").length >= 10,
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
    validate: (span) => luhnValid(span),
  },
  {
    id: "pii.ip_public",
    tier: "MEDIUM",
    category: "pii",
    description: "Public IPv4 address",
    regex: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/,
    validate: (span) => isPublicIPv4(span),
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
