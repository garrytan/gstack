/**
 * #1947 — security/community dashboards must never report fake zeros.
 *
 * A backend failure, a network failure, or a missing jq used to degrade to
 * "0 attacks" / "Weekly active installs: 0" — indistinguishable from a
 * genuinely healthy reading on a security-signaling surface. The contract
 * pinned here:
 *
 *   - non-200 / network failure / error body  → "unknown", never 0
 *   - jq missing (security dashboard)         → "unknown — install jq", never 0
 *   - 200 with the new backend's status:"ok"  → figures trusted
 *   - 200 without the marker (legacy backend) → figures shown + "unverified" note
 *
 * curl is stubbed via a prepended PATH; the jq-missing case runs with a
 * PATH containing only the stub + whitelisted tools (no jq).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SEC_BIN = join(ROOT, "bin", "gstack-security-dashboard");
const COMM_BIN = join(ROOT, "bin", "gstack-community-dashboard");
// Absolute path: the jq-missing case runs with a whitelist-only PATH, so
// "bash" itself wouldn't resolve through the child env.
const BASH = Bun.which("bash") || "/bin/bash";

const GOOD_BODY_MARKER = JSON.stringify({
  status: "ok",
  weekly_active: 42,
  change_pct: 5,
  top_skills: [{ skill: "ship", count: 9 }],
  crashes: [],
  versions: [],
  security: {
    attacks_last_7_days: 3,
    top_attack_domains: [{ domain: "evil.example", count: 7 }],
    top_attack_layers: [{ layer: "L4", count: 3 }],
    verdict_distribution: [{ verdict: "block", count: 3 }],
  },
});

// Pre-#1947 backend shape: same data, no status marker.
const GOOD_BODY_LEGACY = JSON.stringify({
  ...JSON.parse(GOOD_BODY_MARKER),
  status: undefined,
});

const CURL_STUB = `#!/bin/sh
# Test stub for curl: honors -o <file>, prints the HTTP code (as -w would).
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
case "\${STUB_CURL_MODE:-ok}" in
  ok)       [ -n "$out" ] && printf '%s' "$STUB_CURL_BODY" > "$out"; printf '200' ;;
  error503) [ -n "$out" ] && printf '%s' '{"error":"pulse_unavailable"}' > "$out"; printf '503' ;;
  netfail)  exit 7 ;;
esac
`;

let tmp: string;
let stubBin: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gstack-dash-test-"));
  stubBin = join(tmp, "stub-bin");
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(stubBin, "curl"), CURL_STUB);
  chmodSync(join(stubBin, "curl"), 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function run(
  bin: string,
  opts: {
    mode: "ok" | "error503" | "netfail";
    body?: string;
    json?: boolean;
    noJq?: boolean;
  },
) {
  let pathEnv = `${stubBin}:${process.env.PATH || ""}`;
  if (opts.noJq) {
    // Whitelist-only PATH: the curl stub plus the real tools the script
    // needs — everything except jq.
    const toolBin = join(tmp, "tool-bin");
    mkdirSync(toolBin, { recursive: true });
    for (const tool of ["mktemp", "cat", "grep", "head", "sed", "awk", "rm", "sh", "bash", "tr", "tail"]) {
      const real = Bun.which(tool);
      if (real) symlinkSync(real, join(toolBin, tool));
    }
    pathEnv = `${stubBin}:${toolBin}`;
  }
  return spawnSync(BASH, opts.json ? [bin, "--json"] : [bin], {
    encoding: "utf-8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: pathEnv,
      GSTACK_DIR: ROOT,
      GSTACK_SUPABASE_URL: "https://stub.supabase.test",
      GSTACK_SUPABASE_ANON_KEY: "stub-key",
      STUB_CURL_MODE: opts.mode,
      STUB_CURL_BODY: opts.body ?? "",
    },
  });
}

describe("gstack-security-dashboard — never reports fake zeros (#1947)", () => {
  it("backend 503 → unknown, not 0 (human mode)", () => {
    const r = run(SEC_BIN, { mode: "error503" });
    expect(r.stdout).toContain("unknown — backend error (HTTP 503)");
    expect(r.stdout).not.toContain("Attacks detected last 7 days: 0");
  });

  it("backend 503 → status unknown (json mode)", () => {
    const r = run(SEC_BIN, { mode: "error503", json: true });
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.status).toBe("unknown");
    expect(parsed.reason).toBe("backend_error");
    expect(parsed.security).toBeNull();
  });

  it("network failure → unknown, not 0", () => {
    const r = run(SEC_BIN, { mode: "netfail", json: true });
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.status).toBe("unknown");
    expect(parsed.security).toBeNull();
  });

  it("jq missing → unknown with install hint, never the lossy-grep zero", () => {
    const r = run(SEC_BIN, { mode: "ok", body: GOOD_BODY_MARKER, noJq: true });
    expect(r.stdout).toContain("unknown — install jq");
    expect(r.stdout).not.toContain("Attacks detected last 7 days: 0");
    expect(r.stdout).not.toContain("Attacks detected last 7 days: 3");
  });

  it("jq missing → reason jq_missing (json mode)", () => {
    const r = run(SEC_BIN, { mode: "ok", body: GOOD_BODY_MARKER, noJq: true, json: true });
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.status).toBe("unknown");
    expect(parsed.reason).toBe("jq_missing");
  });

  it("200 + status:ok marker → figures trusted (human mode)", () => {
    const r = run(SEC_BIN, { mode: "ok", body: GOOD_BODY_MARKER });
    expect(r.stdout).toContain("Attacks detected last 7 days: 3");
    expect(r.stdout).toContain("evil.example");
    expect(r.stdout).not.toContain("unverified");
  });

  it("200 + status:ok marker → status ok with full security section (json mode)", () => {
    const r = run(SEC_BIN, { mode: "ok", body: GOOD_BODY_MARKER, json: true });
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.status).toBe("ok");
    expect(parsed.security.attacks_last_7_days).toBe(3);
    // Nested arrays survive (the old lossy-grep fallback broke on these).
    expect(parsed.security.top_attack_domains[0].domain).toBe("evil.example");
  });

  it("stale cache responses pass the stale flag through (json mode)", () => {
    const staleBody = JSON.stringify({ ...JSON.parse(GOOD_BODY_MARKER), stale: true });
    const r = run(SEC_BIN, { mode: "ok", body: staleBody, json: true });
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.status).toBe("ok");
    expect(parsed.stale).toBe(true);
  });

  it("stale snapshot is flagged in human mode too — frozen figures never read as current", () => {
    const staleBody = JSON.stringify({ ...JSON.parse(GOOD_BODY_MARKER), stale: true });
    const r = run(SEC_BIN, { mode: "ok", body: staleBody });
    expect(r.stdout).toContain("Attacks detected last 7 days: 3");
    expect(r.stdout).toContain("stale snapshot");
  });

  it("200 without marker (legacy backend) → figures shown with unverified note", () => {
    const r = run(SEC_BIN, { mode: "ok", body: GOOD_BODY_LEGACY });
    expect(r.stdout).toContain("Attacks detected last 7 days: 3");
    expect(r.stdout).toContain("unverified");
  });

  it("200 without marker → legacy_unverified (json mode)", () => {
    const r = run(SEC_BIN, { mode: "ok", body: GOOD_BODY_LEGACY, json: true });
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.status).toBe("legacy_unverified");
    expect(parsed.security.attacks_last_7_days).toBe(3);
  });

  it("200 with a body missing .security → unknown backend_error, never 0", () => {
    const r = run(SEC_BIN, {
      mode: "ok",
      body: JSON.stringify({ weekly_active: 42, status: "ok" }),
      json: true,
    });
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.status).toBe("unknown");
    expect(parsed.reason).toBe("backend_error");
    expect(parsed.security).toBeNull();
  });
});

describe("gstack-community-dashboard — never reports fake zeros (#1947)", () => {
  it("backend 503 → unknown, not 'Weekly active installs: 0'", () => {
    const r = run(COMM_BIN, { mode: "error503" });
    expect(r.stdout).toContain("unknown — backend error (HTTP 503)");
    expect(r.stdout).not.toContain("Weekly active installs: 0");
  });

  it("network failure → unknown, not 0", () => {
    const r = run(COMM_BIN, { mode: "netfail" });
    expect(r.stdout).toContain("unknown — backend error (HTTP 000)");
    expect(r.stdout).not.toContain("Weekly active installs:");
  });

  it("200 + status:ok marker → figures shown without unverified note", () => {
    const r = run(COMM_BIN, { mode: "ok", body: GOOD_BODY_MARKER });
    expect(r.stdout).toContain("Weekly active installs: 42");
    expect(r.stdout).not.toContain("unverified");
  });

  it("200 without marker (legacy backend) → figures shown with unverified note", () => {
    const r = run(COMM_BIN, { mode: "ok", body: GOOD_BODY_LEGACY });
    expect(r.stdout).toContain("Weekly active installs: 42");
    expect(r.stdout).toContain("unverified");
  });

  it("200 with a garbage body (no weekly_active) → unknown, never 0", () => {
    const r = run(COMM_BIN, { mode: "ok", body: '{"error":"weird"}' });
    expect(r.stdout).toContain("unknown — backend error (HTTP 200)");
    expect(r.stdout).not.toContain("Weekly active installs:");
  });

  it("whitespaced marker ('\"status\": \"ok\"') still classified as verified when jq is present", () => {
    // Pre-landing review: the grep-only marker check was whitespace-sensitive;
    // a proxy-reserialized body must not be misclassified as legacy.
    const spaced = GOOD_BODY_MARKER.replace('"status":"ok"', '"status": "ok"');
    const r = run(COMM_BIN, { mode: "ok", body: spaced });
    expect(r.stdout).toContain("Weekly active installs: 42");
    expect(r.stdout).not.toContain("unverified");
  });

  it("stale snapshot flagged in human mode (matches security-dashboard)", () => {
    const staleBody = JSON.stringify({ ...JSON.parse(GOOD_BODY_MARKER), stale: true });
    const r = run(COMM_BIN, { mode: "ok", body: staleBody });
    expect(r.stdout).toContain("Weekly active installs: 42");
    expect(r.stdout).toContain("stale snapshot");
  });

  it("network failure reports HTTP 000, never a doubled 000000", () => {
    // Adversarial review finding 6: curl prints its own 000 before a
    // non-zero exit; a `|| echo` doubled it in user-facing output.
    const r = run(COMM_BIN, { mode: "netfail" });
    expect(r.stdout).toContain("(HTTP 000)");
    expect(r.stdout).not.toContain("000000");
  });
});
