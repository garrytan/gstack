/**
 * internal.hostname vs property reads in source code (#3987).
 *
 * The hostname pattern ends in `.local|.prod|.staging|.internal|.corp|.lan`,
 * so a property read in code (`server.local(...)`, `config.prod`) reported as
 * a leaked internal host. The pregate secrets stage scans each file under its
 * own name, so every such read in a pushed diff became a WARN, and /ship asked
 * for a confirm on it. The CODE lines are copied verbatim from gstack's own
 * source, with the issue's examples after them.
 *
 * The exemption needs a code file's path, a span outside any string or
 * comment on its line, and code syntax on both sides of it, so every real host
 * below still reports.
 */
import { describe, test, expect } from "bun:test";
import { scan } from "../lib/redact-engine";

const flagsHost = (input: string, sourcePath?: string): boolean =>
  scan(input, { repoVisibility: "private", ...(sourcePath ? { sourcePath } : {}) }).findings.some(
    (f) => f.id === "internal.hostname",
  );

describe("internal.hostname: a property read in code is not a host", () => {
  const CODE: [string, string][] = [
    ["browse/test/server-auth.test.ts", "    const post = (headers: Record<string, string>) => server.local('/extension-token', { method: 'POST', headers });"],
    ["browse/test/server-auth.test.ts", "      expect(await statusAndJson(await server.local(route))).toEqual(UNAUTHORIZED);"],
    ["browse/test/dual-listener.test.ts", "    for (const call of [server.local, server.tunnel]) {"],
    ["lib/code-intelligence/sourcebot-adapter.ts", "    this.local = isLoopback(this.#baseUrl);"],
    ["lib/pregate/config.ts", "    if (!Array.isArray(obj.local) || obj.local.some(l => typeof l !== 'string')) errors.push({ code: 'X' });"],
    ["lib/pregate/config.ts", "    else (obj.local as string[]).forEach((l, i) => { if (!LANE_ID.test(l)) errors.push(l); });"],
    ["lib/pregate/config.ts", `  return { declaresLanes: LANE_KEYS.some(k => k in o), config: { $schema: o.$schema, runner: o.runner ?? null, dependencies: o.dependencies ?? {}, empty_lanes: o.empty_lanes ?? [], lanes: o.lanes ?? {}, remote: o.remote ?? [], local: o.local ?? [] } };`],
    ["lib/gate-diff/git.ts", "  if (base.local === 'fallback') return `${base.unrelatedRemote ? `${base.unrelatedRemote} shares no history with HEAD` : `no remote-tracking branch for ${name}`}; using the local branch`;"],
    ["lib/pregate/lane-selection.ts", "    if (lane.tier === 'platform' && ctx.config.local.includes(lane.id)) ctx.explain.push(lane.id);"],
    ["test/code-intelligence.test.ts", "    expect(g.local).toBe(false);"],
    ["src/a.ts", "  return m.local"],
    ["src/a.ts", "if (config.prod) start();"],
    ["src/a.ts", "const host = env.staging ? a : b;"],
    ["src/a.ts", "} else if (!env.staging) {"],
    ["app/x.py", "if settings.internal:\n    pass\n"],
    ["app/x.py", "if ready and not cfg.local:  # dev only\n    pass\n"],
    ["app/x.py", "mode = 'a' if cfg.prod else 'b'\n"],
    ["lib/a.dart", "  if (config.prod) return;"],
  ];
  for (const [path, line] of CODE) {
    test(`${path}: ${line.trim()}`, () => {
      expect(flagsHost(line, path)).toBe(false);
    });
  }
});

describe("internal.hostname: real hosts still report", () => {
  const HOSTS: [string, string | undefined, string][] = [
    ["quoted URL in code", "src/a.ts", 'const url = "http://build.corp/api";'],
    ["quoted host in code", "src/a.ts", "const host = 'db.internal';"],
    ["template literal in code", "src/a.ts", "const u = `http://build-7.internal/health`;"],
    ["quoted host in a call", "src/a.ts", "connect('db.internal', 5432);"],
    ["line comment in code", "src/a.ts", "const port = 5432; // primary is db.internal"],
    ["block comment in code", "src/a.ts", "/* (db.internal) */"],
    ["JSDoc continuation line", "src/a.ts", " * Falls back to (printer.local) when mDNS answers."],
    ["host and port in code", "src/a.ts", "dial(db.internal:5432);"],
    ["hyphenated host in code", "src/a.ts", "if (build-7.internal) ok();"],
    ["host followed by a path", "src/a.ts", "return proxy.corp/api;"],
    ["prose in a code file", "src/a.ts", "connect to db.internal on port 5432"],
    ["keyword then prose", "src/a.ts", "if api.corp is down, page the on-call"],
    ["return in prose", "src/a.ts", "then return to printer.local for a retry"],
    ["shell command", "src/a.ts", "ssh jump.corp"],
    ["and before a host in a JS file", "src/a.ts", "deploy to staging.prod and prod.internal"],
    ["if in prose, closed by a paren", "src/a.ts", "(only if build.internal)"],
    ["bang in prose", "src/a.ts", "Done! build.internal"],
    ["a host alone on its line", "src/a.ts", "const hosts = `\ndb.internal\ncache.internal,\n`;"],
    ["a Python sentence ending in a colon", "app/x.py", "if the VPN is down, use backup.corp:\n"],
    ["a Python host before a port", "app/x.py", "if db.internal:5432 is reachable\n"],
    ["Python string", "app/x.py", 'HOST = "db.internal"\n'],
    ["Python comment", "app/x.py", "x = 1  # if (db.internal)\n"],
    ["Python docstring line", "app/x.py", '"""\nFalls back to (printer.local).\n"""\n'],
    ["prose", "README.md", "Connect to db.internal on port 5432"],
    ["config value", "config/app.yaml", "host: db.internal"],
    ["config assignment", ".env", "HOST=db.internal"],
    ["URL host field", "deploy.json", '{ "host": "api.staging", "url": "https://build.corp/x" }'],
    ["a code shape without a path", undefined, "if (config.prod) start();"],
    ["a code shape past the context cap", "src/a.ts", `if (${"x".repeat(1200)} && m.local) go();`],
  ];
  for (const [label, path, input] of HOSTS) {
    test(label, () => {
      expect(flagsHost(input, path)).toBe(true);
    });
  }
});

describe("internal.hostname: the property-read check stays bounded", () => {
  test("a long line of property reads finishes quickly", () => {
    const line = `if (${"!".repeat(20000)}${"cfg.local && ".repeat(5000)}ok) go();`;
    const started = performance.now();
    flagsHost(line, "src/a.ts");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
