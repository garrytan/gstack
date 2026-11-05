/**
 * internal.hostname vs property access in source code (#3987).
 *
 * The pattern matches any `identifier.(internal|corp|local|lan|prod|
 * staging)`, so in a code file ordinary member access (`return m.local`,
 * `if (config.prod)`, `if settings.internal:`) reported as a leaked
 * internal host on every push. The fix exempts a span in a code file
 * only when it sits outside any string literal or comment; a hostname
 * in code lives in a string, a URL, or a comment, so it still reports,
 * and prose scanned without a code path still reports (fail closed).
 * This file pins BOTH directions: the exemption must not swallow real
 * hosts, and the real-host cases must not reintroduce the noise.
 */
import { describe, test, expect } from "bun:test";
import { scan } from "../lib/redact-engine";
import { isPropertyAccess } from "../lib/redact-patterns";

const flagsHost = (s: string, sourcePath?: string): boolean =>
  scan(s, { repoVisibility: "private", ...(sourcePath ? { sourcePath } : {}) }).findings.some(
    (f) => f.id === "internal.hostname",
  );

describe("internal.hostname — property access in code files is not a host (#3987)", () => {
  const CODE_ACCESS: [string, string, string][] = [
    ["ts return", "src/a.ts", "  return m.local"],
    ["ts condition", "src/a.ts", "if (config.prod) start();"],
    ["ts ternary", "src/a.ts", "const host = env.staging ? a : b;"],
    ["py condition", "app/x.py", "if settings.internal:"],
    ["ts this-access", "src/a.ts", "return this.local;"],
    ["ts chained access", "src/a.ts", "const v = a.b.internal;"],
    ["ts division after access", "src/a.ts", "const v = m.local / 2;"],
    ["ts assignment", "src/a.ts", "a.local = 5;"],
    ["py attribute", "app/x.py", "x = settings.corp"],
  ];
  for (const [label, file, input] of CODE_ACCESS) {
    test(label, () => {
      expect(flagsHost(input, file)).toBe(false);
    });
  }
});

describe("internal.hostname — hosts in code files still report (#3987)", () => {
  const STILL_HOSTS: [string, string, string][] = [
    ["ts url in string", "src/a.ts", 'const url = "http://build.corp/api";'],
    ["ts host in string", "src/a.ts", 'const host = "db.internal";'],
    ["ts host mid-string", "src/a.ts", 'const s = "connect to db.internal now";'],
    ["ts single-quoted host", "src/a.ts", "const host = 'db.internal';"],
    ["ts template host", "src/a.ts", "const u = `http://build.corp/api`;"],
    ["ts line comment", "src/a.ts", "// see db.internal for docs"],
    ["ts block comment", "src/a.ts", "/* db.internal is the old host */"],
    [
      "ts block comment continuation",
      "src/a.ts",
      "/* see\n   db.internal for details */",
    ],
    ["py host in string", "app/x.py", 'host = "db.internal"'],
    ["py host mid-string", "app/x.py", 'msg = "connect to db.internal now"'],
    ["py comment", "app/x.py", "# see db.internal for docs"],
  ];
  for (const [label, file, input] of STILL_HOSTS) {
    test(label, () => {
      expect(flagsHost(input, file)).toBe(true);
    });
  }
});

describe("internal.hostname — no code path means fail closed (#3987)", () => {
  test("prose host without a path still reports", () => {
    expect(flagsHost("Connect to db.internal on port 5432")).toBe(true);
  });
  test("code-looking line without a path still reports", () => {
    expect(flagsHost("  return m.local")).toBe(true);
  });
  test("prose file path does not exempt", () => {
    expect(flagsHost("Connect to db.internal on port 5432", "README.md")).toBe(true);
  });
});

describe("isPropertyAccess — unit", () => {
  const matchFor = (input: string): RegExpExecArray => {
    const re = /\b([a-z0-9][a-z0-9\-]*\.(?:internal|corp|local|lan|prod|staging))\b/i;
    const m = re.exec(input);
    if (!m) throw new Error(`pattern did not match: ${input}`);
    return m;
  };

  test("exempts bare access in a code file", () => {
    expect(isPropertyAccess(matchFor("return m.local"), "src/a.ts")).toBe(true);
  });
  test("does not exempt without a source path", () => {
    expect(isPropertyAccess(matchFor("return m.local"), undefined)).toBe(false);
  });
  test("does not exempt a prose path", () => {
    expect(isPropertyAccess(matchFor("return m.local"), "README.md")).toBe(false);
  });
  test("does not exempt a host inside a string", () => {
    expect(isPropertyAccess(matchFor('const u = "http://build.corp/api"'), "src/a.ts")).toBe(false);
  });
  test("does not exempt a host in a comment", () => {
    expect(isPropertyAccess(matchFor("// see db.internal"), "src/a.ts")).toBe(false);
  });
});
