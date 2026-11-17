/**
 * GST-3004: env.kv ("secret-named assignment with high-entropy value") flagged
 * code as a secret, and the pregate secrets check, which cannot be downgraded,
 * stopped pushes on it: a JS/TS template key (#4287, #4309), a TypeScript type
 * annotation with spaced generic arguments (CAPY-1, qm#3589), an array of
 * loader names in gbrain's generated operation table (GBRA-615), a Python
 * keyword argument reading a settings constant and a quoted dotted field path
 * (#4289). Each exemption is decided by the value's shape, never by the key's
 * name or the file's path, and each pass below has a hold case putting a
 * real-looking secret in the same position.
 */
// Value: protects=env.kv passes the five code shapes above while a secret in the same position, a config file or a string still reports; fails_when=one of the false positives returns, or an exemption lets a high-entropy or provider-shaped value through; why_new=the cases had no test; seam=none; no_claim=scanner-level only, the pregate case lives in pregate-secrets-source-context.test.ts
import { describe, expect, test } from "bun:test";
import { scan } from "../lib/redact-engine";

const ids = (text: string, sourcePath?: string) =>
  scan(text, { repoVisibility: "private", processEnv: {}, ...(sourcePath ? { sourcePath } : {}) }).findings.map((f) => f.id);
const kv = (text: string, sourcePath?: string) => ids(text, sourcePath).includes("env.kv");
const S = "Qx9vL2mZp8Rt4Kw7Yn3Bh2Jd";
const STRIPE = ["sk", "live", S].join("_");
const SPACED = "R7m!2pX K4v@8Q j9W#3s";
const passes = (cases: ReadonlyArray<readonly [string, string | undefined]>) => {
  for (const [code, file] of cases) expect({ code, file, kv: kv(code, file) }).toEqual({ code, file, kv: false });
};
const holds = (cases: ReadonlyArray<readonly [string, string | undefined]>) => {
  for (const [code, file] of cases) expect({ code, file, kv: kv(code, file) }).toEqual({ code, file, kv: true });
};

