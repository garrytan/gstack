/**
 * GST-3004 (#4289 cases 3 and 4): env.kv read only the first token after a
 * secret-named assignment at the start of a line, so a secret placed after a
 * short concatenated piece (`KEY = "form.x" + "<secret>"`) or written in a
 * comment (`x = 1  # API_KEY = "<secret>"`) gave no finding. A `+` chain's
 * literals are now joined and checked, and a name may start right after a
 * comment marker. The benign cases are the same shapes holding text that names
 * a key, so the new reads add no finding there.
 */
// Value: protects=env.kv reports a secret in a + chain or a comment; fails_when=either miss returns, or the comment read starts reporting prose and key-naming text; why_new=#4289 cases 3 and 4 had no test; seam=none; no_claim=scanner-level only, the pregate case lives in pregate-secrets-source-context.test.ts
import { describe, expect, test } from "bun:test";
import { scan } from "../lib/redact-engine";

const findings = (text: string, sourcePath?: string) =>
  scan(text, { repoVisibility: "private", processEnv: {}, ...(sourcePath ? { sourcePath } : {}) }).findings.filter((f) => f.id === "env.kv");
const kv = (text: string, sourcePath?: string) => findings(text, sourcePath).length > 0;
const S = "Qx9vL2mZp8Rt4Kw7Yn3Bh2Jd";
const S2 = ["Zz8Kq2Lm", "7Np4Rs9T", "v3Wx6Yb"].join("");

describe("env.kv: secrets built by concatenation or written in comments (GST-3004, #4289)", () => {
  test("a secret after a short concatenated piece, or split across pieces, reports", () => {
    for (const [code, file] of [
      ['KEY = "form.x" + "' + S + '"', "app/forms.py"],
      ["KEY = 'form.x' + '" + S + "'", "app/forms.py"],
      ['  apiKey: "sk" + "' + S + '",', "src/client.ts"],
      ['  apiKey: base + "' + S + '",', "src/client.ts"],
      ['TOKEN = "Qx9vL2m" + "Zp8Rt4K" + "w7Yn3Bh"', "app/client.py"],
      ['TOKEN = "Qx9vL2m" + region + "Zp8Rt4K" + "w7Yn3Bh"', "app/client.py"],
      ['TOKEN = "Qx9vL2m" + "Zp8Rt4K" + fetch_rest()', "app/client.py"],
      ['TOKEN="abc"+"' + S + '"', ".env"],
    ] as const) expect({ code, file, kv: kv(code, file) }).toEqual({ code, file, kv: true });
  });
  test("a secret in a trailing or whole-line comment reports", () => {
    for (const [code, file] of [
      ['x = 1  # API_KEY = "' + S + '"', "app/settings.py"],
      ["# API_KEY=" + S, "deploy/env.sh"],
      ['const a = 1; // apiKey: "' + S + '"', "src/client.ts"],
      ['// apiKey: "' + S + '"', "src/client.ts"],
      ['/* token: "' + S + '" */', "src/client.ts"],
      ["<!-- password: " + S + " -->", "docs/setup.html"],
      ["retries: 3  # token: " + S, "deploy/values.yaml"],
    ] as const) expect({ code, file, kv: kv(code, file) }).toEqual({ code, file, kv: true });
  });
  test("a secret in the code and another in its comment report separately", () => {
    expect(findings('API_KEY="' + S + '"  # TOKEN="' + S2 + '"', "app/settings.py").map((f) => f.col)).toEqual([10, 46]);
  });
  test("a long run of spaces or comment markers scans in linear time", () => {
    for (const text of [" ".repeat(40_000) + "x", "# " + " ".repeat(40_000) + "x", "#".repeat(40_000) + "x", "/".repeat(40_000)]) {
      const started = performance.now();
      scan(text, { repoVisibility: "private", processEnv: {}, sourcePath: "src/client.ts", maxBytes: 1 << 20 });
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
  test("a line whose code is exempt still reports a secret in its comment", () => {
    expect(kv('    session = self.client.session  # TOKEN="' + S + '"', "tests/test_views.py")).toBe(true);
  });

  test("benign: chains of key-naming text and names, prose and key-naming text in comments, and placeholders give no finding", () => {
    for (const [code, file] of [
      ['sessionKey = "user:" + user_id + ":sessions_active"', "app/cache.py"],
      ['token = "Bearer " + jwt', "app/client.py"],
      ['KEY = "form." + "section.fieldName"', "app/forms.py"],
      ["  sessionKey: prefix + suffix,", "src/cache.ts"],
      ["# Auth: authentication, authorization, sessions, permissions. A data file", "bin/diff-scope"],
      ["//     signal_key: 'test-discipline',", "hooks/preference.ts"],
      ["# password: changeme", "deploy/values.yaml"],
      ["# token: ${GITHUB_TOKEN}", "deploy/env.sh"],
      ["x = 1  # see docs/token: for details", "app/settings.py"],
      ["url = 'https://example.test/#token=abcdefgh'", "app/settings.py"],
    ] as const) expect({ code, file, kv: kv(code, file) }).toEqual({ code, file, kv: false });
  });
});
