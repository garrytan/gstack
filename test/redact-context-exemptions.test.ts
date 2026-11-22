/**
 * Redaction false positives that blocked pushes and decision logs, each paired
 * with true-positive controls that must still report at the same tier.
 *
 * Every exemption below is decided by context, so each table carries the
 * benign vector AND the same (or same-shaped) value in a sensitive context.
 * A guard that passes the benign half by gutting the pattern fails the
 * control half.
 */
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { scan, type Finding } from "../lib/redact-engine";

const FIXTURES = path.join(import.meta.dir, "fixtures", "redact-diagram");

function findings(text: string): Finding[] {
  return scan(text, { repoVisibility: "private" }).findings;
}
function tierOf(text: string, id: string): string | undefined {
  return findings(text).find((f) => f.id === id)?.severity;
}

function table(id: string, tier: string, benign: string[], controls: string[]): void {
  for (const input of benign) {
    test(`clean: ${input.slice(0, 70)}`, () => {
      expect(findings(input).map((f) => f.id)).not.toContain(id);
    });
  }
  for (const input of controls) {
    test(`still ${tier}: ${input.slice(0, 70)}`, () => {
      expect(tierOf(input, id)).toBe(tier);
    });
  }
}

describe("pii.phone.e164 / pii.cc: vector geometry is not PII (#2885, #2827)", () => {
  table(
    "pii.phone.e164",
    "MEDIUM",
    [
      "M 37.6188 101.694 L 100 64.5326 100",
      "M50 1C1 2 37.6188 101.694 51.6863 99.4363Z",
      'viewBox="0 0 581.66796875 695.65625"',
      'transform="translate(296.1484375, 298.796875)"',
      "fill:hsl(0, 0%, 98.9215686275%)",
      "v 12.3456 100.125 7.5",
      '{"type":"rectangle","x":250.9140625,"y":8}',
      '{"seed":1808177121,"version":3,"versionNonce":1365644783}',
      '"updated": 1791059590857,',
    ],
    [
      "call me at +1 415 555 0123 tomorrow",
      "tel: +14155550123",
      "p 415.555.0123",
      "tel +1 415.555.0123",
      "ring +44 20 7946 0958",
      "phone: (415) 555-0123",
      "+37.6188 101.694",
      '{"phone":1808177121}',
      '"contact": 14155550123,',
      "seed 1808177121",
    ],
  );

  table(
    "pii.cc",
    "MEDIUM",
    ['"height":492.34399999999994,', '"gap":3.266375000000039}', "0.4111111111111111"],
    ["card 4111 1111 1111 1111", "card 4111111111111111.", "4111111111111111"],
  );

  test("a rendered /diagram triplet produces no PII findings", () => {
    for (const name of ["flow.svg", "flow.excalidraw"]) {
      const text = fs.readFileSync(path.join(FIXTURES, name), "utf8");
      const pii = findings(text).filter((f) => f.id === "pii.phone.e164" || f.id === "pii.cc");
      expect({ name, pii: pii.map((f) => f.id) }).toEqual({ name, pii: [] });
    }
  });
});

describe("env.kv: a function call assigned to a credential name is code (#2899)", () => {
  table(
    "env.kv",
    "MEDIUM",
    [
      '    session = _FlakySession(requests.ReadTimeout("Read timed out"))',
      "    session = _FlakySession(responses=[1])",
      "    session = requests.Session()",
      "    session = find_session(client, args.session_id, now=now, state=state)",
      '    token = make_token(user, scopes=["read"])',
      "    password = getpass.getpass()",
      "    session = build_http_session(",
    ],
    [
      'session = "Xk9pQ2mLr7Tz4vBn"',
      "SESSION_SECRET=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c",
      'password = "Tr0ub4dor&3!xyz"',
      "PASSWORD=Tr0ub4dor&3!xyz#",
      "password = correct.horse.battery.staple",
      'api_key: "Zx9Qw8Er7Ty6Ui5Op4As3Df2"',
      "API_SECRET=Abc123xyz(9Qm",
      'password = "getPassword(x)Q9z"',
      'token = decrypt("Zx9Qw8Er7Ty6Ui5Op4As3Df2")',
    ],
  );
});

