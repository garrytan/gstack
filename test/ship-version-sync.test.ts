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
    const stdout = execSync(script, { shell: "/bin/bash", encoding: "utf8", timeout: 30_000 });
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
    execSync(script, { shell: "/bin/bash", stdio: "pipe", timeout: 30_000 });
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
    execSync(script, { shell: "/bin/bash", stdio: "pipe", timeout: 30_000 });
    return { code: 0 };
  } catch (e: any) {
    return { code: e.status ?? 1 };
  }
};

const pkgVersion = () =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

test("rendered drift repair rejoins the existing-version queue check", () => {
  const ship = readFileSync(join(import.meta.dir, '../ship/SKILL.md'), 'utf8');
  const version = ship.slice(ship.indexOf('## Step 12:'), ship.indexOf('## Step 14:')).replace(/\s+/g, ' ');
  expect(version).toMatch(/DRIFT_STALE_PKG[^\n]+repair[^\n]+reclassify[^\n]+ALREADY_BUMPED[^\n]+queue/);
  expect(version).toContain('--current-version "$BASE_VERSION"');
  expect(version).toContain('CANDIDATE_VERSION');
  expect(version).toMatch(/keep[^\n]+NEW_VERSION[^\n]+currentVersion/);
});

test("rendered queue dispatch preserves offline git candidates without empty fallback fallthrough", () => {
  const ship = readFileSync(join(import.meta.dir, '../ship/SKILL.md'), 'utf8');
  const qualifyAt = ship.indexOf('**Qualify first:**');
  const usableAt = ship.indexOf('**Usable candidate:**');
  const missingAt = ship.indexOf('**No usable candidate:**');
  expect(qualifyAt).toBeGreaterThanOrEqual(0);
  expect(usableAt).toBeGreaterThan(qualifyAt);
  expect(usableAt).toBeGreaterThanOrEqual(0);
  expect(missingAt).toBeGreaterThan(usableAt);
  const qualify = ship.slice(qualifyAt, usableAt).replace(/\s+/g, ' ');
  const usable = ship.slice(usableAt, missingAt).replace(/\s+/g, ' ');
  const missing = ship.slice(missingAt, ship.indexOf('4. **Write the bump**', missingAt)).replace(/\s+/g, ' ');
  expect(qualify).toContain('require successful utility output and a nonempty valid version');
  expect(qualify).toContain('`offline:false` qualifies; `offline:true` qualifies only with `fallback:"git"`');
  expect(qualify).toContain('Offline output without that fallback, failure, malformed output or an empty version is unusable');
  expect(usable).toContain('warnings and claimed queue');
  expect(usable).toContain('CANDIDATE_VERSION');
  expect(missing).toContain('local `BUMP_LEVEL` arithmetic');
  expect(missing).toContain('ALREADY_BUMPED keeps `currentVersion`');
  expect(missing).not.toContain('CANDIDATE_VERSION');
});

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

// G1 (#2334, #2343): the generated /ship flow, driven against the real
// classifier on a versionless app, a monorepo, a release-please repo and a
// broken pin. Every state the CLI emits must have a dispatch arm, and the
// NO_VERSION arm must carry through to the CHANGELOG and title steps.
test("rendered /ship handles every version-source outcome the classifier emits", () => {
  const ship = readFileSync(join(import.meta.dir, "../ship/SKILL.md"), "utf8");
  const changelog = readFileSync(join(import.meta.dir, "../ship/sections/changelog.md"), "utf8");
  const step12 = ship.slice(ship.indexOf("## Step 12:"), ship.indexOf("## Step 14:")).replace(/\s+/g, " ");
  const step18 = ship.slice(ship.indexOf("Prepare the title from that result"), ship.indexOf("## Step 20:")).replace(/\s+/g, " ");
  const classifyCmd = step12.match(/bun run \S+gstack-version-bump classify --base <base>/);
  expect(classifyCmd).not.toBeNull();
  const bin = join(import.meta.dir, "../bin/gstack-version-bump");
  const fixtures: Record<string, Record<string, string>> = {
    versionless: { "package.json": pkgJson("2.3.4") },
    monorepo: { "pnpm-workspace.yaml": "packages: []\n" },
    releasePlease: { "release-please-config.json": "{}" },
    brokenPin: { ".gstack-pin": "" },
  };
  for (const [name, files] of Object.entries(fixtures)) {
    const repo = mkdtempSync(join(tmpdir(), `ship-g1-${name}-`));
    try {
      for (const [rel, body] of Object.entries(files)) writeFileSync(join(repo, rel), body);
      if (name === "brokenPin") {
        execSync("mkdir -p .gstack && echo missing/VERSION > .gstack/version-path", { cwd: repo, shell: "/bin/bash", timeout: 10_000 });
      }
      execSync("git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm base && git update-ref refs/remotes/origin/main HEAD", { cwd: repo, shell: "/bin/bash", timeout: 30_000 });
      let state = "";
      let code = 0;
      try {
        state = JSON.parse(execSync(`bun "${bin}" classify --base main`, { cwd: repo, stdio: "pipe", timeout: 30_000 }).toString()).state;
      } catch (e: any) {
        code = e.status;
      }
      if (name === "brokenPin") {
        expect(code).toBe(2);
        expect(step12).toMatch(/\*\*Exit 2\*\* → STOP[^.]*stderr/);
        expect(step12).toContain("Never substitute `0.0.0.0`");
      } else {
        expect(state).toBe("NO_VERSION");
        expect(step12).toContain(`**${state}** →`);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
  const arm = step12.slice(step12.indexOf("**NO_VERSION** →"), step12.indexOf("**Exit 2** →"));
  expect(arm).toContain("`notice`");
  expect(arm).toMatch(/skip the rest of Step 12 and Step 13/);
  expect(arm).toContain("never create VERSION");
  expect(changelog).toMatch(/NO_VERSION[^\n]*skip this step/);
  expect(step18).toMatch(/NO_VERSION[^.]*replaces items 1-3/);
  expect(step18).toContain("no version prefix");
});
