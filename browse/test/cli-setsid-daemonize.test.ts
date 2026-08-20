/**
 * Coverage for #1612 — macOS/Linux server must survive sandboxed-shell
 * harnesses by becoming its own session leader (setsid).
 *
 * Pre-#1612, Bun.spawn().unref() removed the child from Bun's event loop
 * but did NOT call setsid(). When the CLI ran inside Claude Code's
 * per-command sandbox, Conductor, or CI step runners, the session leader's
 * exit sent SIGHUP to every PID in the session, killing the bun server.
 *
 * The fix routes macOS/Linux spawn through Node's child_process.spawn with
 * detached:true, which calls setsid() so the server becomes its own session
 * leader (PPID=1 on Linux, similar reparenting on Darwin).
 *
 * The actual setsid syscall is hard to assert in a unit test without a
 * real spawn — testing here is static: the cli.ts source must use the
 * Node spawn path on macOS/Linux, with detached:true and .unref(). If a
 * future refactor reverts to Bun.spawn().unref() on the macOS/Linux branch
 * the regression returns and these tests fail.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(ROOT, "browse", "src", "cli.ts");

function read(): string {
  return fs.readFileSync(CLI, "utf-8");
}

describe("#1612 macOS/Linux daemonize via Node setsid path", () => {
  test("cli.ts imports nodeSpawn from child_process (Node spawn alias)", () => {
    const body = read();
    // The fix relies on Node's child_process.spawn (which calls setsid on
    // detached:true), aliased to avoid name collision with Bun.spawn. Match
    // either `nodeSpawn` or `spawn as nodeSpawn` to be flexible to the
    // exact import style.
    expect(body).toMatch(/(spawn as nodeSpawn|nodeSpawn\s*[,}])/);
    expect(body).toMatch(/from\s+['"]child_process['"]/);
  });

  test("non-Windows branch uses nodeSpawn(...).unref() with detached:true", () => {
    const body = read();
    // Find the non-Windows branch and assert it uses the Node spawn alias
    // with detached:true. Match the pattern `nodeSpawn(...) ... detached:true`.
    expect(body).toMatch(/nodeSpawn\([\s\S]{0,500}detached:\s*true/);
    expect(body).toMatch(/nodeSpawn\([\s\S]{0,500}\.unref\(\)/);
  });

  test("non-Windows branch comment documents setsid/SIGHUP root cause", () => {
    const body = read();
    // The comment block must mention setsid() so a future refactor sees the
    // why before changing the spawn call.
    expect(body).toMatch(/setsid/);
    expect(body).toMatch(/SIGHUP/);
  });

  test("the spawn call on macOS/Linux is nodeSpawn, not Bun.spawn", () => {
    const body = read();
    // Strip line comments before regex matching, so the "Bun.spawn().unref()"
    // mentions inside the explanatory comment don't trigger false positives.
    const codeOnly = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // Find the non-Windows branch. The `} else {` block following the
    // Windows branch. We then require its first ~400 chars contain a
    // nodeSpawn() call and NOT a Bun.spawn() call (excluding the comment).
    const nonWindowsStart = codeOnly.indexOf("nodeSpawn('bun'");
    expect(nonWindowsStart).toBeGreaterThan(-1);
    const slice = codeOnly.slice(nonWindowsStart, nonWindowsStart + 400);
    expect(slice).toMatch(/nodeSpawn\(/);
    expect(slice).not.toMatch(/Bun\.spawn\(/);
  });
});
