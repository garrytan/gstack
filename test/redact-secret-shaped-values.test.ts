/**
 * GST-3500 redesign of the secrets scan's declaration rules, plus three
 * false-positive and miss reports gathered on the same issue:
 *
 *   - JS/TS and Go declarations (`const token = "<key>"`, `token := "<key>"`)
 *     gave no finding. They now report as env.kv.js and env.kv.go, but only
 *     when the literal is secret-shaped (a provider key prefix, or random
 *     text: 16+ characters, 3.5+ bits, a mixed run of letters and digits).
 *     The name alone never reports, so key names, environment-variable names,
 *     paths and words as values stay clean.
 *   - GBRA-108: env.kv read a JSON `"key": "sources/vector-index"` field as a
 *     credential. GEVA-561: it read an environment-variable name as a value
 *     (`API_KEY=OPENAI_API_KEY`) as one too.
 *   - TRUT-39: the phone rule read a YYYYMMDD-HHMM run folder as a number.
 *   - HARN-108: a known secret's base64 form was never found by value, and
 *     `AIza…`/`sk-…` matched by chance deep inside long base64 blobs.
 */
// Value: protects=secret-shaped JS/TS and Go declarations report while names-as-values stay clean, JSON "key" paths, env-var-name values and run-folder stamps stop reporting, and a known secret's base64 forms report HIGH; fails_when=a declaration miss returns, a word or name value reports, an exemption swallows a real secret, a base64-encoded key goes unfound, or a chance AIza/sk- match deep in a blob reports; why_new=GST-3500, GBRA-108, GEVA-561, TRUT-39 and HARN-108 had no cases; seam=none; no_claim=scanner-level only, the pregate case lives in pregate-secrets-source-context.test.ts
import { describe, expect, test } from "bun:test";
import { base64Forms, scan } from "../lib/redact-engine";
import { isSecretShapedValue, looksLikeRunStamp } from "../lib/redact-patterns";

const ids = (text: string, sourcePath?: string, processEnv: Record<string, string> = {}) =>
  scan(text, { repoVisibility: "private", processEnv, ...(sourcePath ? { sourcePath } : {}) }).findings.map((f) => f.id);
const j = (...parts: string[]) => parts.join("");
const S = j("Qx9vL2mZ", "p8Rt4Kw7", "Yn3Bh2Jd");
const SK = j("sk-", "live-", "Qx9vL2mZp8", "Rt4Kw7Yn3B");
const UUID = j("ef41947a-643b-", "4494-aaee-", "149f288a9b29");
const HEX = j("9f8e7d6c5b4a3928", "1706f5e4d3c2b1a0");
const GHP = j("ghp_", "a1B2c3D4e5F6g7H8i9J0", "k1L2m3N4o5P6q7R8");
const BT = "\x60";
const has = (id: string, cases: ReadonlyArray<readonly [string, string | undefined]>, want: boolean) => {
  for (const [code, file] of cases) expect({ code, file, hit: ids(code, file).includes(id) }).toEqual({ code, file, hit: want });
};

describe("isSecretShapedValue: the value decides, never the name (GST-3500)", () => {
  test("provider prefixes, UUIDs, hex and mixed random runs are secret-shaped", () => {
    for (const v of [S, SK, UUID, HEX, GHP, S.toUpperCase(), S.toLowerCase(), j("AKIA", "ZQ3XN7P2LM4RT8WV")])
      expect({ v, shaped: isSecretShapedValue(v) }).toEqual({ v, shaped: true });
  });

  test("words, names, paths, placeholders and short or low-entropy text are not", () => {
    for (const v of ["AUTHENTICATION", "PRODUCTION", "CORRECT_HORSE_BATTERY_STAPLE", "CorrectHorseBatteryStaple", "MY_SERVICE_API_KEY", "OAUTH2_SESSION_TOKEN", "agent_model", "terminalFontSize", "test/skill-e2e-plan.test.ts#plan-ceo-review", "e6-multiblock-sentinel", "sources/vector-index", "changeme", "your-api-key-here", "hunter2hunter2", "sk-abcdefgh", "v2024-release-notes", "123e4567-e89b-12d3-a456-426614174000"])
      expect({ v, shaped: isSecretShapedValue(v) }).toEqual({ v, shaped: false });
  });
});