describe("env.kv: code shapes are not secrets (GST-3004)", () => {
  const template = '  key: `${over.day}|${over.groomerId}|over_tough|`,';
  test("a JS/TS template key made of slots and key-naming text passes (#4287)", () => {
    passes([
      [template, "src/cache.ts"],
      [template, "src/Cache.tsx"],
      [template, "src/cache.js"],
      [template, "src/cache.mjs"],
      ["  token: `tok-${over.ordinal ?? 1}`,", "test/prepass.test.ts"],
      ["  key = `${candidate.dev}:${candidate.ino}`,", "lib/cache.ts"],
      ["  idempotency_key: `autopilot-cycle:${src.id}:${opts.slot}`,", "src/fanout.ts"],
      ["  apiKey = `${tenant}:${user.id}:over_tough`; // cache key", "src/cache.ts"],
    ]);
  });
  test("hold: a secret in the template's text, a template without a slot, a literal in a slot or after it, and other files still report", () => {
    holds([
      ["  key: `${over.day}|" + S + "|`,", "src/cache.ts"],
      ["  key: `Qx9v${a}L2mZ${b}p8Rt${c}4Kw7`,", "src/cache.ts"],
      ["  key: `" + S + "`,", "src/cache.ts"],
      ["password = `" + SPACED + "${suffix}`;", "src/client.ts"],
      ["password = `${/m4Fq8Wz2Rn7Yb3Hd9Vk6Lp5C/.source}`;", "src/client.ts"],
      ["password = `${48213957601234}`;", "src/client.ts"],
      ["password = `${0x9f3ac2e1b7d4}`;", "src/client.ts"],
      ['  key: `${lookup("' + S + '")}|over_tough`,', "src/cache.ts"],
      ["  key: `${over.day}|over_tough` + \"" + S + "\",", "src/cache.ts"],
      ["  key: `${over.day}|over_tough` + `" + S + "`,", "src/cache.ts"],
      ["  key: `${over.day}|\n" + S + "`,", "src/cache.ts"],
      ['  key: "`${over.day}|' + S + '`",', "src/cache.ts"],
      ["/*\n  key: `${over.day}|" + S + "`,\n*/", "src/cache.ts"],
      [template, ".env"],
      [template, "config.yaml"],
      [template, undefined],
    ]);
    expect(ids("  key: `${over.day}|" + STRIPE + "`,", "src/cache.ts")).toEqual(expect.arrayContaining(["env.kv", "stripe.secret"]));
  });

  test("a TypeScript annotation with spaced or literal generic arguments passes (CAPY-1)", () => {
    passes([
      ['  session: Pick<Session, "id" | "forkedFrom"> | null,', "src/orchestrator.ts"],
      ["  session: Pick<ClaudePtySession, 'send'>,", "test/helpers/launch.ts"],
      ["  session: Awaited<ReturnType<typeof launchClaudePty>>;", "test/trust.test.ts"],
      ["  auth: Pick<AuthInfo, 'clientId' | 'principal'> | undefined,", "src/context.ts"],
      ["  key: Omit<CacheKey, 'cluster_generation'>,", "src/cache.ts"],
      ["  credentials: Record<string, CredentialEntry>;", "src/vault.ts"],
    ]);
  });
  test("hold: a secret as a literal type or a default, a value in an object literal, and a config file still report", () => {
    holds([
      ['  session: Pick<Session, "' + S + '"> | null,', "src/orchestrator.ts"],
      ['password: Pick<Session, "' + SPACED + '">,', "src/client.ts"],
      ['  session: Pick<Session, "id"> | null = "' + S + '",', "src/orchestrator.ts"],
      ['  session: Pick<Session, "id"> | null, other: "' + S + '",', "src/orchestrator.ts"],
      ['  session: "' + S + '",', "src/orchestrator.ts"],
      ['  session: Pick<Session, "id" | "' + S + '">', "deploy/values.yaml"],
      ['  session: Pick<Session, "id" | "forkedFrom"> | null,', undefined],
    ]);
    expect(ids('  session: Pick<Session, "' + STRIPE + '">,', "src/a.ts")).toEqual(expect.arrayContaining(["env.kv", "stripe.secret"]));
  });

  test("an array of names and key-naming literals in source passes (GBRA-615)", () => {
    const table = "src/core/operation-loaders.generated.ts";
    passes([
      ['  "reveal_secret": [load_secrets, "secretsOperations"],', table],
      ['  "get_token": [load_auth, "authOperations"],', table],
      ['  "get_token": [load_auth, "authOperations"], // generated', table],
      ["  get_token: [loaders.auth, authOperations]", table],
      ['    "session": [load_session, "sessionOperations"],', "gbrain/loaders.py"],
    ]);
    expect(kv('  "storage_list": [load_storage_manifest, "storageOperations"],', table)).toBe(false);
  });
  test("hold: a secret element, a random name, more text after the array, a call or a multi-line array, and a config file still report", () => {
    const table = "src/core/operation-loaders.generated.ts";
    holds([
      ['  "get_token": [load_auth, "' + S + '"],', table],
      ['password: [load_auth, "' + SPACED + '"],', "src/client.ts"],
      ['  "get_token": [load_auth, "authOperations", "' + S + '"],', table],
      ['  "get_token": [' + S + ', "authOperations"],', table],
      ['  "get_token": [load_auth, "authOperations"], "' + S + '",', table],
      ['  "get_token": [load_auth("' + S + '"), "authOperations"],', table],
      ['  "get_token": [load_auth,', table],
      ["  get_token: [load_auth, " + S + "]", "config/loaders.yaml"],
      ['  "get_token": [load_auth, "authOperations"],', "config/loaders.json"],
      ['  "get_token": [load_auth, "authOperations"],', undefined],
    ]);
    expect(ids('  "get_token": [load_auth, "' + STRIPE + '"],', table)).toEqual(expect.arrayContaining(["env.kv", "stripe.secret"]));
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
});
