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
    ],
    [
      "call 37235771700 tomorrow",
      "--phone 37235771700",
      "https://example.com/contact/37235771700",
      '{"phone_id": 37235771700}',
      "run 4155550123 laps",
    ],
  );
});