describe("env.kv.js: a secret-shaped literal bound by a JS/TS declaration reports (GST-3500)", () => {
  test("const, let, var, export, typed, template, class-field and + chain forms report", () => {
    has("env.kv.js", [
      ['const token = "' + SK + '";', "src/client.ts"],
      ["const token = '" + UUID + "';", "src/client.js"],
      ['let apiKey = "' + HEX + '";', "src/client.tsx"],
      ['var secret = "' + S + '";', "lib/legacy.cjs"],
      ['export const API_KEY = "' + S + '";', "src/config.mjs"],
      ['export let clientSecret = "' + GHP + '";', "src/config.mts"],
      ['const apiKey: string = "' + S + '";', "src/config.ts"],
      ['const API_KEY = "' + S.toUpperCase() + '";', "src/config.ts"],
      ["const authToken = " + BT + S + BT + ";", "src/config.jsx"],
      ['  private apiKey = "' + S + '";', "src/client.ts"],
      ['  static readonly ACCESS_TOKEN: string = "' + S + '";', "src/client.ts"],
      ['  private #password = "' + S + '";', "src/client.js"],
      ["const token = " + BT + S + "${suffix}" + BT + ";", "src/client.ts"],
      ["const token = " + BT + "${prefix}-" + S + BT + ";", "src/client.ts"],
      ['const API_KEY = "' + S + '" as const;', "src/config.cts"],
      ['// const token = "' + S + '";', "src/client.ts"],
      ['const token = "sk_live_" + "' + S + '";', "src/client.ts"],
      ['const token = "ab" + "' + S + '";', "src/client.ts"],
      ['diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+const token = "' + S + '";\n', "src/a.ts"],
    ], true);
  });

  test("names, words and paths as values give no finding, however credential-shaped the name", () => {
    has("env.kv.js", [
      ['const API_KEY = "AUTHENTICATION"; process.env[API_KEY];', "src/client.ts"],
      ['const token = "PRODUCTION";', "src/client.ts"],
      ['const password = "CORRECT_HORSE_BATTERY_STAPLE";', "src/client.ts"],
      ["const secret = 'CorrectHorseBatteryStaple';", "src/client.ts"],
      ['const API_KEY = "MY_SERVICE_API_KEY"; process.env[API_KEY];', "src/client.ts"],
      ['export const SESSION_KEY = "OAUTH2_SESSION_TOKEN";', "src/config.ts"],
      ["export const MODE_KEY = 'transcript_ingest_mode';", "lib/consent.ts"],
      ["export const VISIBILITY_OVERRIDE_KEY = 'sealed.visibility';", "lib/guard.ts"],
      ["const FONT_SIZE_KEY = 'terminalFontSize';", "extension/panel.js"],
      ["const key = 'test/skill-e2e-plan.test.ts#plan-ceo-review';", "test/shards.ts"],
      ["export const MULTIBLOCK_SENTINEL_KEY = 'e6-multiblock-sentinel';", "test/helpers/multiblock.ts"],
      ["const key = 'sekrit-ubi-key-4711';", "src/client.ts"],
      ['let session: string; const mode = "BILLING_DASHBOARD";', "src/client.ts"],
      ["const authToken = 'route-table-' + suffix;", "src/routes.ts"],
      ["const secret = " + BT + 'LINKEDIN_CLIENT_SECRET="${value}"' + BT + ";", "src/ingest.ts"],
    ], false);
  });

  test("type annotations, destructuring, imports, calls, environment reads and placeholders give no finding", () => {
    has("env.kv.js", [
      ["let token: string;", "src/client.ts"],
      ["const token: string = getToken();", "src/client.ts"],
      ["const { token } = await auth();", "src/client.ts"],
      ["const { apiKey = defaultKey } = options;", "src/client.ts"],
      ['const [apiKey, setApiKey] = useState("");', "src/App.tsx"],
      ['import { API_KEY } from "./config";', "src/client.ts"],
      ['import token from "./token";', "src/client.ts"],
      ["const token = process.env.API_TOKEN;", "src/client.ts"],
      ['const token = "changeme";', "src/client.ts"],
      ['const token = "${API_TOKEN}";', "src/client.ts"],
      ["const token = " + BT + "Bearer ${jwt}" + BT + ";", "src/client.ts"],
      ['const monkey = "' + S + '";', "src/client.ts"],
      ['const tokenCount = "' + S + '";', "src/client.ts"],
      ["private apiKey: string;", "src/client.ts"],
    ], false);
  });

  test("gives up on purpose: a low-entropy human password in a declaration is not read", () => {
    has("env.kv.js", [['const password = "hunter2hunter2";', "src/client.ts"]], false);
  });

  test("scoped to JS/TS: other files and scans without a path are not read by this rule", () => {
    has("env.kv.js", [
      ['const token = "' + S + '";', "src/lib.rs"],
      ['const token = "' + S + '";', "app/client.py"],
      ['const token = "' + S + '";', "docs/setup.md"],
      ['const token = "' + S + '";', undefined],
    ], false);
  });

  test("hold: lines env.kv reports today still report", () => {
    has("env.kv", [
      ['  apiKey: "' + S + '",', "src/client.ts"],
      ["API_KEY=" + S, ".env"],
      ['const a = 1; // apiKey: "' + S + '"', "src/client.ts"],
      ['  #password = "' + S + '";', "src/client.js"],
    ], true);
  });
});

