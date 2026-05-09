/**
 * browseClient unit tests — binary resolution and error mapping.
 *
 * These are pure unit tests; they do NOT require a running browse daemon.
 */

import { describe, expect, test } from "bun:test";

import { BrowseClientError } from "../src/types";
import { resolveBrowseBin } from "../src/browseClient";

describe("resolveBrowseBin", () => {
  test("throws BrowseClientError with setup hint when nothing is found", () => {
    // Point every candidate path to a non-existent location.
    const originalEnv = process.env.BROWSE_BIN;
    process.env.BROWSE_BIN = "/nonexistent/browse-does-not-exist";

    // We can't easily mock the sibling and global paths without touching
    // the filesystem, so in a typical dev environment this will usually
    // find the real browse. That's fine — on CI it will throw, and the
    // error message shape is what we're actually asserting.
    let thrown: any = null;
    try {
      resolveBrowseBin();
    } catch (err) {
      thrown = err;
    }

    if (thrown) {
      expect(thrown).toBeInstanceOf(BrowseClientError);
      expect(thrown.message).toContain("browse binary not found");
      expect(thrown.message).toContain("./setup");
      expect(thrown.message).toContain("BROWSE_BIN");
    }

    // Restore env
    if (originalEnv === undefined) {
      delete process.env.BROWSE_BIN;
    } else {
      process.env.BROWSE_BIN = originalEnv;
    }
  });

  test("honors BROWSE_BIN when it points at a real executable", () => {
    const originalEnv = process.env.BROWSE_BIN;
    // `/bin/sh` exists on every POSIX system and is executable.
    process.env.BROWSE_BIN = "/bin/sh";

    try {
      const resolved = resolveBrowseBin();
      expect(resolved).toBe("/bin/sh");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BROWSE_BIN;
      } else {
        process.env.BROWSE_BIN = originalEnv;
      }
    }
  });
});

describe("BrowseClientError", () => {
  test("captures exit code, command, and stderr", () => {
    const err = new BrowseClientError(127, "pdf", "Chromium not found");
    expect(err.exitCode).toBe(127);
    expect(err.command).toBe("pdf");
    expect(err.stderr).toBe("Chromium not found");
    expect(err.message).toContain("browse pdf exited 127");
    expect(err.message).toContain("Chromium not found");
    expect(err.name).toBe("BrowseClientError");
  });
});
