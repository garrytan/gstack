/**
 * Unit tests for lib/redact-engine.ts + lib/redact-patterns.ts.
 *
 * One positive test per pattern, plus FP-filters, validators (Luhn/entropy/
 * RFC1918), email allowlist, no-promotion visibility semantics, tool-fence
 * degrade, normalization (zero-width / homoglyph / entity), oversize fail-closed,
 * and pure-function purity.
 */
import { describe, test, expect } from "bun:test";
import {
  scan,
  exitCodeFor,
  maskPreview,
  normalizeWithMap,
  type RepoVisibility,
} from "../lib/redact-engine";
import {
  PATTERNS,
  luhnValid,
  shannonEntropy,
  isPublicIPv4,
  isPlaceholderSpan,
} from "../lib/redact-patterns";

function ids(text: string, vis: RepoVisibility = "private"): string[] {
  return scan(text, { repoVisibility: vis }).findings.map((f) => f.id);
}

describe("HIGH credential patterns", () => {
  const cases: Array<[string, string]> = [
    ["aws.access_key", "key = AKIA1234567890ABCDEF"],
    ["aws.secret_key", "aws_secret_access_key = AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd"],
    ["github.pat", "token ghp_" + "1234567890abcdefghijklmnopqrstuvwxyz"],
    ["github.oauth", "gho_" + "1234567890abcdefghijklmnopqrstuvwxyz"],
    ["github.server", "ghs_1234567890abcdefghijklmnopqrstuvwxyz"],
    ["github.fine_grained", "github_pat_" + "A".repeat(82)],
    ["anthropic.key", "sk-ant-" + "api03-abcdefghij1234567890XYZ"],
    ["openai.key", "sk-proj-" + "a".repeat(40)],
    ["sendgrid.key", "SG." + "a".repeat(22) + "." + "b".repeat(43)],
    ["stripe.secret", "sk_live_" + "a".repeat(30)],
    ["slack.token", "xox" + "b-1234567890-abcdefghijklmnop"],
    ["slack.webhook", "https://hooks.slack.com/services/T00000000/B11111111/" + "a".repeat(24)],
    ["discord.webhook", "https://discord.com/api/webhooks/123456789012345678/" + "a".repeat(60)],
    ["pem.private_key", "-----BEGIN RSA PRIVATE KEY-----"],
  ];
  for (const [id, text] of cases) {
    test(`flags ${id}`, () => {
      expect(ids(text)).toContain(id);
    });
  }

  // #1868 — modern OpenAI keys use base64url bodies (with - and _). The old
  // [A-Za-z0-9]{32,} regex stopped at the first separator and missed them all,
  // failing a HIGH credential OPEN through the redaction gate.
  test("openai.key flags modern sk-proj-/sk-svcacct-/sk-admin- shapes (#1868)", () => {
    const missed = [
      "sk-proj-Ab12_Cd34-Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv",
      "sk-svcacct-abc_def-ghijklmnopqrstuvwxyz0123456789ABCDEF",
      "sk-admin-AAAA_BBBB-CCCC_DDDD-EEEE_FFFF-GGGG_HHHH1234",
    ];
    for (const key of missed) {
      expect(ids(`OPENAI_API_KEY=${key}`)).toContain("openai.key");
    }
    // legacy contiguous shape still flags
    expect(ids("sk-proj-" + "a".repeat(40))).toContain("openai.key");
  });

  test("openai.key does not over-match prose / malformed sk- strings (#1868 calibration)", () => {
    // HIGH tier BLOCKS, so false positives on prose are costly. None of these
    // should flag as openai.key.
    const benign = [
      "the sk-learning-rate-schedule-was-tuned-carefully", // hyphenated prose
      "sk--double-dash-typo-not-a-real-key",
      "use sk-proj for the project prefix in docs", // no body
      "sk-short", // too short, no prefix
    ];
    for (const text of benign) {
      expect(ids(text)).not.toContain("openai.key");
    }
  });

  test("twilio.auth_token needs an SID nearby", () => {
    const sid = "AC" + "a".repeat(32);
    const tok = "b".repeat(32);
    expect(ids(`account ${sid} token ${tok}`)).toContain("twilio.auth_token");
    // bare 32-hex with no SID nearby should NOT flag as twilio
    expect(ids(`random ${tok} here`)).not.toContain("twilio.auth_token");
  });

  test("db.url_with_password flags real password, skips placeholder/env-var", () => {
    expect(ids("postgres://user:s3cretP@ss@db.example.com/app")).toContain("db.url_with_password");
    expect(ids("postgres://user:${DB_PASSWORD}@host/app")).not.toContain("db.url_with_password");
  });

  test("all HIGH patterns block (exit 3)", () => {
    const r = scan("AKIA1234567890ABCDEF", { repoVisibility: "private" });
    expect(exitCodeFor(r)).toBe(3);
  });
});