describe("coverage matrix for non-JS assignments (gbrain #10028)", () => {
  test("Rust let, Go :=, var and const, Python and YAML assignments report", () => {
    has("env.kv.rust", [['let token = "' + SK + '";', "src/main.rs"]], true);
    has("env.kv.go", [
      ['token := "' + S + '"', "cmd/main.go"],
      ['\tapiToken := "' + SK + '"', "cmd/main.go"],
      ['var secret = "' + HEX + '"', "cmd/main.go"],
      ['const apiKey string = "' + S + '"', "cmd/main.go"],
      ["\tpassword := " + BT + S + BT, "cmd/main.go"],
    ], true);
    has("env.kv", [['token = "' + S + '"', "app/settings.py"], ["token: " + S, "config/app.yaml"]], true);
  });

  test("Go declarations without a secret-shaped literal, and other files, give no env.kv.go finding", () => {
    has("env.kv.go", [
      ['token := os.Getenv("API_TOKEN")', "cmd/main.go"],
      ['token := "PRODUCTION"', "cmd/main.go"],
      ["var token string", "cmd/main.go"],
      ['token := ""', "cmd/main.go"],
      ['const tokenHeader = "X-Session-Token"', "cmd/main.go"],
      ['token := "' + S + '"', "src/client.ts"],
      ['token := "' + S + '"', undefined],
    ], false);
  });
});

describe("env.kv: a JSON key path and an environment-variable name are names (GBRA-108, GEVA-561)", () => {
  test("a JSON \"key\" field holding a short lowercase path gives no finding", () => {
    has("env.kv", [
      ['"key": "sources/vector-index",', "test/fixtures/doctor.json"],
      ['  "key": "config/embedding_model",', "test/goldens/doctor.json"],
      ['  "key": "sources/foo"', undefined],
      ['    { "key": "checks/e2e/doctor", "ok": true }', "golden.json"],
    ], false);
  });

  test("a secret under \"key\", a mixed run, an uppercase path or another name still reports", () => {
    has("env.kv", [
      ['"key": "' + SK + '",', "test/fixtures/doctor.json"],
      ['"key": "' + S + '",', "test/fixtures/doctor.json"],
      ['"key": "sources/' + S.toLowerCase() + '",', "test/fixtures/doctor.json"],
      ['"key": "sources/x7k2m9q4",', "test/fixtures/doctor.json"],
      ['"key": "Sources/VectorIndex9",', "test/fixtures/doctor.json"],
      ['"api_key": "sources/vector-index",', "test/fixtures/doctor.json"],
    ], true);
  });

  test("an unquoted environment-variable name ending in a credential word gives no finding; a quoted one or a secret does", () => {
    has("env.kv", [["API_KEY=OPENAI_API_KEY", ".env"], ["token: GITHUB_TOKEN", "config/ci.yaml"], ["  token: DAEMON_TOKEN,", undefined]], false);
    has("env.kv", [["API_KEY=" + S.toUpperCase(), ".env"], ["API_KEY=QX9V_L2MZ_P8RT_API_KEY", ".env"], ["API_KEY=OPENAI_API_KEY_" + S, ".env"], ["OPENAI_API_KEY: 'ANOTHER_SECRET',", "test/codex.test.ts"], ['"apiKey": "ANTHROPIC_API_KEY",', "config.json"]], true);
  });
});

describe("pii.phone.e164: a YYYYMMDD-HHMM run folder is a date, not a phone number (TRUT-39)", () => {
  test("valid run stamps give no finding", () => {
    for (const text of ["runs/20261123-1711/report.md", "20261123-1711", "out/20251231-2359-retry", "19990101-0000"])
      expect({ text, phone: ids(text, "notes.md").includes("pii.phone.e164") }).toEqual({ text, phone: false });
    expect(looksLikeRunStamp("20261123-1711")).toBe(true);
  });

  test("phone numbers and invalid stamps still report", () => {
    for (const text of [j("call +1 415-", "555-0123"), j("415-555", "-0123"), j("+44 20 ", "7946 0958"), j("20261323", "-1711"), j("20261123", "-2471"), j("20261132", "-1711"), j("30261123", "-1711")])
      expect({ text, phone: ids(text, "notes.md").includes("pii.phone.e164") }).toEqual({ text, phone: true });
    expect(looksLikeRunStamp(j("20261123", "-171"))).toBe(false);
  });
});

