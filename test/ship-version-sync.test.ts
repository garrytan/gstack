// /ship Step 12: VERSION ↔ package.json drift detection + repair.
// Mirrors the bash blocks in ship/SKILL.md.tmpl Step 12. When the template
// changes, update both sides together.
//
// Coverage gap: node-absent + bun-present path. Simulating "no node" in-process
// is flaky across dev machines; covered by manual spot-check + CI running on
// bun-only images if/when we add them.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ship-drift-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeFiles = (files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
};

const pkgJson = (version: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    version === null ? { name: "x", ...extra } : { name: "x", version, ...extra },
    null,
    2,
  ) + "\n";

const idempotency = (base: string): { stdout: string; code: number } => {
  const script = `
cd "${dir}" || exit 2
BASE_VERSION="${base}"
CURRENT_VERSION=$(cat VERSION 2>/dev/null | tr -d '\\r\\n[:space:]' || echo "0.0.0.0")
[ -z "$CURRENT_VERSION" ] && CURRENT_VERSION="0.0.0.0"
PKG_VERSION=""
PKG_EXISTS=0
if [ -f package.json ]; then
  PKG_EXISTS=1
  if command -v node >/dev/null 2>&1; then
    PKG_VERSION=$(node -e 'const p=require("./package.json");process.stdout.write(p.version||"")' 2>/dev/null)
    PARSE_EXIT=$?
  elif command -v bun >/dev/null 2>&1; then
    PKG_VERSION=$(bun -e 'const p=require("./package.json");process.stdout.write(p.version||"")' 2>/dev/null)
    PARSE_EXIT=$?
  else
    echo "ERROR: no parser"; exit 1
  fi
  if [ "$PARSE_EXIT" != "0" ]; then
    echo "ERROR: invalid JSON"; exit 1
  fi
fi
if [ "$CURRENT_VERSION" = "$BASE_VERSION" ]; then
  if [ "$PKG_EXISTS" = "1" ] && [ -n "$PKG_VERSION" ] && [ "$PKG_VERSION" != "$CURRENT_VERSION" ]; then
    echo "STATE: DRIFT_UNEXPECTED"; exit 1
  fi
  echo "STATE: FRESH"
else
  if [ "$PKG_EXISTS" = "1" ] && [ -n "$PKG_VERSION" ] && [ "$PKG_VERSION" != "$CURRENT_VERSION" ]; then
    echo "STATE: DRIFT_STALE_PKG"
  else
    echo "STATE: ALREADY_BUMPED"
  fi
fi`;
  try {
    const stdout = execSync(script, { shell: "/bin/bash", encoding: "utf8" });
    return { stdout: stdout.trim(), code: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout || "").toString().trim(), code: e.status ?? 1 };
  }
};

const bump = (newVer: string): { code: number } => {
  const script = `
cd "${dir}" || exit 2
NEW_VERSION="${newVer}"
if ! printf '%s' "$NEW_VERSION" | grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'; then
  echo "invalid semver" >&2; exit 1
fi
echo "$NEW_VERSION" > VERSION
if [ -f package.json ]; then
  node -e 'const fs=require("fs"),p=require("./package.json");p.version=process.argv[1];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\\n")' "$NEW_VERSION"
fi`;
  try {
    execSync(script, { shell: "/bin/bash", stdio: "pipe" });
    return { code: 0 };
  } catch (e: any) {
    return { code: e.status ?? 1 };
  }
};

const syncRepair = (): { code: number } => {
  const script = `
cd "${dir}" || exit 2
REPAIR_VERSION=$(cat VERSION | tr -d '\\r\\n[:space:]')
if ! printf '%s' "$REPAIR_VERSION" | grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'; then
  echo "invalid repair semver" >&2; exit 1
fi
node -e 'const fs=require("fs"),p=require("./package.json");p.version=process.argv[1];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\\n")' "$REPAIR_VERSION"`;
  try {
    execSync(script, { shell: "/bin/bash", stdio: "pipe" });
    return { code: 0 };
  } catch (e: any) {
    return { code: e.status ?? 1 };
  }
};

const pkgVersion = () =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

// --- Idempotency classification: 6 cases ---

test("FRESH: VERSION == base, pkg synced", () => {
  writeFiles({ VERSION: "0.0.0.0\n", "package.json": pkgJson("0.0.0.0") });
  expect(idempotency("0.0.0.0")).toEqual({ stdout: "STATE: FRESH", code: 0 });
});

test("FRESH: VERSION == base, no package.json", () => {
  writeFiles({ VERSION: "0.0.0.0\n" });
  expect(idempotency("0.0.0.0")).toEqual({ stdout: "STATE: FRESH", code: 0 });
});

test("ALREADY_BUMPED: VERSION ahead, pkg synced", () => {
  writeFiles({ VERSION: "0.1.0.0\n", "package.json": pkgJson("0.1.0.0") });
  expect(idempotency("0.0.0.0")).toEqual({ stdout: "STATE: ALREADY_BUMPED", code: 0 });
});