describe("MEDIUM demoted credential-shaped patterns (TENSION-1)", () => {
  test("stripe.publishable is MEDIUM not HIGH", () => {
    const f = scan("pk_live_" + "a".repeat(30), { repoVisibility: "private" }).findings.find(
      (x) => x.id === "stripe.publishable",
    );
    expect(f?.tier).toBe("MEDIUM");
  });
  test("google.api_key is MEDIUM", () => {
    const f = scan("AIza" + "a".repeat(35), { repoVisibility: "private" }).findings.find(
      (x) => x.id === "google.api_key",
    );
    expect(f?.tier).toBe("MEDIUM");
  });
  test("jwt is MEDIUM", () => {
    const jwt = "eyJhbGciOiJ.eyJzdWIiOiI." + "x".repeat(20);
    const f = scan(jwt, { repoVisibility: "private" }).findings.find((x) => x.id === "jwt");
    expect(f?.tier).toBe("MEDIUM");
  });
  test("env.kv fires on high-entropy, skips placeholder", () => {
    expect(ids("API_TOKEN=8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ")).toContain("env.kv");
    expect(ids("API_KEY=changeme")).not.toContain("env.kv");
    expect(ids("API_KEY=${MY_VAR}")).not.toContain("env.kv");
  });
});

describe("PII patterns", () => {
  test("email flags + is autoRedactable", () => {
    const f = scan("ping alice@corp.io please", { repoVisibility: "private" }).findings.find(
      (x) => x.id === "pii.email",
    );
    expect(f).toBeTruthy();
    expect(f?.autoRedactable).toBe(true);
  });
  test("email allowlist: example.com, noreply, self, repo-public", () => {
    expect(ids("see user@example.com")).not.toContain("pii.email");
    expect(ids("from noreply@github.com")).not.toContain("pii.email");
    expect(
      scan("me@garry.dev", { repoVisibility: "private", selfEmail: "me@garry.dev" }).findings,
    ).toHaveLength(0);
    expect(
      scan("bob@acme.co", { repoVisibility: "private", repoPublicEmails: ["bob@acme.co"] }).findings,
    ).toHaveLength(0);
  });
  test("phone E.164", () => {
    expect(ids("call +14155550123 now")).toContain("pii.phone.e164");
  });
  test("ssn flags valid, skips 000 octet", () => {
    expect(ids("ssn 123-45-6789")).toContain("pii.ssn");
    expect(ids("000-12-3456")).not.toContain("pii.ssn");
  });
  test("credit card needs Luhn", () => {
    expect(ids("card 4111111111111111")).toContain("pii.cc");
    expect(ids("num 4111111111111112")).not.toContain("pii.cc");
  });
  test("public IP flagged, RFC1918 skipped", () => {
    expect(ids("connect 8.8.8.8")).toContain("pii.ip_public");
    expect(ids("local 192.168.1.5")).not.toContain("pii.ip_public");
    expect(ids("local 10.0.0.1")).not.toContain("pii.ip_public");
  });
});