describe("HARN-108: base64 forms of a known secret and chance matches in base64 blobs", () => {
  const SECRET = j("Zq8Lm2Xv", "7Nc4Rt9W", "y1Kp6Hd3");
  const env = { SERVICE_API_KEY: SECRET };
  const filler = (n: number, seed: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + seed * 11 + 5) % 256));
  const embed = (shift: number, url: boolean) => {
    const text = Buffer.concat([filler(30 + shift, shift), Buffer.from(SECRET), filler(31, 7)]).toString("base64");
    return url ? text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : text;
  };

  test("base64Forms gives one stable string per alignment and alphabet, each a substring of the encoded stream", () => {
    const forms = base64Forms(SECRET);
    expect(forms.length).toBeGreaterThanOrEqual(3);
    expect(forms.length).toBeLessThanOrEqual(6);
    for (const shift of [0, 1, 2]) for (const url of [false, true]) expect({ shift, url, found: forms.some((f) => embed(shift, url).includes(f)) }).toEqual({ shift, url, found: true });
  });

  test("the value's base64 or base64url form at each alignment reports env.value HIGH", () => {
    for (const shift of [0, 1, 2]) for (const url of [false, true]) {
      const found = scan("blob: " + embed(shift, url) + "\n", { processEnv: env }).findings.filter((f) => f.id === "env.value");
      expect({ shift, url, hits: found.map((f) => [f.severity, f.description]) }).toEqual({ shift, url, hits: [["HIGH", "Value of the SERVICE_API_KEY environment variable, base64-encoded"]] });
    }
  });

  test("the plain value still reports, and a blob without the value does not", () => {
    expect(ids("key " + SECRET, undefined, env)).toContain("env.value");
    const other = Buffer.concat([filler(30, 1), Buffer.from(SECRET.split("").reverse().join("")), filler(31, 7)]).toString("base64");
    expect(ids("blob: " + other, undefined, env)).not.toContain("env.value");
  });

  const AIZA = j("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q");
  const OPENAI = j("sk-proj-", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4");
  const BLOB = filler(240, 3).toString("base64");
  const inside = (key: string, at: number, blob = BLOB) => "data:image/png;base64," + blob.slice(0, at) + "/" + key + "/" + blob.slice(at);

  test("a pattern match deep inside a long base64 run is chance and gives no provider finding", () => {
    expect(ids(inside(AIZA, 100))).not.toContain("google.api_key");
    expect(ids(inside(OPENAI, 120))).not.toContain("openai.key");
  });

  test("a key at the start of a run, in a short run or on its own still reports", () => {
    expect(ids(inside(AIZA, 10))).toContain("google.api_key");
    expect(ids(inside(AIZA, 100, BLOB.slice(0, 120)))).toContain("google.api_key");
    expect(ids("GOOGLE_KEY: " + AIZA)).toContain("google.api_key");
    expect(ids(inside(OPENAI, 20))).toContain("openai.key");
    const ANTHROPIC = j("sk-ant-api03-", "Ab3dE5gH7jK9mN1pQ3sT5vX7zB9cD1fG3hJ5kL7nP9rS1tV3wY5aC7eF9iK1mO3qU5xZ7bD9fH1jL3nR5tW7yA9cE1gI3kM5oQ7-xyzAA");
    expect(ids("MY_COMPANY_PRODUCTION_ANTHROPIC_API_KEY_FOR_THE_BACKGROUND_WORKER_FLEET_AND_BATCH_JOBS_V2=" + ANTHROPIC)).toContain("anthropic.key");
    expect(ids("services/" + "background-worker-fleet-and-batch-jobs-for-the-production-cluster-v2/" + OPENAI + "/" + "x".repeat(60))).toContain("openai.key");
  });

  test("the exact value stays HIGH deep inside a long base64 run", () => {
    const found = scan(inside(AIZA, 100), { processEnv: { GOOGLE_API_KEY: AIZA } }).findings.filter((f) => f.id === "env.value");
    expect(found.map((f) => f.severity)).toEqual(["HIGH"]);
  });
});
