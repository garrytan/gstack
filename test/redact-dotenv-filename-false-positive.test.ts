/**
 * internal.hostname vs dotenv FILENAMES.
 *
 * `.env.local` ends in `.local`, so the internal-hostname pattern matches on
 * `env.local` and reports a filename as a leaked internal host. This is not an
 * exotic collision: `--env-file=.env.local` in an npm script, `.env.staging` in
 * a README, `.env.prod` in a .gitignore. It fires on branches that leak
 * nothing, and a scanner that cries wolf on package.json is a scanner people
 * learn to skim past — which costs far more than the finding was ever worth.
 *
 * The guard has to stay narrow, so this file pins BOTH directions. The
 * negative controls are the point: an exemption written as "any span ending
 * .local" would pass the dotenv half while quietly gutting the pattern for
 * every real host.
 */
import { describe, test, expect } from "bun:test";
import { scan } from "../lib/redact-engine";
import { isDotenvFilename } from "../lib/redact-patterns";

const flagsHost = (s: string): boolean =>
  scan(s, { repoVisibility: "private" }).findings.some((f) => f.id === "internal.hostname");

describe("internal.hostname — real internal hosts stay flagged", () => {
  const REAL_HOSTS: [string, string][] = [
    [".internal", "curl http://build-7.internal/health"],
    [".corp", "ssh jump.corp"],
    [".local", "ping printer.local"],
    [".lan", "nas.lan is down"],
    [".prod", "deploy to shipping.prod now"],
    [".staging", "hit api.staging first"],
    ["multi-label, dotted prefix", "host: api.corp.local"],
    ["not a dotenv file", "myenv.local resolves"],
    ["env as a real subdomain", "https://env.prod//status"],
  ];
  for (const [label, input] of REAL_HOSTS) {
    test(label, () => {
      expect(flagsHost(input)).toBe(true);
    });
  }
});

describe("internal.hostname — dotenv filenames are not hosts", () => {
  const DOTENV: [string, string][] = [
    ["npm script", '"dev": "tsx --env-file=.env.local scripts/x.ts"'],
    ["bare filename", "copy .env.example to .env.local"],
    ["staging", "secrets live in .env.staging"],
    ["prod", "never commit .env.prod"],
    ["gitignore line", ".env.local"],
    ["path prefix", "apps/web/.env.local"],
  ];
  for (const [label, input] of DOTENV) {
    test(label, () => {
      expect(flagsHost(input)).toBe(false);
    });
  }
});

describe("isDotenvFilename — unit", () => {
  const matchFor = (input: string): RegExpExecArray => {
    const re = /\b([a-z0-9][a-z0-9\-]*\.(?:internal|corp|local|lan|prod|staging))\b/i;
    const m = re.exec(input);
    if (!m) throw new Error(`pattern did not match: ${input}`);
    return m;
  };

  test("exempts a dot-prefixed env filename", () => {
    expect(isDotenvFilename(matchFor("--env-file=.env.local"))).toBe(true);
  });

  test("does not exempt env.local without the leading dot", () => {
    expect(isDotenvFilename(matchFor("host env.local here"))).toBe(false);
  });

  test("does not exempt a dot-prefixed host that is not env", () => {
    expect(isDotenvFilename(matchFor("api.corp.local"))).toBe(false);
  });
});