describe("internal + legal patterns", () => {
  test("internal hostname", () => {
    expect(ids("db1.corp internal host")).toContain("internal.hostname");
  });
  test("localhost url with path", () => {
    expect(ids("hit http://localhost:8080/admin/secrets")).toContain("internal.url_private");
  });
  test("NDA marker", () => {
    expect(ids("This is CONFIDENTIAL material")).toContain("legal.nda_marker");
  });
  test("named criticism needs a capitalized full name nearby", () => {
    expect(ids("John Smith is incompetent at this")).toContain("legal.named_criticism");
    expect(ids("the build is incompet019ently configured".replace("019", ""))).not.toContain(
      "legal.named_criticism",
    );
  });
});

describe("LOW patterns surface only", () => {
  test("user path is LOW", () => {
    const f = scan("/Users/bob/secret/config", { repoVisibility: "private" }).findings.find(
      (x) => x.id === "internal.user_path",
    );
    expect(f?.tier).toBe("LOW");
  });
  test("TODO marker is LOW", () => {
    const f = scan("TODO(alice) fix later", { repoVisibility: "private" }).findings.find(
      (x) => x.id === "hygiene.todo",
    );
    expect(f?.tier).toBe("LOW");
  });
});

describe("placeholder suppression (per-span)", () => {
  test("AWS docs EXAMPLE key not flagged", () => {
    expect(ids("AKIAIOSFODNN7EXAMPLE")).not.toContain("aws.access_key");
  });
  test("your_ prefix not flagged", () => {
    expect(isPlaceholderSpan("your_api_key")).toBe(true);
  });
  test("a real secret on a line that ALSO contains EXAMPLE still flags", () => {
    // line-based suppression would wrongly skip this; per-span must catch it.
    expect(ids("# EXAMPLE usage\nkey AKIA1234567890ABCDEF")).toContain("aws.access_key");
  });
});

describe("no visibility-based tier promotion (TENSION-2-followup)", () => {
  test("email stays MEDIUM on both private and public", () => {
    const priv = scan("x@corp.io", { repoVisibility: "private" }).findings[0];
    const pub = scan("x@corp.io", { repoVisibility: "public" }).findings[0];
    expect(priv.tier).toBe("MEDIUM");
    expect(pub.tier).toBe("MEDIUM");
    expect(pub.severity).toBe("MEDIUM"); // NOT promoted to HIGH
    expect(pub.repoVisibility).toBe("public"); // recorded for sterner wording
  });
  test("demoted credential patterns stay MEDIUM on public", () => {
    const pub = scan("pk_live_" + "a".repeat(30), { repoVisibility: "public" }).findings[0];
    expect(pub.severity).toBe("MEDIUM");
  });
  test("unknown visibility treated as public for wording, still no promotion", () => {
    const r = scan("x@corp.io", { repoVisibility: "unknown" });
    expect(r.findings[0].severity).toBe("MEDIUM");
  });
});

describe("tool-attributed fence WARN-degrade (TENSION-3)", () => {
  test("placeholder-shaped credential in tool fence → WARN", () => {
    const text = "```codex-review\nfound your_aws_key AKIAIOSFODNN7EXAMPLE in code\n```";
    const r = scan(text, { repoVisibility: "private" });
    // the EXAMPLE key is suppressed as placeholder; verify a non-credential note doesn't block
    expect(r.counts.HIGH).toBe(0);
  });
  test("live-format credential in tool fence STILL blocks", () => {
    const text = "```codex-review\nleaked AKIA1234567890ABCDEF here\n```";
    const r = scan(text, { repoVisibility: "private" });
    expect(r.counts.HIGH).toBe(1); // not degraded — live format
  });
  test("AKIA outside any fence blocks", () => {
    expect(exitCodeFor(scan("AKIA1234567890ABCDEF", {}))).toBe(3);
  });
});

