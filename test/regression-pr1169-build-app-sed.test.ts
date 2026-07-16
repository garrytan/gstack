/**
 * Regression tests for PR #1169 bugs #2 + #3 — scripts/build-app.sh.
 *
 * Bug #2: sed replacement for Chromium rebrand interpolated $APP_NAME without
 * escaping sed replacement metachars (`&`, `/`, `\`). A name with `/` either
 * broke the s/// command or got interpreted as sed syntax.
 *
 * Bug #3: `DMG_TMP=$(mktemp -d)` was unchecked. On mktemp failure $DMG_TMP
 * was empty and the next `cp -a "$APP_DIR" "$DMG_TMP/"` would copy the .app
 * bundle into the filesystem root.
 *
 * Bug #2 is verified via a runtime isolation test of the sed-escape sequence
 * (codex pushback: static-grep for "uses escape helper" is too narrow; the
 * real invariant is metachar safety end-to-end). Bug #3 is verified via
 * static check — the entire build flow needs xcrun/hdiutil and can't be
 * spawned in CI, but the failure-guard shape is what we want to lock.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(ROOT, "scripts/build-app.sh");

describe("PR #1169 bug #2: build-app.sh sed escape for $APP_NAME", () => {
  test("escape sequence produces sed-safe output for `&`, `/`, `\\` in APP_NAME", () => {
    // Mirror the script's escape sequence and run it in isolation against a
    // hostile name. The escape sequence at line ~98 is:
    //   APP_NAME_SED_ESCAPED=$(printf '%s' "$APP_NAME" | sed 's/[&/\]/\\&/g')
    // We assert the resulting string can then be used as a sed replacement
    // safely — round-trip via a real `sed s///` against a stub strings file.

    const inputs: string[] = [
      "Foo/Bar&Baz",      // slash + ampersand
      "Cool\\App",        // backslash
      "Plain Name",        // no metachars (baseline)
      "A/B\\C&D",          // all three at once
      "End/",              // trailing slash
      "&Start",            // leading ampersand
    ];

    for (const appName of inputs) {
      // Bug #2 invariant: the escaped string, used as the replacement half
      // of `sed s/<needle>/<replacement>/g`, results in the literal appName
      // appearing in the output.
      const result = spawnSync(
        "bash",
        ["-c",
          `set -eu
           APP_NAME="$1"
           APP_NAME_SED_ESCAPED=$(printf '%s' "$APP_NAME" | sed 's/[&/\\]/\\\\&/g')
           printf 'Google Chrome for Testing' | sed "s/Google Chrome for Testing/\${APP_NAME_SED_ESCAPED}/g"
          `,
          "_",
          appName,
        ],
        { encoding: "utf-8" }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(appName);
      expect(result.stderr).toBe("");
    }
  });

  test("script body still routes APP_NAME through the escape helper before sed", () => {
    // Belt-and-braces static check: the rebrand block must contain BOTH the
    // escape line and the sed line referencing the escaped variable.
    const body = fs.readFileSync(SCRIPT, "utf-8");
    expect(body).toMatch(/APP_NAME_SED_ESCAPED=\$\(printf '%s' "\$APP_NAME" \| sed/);
    expect(body).toMatch(/sed -i ''\s*"s\/Google Chrome for Testing\/\$\{APP_NAME_SED_ESCAPED\}\/g"/);
  });

  test("no bare `$APP_NAME` interpolation directly into the rebrand sed", () => {
    // Ensure no future refactor reintroduces the bug by interpolating
    // $APP_NAME straight into the s/// replacement.
    const body = fs.readFileSync(SCRIPT, "utf-8");
    expect(body).not.toMatch(/sed -i ''\s*"s\/Google Chrome for Testing\/\$APP_NAME\//);
    expect(body).not.toMatch(/sed -i ''\s*"s\/Google Chrome for Testing\/\$\{APP_NAME\}\//);
  });
});

describe("PR #1169 bug #3: build-app.sh DMG_TMP mktemp failure guard", () => {
  test("mktemp -d for DMG_TMP is followed by an explicit failure handler", () => {
    const body = fs.readFileSync(SCRIPT, "utf-8");
    // The script must assign DMG_TMP and immediately check for failure on
    // the SAME line via `||`, then validate the path is non-empty and a real
    // directory before cp.
    const guard = body.match(
      /DMG_TMP=\$\(mktemp -d\)\s*\|\|\s*\{[^}]*exit\s+\d/
    );
    expect(guard).not.toBeNull();
  });

  test("DMG_TMP is also validated as non-empty AND a directory before cp", () => {
    const body = fs.readFileSync(SCRIPT, "utf-8");
    // After mktemp, a defensive check should reject empty or non-directory
    // paths (covers cases where mktemp succeeds but returns garbage).
    expect(body).toMatch(
      /\[\s*-z\s+"\$DMG_TMP"\s*\][^\n]*\|\|\s*\[\s*!\s+-d\s+"\$DMG_TMP"\s*\]/
    );
  });

  test("no `cp -a ... \"$DMG_TMP/\"` before the validation block", () => {
    const body = fs.readFileSync(SCRIPT, "utf-8");
    // The cp must come AFTER the validation. Find the line offsets.
    const mktempIdx = body.search(/DMG_TMP=\$\(mktemp -d\)/);
    const validationIdx = body.search(
      /\[\s*-z\s+"\$DMG_TMP"\s*\]/
    );
    const cpIdx = body.search(/cp -a "\$APP_DIR" "\$DMG_TMP\//);
    expect(mktempIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeGreaterThan(mktempIdx);
    expect(cpIdx).toBeGreaterThan(validationIdx);
  });

  test("runtime: escape function refuses to leave DMG_TMP empty (fake-mktemp PATH stub)", () => {
    // Codex strongly preferred runtime testing here. The full build-app.sh
    // depends on xcrun/hdiutil/PlistBuddy — too heavy for CI. Instead, we
    // extract just the failure-guard shape and run it with a fake mktemp
    // that always exits 1. Asserts the script exits non-zero before cp.

    const fakeBin = fs.mkdtempSync(path.join("/tmp", "pr1169-fakebin-"));
    fs.writeFileSync(
      path.join(fakeBin, "mktemp"),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 }
    );

    // The guard, isolated. Mirrors the actual script's logic. Use a regular
    // string + array of lines so the embedded bash backticks/dollars don't
    // get interpreted by the JS template-literal parser.
    const guardScript = [
      'set -u',
      'DMG_TMP=$(mktemp -d) || { echo "ERROR: mktemp -d failed — refusing to continue so we don\'t cp into the filesystem root." >&2; exit 1; }',
      'if [ -z "$DMG_TMP" ] || [ ! -d "$DMG_TMP" ]; then',
      '  echo "ERROR: mktemp -d returned an invalid path (\'$DMG_TMP\')." >&2',
      '  exit 1',
      'fi',
      '# If we got here, we would run the cp block, which is the bug.',
      'echo "REACHED_CP_BLOCK_WHICH_IS_THE_BUG" >&2',
      'exit 0',
    ].join('\n');

    const result = spawnSync(
      "bash",
      ["-c", guardScript],
      {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      }
    );

    fs.rmSync(fakeBin, { recursive: true, force: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/mktemp -d failed|invalid path/);
    expect(result.stderr).not.toMatch(/REACHED_CP_BLOCK_WHICH_IS_THE_BUG/);
  });
});
