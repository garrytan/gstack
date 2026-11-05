/**
 * internal.hostname vs property access in source code (#3987).
 *
 * The hostname pattern ends in `.local|.prod|.staging|…`, so a property read in
 * code (`config.prod`, `env.staging`, `m.local`) reports as a leaked internal
 * host. Each of these sits straight after a control-flow keyword and is closed
 * by a code terminator, which a host in prose or config never is.
 *
 * The exemption has to stay narrow, so both directions are pinned: a real host
 * in a sentence, a URL, an assignment or a shell command still reports.
 */
import { describe, test, expect } from "bun:test";
import { scan } from "../lib/redact-engine";

const flagsHost = (s: string): boolean =>
  scan(s, { repoVisibility: "private" }).findings.some((f) => f.id === "internal.hostname");

describe("internal.hostname — property access in code is not a host", () => {
  const CODE: [string, string][] = [
    ["return in JS", "return m.local;"],
    ["return without semicolon", "  return m.local"],
    ["if with parens", "if (config.prod) start();"],
    ["else if", "} else if (env.staging) {"],
    ["negated", "if (!config.prod) return;"],
    ["logical and", "if (ready && config.prod) deploy();"],
    ["python if", "if settings.internal:"],
    ["python elif", "elif settings.local:"],
    ["python and", "if enabled and settings.internal:"],
    ["python not", "if not settings.internal:"],
    ["python compound before and after", "if ready and cfg.prod and not cfg.local:"],
    ["python trailing comment", "if settings.internal:  # dev only"],
    ["while", "while (queue.local) drain();"],
    ["ternary", "const x = flag ? 1 : 2; if (env.prod ? a : b) go();"],
  ];
  for (const [label, input] of CODE) {
    test(label, () => {
      expect(flagsHost(input)).toBe(false);
    });
  }
});

describe("internal.hostname — real hosts stay flagged near the same keywords", () => {
  const REAL: [string, string][] = [
    ["if in prose", "if api.corp is down, page the on-call"],
    ["return in prose", "then return to printer.local for a retry"],
    ["URL after if", "if (fetch('http://build-7.internal/health')) ok();"],
    ["assignment", "HOST=db.internal"],
    ["config key", 'host: "api.staging"'],
    ["shell command", "ssh jump.corp"],
    ["ping", "ping printer.local"],
    ["return a string", 'return "nas.lan";'],
    ["and before a host at end of line", "deploy to staging.prod and prod.internal"],
    ["or before a host at end of line", "ping a.lan or b.local"],
    ["not before a host", "this is not db.internal"],
    ["if before a host, closed by a paren in prose", "(only if build.internal)"],
    ["port after an if-condition", "if db.internal:5432 is reachable"],
    ["colon then a port", "if db.internal:5432"],
    ["sentence-leading If", "If api.corp: it is down"],
    ["bang in prose", "Done! build.internal"],
    ["keyword on the previous line", "check if\nbuild.internal"],
    ["python condition that is prose", "if api.corp and the cache are down"],
    ["sentence with a colon after the host", "if the VPN is down, use backup.corp:"],
    ["sentence naming a host then a colon", "if you hit this, ping db.internal:"],
    ["prose before and after the host", "if the cache is cold and db.internal is slow:"],
    ["words between the host and the colon", "if cfg.prod then restart the db.internal service:"],
  ];
  for (const [label, input] of REAL) {
    test(label, () => {
      expect(flagsHost(input)).toBe(true);
    });
  }
});

describe("internal.hostname — property-access check stays bounded", () => {
  test("a very long line of '!' before many hosts finishes quickly and still reports", () => {
    const line = `${"!".repeat(20000)} ${"a.lan ".repeat(2000)}`;
    const started = performance.now();
    const flagged = flagsHost(line);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(flagged).toBe(true);
  });

  test("a host past the context cap on a long line is not exempted", () => {
    const filler = "x".repeat(400);
    expect(flagsHost(`if (${filler}) return m.local;`)).toBe(true);
    expect(flagsHost(`return m.local; ${filler}`)).toBe(true);
  });
});