describe("env.kv: a name-shaped literal inside a call is a file or dict key, not a secret (GST-1064)", () => {
  const FAKE_KEY = "Zx9Qw8Er7Ty6Ui5Op4As3Df2";
  const FAKE_STRIPE_TAIL = "4eC39HqLyjWDarjtT1zdp7dc";
  table(
    "env.kv",
    "MEDIUM",
    [
      String.raw`key = json.loads(files.get("key.json", ""))`,
      String.raw`token = resp.json().get("access_token")`,
      String.raw`    session = store.load('session.cookie')`,
      String.raw`secret = vault.read("client_secret")`,
    ],
    [
      String.raw`key = "${FAKE_KEY}"`,
      String.raw`KEY=${FAKE_KEY}`,
      String.raw`key = json.loads("sk_live_${FAKE_STRIPE_TAIL}")`,
      String.raw`token = resp.json().get("access_token", "${FAKE_KEY}")`,
      String.raw`password = os.getenv("DB_PASSWORD", "hunter2.Zx9Qw8")`,
      String.raw`key = json.loads(files.get("key.json")) or "${FAKE_KEY}"`,
      String.raw`password = os.getenv("DB_PASSWORD", "correct-horse-battery-staple")`,
      String.raw`api_key = decrypt("prod-signing-key")`,
      String.raw`token = decrypt("correct_horse_battery_staple")`,
      String.raw`key = decrypt("qwhzxkvbnmplor")`,
      String.raw`SECRET_KEY = os.getenv("SECRET_KEY", "orange_monkey_pass")`,
      String.raw`password = os.environ.get("DB_PASSWORD", "purple_walrus")`,
      String.raw`token = resp.json().get("access_token", "orange_monkey_pass")`,
      String.raw`key = derive_secret("tigers.horse")`,
      String.raw`password = os.getenv("DB_PASSWORD", "qwhzxkvbnmplor.txt")`,
      String.raw`password = make_password("orange_monkey_pass")`,
      String.raw`password = bcrypt.hashpw("orange_monkey_pass", salt)`,
      String.raw`token = jwt.encode("purple_walrus_pie", payload)`,
      String.raw`api_key = settings.Secret("correct_horse_battery")`,
      String.raw`password = hash_password("purple_walrus")`,
      String.raw`password=hash_password("purple_walrus")`,
      String.raw`+password = hash_password( "purple_walrus" )`,
      String.raw`password = hash_password("purple_walrus").encode()`,
      String.raw`password = hash_password("purple_walrus")  # seed user`,
      String.raw`password = config.get("db_password") or ("orange_monkey_pass")`,
      String.raw`password = config.get("db_password", ("orange_monkey_pass"))`,
      String.raw`password = login(user, ("purple_walrus"))`,
      String.raw`password = load_cfg("app.yaml"); login("purple_walrus")`,
      String.raw`password = login(user, str("purple_walrus"))`,
      String.raw`password = encrypt(str("orange_monkey_pass"))`,
    ],
  );
});

describe("env.kv: reading an environment variable in code names a secret without holding one (GST-1894)", () => {
  const FAKE_KEY = "Zx9Qw8Er7Ty6Ui5Op4As3Df2";
  const GH = ["ghp", "_", "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh7Jk8Lm9Np0"].join("");
  table(
    "env.kv",
    "MEDIUM",
    [
      String.raw`    token = opts?.env?.AGENT_API_TOKEN;`,
      String.raw`token = ctx.env.AGENT_API_TOKEN;`,
      String.raw`token = env?.AGENT_API_TOKEN;`,
      String.raw`token = env.AGENT_API_TOKEN,`,
      String.raw`token = import.meta.env.VITE_API_TOKEN;`,
      String.raw`token = Bun.env.AGENT_API_TOKEN;`,
      String.raw`token = this.env!.AGENT_API_TOKEN;`,
      String.raw`token = process.env.AGENT_API_TOKEN;`,
      String.raw`token = process.env["AGENT_API_TOKEN"];`,
      String.raw`token = opts?.env?.["AGENT_API_TOKEN"];`,
      String.raw`token = os.environ["OPENROUTER_API_KEY_V2"]`,
      String.raw`token = os.getenv("OPENROUTER_API_KEY_V2")`,
      String.raw`token = System.getenv("AGENT_API_TOKEN");`,
    ],
    [
      String.raw`token = "${FAKE_KEY}"`,
      `AGENT_API_TOKEN=${FAKE_KEY}`,
      `export AGENT_API_TOKEN=${FAKE_KEY}`,
      String.raw`token = opts?.env?.AGENT_API_TOKEN ?? "${FAKE_KEY}"`,
      String.raw`token = env.AGENT_API_TOKEN||"${FAKE_KEY}"`,
      String.raw`token = process.env["AGENT_API_TOKEN"] || "${FAKE_KEY}"`,
      String.raw`token = os.getenv("AGENT_API_TOKEN", "${FAKE_KEY}")`,
      String.raw`token = process.env["${FAKE_KEY}"]`,
      String.raw`token = os.environ["${FAKE_KEY}"]`,
      `token = env.${FAKE_KEY}`,
      String.raw`token = myenv.AGENT_API_TOKEN;`,
    ],
  );

  test("a known key prefix beside an env name still reports HIGH", () => {
    for (const input of [`AGENT_API_TOKEN=${GH}`, String.raw`token = opts?.env?.AGENT_API_TOKEN ?? "${GH}"`]) {
      expect(findings(input).some((f) => f.severity === "HIGH")).toBe(true);
    }
  });
});

