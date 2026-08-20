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

  test("IPv4 listener binds loopback at the socket level (B5)", () => {
    expect(src).toContain("requiredLocalEndpoint");
    expect(src).toContain('NWEndpoint.Host("127.0.0.1")');
    // IPv6 wildcard + peer-check path must survive (CoreDevice tunnel peers).
    expect(src).toMatch(/case \.ipv6:\s*\n\s*listener = try NWListener\(using: params, on:/);
  });
});
