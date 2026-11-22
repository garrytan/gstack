/**
 * GST-3500: env.kv reads a secret-named value only when the name starts its
 * line, so a key bound by a JavaScript or TypeScript declaration
 * (`const token = "<key>";`, `export let API_KEY = '<key>'`,
 * `var secret = \`<key>\``) or a class field (`private apiKey = "<key>";`)
 * gave no finding. These now report as env.kv.js in a .js, .jsx, .ts, .tsx,
 * .mjs, .cjs, .mts or .cts file. Declarations that hold no literal (type
 * annotations, destructuring, imports, calls, environment reads) and
 * placeholders stay clean, and other files read as before.
 */
// Value: protects=a key bound by a JS/TS const, let, var or class field reports while declarations without a secret literal stay clean; fails_when=the declaration miss returns, the rule flags a type annotation, destructuring, an import or a placeholder, or it fires outside JS/TS files; why_new=GST-3500 had no test; seam=none; no_claim=scanner-level only, the pregate case lives in pregate-secrets-source-context.test.ts
import { describe, expect, test } from "bun:test";
import { scan } from "../lib/redact-engine";

const ids = (text: string, sourcePath?: string) =>
  scan(text, { repoVisibility: "private", processEnv: {}, ...(sourcePath ? { sourcePath } : {}) }).findings.map((f) => f.id);
const S = "Qx9vL2mZp8Rt4Kw7Yn3Bh2Jd";
const FAKE = ["sk", "live", "FAKE", S].join("-");
const BT = "\x60";
const has = (id: string, cases: ReadonlyArray<readonly [string, string | undefined]>, want: boolean) => {
  for (const [code, file] of cases) expect({ code, file, hit: ids(code, file).includes(id) }).toEqual({ code, file, hit: want });
};

describe("env.kv.js: a key bound by a JS/TS declaration reports (GST-3500)", () => {
  test("const, let, var, export, typed, template and class-field forms report in JS/TS files", () => {
    has("env.kv.js", [
      ['const token = "' + FAKE + '";', "src/client.ts"],
      ["const token = '" + S + "';", "src/client.js"],
      ['let apiKey = "' + S + '";', "src/client.tsx"],
      ['var secret = "' + S + '";', "lib/legacy.cjs"],
      ['export const API_KEY = "' + S + '";', "src/config.mjs"],
      ['export let clientSecret = "' + S + '";', "src/config.mts"],
      ['const apiKey: string = "' + S + '";', "src/config.ts"],
      ["const authToken = " + BT + S + BT + ";", "src/config.jsx"],
      ['  private apiKey = "' + S + '";', "src/client.ts"],
      ['  static readonly ACCESS_TOKEN: string = "' + S + '";', "src/client.ts"],
      ['  #password = "' + S + '";', "src/client.js"],
      ['const API_KEY = "' + S + '" as const;', "src/config.cts"],
      ['// const token = "' + S + '";', "src/client.ts"],
      ["const token = 'ef41947a-643b-4494-aaee-149f288a9b29';", "src/client.ts"],
      ["const key = 'sekrit-ubi-key-4711';", "src/client.ts"],
      ["const token = 'tunnel-start-token-0123456789';", "src/client.ts"],
      ["const secret = " + BT + "prefix-" + S, "src/client.ts"],
      ['const token = "sk_live_" + "' + S + '";', "src/client.ts"],
      ['const token = "ab" + "' + S + '";', "src/client.ts"],
      ['diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+const token = "' + S + '";\n', "src/a.ts"],
    ], true);
  });

  test("benign: type annotations, destructuring, imports, calls, environment reads, placeholders and non-credential names give no finding", () => {
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
      ['const token = "short";', "src/client.ts"],
      ['const monkey = "' + S + '";', "src/client.ts"],
      ['const tokenCount = "' + S + '";', "src/client.ts"],
      ["private apiKey: string;", "src/client.ts"],
      ["export const MODE_KEY = 'transcript_ingest_mode';", "lib/consent.ts"],
      ["export const VISIBILITY_OVERRIDE_KEY = 'sealed.visibility';", "lib/guard.ts"],
      ["const FONT_SIZE_KEY = 'terminalFontSize';", "extension/panel.js"],
      ["const key = 'test/skill-e2e-plan.test.ts#plan-ceo-review';", "test/shards.test.ts"],
      ["export const MULTIBLOCK_SENTINEL_KEY = 'e6-multiblock-sentinel';", "test/helpers/multiblock.ts"],
      ["const authToken = 'route-table-' + suffix;", "test/routes.test.ts"],
      ["const secret = " + BT + 'LINKEDIN_CLIENT_SECRET="${value}"' + BT + ";", "test/ingest.test.ts"],
    ], false);
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
      ['API_KEY=' + S, ".env"],
      ['const a = 1; // apiKey: "' + S + '"', "src/client.ts"],
    ], true);
  });
});