describe("env.kv: the env-read exemption needs a finished expression with no fallback; otherwise the line reads as on main (GST-1894)", () => {
  const FAKE_KEY = "Zx9Qw8Er7Ty6Ui5Op4As3Df2";
  const kv = (text: string) => findings(text).some((f) => f.id === "env.kv");
  test.each([
    ["comment after ??", String.raw`token = opts?.env?.AGENT_API_TOKEN ?? // fallback` + "\n" + String.raw`  "${FAKE_KEY}";`],
    ["blank line after ??", String.raw`token = opts?.env?.AGENT_API_TOKEN ??` + "\n\n" + String.raw`  "${FAKE_KEY}";`],
    ["fallback wrapped after ??", String.raw`token = opts?.env?.AGENT_API_TOKEN ??` + "\n" + String.raw`  "${FAKE_KEY}";`],
    ["fallback on the next line", String.raw`token = opts?.env?.AGENT_API_TOKEN` + "\n" + String.raw`  ?? "${FAKE_KEY}";`],
    ["|| on the next line", String.raw`token = env.AGENT_API_TOKEN` + "\n" + String.raw`  || "${FAKE_KEY}"`],
    ["backtick fallback", "token = opts?.env?.AGENT_API_TOKEN ?? `" + FAKE_KEY + "`;"],
    ["backtick concatenation", "token = ctx.env.AGENT_API_TOKEN + `" + FAKE_KEY + "`;"],
    ["ternary", "token = opts?.env?.AGENT_API_TOKEN ? opts.env.AGENT_API_TOKEN : `" + FAKE_KEY + "`;"],
    ["python or", String.raw`token = ctx.env.AGENT_API_TOKEN or FALLBACK_TOKEN_VALUE`],
    ["getenv default", String.raw`token = System.getenv("AGENT_API_TOKEN", "${FAKE_KEY}");`],
    ["call left open", String.raw`token = System.getenv("AGENT_API_TOKEN")`],
  ])("fires as on main: %s", (_, input) => {
    expect(kv(input)).toBe(true);
  });
  test.each([
    ["multi-line call", ["client = OpenAI(", String.raw`    api_key=os.getenv("OPENAI_API_KEY"),`, String.raw`    base_url="https://api.openai.com/v1",`, ")"].join("\n")],
    ["object property", String.raw`  token: opts?.env?.AGENT_API_TOKEN,`],
    ["code span in a comment", "token = make_token(user)  // `process.env.AGENT_API_TOKEN` fallback"],
    ["getenv with an empty default", String.raw`token = os.getenv("OPENROUTER_API_KEY_V2", "")`],
  ])("still exempt, as on main: %s", (_, input) => {
    expect(kv(input)).toBe(false);
  });
});

