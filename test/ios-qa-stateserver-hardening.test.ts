/**
 * StateServer hardening pins (fork port wave 2, B3 + B5).
 *
 * B3: the boot token must never appear in an os_log statement. The daemon
 * reads it from the 0600 app-container file (copyFileFromAppContainer in
 * tunnel-bootstrap.ts); the old `token=\(self.bootToken, privacy: .public)`
 * announce line had NO consumer and handed a live credential to anything
 * reading the unified log during the launch window.
 *
 * B5: the IPv4 listener has no CoreDevice tunnel path, so it must bind to
 * loopback at the socket level (requiredLocalEndpoint 127.0.0.1), not rely
 * solely on the per-connection peer check. IPv6 keeps the wildcard bind for
 * CoreDevice ULA peers by design.
 *
 * #1837: the boot-token file is the daemon's only way in, so writing it must
 * not be a silent `try?`. A failure is logged and reported on /healthz (the
 * daemon then names the device-side cause instead of relaunching the app).
 *
 * Pinned on BOTH the generated template and the fixture app copy so neither
 * can drift back independently.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const COPIES = [
  "ios-qa/templates/StateServer.swift.template",
  "test/fixtures/ios-qa/FixtureApp/Sources/DebugBridgeCore/StateServer.swift",
];

describe.each(COPIES)("StateServer hardening — %s", (rel) => {
  const src = readFileSync(join(ROOT, rel), "utf-8");

  test("no os_log statement interpolates the boot token (B3)", () => {
    const logLines = src.split("\n").filter((l) => /logger\.(notice|info|error|debug|log)/.test(l));
    for (const line of logLines) {
      expect(line).not.toContain("bootToken");
    }
    // The bootstrap announce survives (diagnostics), token-free.
    expect(src).toContain('gstack-ios-qa-bootstrap port=');
    expect(src).not.toContain("gstack-ios-qa-bootstrap token=");
  });

  test("boot-token write failures are loud, not a silent try? (#1837)", () => {
    expect(src).not.toMatch(/try\?\s*bootToken\.write/);
    expect(src).not.toMatch(/try\?\s*FileManager\.default\.setAttributes\(\[\.posixPermissions: 0o600\]/);
    const start = src.slice(src.indexOf("public func start()"), src.indexOf("public func register("));
    expect(start).toMatch(/do \{\s*try bootToken\.write\(toFile: tokenFile/);
    expect(start).toMatch(/\} catch \{\s*bootTokenWriteError = error\.localizedDescription\s*logger\.error\(/);
    expect(start).toContain("gstack-ios-qa-bootstrap NOT READY");
    expect(src).toContain('health["boot_token_error"] = failure');
  });

  test("comments no longer claim os_log carries the boot token", () => {
    expect(src).not.toMatch(/os_log scrape|wrote to os_log|scraping\s*\n?\/\/\s*os_log/);
  });

  test("IPv4 listener binds loopback at the socket level (B5)", () => {
    expect(src).toContain("requiredLocalEndpoint");
    expect(src).toContain('NWEndpoint.Host("127.0.0.1")');
    // IPv6 wildcard + peer-check path must survive (CoreDevice tunnel peers).
    expect(src).toMatch(/case \.ipv6:\s*\n\s*listener = try NWListener\(using: params, on:/);
  });
});
