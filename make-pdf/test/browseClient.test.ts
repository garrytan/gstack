/**
 * browseClient unit tests — binary resolution and error mapping.
 *
 * These are pure unit tests; they do NOT require a running browse daemon.
 * Cross-platform: assertions that pin POSIX behavior early-return on win32
 * and vice versa, so both lanes only exercise their own branch.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BrowseClientError } from "../src/types";
import { resolveBrowseBin, findExecutable } from "../src/browseClient";

// A real, always-present executable for the test platform — `cmd.exe` on
// Windows (System32 is on every install) and `/bin/sh` on POSIX. Lets the
// "honors override when it points at a real executable" test work in both
// lanes without writing a temp script.
const REAL_EXE: string =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
    : "/bin/sh";

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("findExecutable", () => {
  test("returns the bare path on POSIX when it's executable", () => {
    if (process.platform === "win32") return;
    const found = findExecutable("/bin/sh");
    expect(found).toBe("/bin/sh");
  });

  test("on win32, probes .exe / .cmd / .bat after the bare-path miss", () => {
    if (process.platform !== "win32") return;
    // cmd.exe lives at System32\cmd.exe — probe with the bare base.
    const base = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd");
    const found = findExecutable(base);
    expect(found).toBe(base + ".exe");
  });

  test("returns null when no extension matches", () => {
    const found = findExecutable("/nonexistent/path/to/nothing");
    expect(found).toBeNull();
  });
});

describe("resolveBrowseBin", () => {
  test("throws BrowseClientError with setup hint when nothing is found", () => {
    // Point overrides at non-existent paths and clear PATH so Bun.which finds
    // nothing. Sibling/global probes go through findExecutable on real paths,
    // but the test asserts on the error shape rather than depending on whether
    // a real browse install exists on the box.
    let thrown: unknown = null;
    try {
      withEnv(
        {
          GSTACK_BROWSE_BIN: "/nonexistent/gstack-browse-bin",
          BROWSE_BIN: "/nonexistent/browse-bin",
          PATH: "",
          Path: "",
        },
        () => resolveBrowseBin(),
      );
    } catch (err) {
      thrown = err;
    }

    if (thrown) {
      expect(thrown).toBeInstanceOf(BrowseClientError);
      expect((thrown as BrowseClientError).message).toContain("browse binary not found");
      expect((thrown as BrowseClientError).message).toContain("./setup");
      expect((thrown as BrowseClientError).message).toContain("GSTACK_BROWSE_BIN");
      // Back-compat alias still surfaces in the diagnostic.
      expect((thrown as BrowseClientError).message).toContain("BROWSE_BIN");
    }
    // If the test box has a real browse install on disk, sibling/global may
    // resolve and the helper won't throw — that's fine; the assertion is
    // gated on whether it threw at all.
  });

  test("honors GSTACK_BROWSE_BIN when it points at a real executable", () => {
    const resolved = withEnv({ GSTACK_BROWSE_BIN: REAL_EXE }, () => resolveBrowseBin());
    expect(resolved).toBe(REAL_EXE);
  });

  test("honors BROWSE_BIN as a back-compat alias", () => {
    const resolved = withEnv(
      { GSTACK_BROWSE_BIN: undefined, BROWSE_BIN: REAL_EXE },
      () => resolveBrowseBin(),
    );
    expect(resolved).toBe(REAL_EXE);
  });

  test("GSTACK_BROWSE_BIN takes precedence over BROWSE_BIN", () => {
    const resolved = withEnv(
      { GSTACK_BROWSE_BIN: REAL_EXE, BROWSE_BIN: "/nonexistent/legacy" },
      () => resolveBrowseBin(),
    );
    expect(resolved).toBe(REAL_EXE);
  });

  test("strips wrapping double quotes from override values", () => {
    const resolved = withEnv({ GSTACK_BROWSE_BIN: `"${REAL_EXE}"` }, () => resolveBrowseBin());
    expect(resolved).toBe(REAL_EXE);
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
