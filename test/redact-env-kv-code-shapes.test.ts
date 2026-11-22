/**
 * GST-3004: env.kv ("secret-named assignment with high-entropy value") flagged
 * code as a secret, and the pregate secrets check, which cannot be downgraded,
 * stopped pushes on it. Three shapes are now read as code, each by the value's
 * shape and never by the key's name or the file's path, and each pass has a
 * hold case putting a real-looking secret in the same position: a TypeScript
 * type with spaced generic arguments, a Python keyword argument reading a
 * CONSTANT_CASE setting, and a quoted camelCase dotted field path (#4289).
 * Three reported shapes stay known limits: a JS/TS template key (#4287), an
 * array of names (GBRA-615) and a string-literal generic type (CAPY-1). An
 * entropy test on their text alone let random hex and encoded literals through
 * (the second-model audit's bypasses below), so they still report.
 */
// Value: protects=env.kv passes three code shapes while a secret in the same position, a config file or a string still reports, and the three known-limit shapes and the audit's bypass lines keep reporting; fails_when=one of the fixed false positives returns, or an exemption lets a high-entropy, hex, encoded or provider-shaped value through; why_new=the cases had no test; seam=none; no_claim=scanner-level only, the pregate case lives in pregate-secrets-source-context.test.ts
import { describe, expect, test } from "bun:test";
import { scan } from "../lib/redact-engine";

const ids = (text: string, sourcePath?: string) =>
  scan(text, { repoVisibility: "private", processEnv: {}, ...(sourcePath ? { sourcePath } : {}) }).findings.map((f) => f.id);
const kv = (text: string, sourcePath?: string) => ids(text, sourcePath).includes("env.kv");
const S = "Qx9vL2mZp8Rt4Kw7Yn3Bh2Jd";
const HEX = ["9d1e7ebb", "51b069eb", "1bd6"].join("");
const STRIPE = ["sk", "live", S].join("_");
const SPACED = "R7m!2pX K4v@8Q j9W#3s";
const BT = "~";
const passes = (cases: ReadonlyArray<readonly [string, string | undefined]>) => {
  for (const [code, file] of cases) expect({ code, file, kv: kv(code, file) }).toEqual({ code, file, kv: false });
};
const holds = (cases: ReadonlyArray<readonly [string, string | undefined]>) => {
  for (const [code, file] of cases) expect({ code, file, kv: kv(code, file) }).toEqual({ code, file, kv: true });
};

