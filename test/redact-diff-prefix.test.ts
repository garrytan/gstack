/**
 * GST-543: a unified-diff line prefix never hides a finding. `git diff |
 * gstack-redact` and a `\`\`\`diff` fence in a PR body put `+`, `-` or a space
 * before every line; a line-anchored rule that stops at that character
 * misses the credential on an added line. Every pattern must report its
 * sample bare, behind each diff prefix and inside a real hunk.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { scan } from "../lib/redact-engine";
import { PATTERNS } from "../lib/redact-patterns";

const j = (...p: string[]) => p.join("");
const hex32 = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const SAMPLES: Record<string, string> = {
  "aws.access_key": j("AKIA", "ZQ3XN7P2LM4RT8WV"),
  "aws.secret_key": j("aws_secret_access_key = ", "Zq3Xn7P2Lm4Rt8Wv", "Bc5Df6Gh7Jk8Lm9Np0Qr1St2"),
  "github.pat": j("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  "github.oauth": j("gho_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  "github.server": j("ghs_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  "github.fine_grained": j("github_pat_", "a1B2c3D4e5F6g7H8i9J0".repeat(4), "kL"),
  "gitlab.token": j("glpat-", "a1B2c3D4e5F6g7H8i9J0"),
  "groq.key": j("gsk_", "a1B2c3D4e5F6g7H8i9J0k1L2"),
  "tavily.key": j("tvly-", "a1B2c3D4e5F6g7H8i9J0"),
  "notion.token": j("ntn_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2"),
  "huggingface.token": j("hf_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"),
  "npm.token": j("npm_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  "digitalocean.token": j("dop_v1_", hex32, hex32),
  "gcp.service_account": j('{"private_key_id": "', hex32, '", "private_key": "-----BEGIN ', 'PRIVATE KEY-----"}'),
  "anthropic.key": j("sk-ant-", "api03-a1B2c3D4e5F6g7H8i9J0k1L2"),
  "openai.key": j("sk-proj-", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4"),
  "sendgrid.key": j("SG.", "a1B2c3D4e5F6g7H8i9J0k1", ".", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V"),
  "stripe.secret": j("sk_live_", "a1B2c3D4e5F6g7H8i9J0k1L2"),
  "slack.token": j("xoxb-", "12345", "67890-a1B2c3D4e5F6"),
  "slack.webhook": j("https://hooks.slack.com/services/", "T0ABCDEFG/B0ABCDEFG/", "a1B2c3D4e5F6g7H8i9J0k1L2"),
  "discord.webhook": j("https://discord.com/api/webhooks/", "123456789012345678/", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4y5Z6a7B8c9D0e1F2"),
  "twilio.auth_token": j("AC", hex32, " ", hex32.split("").reverse().join("")),
  "google.oauth_client_secret": j("GOCSPX-", "a1B2c3D4e5F6g7H8i9J0k1L2"),
  "telegram.bot_token": j("123456789", ":", "AAa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q"),
  "pem.private_key": j("-----BEGIN RSA ", "PRIVATE KEY-----"),
  "db.url_with_password": j("postgres://admin:", "Xk9pQ2vLm7Rt", "@db.acme.io/prod"),
  "creds.basic_auth_url": j("https://deploy:", "Xk9pQ2vLm7Rt", "@ci.acme.io/hook"),
  "stripe.publishable": j("pk_live_", "a1B2c3D4e5F6g7H8i9J0k1L2"),
  "google.api_key": j("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
  "jwt": ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join("."),
  "env.kv": j("API_TOKEN=", "8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ"),
  "auth.bearer": j("Authorization: Bearer ", "a1B2c3D4e5F6g7H8i9J0k1L2"),
  "pii.email": j("dana.whitfield@", "acmecorp.io"),
  "pii.phone.e164": j("+1415", "5552671"),
  "pii.ssn": j("123-45", "-6789"),
  "pii.cc": j("4532 0151 ", "1283 0366"),
  "pii.ip_public": j("203.0.", "113.77"),
  "pii.wallet": j("0x529084000985", "27886E0F7030069857D2E4169EE7"),
  "internal.hostname": j("build-01.", "corp"),
  "internal.url_private": j("http://local", "host:8080/admin"),
  "legal.nda_marker": j("CONFIDEN", "TIAL"),
  "legal.named_criticism": j("Dana Whitfield was ", "fir", "ed"),
  "internal.user_path": j("/Us", "ers/dana/projects/app"),
  "hygiene.todo": j("TO", "DO(dana)"),
};

const ids = (text: string) => scan(text, { repoVisibility: "public", processEnv: {} }).findings.map((f) => f.id);
const hunk = (body: string) => ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -0,0 +1 @@", body, ""].join("\n");

describe("GST-543: a diff line prefix never hides a finding", () => {
  test("every pattern has a sample that reports bare", () => {
    expect(PATTERNS.map((p) => p.id).filter((id) => !SAMPLES[id])).toEqual([]);
    expect(PATTERNS.filter((p) => !ids(SAMPLES[p.id]!).includes(p.id)).map((p) => p.id)).toEqual([]);
  });

  test("each sample still reports behind +, - and a space, and on an added line inside a hunk", () => {
    const missed: string[] = [];
    for (const p of PATTERNS) {
      const s = SAMPLES[p.id]!;
      for (const [label, text] of [["+", "+" + s], ["-", "-" + s], ["space", " " + s], ["hunk", hunk("+" + s)], ["indented hunk", hunk("+    " + s)], ["indented removed", hunk("-    " + s)], ["tab removed", hunk("-\t" + s)], ["combined ++", hunk("++" + s)], ["combined space+", hunk(" +  " + s)], ["combined +-", hunk("+-" + s)]] as const)
        if (!ids(text).includes(p.id)) missed.push(`${p.id} (${label})`);
    }
    expect(missed).toEqual([]);
  });

  test("env.kv reports an exported or indented credential on an added or removed line", () => {
    const v = SAMPLES["env.kv"]!.slice("API_TOKEN=".length);
    for (const line of [`-export API_TOKEN=${v}`, `+export API_TOKEN=${v}`, `-  api_token: ${v}`])
      expect({ line, kv: ids(hunk(line)).includes("env.kv") }).toEqual({ line, kv: true });
    for (const bullet of ["- Credentials: `.auth.json`, `auth-token.json`", "- Session: `GSTACK_SESSION_KIND=unattended`", "  - Session: `GSTACK_SESSION_KIND=unattended`", "-- Session: `GSTACK_SESSION_KIND=unattended`"])
      expect({ bullet, kv: ids(bullet).includes("env.kv") }).toEqual({ bullet, kv: false });
  });

  test("git diff | gstack-redact reports an added env.kv credential and exits 2; a placeholder on the same line stays clean", () => {
    const run = (line: string) => spawnSync("bun", [path.join(import.meta.dir, "..", "bin", "gstack-redact"), "--json"], { input: hunk("+" + line), encoding: "utf8", timeout: 30_000 });
    const real = run(SAMPLES["env.kv"]!);
    expect({ status: real.status, ids: JSON.parse(real.stdout).findings.map((f: { id: string }) => f.id) }).toEqual({ status: 2, ids: ["env.kv"] });
    expect(run("API_TOKEN=changeme").status).toBe(0);
  });

  test("the prefix changes nothing else: env.kv's exemptions hold on an added line", () => {
    for (const line of ["API_TOKEN=changeme", "cacheKey: 8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ", "input_key: expected_media_rate_bits_per_second", 'api_key=os.environ["API_KEY"]', "TOKEN=${API_TOKEN}"]) {
      expect({ line, bare: ids(line).includes("env.kv") }).toEqual({ line, bare: false });
      for (const marker of ["+", "-", "+  ", "-  ", "++", " +", "+-"]) expect({ line: marker + line, kv: ids(hunk(marker + line)).includes("env.kv") }).toEqual({ line: marker + line, kv: false });
    }
  });
});
