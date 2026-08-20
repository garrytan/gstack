/**
 * gstack-upgrade/migrations/v1.40.0.0.sh — migration script unit tests.
 *
 * Per #1581: the original script unconditionally `touch`ed its done-marker even
 * when the jq-gated privacy-map patch was skipped. The fix defers `touch ${DONE}`
 * until every required repair either succeeded or was provably unnecessary.
 *
 * The "regression case" that this file pins is case 2: jq missing + privacy-map
 * present → no done-marker. Against the buggy script, case 2 fails (marker is
 * written despite skipped patch); against the fix it passes.
 *
 * Strategy: each test sets up an isolated tmpHome with controlled fixture
 * content, and runs the migration via `spawnSync('bash', [MIGRATION], …)`.
 * For "jq missing" we point PATH at a curated dir of symlinks to the standard
 * utilities the script uses, omitting jq. For "jq mutation fails" we point PATH
 * at a dir containing a jq shim that exits 1.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const MIGRATION = path.join(
  ROOT,
  "gstack-upgrade",
  "migrations",
  "v1.40.0.0.sh",
);

const NEW_PATTERN = "projects/*/*-eng-review-test-plan-*.md";
const REAL_PATH = "/usr/bin:/bin:/opt/homebrew/bin";

let tmpHome: string;
let gstackHome: string;
let migrationDir: string;
let donePath: string;
let allowlistPath: string;
let privacyPath: string;
let gitattrsPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-mig-v1400-"));
  gstackHome = path.join(tmpHome, ".gstack");
  migrationDir = path.join(gstackHome, ".migrations");
  donePath = path.join(migrationDir, "v1.40.0.0.done");
  allowlistPath = path.join(gstackHome, ".brain-allowlist");
  privacyPath = path.join(gstackHome, ".brain-privacy-map.json");
  gitattrsPath = path.join(gstackHome, ".gitattributes");
  fs.mkdirSync(gstackHome, { recursive: true });
});