describe("env.kv: code shapes are not secrets (GST-3004)", () => {
  test("a TypeScript annotation with spaced generic arguments passes", () => {
    passes([
      ["  session: Awaited<ReturnType<typeof launchClaudePty>>;", "test/trust.test.ts"],
      ["  credentials: Record<string, CredentialEntry>;", "src/vault.ts"],
      ["  auth: Map<string, AuthInfo> | undefined,", "src/context.ts"],
      ["  session: Pick<ClaudePtySession, Send | Close> | null,", "src/launch.ts"],
    ]);
  });
  test("hold: a literal type, a default value, an object-literal value and a config file still report", () => {
    holds([
      ['  session: Pick<Session, "' + S + '"> | null,', "src/orchestrator.ts"],
      ['  session: Pick<Session, "' + HEX + '">,', "src/orchestrator.ts"],
      ['password: Pick<Session, "' + SPACED + '">,', "src/client.ts"],
      ['  session: Awaited<ReturnType<typeof launch>> = "' + S + '",', "src/orchestrator.ts"],
      ['  session: Map<string, AuthInfo>, other: "' + S + '",', "src/orchestrator.ts"],
      ['  session: "' + S + '",', "src/orchestrator.ts"],
      ["  session: Awaited<ReturnType<typeof " + S + ">>;", "deploy/values.yaml"],
      ["  session: Awaited<ReturnType<typeof launchClaudePty>>;", undefined],
    ]);
    expect(ids('  session: Pick<Session, "' + STRIPE + '">,', "src/a.ts")).toEqual(expect.arrayContaining(["env.kv", "stripe.secret"]));
  });

  test("a Python keyword argument reading a CONSTANT_CASE setting passes (#4289)", () => {
    passes([
      ["    aws_secret_access_key=settings.S3_SECRET_KEY,", "app/storage.py"],
      ["    aws_secret_access_key=settings.S3_SECRET_KEY)", "app/storage.py"],
      ["    aws_secret_access_key=settings.S3_SECRET_KEY,  # from the env", "app/storage.py"],
      ["    password=django_settings.DATABASES_DEFAULT_PASSWORD,", "app/db.py"],
    ]);
  });
  test("hold: a literal beside the read, a lowercase attribute, a .env file and a string still report (#4289's table)", () => {
    holds([
      ['    aws_secret_access_key=settings.S3_SECRET_KEY or "' + S + '",', "app/storage.py"],
      ['    aws_secret_access_key=settings.S3_SECRET_KEY + "' + S + '",', "app/storage.py"],
      ['    aws_secret_access_key=settings.S3_SECRET_KEY.replace("a", "' + S + '"),', "app/storage.py"],
      ['    password=settings.DB_PASSWORD; token="' + S + '"', "app/storage.py"],
      ["    aws_secret_access_key=settings.S3_SECRET_KEY, region=" + S, "app/storage.py"],
      ["      password=request.password,", "app/api/handlers.py"],
      ["SECRET_KEY=settings.S3_SECRET_KEY", ".env"],
      ['CONFIG = """\n    aws_secret_access_key=settings.S3_SECRET_KEY,\n"""', "app/storage.py"],
    ]);
  });

  test("a quoted camelCase dotted field path of three word segments passes (#4289)", () => {
    passes([
      ['KEY = "form.section.fieldName"', "app/forms.py"],
      ['    field_key="form.section.fieldName",', "app/forms.py"],
      ["  KEY = 'form.section.fieldName';", "src/forms.ts"],
    ]);
  });
  test("hold: a secret segment, a digit, a two-segment or all-lowercase path and an unclosed quote still report", () => {
    holds([
      ['    session = "self.client.session"', "tests/test_views.py"],
      ['KEY = "form.' + S + '"', "app/forms.py"],
      ['KEY = "form.section.' + S + '"', "app/forms.py"],
      ['KEY = "form.section2.fieldName"', "app/forms.py"],
      ['KEY = "section.fieldNameValue"', "app/forms.py"],
      ['KEY = "form.section.fieldName', "app/forms.py"],
    ]);
  });
  test("hold: a dotted field path with a secret literal after it, or outside source code, still reports", () => {
    holds([
      ['password = "form.section.fieldName" or "' + S + '"', "app/forms.py"],
      ['SECRET_KEY = "form.section.fieldName", "' + S + '"', "app/forms.py"],
      ['  apiKey: "form.section.fieldName" || "' + S + '",', "src/forms.ts"],
      ['PASSWORD="form.section.fieldName"', ".env"],
      ['session_key: "form.section.fieldName"', "config/app.yml"],
      ['PASSWORD="form.section.fieldName"', undefined],
    ]);
  });

  test("known limits: template keys, arrays of names and string-literal generic types still report, and so do the audit's bypass lines", () => {
    const template = (text: string) => text.replaceAll(BT, "\x60").replaceAll("@{", "$" + "{");
    holds([
      [template("  key: ~@{over.day}|@{over.groomerId}|over_tough|~,"), "src/cache.ts"],
      ['  "reveal_secret": [load_secrets, "secretsOperations"],', "src/core/operation-loaders.generated.ts"],
      ['  session: Pick<Session, "id" | "forkedFrom"> | null,', "src/orchestrator.ts"],
      [template("password = ~" + SPACED + "@{suffix}~;"), "src/client.ts"],
      [template("password = ~@{tenant}" + HEX + "~;"), "src/client.ts"],
      [template("password = ~@{/m4Fq8Wz2Rn7Yb3Hd9Vk6Lp5C/.source}~;"), "src/client.ts"],
      [template("password = ~@{String.fromCharCode(109,52,70,113,56,87,122,50)}~;"), "src/client.ts"],
      ['password: [load_auth, "' + SPACED + '"],', "src/client.ts"],
      ['password: [load_auth, "' + HEX + '"],', "src/client.ts"],
    ]);
  });
});
