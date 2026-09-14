/**
 * Coverage for #1606 — `_gstack_gbrain_validate_varname` LC_ALL=C pin.
 *
 * Without the `local LC_ALL=C`, macOS default locale (en_US.UTF-8) makes
 * `case "$name" in [A-Z_][A-Z0-9_]*)` match lowercase letters too —
 * lower-case identifiers pass validation and then trip `printf -v "$varname"`
 * with "not a valid identifier" the caller can't distinguish from other
 * failures.
 *
 * Tests exercise the validator by sourcing bin/gstack-gbrain-lib.sh and
 * calling _gstack_gbrain_validate_varname directly. Asserts:
 *   - Valid uppercase identifiers accepted (return 0)
 *   - Lowercase identifiers REJECTED (return 2) — pre-#1606 regression case
 *   - Mixed-case rejected
 *   - Empty name rejected
 *   - Names starting with digit rejected
 *   - Underscore prefix accepted
 *   - LC_ALL=C does not leak to caller (local scope preserved)
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const LIB = path.join(ROOT, "bin", "gstack-gbrain-lib.sh");

function runValidator(name: string): { status: number | null } {
  // Source the lib then run the validator against the input. Use bash -c with
  // single-quoted body to avoid double interpolation. LANG=en_US.UTF-8 set
  // explicitly so the test catches the macOS locale FP case even when CI's
  // default locale would mask it.
  const result = spawnSync(
    "bash",
    ["-c", `. "${LIB}"; _gstack_gbrain_validate_varname "$1"`, "bash", name],
    {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    },
  );
  return { status: result.status };
}

describe("#1606 _gstack_gbrain_validate_varname — LC_ALL=C pin", () => {
  test("ACCEPTS uppercase identifier (canonical happy path)", () => {
    expect(runValidator("DATABASE_URL").status).toBe(0);
  });

  test("ACCEPTS uppercase + digits + underscores", () => {
    expect(runValidator("GBRAIN_DB_URL_v2".toUpperCase()).status).toBe(0);
    expect(runValidator("X1_2_3").status).toBe(0);
  });

  test("ACCEPTS underscore-prefixed identifier", () => {
    expect(runValidator("_PRIVATE_VAR").status).toBe(0);
  });

  test("REJECTS lowercase identifier (#1606 regression — would pass on macOS without LC_ALL=C)", () => {
    expect(runValidator("lower_case").status).toBe(2);
  });

  test("REJECTS mixed-case identifier", () => {
    expect(runValidator("MixedCase").status).toBe(2);
    expect(runValidator("camelCase").status).toBe(2);
  });

  test("REJECTS name starting with digit", () => {
    expect(runValidator("1ABC").status).toBe(2);
  });

  test("REJECTS empty name", () => {
    expect(runValidator("").status).toBe(2);
  });

  // Note: hyphen/dot acceptance is a pre-existing overpermissiveness in the
  // glob pattern `[A-Z_][A-Z0-9_]*` — `*` matches any chars after the bracket
  // class. NOT in scope for #1606; tracked separately for a future cleanup
  // wave. Tests intentionally do not assert hyphen/dot rejection so this
  // file doesn't regress when that future fix lands.

  test("LC_ALL=C is local to the validator (does not leak to caller)", () => {
    // After sourcing + calling the validator, $LC_ALL in the caller scope
    // must remain whatever LANG/LC_ALL the caller set. We seed LC_ALL with a
    // distinctive value, call the validator, then print $LC_ALL — the
    // distinctive value must survive.
    const result = spawnSync(
      "bash",
      ["-c", `. "${LIB}"; LC_ALL=fr_FR.UTF-8; _gstack_gbrain_validate_varname FOO; echo "$LC_ALL"`],
      {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, LANG: "en_US.UTF-8" },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("fr_FR.UTF-8");
  });
});