describe("env.kv: a lowercase fixture label that names itself a secret, in a test file only (GST-1894)", () => {
  const kv = (text: string, sourcePath?: string) => scan(text, { repoVisibility: "private", sourcePath }).findings.some((f) => f.id === "env.kv");
  test.each([
    ["memory-registry-pg.test.ts", '      clientSecret: "personal-secret",'],
    ["memory-registry-pg.test.ts", '  signingSecret: "memory-authority-signing-secret",'],
    ["auth.spec.tsx", "    apiKey: 'staging-api-key',"],
    ["test_auth.py", '    password = "admin_password_fixture"'],
    ["auth_test.go", '  token: "refresh-token-value",'],
  ])("clean in %s: %s", (file, input) => {
    expect(kv(input, file)).toBe(false);
  });
  test.each([
    ["memory-registry.ts", '      clientSecret: "personal-secret",'],
    [undefined, '      clientSecret: "personal-secret",'],
    ["deploy.env", "CLIENT_SECRET=personal-secret"],
    ["memory-registry-pg.test.ts", '      clientSecret: "correct-horse-battery-staple",'],
    ["memory-registry-pg.test.ts", '      clientSecret: "Personal-Secret-9x",'],
    ["memory-registry-pg.test.ts", '      clientSecret: "secretive-horse",'],
    ["memory-registry-pg.test.ts", '      clientSecret: "Zx9Qw8Er7Ty6Ui5Op4As3Df2",'],
    ["memory-registry-pg.test.ts.bak", '      clientSecret: "personal-secret",'],
    ["src/ab-test.ts", '      clientSecret: "personal-secret",'],
    ["scripts/load-test.ts", '      clientSecret: "personal-secret",'],
    ["src/test_helpers.ts", '      clientSecret: "personal-secret",'],
    ["spec/auth_spec.rb", '      clientSecret: "personal-secret",'],
  ])("still MEDIUM in %s: %s", (file, input) => {
    expect(kv(input, file)).toBe(true);
  });
});

describe("internal.hostname: per-machine config filenames are not hosts (#2962, #2740)", () => {
  table(
    "internal.hostname",
    "MEDIUM",
    [
      "Edit CLAUDE.local.md and settings.local.json",
      "no `CLAUDE.local.md`, no @import",
      "edit .claude/settings.local.json",
      "helm -f values.staging.yaml",
      "config.prod.toml is read first",
      "npm run dev -- --env-file=.env.local",
      "copy .env.local to .env.staging",
    ],
    [
      "ssh build.local",
      "ping printer.local.",
      "http://printer.local/md",
      "printer.local.mdx is odd",
      "curl http://settings.local:8080/health",
      "the api.corp gateway",
      "connect to build-7.internal",
    ],
  );
});

describe("pii.ip_public: a four-part version needs a version declaration (#2784)", () => {
  table(
    "pii.ip_public",
    "MEDIUM",
    [
      '  "version": "1.128.1.0",',
      "app_version = 1.128.1.0",
      "schema-version: 1.128.1.0",
      "APP_VERSION=1.128.1.0",
      "Released version 1.128.1.0 today",
      "## [1.128.1.0] - 2026-09-02",
      "<Version>1.128.1.0</Version>",
      '[assembly: AssemblyVersion("1.0.0.0")]',
      "released v1.128.1.0 today",
    ],
    [
      "1.128.1.0",
      "host: 1.128.1.0",
      "server = 1.128.1.0",
      '"upstream": "1.128.1.0"',
      "resolver = 8.8.8.8",
      "version: 1.2.3.4 via 8.8.8.8",
      "the version endpoint moved to 1.128.1.0",
      "conversion 1.128.1.0",
      "## 1.128.1.0 is our egress",
      "## [1.128.1.0 mirror]",
    ],
  );
});

describe("pii.ip_public: a four-part version beside a VERSION file or a semver is not an address (GST-2047)", () => {
  table(
    "pii.ip_public",
    "MEDIUM",
    [
      'fs.writeFileSync(path.join(dir, "VERSION"), "1.98.0.0\\n");',
      "echo 1.98.0.0 > VERSION",
      "cat pkg/VERSION -> 1.98.0.0",
      "write('1.98.0.0', 'VERSION')",
      "bumps 1.98.0.0 (1.98.0 on npm)",
      "from v1.97.2 to 1.98.0.0",
      "1.98.0.0 / 1.98.0-rc.1",
    ],
    [
      "resolver = 8.8.8.8",
      'fs.writeFileSync(path.join(dir, "HOSTS"), "8.8.8.8\\n");',
      "VERSION bumped; the DNS server 8.8.8.8 answered",
      "8.8.8.8 is in VERSION notes",
      "echo 8.8.8.8 > VERSIONS",
      "cat MY_VERSION_HOST 8.8.8.8",
      "node 22.11.0 talks to 8.8.8.8 over the egress proxy",
      "1.1.1.1, 8.8.8.8",
    ],
  );

  test("a VERSION file holding only a quad is a version; the same quad in any other file, or in a VERSION file with other lines, still reports", () => {
    const ids = (text: string, sourcePath: string) => scan(text, { repoVisibility: "private", sourcePath }).findings.map((f) => f.id);
    expect(ids("1.98.0.0\n", "VERSION")).not.toContain("pii.ip_public");
    expect(ids("1.98.0.0\n", "/repo/pkg/VERSION")).not.toContain("pii.ip_public");
    expect(ids("1.98.0.0\n", "HOSTS")).toContain("pii.ip_public");
    expect(ids("1.98.0.0\n", "NOT_VERSION")).toContain("pii.ip_public");
    expect(ids("host 8.8.8.8\n", "VERSION")).toContain("pii.ip_public");
    expect(scan("1.98.0.0\nupstream 8.8.8.8\n", { repoVisibility: "private", sourcePath: "VERSION" }).findings.filter((f) => f.id === "pii.ip_public").map((f) => f.line)).toEqual([1, 2]);
  });
});

