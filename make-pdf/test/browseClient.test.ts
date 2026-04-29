/**
 * browseClient unit tests — binary resolution and error mapping.
 *
 * These are pure unit tests; they do NOT require a running browse daemon.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BrowseClientError } from "../src/types";
import { resolveBrowseBin, findExecutable } from "../src/browseClient";

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
    // Pick a path that exists and is executable on the current platform.
    // `/bin/sh` is universal on POSIX; `cmd.exe` ships with every Windows.
    const realExe = process.platform === "win32"
      ? "C:\\Windows\\System32\\cmd.exe"
      : "/bin/sh";
    process.env.BROWSE_BIN = realExe;

    try {
      const resolved = resolveBrowseBin();
      expect(resolved).toBe(realExe);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BROWSE_BIN;
      } else {
        process.env.BROWSE_BIN = originalEnv;
      }
    }
  });

  test("on win32, honors BROWSE_BIN pointing at a base path that needs .exe", () => {
    if (process.platform !== "win32") return;
    const originalEnv = process.env.BROWSE_BIN;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-resolve-"));
    const exePath = path.join(tmpDir, "browse.exe");
    try {
      fs.writeFileSync(exePath, "");
      // Point BROWSE_BIN at the base path WITHOUT .exe — mirrors the real
      // failure Sam hit with BROWSE_BIN=/c/.../dist/browse when the on-disk
      // artifact was browse.exe (https://github.com/garrytan/gstack/pull/???).
      process.env.BROWSE_BIN = path.join(tmpDir, "browse");
      const resolved = resolveBrowseBin();
      expect(resolved).toBe(exePath);
    } finally {
      if (originalEnv === undefined) delete process.env.BROWSE_BIN;
      else process.env.BROWSE_BIN = originalEnv;
      try { fs.unlinkSync(exePath); } catch { /* best-effort */ }
      try { fs.rmdirSync(tmpDir); } catch { /* best-effort */ }
    }
  });
});

describe("findExecutable", () => {
  test("returns the path as-is when it's directly executable", () => {
    const probe = process.platform === "win32"
      ? "C:\\Windows\\System32\\cmd.exe"
      : "/bin/sh";
    expect(findExecutable(probe)).toBe(probe);
  });

  test("returns null when the path does not exist in any known form", () => {
    expect(findExecutable("/nonexistent/definitely-not-here")).toBeNull();
  });

  test("on win32, probes .exe when the bare path is missing", () => {
    if (process.platform !== "win32") return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-findexe-"));
    const exePath = path.join(tmpDir, "fake-browse.exe");
    try {
      fs.writeFileSync(exePath, "");
      // Base path WITHOUT .exe — exactly how the hardcoded sibling and
      // global candidates inside resolveBrowseBin probe for the binary.
      const resolved = findExecutable(path.join(tmpDir, "fake-browse"));
      expect(resolved).toBe(exePath);
    } finally {
      try { fs.unlinkSync(exePath); } catch { /* best-effort */ }
      try { fs.rmdirSync(tmpDir); } catch { /* best-effort */ }
    }
  });

  test("on win32, probes .cmd and .bat as well as .exe", () => {
    if (process.platform !== "win32") return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-findexe-"));
    const cmdPath = path.join(tmpDir, "wrapper.cmd");
    try {
      fs.writeFileSync(cmdPath, "@echo off\r\n");
      const resolved = findExecutable(path.join(tmpDir, "wrapper"));
      expect(resolved).toBe(cmdPath);
    } finally {
      try { fs.unlinkSync(cmdPath); } catch { /* best-effort */ }
      try { fs.rmdirSync(tmpDir); } catch { /* best-effort */ }
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