afterEach(() => {
  try {
    fs.chmodSync(gstackHome, 0o755);
    if (fs.existsSync(allowlistPath)) fs.chmodSync(allowlistPath, 0o644);
    if (fs.existsSync(privacyPath)) fs.chmodSync(privacyPath, 0o644);
    if (fs.existsSync(gitattrsPath)) fs.chmodSync(gitattrsPath, 0o644);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

/**
 * Construct a PATH-style directory of symlinks to standard utilities the
 * migration script needs (mkdir, grep, sed, mv, rm, mktemp, cat, touch, printf,
 * command, etc.). Optionally omit jq, or substitute a shim.
 */
function makeCuratedPath(opts: { jq?: "missing" | "shim-fail" | "real" } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-mig-path-"));
  const utils = [
    "bash",
    "sh",
    "mkdir",
    "grep",
    "sed",
    "mv",
    "rm",
    "mktemp",
    "cat",
    "touch",
    "printf",
    "command",
    "echo",
    "test",
    "[",
    "tee",
    "true",
    "false",
    "ls",
    "chmod",
  ];
  const realDirs = REAL_PATH.split(":");
  for (const u of utils) {
    for (const d of realDirs) {
      const src = path.join(d, u);
      if (fs.existsSync(src)) {
        try {
          fs.symlinkSync(src, path.join(dir, u));
        } catch {}
        break;
      }
    }
  }
  const jq = opts.jq ?? "real";
  if (jq === "real") {
    for (const d of realDirs) {
      const src = path.join(d, "jq");
      if (fs.existsSync(src)) {
        try {
          fs.symlinkSync(src, path.join(dir, "jq"));
        } catch {}
        break;
      }
    }
  } else if (jq === "shim-fail") {
    const shim = path.join(dir, "jq");
    fs.writeFileSync(
      shim,
      `#!/usr/bin/env bash\necho "fake jq: refusing" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
  }
  // jq === "missing" → don't add anything
  return dir;
}

function run(opts: { path?: string } = {}) {
  const env = {
    HOME: tmpHome,
    PATH: opts.path ?? REAL_PATH,
  };
  return spawnSync("bash", [MIGRATION], {
    env,
    encoding: "utf-8",
    cwd: tmpHome,
  });
}

function freshPrivacyMap() {
  fs.writeFileSync(
    privacyPath,
    JSON.stringify(
      [{ pattern: "projects/*/*-some-other-*.md", class: "artifact" }],
      null,
      2,
    ),
  );
}

function freshAllowlist() {
  fs.writeFileSync(
    allowlistPath,
    "# header\nprojects/*/*-some-other-*.md\n# ---- USER ADDITIONS BELOW\n",
  );
}

function freshGitattrs() {
  fs.writeFileSync(gitattrsPath, "projects/*/*-some-other-*.md merge=union\n");
}

describe("migrations/v1.40.0.0.sh", () => {
  test("case 1: jq present, fresh privacy-map — all three files patched, marker written", () => {
    freshAllowlist();
    freshPrivacyMap();
    freshGitattrs();

    const r = run();

    expect(r.status).toBe(0);
    expect(fs.existsSync(donePath)).toBe(true);

    const allowlist = fs.readFileSync(allowlistPath, "utf-8");
    expect(allowlist).toContain(NEW_PATTERN);

    const privacy = JSON.parse(fs.readFileSync(privacyPath, "utf-8"));
    expect(
      privacy.some(
        (e: any) => e.pattern === NEW_PATTERN && e.class === "artifact",
      ),
    ).toBe(true);

    const gitattrs = fs.readFileSync(gitattrsPath, "utf-8");
    expect(gitattrs).toContain(`${NEW_PATTERN} merge=union`);
  });

  test("case 2 (regression for #1581): jq missing, privacy-map exists — marker NOT written, text patches still applied", () => {
    freshAllowlist();
    freshPrivacyMap();
    freshGitattrs();

    const noJq = makeCuratedPath({ jq: "missing" });
    const r = run({ path: noJq });

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/jq not found/);

    // Done-marker must NOT be written — this is the whole point of the fix.
    expect(fs.existsSync(donePath)).toBe(false);

    // Text-only patches still landed (they don't need jq).
    expect(fs.readFileSync(allowlistPath, "utf-8")).toContain(NEW_PATTERN);
    expect(fs.readFileSync(gitattrsPath, "utf-8")).toContain(
      `${NEW_PATTERN} merge=union`,
    );

    // Privacy-map untouched (still missing the new entry).
    const privacy = JSON.parse(fs.readFileSync(privacyPath, "utf-8"));
    expect(privacy.some((e: any) => e.pattern === NEW_PATTERN)).toBe(false);
  });

  test("case 3: jq missing, then jq restored — second run completes patch and writes marker", () => {
    freshAllowlist();
    freshPrivacyMap();
    freshGitattrs();

    // First run with jq missing
    const noJq = makeCuratedPath({ jq: "missing" });
    const r1 = run({ path: noJq });
    expect(r1.status).toBe(0);
    expect(fs.existsSync(donePath)).toBe(false);

    // Second run with jq restored
    const r2 = run();
    expect(r2.status).toBe(0);
    expect(fs.existsSync(donePath)).toBe(true);

    const privacy = JSON.parse(fs.readFileSync(privacyPath, "utf-8"));
    expect(
      privacy.some(
        (e: any) => e.pattern === NEW_PATTERN && e.class === "artifact",
      ),
    ).toBe(true);
  });

  test("case 4: jq present, privacy-map already has correct entry — idempotent, marker written", () => {
    freshAllowlist();
    fs.writeFileSync(
      privacyPath,
      JSON.stringify(
        [{ pattern: NEW_PATTERN, class: "artifact" }],
        null,
        2,
      ),
    );
    freshGitattrs();

    const r = run();
    expect(r.status).toBe(0);
    expect(fs.existsSync(donePath)).toBe(true);

    const privacy = JSON.parse(fs.readFileSync(privacyPath, "utf-8"));
    const matches = privacy.filter((e: any) => e.pattern === NEW_PATTERN);
    expect(matches.length).toBe(1);
    expect(matches[0].class).toBe("artifact");
  });

  test("case 5: jq present, privacy-map file missing — allowlist + gitattrs patched, marker written", () => {
    freshAllowlist();
    // No privacy-map file
    freshGitattrs();

    const r = run();
    expect(r.status).toBe(0);
    expect(fs.existsSync(donePath)).toBe(true);
    expect(fs.existsSync(privacyPath)).toBe(false);

    expect(fs.readFileSync(allowlistPath, "utf-8")).toContain(NEW_PATTERN);
    expect(fs.readFileSync(gitattrsPath, "utf-8")).toContain(
      `${NEW_PATTERN} merge=union`,
    );
  });

  test("case 6: jq present, privacy-map JSON malformed — no marker, error logged, no mutation", () => {
    freshAllowlist();
    fs.writeFileSync(privacyPath, "{ this is not json [");
    freshGitattrs();

    const r = run();
    expect(r.status).toBe(0);
    // No marker — broken JSON should NOT be papered over.
    expect(fs.existsSync(donePath)).toBe(false);
    // Privacy-map content untouched.
    expect(fs.readFileSync(privacyPath, "utf-8")).toBe("{ this is not json [");
  });

  test("case 7: jq present but mutation fails (shim exit 1) — no marker, tempfile cleaned up", () => {
    freshAllowlist();
    freshPrivacyMap();
    freshGitattrs();

    const fakeJq = makeCuratedPath({ jq: "shim-fail" });
    const r = run({ path: fakeJq });

    expect(r.status).toBe(0);
    expect(fs.existsSync(donePath)).toBe(false);

    // Tempfile cleanup: no leftover *.tmp.* sidecars.
    const leftovers = fs
      .readdirSync(gstackHome)
      .filter((n) => n.startsWith(".brain-privacy-map.json.tmp."));
    expect(leftovers.length).toBe(0);
  });

  test("case 8: allowlist append fails (read-only file, no USER ADDITIONS marker) — no marker, warn logged", () => {
    // Allowlist WITHOUT the "# ---- USER ADDITIONS BELOW" marker — the script
    // falls into the plain `printf >>` append path. Make the file read-only
    // so the append fails (sed -i.bak on macOS silently no-ops on read-only
    // files, so we have to take the printf path to exercise this).
    fs.writeFileSync(
      allowlistPath,
      "# header\nprojects/*/*-some-other-*.md\n",
    );
    freshPrivacyMap();
    freshGitattrs();
    fs.chmodSync(allowlistPath, 0o444);

    const r = run();
    expect(r.status).toBe(0);
    // Marker must NOT be written when a required repair failed.
    expect(fs.existsSync(donePath)).toBe(false);
  });
});