describe("pii.ip_public: a four-part version gstack names is not an address (GST-1204)", () => {
  table(
    "pii.ip_public",
    "MEDIUM",
    [
      "gstack 1.94.4.0",
      "gstack: ok 1.94.4.0 for=ship",
      "gstack: fail claude,codex (1.93.37.0)",
      "upgraded gstack from 1.93.14.0 to 1.94.4.0",
      "seen on gstack 1.94.4.0 to 1.94.8.0",
      "(gstack 1.94.4.0-1.94.8.0)",
    ],
    [
      "gstack talks to 8.8.8.8",
      "gstack-proxy 1.128.1.0",
      "landed in 1.94.4.0",
      "gstack 1.94.4.0 via 8.8.8.8",
      "from 1.128.1.0 to 1.128.1.1",
      "gstack 8.8.8.8",
      "gstack: fail 8.8.8.8",
      "upgraded gstack from 8.8.8.8",
      "my-gstack 1.94.4.0",
      "/opt/gstack 1.94.4.0",
      "gstack 1.94.4.0 - 8.8.8.8",
      "VERSION 1.2.3.4 to 8.8.8.8",
    ],
  );
});

describe("db.url_with_password: postgres:postgres only on a loopback host (#2913)", () => {
  // Assembled from parts so this file's own source never carries a
  // credential-bearing URL for the repo's secret scan to block.
  const url = (userinfo: string, rest: string, scheme = "postgresql") => `${scheme}://${userinfo}@${rest}`;
  const pg = ["postgres", "postgres"].join(":");
  table(
    "db.url_with_password",
    "HIGH",
    [
      `DATABASE_URL=${url(pg, "localhost:5432/app_test")}`,
      `DATABASE_URL=${url(pg, "127.0.0.1:5432/app", "postgres")}`,
      `DIRECT_URL="${url(pg, "localhost/app")}"`,
      `url: ${url(pg, "localhost", "postgres")}`,
      url(pg, "localhost:5432?sslmode=disable"),
    ],
    [
      `DATABASE_URL=${url(pg, "db:5432/app")}`,
      `DATABASE_URL=${url(pg, "postgres:5432/app")}`,
      `DATABASE_URL=${url(pg, "prod-host:5432/app")}`,
      `DATABASE_URL=${url(pg, "localhost.evil.example.net/app")}`,
      `DATABASE_URL=${url(pg, "127.0.0.1.nip.io/app")}`,
      `DATABASE_URL=${url(pg, "localhost@prod-db/app")}`,
      `DATABASE_URL=${url(["user", "s3cretPassw0rd"].join(":"), "prod-host:5432/app")}`,
      `DATABASE_URL=${url(["postgres", "hunter2x"].join(":"), "localhost:5432/app")}`,
      `DATABASE_URL=${url(["admin", "postgres"].join(":"), "localhost:5432/app")}`,
      `DATABASE_URL=${url(["postgres", "Postgres"].join(":"), "localhost:5432/app")}`,
      `DATABASE_URL=${url(pg, "localhost:3306/app", "mysql")}`,
    ],
  );
});

// Free Tests flaked test/capy-captain-flow.test.ts in 7 of 57 runs (2026-10-21..23): the autoplan run id
// run-YYYYMMDDHHMMSS put a 14-digit stamp in the approval row, and one stamp in ten passes Luhn.
describe("pii.cc: a separator-free YYYYMMDDHHMMSS stamp is not a card number", () => {
  table(
    "pii.cc",
    "MEDIUM",
    [
      'Approve the plan "Retry backoff" (autoplan run run-20261024131504, 2 decisions)',
      "autoplan:run-20261024131504@gate_rev=1",
      "backup stamp 20261024131512 ran late",
    ],
    [
      "card 30569309025904",
      "ref 20261324131501",
      "stamp 202610241315045",
      "card 2026 1024 1315 04",
      "card 4111111111111111",
    ],
  );
});

