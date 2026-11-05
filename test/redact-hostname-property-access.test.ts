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
  ];
  for (const [label, input] of REAL) {
    test(label, () => {
      expect(flagsHost(input)).toBe(true);
    });
  }
});
