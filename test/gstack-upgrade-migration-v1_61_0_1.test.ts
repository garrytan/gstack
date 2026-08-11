import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const MIGRATION = path.join(ROOT, "gstack-upgrade", "migrations", "v1.61.0.1.sh");
const PATTERNS = [
  "projects/*/*-design-*.md",
  "projects/*/*-test-plan-*.md",
  "projects/*/*-eng-review-test-plan-*.md",
];

let home: string;
let gstackHome: string;
let noJqPath: string;
let jqPath: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function findUtility(name: string): string {
  for (const dir of process.platform === "win32"
    ? ["C:\\Program Files\\Git\\bin", "C:\\Program Files\\Git\\usr\\bin"]
    : ["/usr/bin", "/bin"]) {
    for (const filename of process.platform === "win32" ? [name, `${name}.exe`] : [name]) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`missing test utility: ${name}`);
}

function makeNoJqPath(): string {
  if (process.platform === "win32") {
    return "C:\\Program Files\\Git\\bin;C:\\Program Files\\Git\\usr\\bin";
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-no-jq-path-"));
  for (const utility of ["mkdir", "grep", "sed", "mktemp", "mv", "rm", "touch", "sort", "head", "basename", "find"]) {
    fs.symlinkSync(findUtility(utility), path.join(dir, utility));
  }
  return dir;
}

function bashPath(value: string): string {
  if (process.platform !== "win32") return value;
  return value.split(";").map((part) => part
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`))
    .join(":");
}

function makeJqShim(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-jq-shim-"));
  const shim = path.join(dir, "jq");
  const implementation = path.join(dir, "jq.js");
  write(
    implementation,
    String.raw`const fs = require("fs");
const args = process.argv.slice(2);
const source = args[args.length - 1];
const input = JSON.parse(fs.readFileSync(source, "utf8"));
const argIndex = args.indexOf("--arg");
const pattern = argIndex >= 0 ? args[argIndex + 2] : "";
if (args.some((arg) => arg.includes("type =="))) process.exit(Array.isArray(input) ? 0 : 1);
if (args.some((arg) => arg.includes("map(select"))) process.exit(input.some((entry) => entry.pattern === pattern) ? 0 : 1);
if (args.some((arg) => arg.includes(". +="))) {
  if (process.env.JQ_TEST_MODE === "mutation-fail") process.exit(1);
  process.stdout.write(JSON.stringify([...input, { pattern, class: "artifact" }]) + "\n");
  process.exit(0);
}
process.exit(1);
`,
  );
  write(
    shim,
    `#!/usr/bin/env bash\nexec \"$JQ_TEST_RUNTIME\" \"$(dirname \"$0\")/jq.js\" \"$@\"\n`,
  );
  fs.chmodSync(shim, 0o755);
  return dir;
}

function run(options: { jq: "missing" | "present"; bashEnv?: string } ) {
  const basePath = options.jq === "present" ? `${bashPath(jqPath)}:${bashPath(noJqPath)}` : bashPath(noJqPath);
  return Bun.spawnSync({
    cmd: [findUtility("bash"), MIGRATION],
    env: {
      ...process.env,
      HOME: home,
      PATH: basePath,
      JQ_TEST_RUNTIME: bashPath(process.execPath),
      JQ_TEST_MODE: process.env.JQ_TEST_MODE ?? "",
      BASH_ENV: options.bashEnv ? bashPath(options.bashEnv) : "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function privacyMap() {
  return path.join(gstackHome, ".brain-privacy-map.json");
}

function doneMarker() {
  return path.join(gstackHome, ".migrations", "v1.61.0.1.done");
}

function allowlist() {
  return path.join(gstackHome, ".brain-allowlist");
}

function gitattrs() {
  return path.join(gstackHome, ".gitattributes");
}

function expectTextRepairs(): void {
  const allowlistContent = fs.readFileSync(allowlist(), "utf8");
  const gitattrsContent = fs.readFileSync(gitattrs(), "utf8");
  for (const pattern of PATTERNS) {
    expect(allowlistContent).toContain(pattern);
    expect(gitattrsContent).toContain(`${pattern} merge=union`);
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-mig-v1610-"));
  gstackHome = path.join(home, ".gstack");
  fs.mkdirSync(gstackHome, { recursive: true });
  noJqPath = makeNoJqPath();
  jqPath = makeJqShim();
});

afterEach(() => {
  for (const dir of [home, noJqPath, jqPath]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("v1.61.0.1 migration", () => {
  test("repairs a v1.38-completed privacy map after jq becomes available", () => {
    write(path.join(gstackHome, ".migrations", "v1.38.1.0.done"), "");
    write(allowlist(), "# ---- USER ADDITIONS BELOW\nprojects/*/custom.txt\n");
    write(gitattrs(), "*.jsonl merge=jsonl-append\n");
    write(
      privacyMap(),
      JSON.stringify([{ pattern: "projects/*/learnings.jsonl", class: "artifact" }], null, 2),
    );

    const before = fs.readFileSync(privacyMap(), "utf8");
    const withoutJq = run({ jq: "missing" });
    expect(withoutJq.exitCode).toBe(0);
    expect(fs.readFileSync(privacyMap(), "utf8")).toBe(before);
    expect(fs.existsSync(doneMarker())).toBe(false);
    expectTextRepairs();

    const withJq = run({ jq: "present" });
    expect(withJq.exitCode).toBe(0);
    const entries = JSON.parse(fs.readFileSync(privacyMap(), "utf8"));
    for (const pattern of PATTERNS) {
      expect(entries).toContainEqual({ pattern, class: "artifact" });
    }
    expect(fs.existsSync(doneMarker())).toBe(true);
  });

  test("does not mark malformed privacy metadata complete", () => {
    write(privacyMap(), "{ this is not JSON");

    const result = run({ jq: "present" });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(privacyMap(), "utf8")).toBe("{ this is not JSON");
    expect(fs.existsSync(doneMarker())).toBe(false);
  });

  test("does not mark a failed atomic privacy rewrite complete", () => {
    write(privacyMap(), JSON.stringify([]));
    process.env.JQ_TEST_MODE = "mutation-fail";
    try {
      const result = run({ jq: "present" });
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(privacyMap(), "utf8")).toBe("[]");
      expect(fs.existsSync(doneMarker())).toBe(false);
      expect(fs.readdirSync(gstackHome).filter((entry) => entry.startsWith(".brain-privacy-map.json.tmp.")).length).toBe(0);
    } finally {
      delete process.env.JQ_TEST_MODE;
    }
  });

  test("does not treat commented or substring-only text rules as active repairs", () => {
    write(allowlist(), [
      `# ${PATTERNS[0]}`,
      `archive/${PATTERNS[1]}`,
      `prefix-${PATTERNS[2]}`,
    ].join("\n") + "\n");
    write(gitattrs(), [
      `# ${PATTERNS[0]} merge=union`,
      `archive/${PATTERNS[1]} merge=union`,
      `prefix-${PATTERNS[2]} merge=union`,
    ].join("\n") + "\n");
    write(privacyMap(), "[]");

    const result = run({ jq: "missing" });

    expect(result.exitCode).toBe(0);
    for (const pattern of PATTERNS) {
      expect(fs.readFileSync(allowlist(), "utf8")).toMatch(new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      expect(fs.readFileSync(gitattrs(), "utf8")).toMatch(new RegExp(`^${(pattern + " merge=union").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
    expect(fs.existsSync(doneMarker())).toBe(false);
  });

  test("recognizes an exact active text rule without duplicating it", () => {
    write(allowlist(), PATTERNS.join("\n") + "\n");
    write(gitattrs(), PATTERNS.map((pattern) => `${pattern} merge=union`).join("\n") + "\n");

    const result = run({ jq: "missing" });

    expect(result.exitCode).toBe(0);
    for (const pattern of PATTERNS) {
      expect(fs.readFileSync(allowlist(), "utf8").split("\n").filter((line) => line === pattern)).toHaveLength(1);
      expect(fs.readFileSync(gitattrs(), "utf8").split("\n").filter((line) => line === `${pattern} merge=union`)).toHaveLength(1);
    }
  });

  test("keeps original privacy bytes and retry state when the atomic rename fails", () => {
    const failingEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-failing-mv-"));
    const failingEnv = path.join(failingEnvDir, "bash-env");
    write(failingEnv, "mv() { return 1; }\n");
    const original = "[\n]\n";
    write(privacyMap(), original);
    try {
      const fixturePreflight = Bun.spawnSync({
        cmd: [findUtility("bash"), "-c", "type -t mv"],
        env: { ...process.env, BASH_ENV: bashPath(failingEnv) },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(fixturePreflight.exitCode).toBe(0);
      expect(new TextDecoder().decode(fixturePreflight.stdout).trim()).toBe("function");
      const result = run({ jq: "present", bashEnv: failingEnv });
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(privacyMap(), "utf8")).toBe(original);
      expect(fs.existsSync(doneMarker())).toBe(false);
      expect(fs.readdirSync(gstackHome).filter((entry) => entry.startsWith(".brain-privacy-map.json.tmp.")).length).toBe(0);
    } finally {
      fs.rmSync(failingEnvDir, { recursive: true, force: true });
    }
  });

  test("preserves an operator-selected privacy class for an existing pattern", () => {
    write(privacyMap(), JSON.stringify([
      { pattern: PATTERNS[0], class: "behavioral" },
    ]));

    const result = run({ jq: "present" });

    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(fs.readFileSync(privacyMap(), "utf8"));
    expect(entries).toContainEqual({ pattern: PATTERNS[0], class: "behavioral" });
    expect(entries.filter((entry: { pattern: string }) => entry.pattern === PATTERNS[0])).toHaveLength(1);
    expect(fs.existsSync(doneMarker())).toBe(true);
  });

  test("marks missing artifact state as safely not applicable", () => {
    const result = run({ jq: "missing" });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(privacyMap())).toBe(false);
    expect(fs.existsSync(doneMarker())).toBe(true);
  });

  test("does not rewrite already-complete metadata on a second run", () => {
    write(privacyMap(), JSON.stringify(PATTERNS.map((pattern) => ({ pattern, class: "artifact" })), null, 2));

    const first = run({ jq: "present" });
    expect(first.exitCode).toBe(0);
    const before = fs.readFileSync(privacyMap(), "utf8");

    const second = run({ jq: "present" });
    expect(second.exitCode).toBe(0);
    expect(fs.readFileSync(privacyMap(), "utf8")).toBe(before);
    expect(fs.existsSync(doneMarker())).toBe(true);
  });
});