describe("pii.phone.e164: GitHub Actions run and job ids in their id positions", () => {
  table(
    "pii.phone.e164",
    "MEDIUM",
    [
      "bun run eval:pass-rates --run 37235771700 --case context-recovery-artifacts",
      "bun run eval:pass-rates --run=37235771700",
      "gh run view 37235771700 --job 111534615007 --log",
      "gh run download 37235771700 -n paid-slice-10-a1",
      "https://github.com/garrytan/gstack/actions/runs/37235771700/job/111534615007",
      "GITHUB_RUN_ID=37235771700",
      '{"run_id": 37235771700}',
      // An 11-digit id after a run word, as a READY block, a ship receipt or an approval record names one (GSTA-121's `screen <id> GREEN`).
      "citing screen 40477638211 GREEN at 5619199800a2",
      "gate=40477638211",
      "rerun passed 40477638211",
      "run #40477638211",
      "Screens: 40477638211",
      "dispatched 40477638211 at the pin",
      "cleared by run 19368712345",
    ],
    [
      "call 37235771700 tomorrow",
      "--phone 37235771700",
      "https://example.com/contact/37235771700",
      '{"phone_id": 37235771700}',
      "run 4155550123 laps",
      // A run word before a 10-digit national number, a bare 11-digit number and a generic word exempt nothing.
      "gate 4155550123",
      "the id is 40477638211",
      "job 40477638211",
      "workflow 40477638211",
      "40477638211 failed",
    ],
  );
});

describe("pii.phone.e164: run ids in a runs= list or an actions/runs/ path (GST-1227)", () => {
  table(
    "pii.phone.e164",
    "MEDIUM",
    [
      // The run list a CI carry or run clear prints (lib/run-evidence.ts runReceiptFields): every id, not only the first.
      "CI_CARRY: cleared pregate.json/remote_gate run tests=412 runs=41629861819/1,41629861820/2 profiles=free-tests heads=2f9d11a0c3e4",
      '{"remote_gate": "carried runs=41629861819/1,41629861820/1,41629861821/3 profiles=free-tests,windows-smoke"}',
      "run=41629861819/1,416298618201/1",
      "see actions/runs/41629861820 for the log",
      "garrytan/gstack actions/runs/4162986182/attempts/2",
    ],
    [
      "call +1 415 555 0123 tomorrow",
      "call +1 415 555 0123 about runs=41629861819/1,41629861820/2",
      "runs=+14155550123/1",
      "runs=1/4155550123",
      "runs=4155550123",
      "reruns=4155550123/1",
      "factions/runs/4155550123",
      "sales-actions/runs/4155550123",
      "runs=4162986182/1",
      "runs=1234567890123/1",
    ],
  );
});

describe("pii.phone.e164: a short sha after review_loop_grant or review_loop_exception (Free Tests 41667825418, 41766865679)", () => {
  table(
    "pii.phone.e164",
    "MEDIUM",
    [
      // The ask gstack-approvals records for the owner's grant, here with a stop head whose 12-character sha is all digits.
      "Owner grant: one scoped fix-check after round 2 (review_loop_grant 367120488513)",
      "Owner accepts the stop after the fix-check (review_loop_exception 367120488513)",
      "review_loop_grant=367120488513",
      "review_loop_grant: 3671204885",
    ],
    [
      "review_loop_grant +14155552671",
      "review_loop_grant 415-555-2671",
      "review_loop_grant (415) 555-2671",
      "call 367120488513 about the review_loop_grant",
      "grant 367120488513",
      "my_review_loop_grant 367120488513",
      "review_loop_grant for 367120488513",
    ],
  );
});

describe("pii.wallet: a bc1 address needs the bech32 alphabet and checksum (Free Tests 41715139988)", () => {
  table(
    "pii.wallet",
    "MEDIUM",
    [
      // The sha the CSO history range printed as <REDACTED-pii.wallet>..<REDACTED-pii.wallet>; it holds 1 and b, outside bech32's alphabet.
      "bc1f7576f1eaf9d548ddb6f742b85ec11b4a3e79..bc1f7576f1eaf9d548ddb6f742b85ec11b4a3e79",
      // A sha inside the alphabet (no 1 or b after the prefix) fails the checksum.
      "commit bc1f7576f2eaf9d548ddf6f742c85ec22d4a3e79",
      // A real address with its last character changed fails the checksum too.
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5",
    ],
    [
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      "send it to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq today",
      "wallet: bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
      "0x52908400098527886E0F7030069857D2E4169EE7",
      "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
    ],
  );
});