test("ALREADY_BUMPED: VERSION ahead, no package.json", () => {
  writeFiles({ VERSION: "0.1.0.0\n" });
  expect(idempotency("0.0.0.0")).toEqual({ stdout: "STATE: ALREADY_BUMPED", code: 0 });
});

test("DRIFT_STALE_PKG: VERSION ahead, pkg stale", () => {
  writeFiles({ VERSION: "0.1.0.0\n", "package.json": pkgJson("0.0.0.0") });
  expect(idempotency("0.0.0.0")).toEqual({ stdout: "STATE: DRIFT_STALE_PKG", code: 0 });
});

test("DRIFT_UNEXPECTED: VERSION == base, pkg edited (exits non-zero)", () => {
  writeFiles({ VERSION: "0.0.0.0\n", "package.json": pkgJson("0.5.0.0") });
  const r = idempotency("0.0.0.0");
  expect(r.stdout.startsWith("STATE: DRIFT_UNEXPECTED")).toBe(true);
  expect(r.code).toBe(1);
});

// --- Parse failures: 2 cases ---

test("idempotency: invalid JSON exits non-zero with clear error", () => {
  writeFiles({ VERSION: "0.1.0.0\n", "package.json": "{ not valid" });
  const r = idempotency("0.0.0.0");
  expect(r.code).toBe(1);
  expect(r.stdout).toContain("invalid JSON");
});

test("idempotency: package.json with no version field treated as <none>", () => {
  writeFiles({ VERSION: "0.1.0.0\n", "package.json": pkgJson(null) });
  // PKG_VERSION is empty → drift check skipped → ALREADY_BUMPED
  expect(idempotency("0.0.0.0")).toEqual({ stdout: "STATE: ALREADY_BUMPED", code: 0 });
});

// --- Bump: 3 cases ---

test("bump: writes VERSION and package.json in sync", () => {
  writeFiles({ VERSION: "0.0.0.0\n", "package.json": pkgJson("0.0.0.0") });
  expect(bump("0.1.0.0").code).toBe(0);
  expect(readFileSync(join(dir, "VERSION"), "utf8").trim()).toBe("0.1.0.0");
  expect(pkgVersion()).toBe("0.1.0.0");
});

test("bump: rejects invalid NEW_VERSION", () => {
  writeFiles({ VERSION: "0.0.0.0\n", "package.json": pkgJson("0.0.0.0") });
  const r = bump("not-a-version");
  expect(r.code).toBe(1);
  // VERSION is unchanged — validation runs before any write.
  expect(readFileSync(join(dir, "VERSION"), "utf8").trim()).toBe("0.0.0.0");
});

test("bump: no package.json is silent", () => {
  writeFiles({ VERSION: "0.0.0.0\n" });
  expect(bump("0.1.0.0").code).toBe(0);
  expect(readFileSync(join(dir, "VERSION"), "utf8").trim()).toBe("0.1.0.0");
  expect(existsSync(join(dir, "package.json"))).toBe(false);
});

// --- Adversarial review regressions: trailing whitespace + invalid REPAIR_VERSION ---

test("trailing CR in VERSION does not cause false DRIFT_STALE_PKG", () => {
  // Before the tr-strip fix, VERSION="0.1.0.0\r" read via cat would mismatch
  // pkg.version="0.1.0.0" and classify as DRIFT_STALE_PKG, then repair would
  // write garbage \r into package.json. Now CURRENT_VERSION is stripped.
  writeFileSync(join(dir, "VERSION"), "0.1.0.0\r\n");
  writeFileSync(join(dir, "package.json"), pkgJson("0.1.0.0"));
  expect(idempotency("0.0.0.0")).toEqual({ stdout: "STATE: ALREADY_BUMPED", code: 0 });
});

test("DRIFT REPAIR rejects invalid VERSION semver instead of propagating", () => {
  // If VERSION is corrupted/manually-edited to something non-semver, the
  // repair path must refuse rather than writing junk into package.json.
  writeFileSync(join(dir, "VERSION"), "not-a-semver\n");
  writeFileSync(join(dir, "package.json"), pkgJson("0.0.0.0"));
  const r = syncRepair();
  expect(r.code).toBe(1);
  // package.json must NOT have been overwritten with the garbage.
  expect(pkgVersion()).toBe("0.0.0.0");
});

// --- THE critical regression test: drift-repair does NOT double-bump ---

test("DRIFT REPAIR: sync path syncs pkg to VERSION without re-bumping", () => {
  // Simulate a prior /ship that bumped VERSION but failed to touch package.json.
  writeFiles({ VERSION: "0.1.0.0\n", "package.json": pkgJson("0.0.0.0") });
  // Idempotency classifies as DRIFT_STALE_PKG.
  expect(idempotency("0.0.0.0").stdout).toBe("STATE: DRIFT_STALE_PKG");
  // Sync-only repair runs — no re-bump.
  expect(syncRepair().code).toBe(0);
  // VERSION is unchanged. package.json now matches VERSION. No 0.2.0.0.
  expect(readFileSync(join(dir, "VERSION"), "utf8").trim()).toBe("0.1.0.0");
  expect(pkgVersion()).toBe("0.1.0.0");
});