describe("normalization", () => {
  test("zero-width chars inside a key are stripped before matching", () => {
    const zwsp = "​";
    const broken = "AKIA1234567890" + zwsp + "ABCDEF";
    expect(ids(broken)).toContain("aws.access_key");
  });
  test("HTML entity decode", () => {
    const { normalized } = normalizeWithMap("a &amp; b");
    expect(normalized).toBe("a & b");
  });
  test("offset map points back into original", () => {
    const input = "xy​z";
    const { normalized, map } = normalizeWithMap(input);
    expect(normalized).toBe("xyz");
    // 'z' is at normalized index 2, original index 3
    expect(map[2]).toBe(3);
  });
});

describe("oversize fails CLOSED", () => {
  test("input over the byte cap returns a single blocking HIGH finding", () => {
    const big = "a".repeat(2000);
    const r = scan(big, { maxBytes: 1000 });
    expect(r.oversize).toBe(true);
    expect(r.counts.HIGH).toBe(1);
    expect(r.findings[0].id).toBe("engine.input_too_large");
    expect(exitCodeFor(r)).toBe(3);
  });

  // #1824: a malformed --max-bytes used to reach the engine as NaN. `byteLen >
  // NaN` is always false, silently disabling the fail-closed guard. The engine
  // guardrail must fall back to the default cap for any non-finite / <= 0 value.
  test("NaN maxBytes falls back to the default cap (does NOT disable the guard)", () => {
    const big = "a".repeat(2 * 1024 * 1024); // > 1 MiB default cap
    const r = scan(big, { maxBytes: NaN });
    expect(r.oversize).toBe(true);
    expect(r.findings[0].id).toBe("engine.input_too_large");
    expect(exitCodeFor(r)).toBe(3);
  });

  test("negative / zero maxBytes falls back to the default cap", () => {
    // negative would make `byteLen > -5` always true (block everything);
    // the guardrail normalizes it to the default instead.
    const small = "ok";
    expect(scan(small, { maxBytes: -5 }).oversize).toBeFalsy();
    expect(scan(small, { maxBytes: 0 }).oversize).toBeFalsy();
    const big = "a".repeat(2 * 1024 * 1024);
    expect(scan(big, { maxBytes: -5 }).oversize).toBe(true);
  });
});

describe("validators", () => {
  test("luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
  test("entropy", () => {
    expect(shannonEntropy("aaaaaaaa")).toBeLessThan(1);
    expect(shannonEntropy("8Fk2pQ9vXz4wL7mN")).toBeGreaterThan(3);
  });
  test("isPublicIPv4", () => {
    expect(isPublicIPv4("8.8.8.8")).toBe(true);
    expect(isPublicIPv4("10.1.2.3")).toBe(false);
    expect(isPublicIPv4("172.16.5.5")).toBe(false);
    expect(isPublicIPv4("999.1.1.1")).toBe(false);
  });
});

describe("masking + purity", () => {
  test("preview never leaks more than 4 leading chars", () => {
    expect(maskPreview("AKIA1234567890ABCDEF")).toBe("AKIA********…");
    expect(maskPreview("abc")).toBe("abc");
  });
  test("scan is pure — same input twice yields identical findings", () => {
    const a = scan("AKIA1234567890ABCDEF x@corp.io", { repoVisibility: "public" });
    const b = scan("AKIA1234567890ABCDEF x@corp.io", { repoVisibility: "public" });
    expect(a).toEqual(b);
  });
});

describe("taxonomy integrity", () => {
  test("every pattern has a unique id", () => {
    const set = new Set(PATTERNS.map((p) => p.id));
    expect(set.size).toBe(PATTERNS.length);
  });
  test("autoRedactable patterns have a redactToken", () => {
    for (const p of PATTERNS) {
      if (p.autoRedactable) expect(p.redactToken).toBeTruthy();
    }
  });
});
