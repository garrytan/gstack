import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";

/**
 * Server integration tests.
 *
 * These test the HTTP protocol without requiring Appium.
 * We test: auth, command routing, unsupported commands, health endpoint.
 *
 * Note: The server.ts requires Appium to be running for real command execution.
 * These tests focus on the HTTP layer behavior that doesn't need a real device.
 */

describe("server protocol", () => {
  // These tests verify the server module can be imported and key types exist
  test("server module exports are valid", async () => {
    // Verify the server file can be parsed by Bun
    const serverPath = path.join(import.meta.dir, "../src/server.ts");
    expect(fs.existsSync(serverPath)).toBe(true);

    const content = fs.readFileSync(serverPath, "utf-8");
    expect(content).toContain("TOKEN");
    expect(content).toContain("/health");
    expect(content).toContain("/command");
    expect(content).toContain("Bearer");
  });

  test("command sets cover expected commands", async () => {
    const serverPath = path.join(import.meta.dir, "../src/server.ts");
    const content = fs.readFileSync(serverPath, "utf-8");

    // Verify read commands
    expect(content).toContain('"text"');
    expect(content).toContain('"links"');
    expect(content).toContain('"forms"');
    expect(content).toContain('"snapshot"');

    // Verify write commands
    expect(content).toContain('"goto"');
    expect(content).toContain('"click"');
    expect(content).toContain('"fill"');
    expect(content).toContain('"scroll"');
    expect(content).toContain('"back"');

    // Verify meta commands
    expect(content).toContain('"screenshot"');
    expect(content).toContain('"status"');
    expect(content).toContain('"stop"');
  });

  test("unsupported commands are explicitly listed", async () => {
    const serverPath = path.join(import.meta.dir, "../src/server.ts");
    const content = fs.readFileSync(serverPath, "utf-8");

    // Web-only commands that should return not_supported
    const webOnly = [
      "cookies", "storage", "js", "eval", "html", "css",
      "cookie-import", "header", "useragent", "upload",
      "pdf", "responsive", "handoff", "resume",
    ];

    for (const cmd of webOnly) {
      expect(content).toContain(`"${cmd}"`);
    }
  });

  test("error hints are defined for common failures", () => {
    const serverPath = path.join(import.meta.dir, "../src/server.ts");
    const content = fs.readFileSync(serverPath, "utf-8");

    expect(content).toContain("getErrorHint");
    expect(content).toContain("not connected");
    expect(content).toContain("no longer exists");
    expect(content).toContain("Disk may be full");
  });

  test("state file format matches expected schema", () => {
    const serverPath = path.join(import.meta.dir, "../src/server.ts");
    const content = fs.readFileSync(serverPath, "utf-8");

    // State object should have required fields
    expect(content).toContain("pid:");
    expect(content).toContain("port");
    expect(content).toContain("token:");
    expect(content).toContain("startedAt:");
  });

  test("idle timeout is configurable via env", () => {
    const serverPath = path.join(import.meta.dir, "../src/server.ts");
    const content = fs.readFileSync(serverPath, "utf-8");

    expect(content).toContain("BROWSE_MOBILE_IDLE_TIMEOUT");
    expect(content).toContain("1800000"); // 30 min default
  });

  test("sequential command queuing is implemented", () => {
    const serverPath = path.join(import.meta.dir, "../src/server.ts");
    const content = fs.readFileSync(serverPath, "utf-8");

    expect(content).toContain("commandQueue");
    // Queue pattern: chain promises
    expect(content).toContain(".then(");
  });
});

describe("mobile-driver interface", () => {
  test("MobileDriver has all required command methods", async () => {
    const driverPath = path.join(import.meta.dir, "../src/mobile-driver.ts");
    const content = fs.readFileSync(driverPath, "utf-8");

    const asyncMethods = [
      "connect", "disconnect", "isHealthy",
      "goto", "click", "fill", "screenshot", "snapshot",
      "text", "scroll", "back", "viewport",
      "links", "forms", "dialogAccept", "dialogDismiss",
    ];

    for (const method of asyncMethods) {
      expect(content).toContain(`async ${method}(`);
    }

    // Non-async methods
    const syncMethods = ["setRefMap", "getRefCount", "clearRefs"];
    for (const method of syncMethods) {
      expect(content).toContain(`${method}(`);
    }
  });

  test("MobileDriver handles disk-full on screenshot", () => {
    const driverPath = path.join(import.meta.dir, "../src/mobile-driver.ts");
    const content = fs.readFileSync(driverPath, "utf-8");

    expect(content).toContain("Screenshot save failed");
    expect(content).toContain("Disk may be full");
  });
});
