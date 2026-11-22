/**
 * GST-3474 (gbrain #10028): env.kv did not read Rust. A secret bound with
 * `let`, `let mut`, `const` or `static` (`let token = "<key>";`) gave no
 * finding, because the name had to start the line. And a Rust type annotation
 * (`token: Option<&str>,`, `key: &RelationshipKey,`) or a match arm's path
 * (`Token::Char(c) => {`) read as a secret-named value, so every Rust landing
 * needed allowlist entries. The binding now reports as env.kv.rust in a .rs
 * file or a scan without a path, and a type annotation in a .rs file passes;
 * every hold case below puts a secret in the same position and still reports.
 */
// Value: protects=a secret in a Rust let, const or static binding reports and a Rust type annotation passes; fails_when=the binding miss returns, a type annotation reports again, the binding rule fires in another language's file, or the annotation exemption lets a literal, a random name or a second field through; why_new=GST-3474 had no Rust case; seam=none; no_claim=scanner-level only, the pregate case lives in pregate-secrets-source-context.test.ts
import { describe, expect, test } from "bun:test";
import { scan } from "../lib/redact-engine";

const ids = (text: string, sourcePath?: string) =>
  scan(text, { repoVisibility: "private", processEnv: {}, ...(sourcePath ? { sourcePath } : {}) }).findings.map((f) => f.id);
const S = "Qx9vL2mZp8Rt4Kw7Yn3Bh2Jd";
const FAKE = ["sk", "live", "FAKE", S].join("-");
const LETTERS = "QxvLmZpRtKwYnBhJdTqWsV";
const has = (id: string, cases: ReadonlyArray<readonly [string, string | undefined]>, want: boolean) => {
  for (const [code, file] of cases) expect({ code, file, hit: ids(code, file).includes(id) }).toEqual({ code, file, hit: want });
};

describe("env.kv.rust: a secret in a Rust binding reports (GST-3474)", () => {
  test("let, let mut, const, static and their visibility, type and literal forms report", () => {
    has("env.kv.rust", [
      ['let token = "' + FAKE + '";', "src/lib.rs"],
      ['    let token = "' + S + '";', "src/lib.rs"],
      ['let mut api_key = "' + S + '";', "src/lib.rs"],
      ['const API_KEY: &str = "' + S + '";', "src/lib.rs"],
      ["pub const API_KEY: &'static str = \"" + S + '";', "src/lib.rs"],
      ['pub(crate) static SESSION_SECRET: &str = "' + S + '";', "src/lib.rs"],
      ['static mut AUTH_TOKEN: &str = "' + S + '";', "src/lib.rs"],
      ['    let token: &str = "' + S + '";', "src/lib.rs"],
      ['    let client_secret = String::from("' + S + '");', "src/lib.rs"],
      ['    let token = "' + S + '".to_string();', "src/lib.rs"],
      ['    let token = r#"' + S + '"#;', "src/lib.rs"],
      ['    let password = b"' + S + '";', "src/lib.rs"],
      ['    // let token = "' + S + '";', "src/lib.rs"],
      ['let token = "' + S + '";', undefined],
      ['diff --git a/src/lib.rs b/src/lib.rs\n+++ b/src/lib.rs\n@@ -0,0 +1 @@\n+    let token = "' + S + '";\n', undefined],
    ], true);
  });

  test("benign: a placeholder, an environment read, a short or low-entropy value and a non-credential name give no finding", () => {
    has("env.kv.rust", [
      ['let token = "changeme";', "src/lib.rs"],
      ['let token = "${API_TOKEN}";', "src/lib.rs"],
      ['let token = env::var("API_TOKEN")?;', "src/lib.rs"],
      ['let token = std::env::var("GITHUB_TOKEN").unwrap_or_default();', "src/lib.rs"],
      ['let token = "short";', "src/lib.rs"],
      ["let token = None;", "src/lib.rs"],
      ['let monkey = "' + S + '";', "src/lib.rs"],
      ['let token_count = "' + S + '";', "src/lib.rs"],
    ], false);
  });

  test("scoped to Rust: the same binding in another language's file is not read by the Rust rule", () => {
    has("env.kv.rust", [
      ['let token = "' + S + '";', "src/client.ts"],
      ['const token = "' + S + '";', "src/client.js"],
      ['static token = "' + S + '"', "app/client.py"],
    ], false);
  });
});

describe("env.kv: a Rust type annotation is code, not a secret (GST-3474)", () => {
  test("struct fields, parameters and match-arm paths in a .rs file pass", () => {
    has("env.kv", [
      ["    token: Option<&str>,", "src/lib.rs"],
      ["    key: &RelationshipKey,", "src/lib.rs"],
      ["    by_key: Mutex<HashMap<String, u32>>,", "src/lib.rs"],
      ["    Token::Char(c) => {", "src/lib.rs"],
      ["    session: Arc<Mutex<Session>>,", "src/lib.rs"],
      ["    auth: Box<dyn Fn(&str) -> bool + Send + Sync>,", "src/lib.rs"],
      ["    private_key: &'a [u8; 32],", "src/lib.rs"],
      ["    session_token: Option<SessionToken>, // refreshed on login", "src/lib.rs"],
      ["    private_key: [u8; KEY_LEN],", "src/lib.rs"],
    ], false);
  });

  test("hold: a literal, a random name, a second field, a quoted name, a comment and other files still report", () => {
    has("env.kv", [
      ['    token: "' + S + '",', "src/lib.rs"],
      ["    key: &" + S + ",", "src/lib.rs"],
      ["    token: " + LETTERS + ",", "src/lib.rs"],
      ['    token: Option<&str> = "' + S + '",', "src/lib.rs"],
      ["    token: Option<&str>, other: " + S + ",", "src/lib.rs"],
      ['    "token": Option<&str>,', "src/lib.rs"],
      ["    token: Option<&str>, // token: " + S, "src/lib.rs"],
      ["// token: " + S, "src/lib.rs"],
      ["    token: Option<&str>,", "deploy/values.yaml"],
      ["    key: &RelationshipKey,", undefined],
      ["    Token::Char(c) => {", "src/lexer.ts"],
    ], true);
  });

  test("hold: a credential line inside a string, a struct literal's value and a comma-less line still report", () => {
    has("env.kv", [
      ['const CFG: &str = r#"\nstripe:\n    token: qxvlmzprtkwynbhjdtwa\n"#;\n', "src/cfg.rs"],
      ['const CFG: &str = "\nauth:\n    token: QXVLMZPRTKWYNBHJ\n";\n', "src/cfg.rs"],
      ["    password: Hunter2password", "src/cfg.rs"],
      ["    token: auth_token_value,", "src/lib.rs"],
    ], true);
  });
});
