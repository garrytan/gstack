/**
 * GST-3297: a key=value secret that follows a path separator is still a
 * secret. env.kv anchored its name at the line start (or after a diff marker
 * or comment marker), so `../password=<v>`, `path/api_key=<v>` and
 * `a/token=<v>` came back raw from the shared redactor. /cso's history.txt is
 * `git log -p` text redacted by it, so a tracked symlink target, a link that
 * exists only in history, and ordinary file content all leaked through
 * `gstack-cso history`. The name may now also start right after a `/`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redact } from "../lib/cso/process";
import { redactFindingSpans, scan } from "../lib/redact-engine";

const j = (...p: string[]) => p.join("");
const VALUE = j("Xk9", "qPz7Lm2Rt8Vw4Ny6");
const PASSWORD = j("pass", "word");
const API_KEY = j("api", "_key");
const TOKEN = j("to", "ken");
const kv = (key: string, value = VALUE) => `${key}=${value}`;

const envKv = (text: string) => scan(text).findings.filter((f) => f.id === "env.kv");

describe("env.kv after a path separator (GST-3297)", () => {
  const leaks: [string, string][] = [
    ["link target, parent dir", `../${kv(PASSWORD)}`],
    ["link target, nested", `cfg/a/../../${kv(TOKEN)}`],
    ["link target, absolute", `/etc/app/${kv(API_KEY)}`],
    ["link line in a manifest", `cfg/up -> ../${kv(PASSWORD)}`],
    ["file content, path prefix", `path/${kv(API_KEY)}`],
    ["file content, short prefix", `a/${kv(TOKEN)}`],
    ["file content, colon form", `settings/${API_KEY}: ${VALUE}`],
    ["file content, double quotes", `target: "../${kv(PASSWORD)}"`],
    ["file content, single quotes", `ln -s 'a/${kv(TOKEN)}' cfg/up`],
    ["file content, mid-line", `url = https://example.test/cb/${kv(TOKEN)}`],
    ["hunk, added line", `+../${kv(PASSWORD)}`],
    ["hunk, removed line", `-../${kv(PASSWORD)}`],
    ["hunk, combined diff", `+-a/${kv(TOKEN)}`],
    ["hunk, context line", ` path/${kv(API_KEY)}`],
    ["hunk, diff header path", `diff --git a/${kv(TOKEN)} b/${kv(TOKEN)}`],
    ["hunk, dashed name", `+a/x-${kv(PASSWORD)}`],
    ["comment with a path", `# rotate cfg/${kv(TOKEN)}`],
    ["call argument, absolute path", `open("/${kv(TOKEN)}")`],
    ["bracketed path, no closing slash", `(/${kv(TOKEN)})`],
    ["doubled slash in a path", `+..//${kv(PASSWORD)}`],
    ["quoted comment marker with a secret run", `x = "//${kv(TOKEN)}"`],
    ["YAML value with a later slash", `link: /${kv(API_KEY)}/rest`],
    ["assignment value with a later slash", `cfg=/db_${kv(PASSWORD)}/x`],
    ["Markdown link with a later slash", `[cb](/${kv(API_KEY)}/rest)`],
    ["single-slash URL with a later slash", `file:/${kv(TOKEN)}/x`],
  ];

  for (const [name, text] of leaks) {
    test(`redacts: ${name}`, () => {
      expect(envKv(text).length).toBeGreaterThan(0);
      const out = redact(text);
      expect(out).not.toContain(VALUE);
      expect(out).toContain("<REDACTED-env.kv>");
    });
  }

  test("a git log -p hunk keeps its shape and loses only the values", () => {
    const hunk = [
      "commit 0123456789abcdef0123456789abcdef01234567",
      "Subject: links",
      "diff --git a/cfg/up b/cfg/up",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/cfg/up",
      "@@ -0,0 +1 @@",
      `+../${kv(PASSWORD)}`,
      "\\ No newline at end of file",
      "diff --git a/app.env b/app.env",
      "--- a/app.env",
      "+++ b/app.env",
      "@@ -1,2 +1,2 @@",
      `-path/${kv(API_KEY)}`,
      `+path/${API_KEY}=\${API_KEY}`,
      ` a/${kv(TOKEN)}`,
      "",
    ].join("\n");
    const out = redactFindingSpans(hunk) ?? "";
    expect(out).not.toContain(VALUE);
    expect(out.split("\n")).toHaveLength(hunk.split("\n").length);
    expect(out).toContain("+../password=<REDACTED-env.kv>");
    expect(out).toContain("-path/api_key=<REDACTED-env.kv>");
    expect(out).toContain(" a/token=<REDACTED-env.kv>");
    expect(out).toContain("+path/api_key=${API_KEY}");
    expect(out).toContain("diff --git a/cfg/up b/cfg/up");
  });

  const clean = [
    "src/auth/token.ts",
    "lib/password-reset/index.ts",
    "docs/api_key.md",
    "routes/token/:id",
    "test/fixtures/session-cookie.json",
    "import { getToken } from '../auth/token';",
    "const token = await getToken(req);",
    "if (!password) throw new Error('password required');",
    "fetch('/oauth/token?grant_type=refresh_token')",
    "app.post('/api/session', login);",
    "see docs/auth/token for how rotation works",
    `cfg/${PASSWORD}=changeme`,
    `docs/${TOKEN}=<your-token-here>`,
    `url/${TOKEN}=\${TOKEN}`,
    `deploy/${API_KEY}=\$API_KEY`,
    `a/cacheKey=${VALUE}`,
    `a/sortKey=${VALUE}`,
    `+src/${TOKEN}=getToken(request)`,
    `// see a/${TOKEN}: rotated weekly by the ops team`,
    "const match = content.match(/authtoken:\\s*(.+)/);",
    "const re = /token=([A-Za-z0-9]+)/g;",
    `["//     signal_key: 'test-discipline',", "hooks/preference.ts"],`,
    "if (!/api_key=[A-Za-z0-9]{20,}/.test(line)) return;",
    "return /token=([A-Za-z0-9]{8,})/;",
  ];

  for (const text of clean) {
    test(`negative control stays unredacted: ${text}`, () => {
      expect(envKv(text)).toEqual([]);
      expect(redact(text)).toBe(text);
    });
  }
});

const ROOT = path.resolve(import.meta.dir, "..");
const launcher = path.join(ROOT, "bin", "gstack-cso-launcher");
const MIB = 1024 * 1024;

describe.skipIf(process.platform === "win32")("/cso history never prints a key=value secret after a slash (GST-3297)", () => {
  let root = "";
  let state = "";
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cso-kv-slash-")));
    state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cso-kv-slash-state-")));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });

  const git = (repo: string, ...args: string[]) => {
    const result = spawnSync("/usr/bin/git", ["-C", repo, ...args], { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin" }, timeout: 60_000 });
    if (result.status) throw new Error(result.stderr);
    return result.stdout;
  };
  const cso = (repo: string, args: string[]) =>
    spawnSync(launcher, args, { cwd: repo, encoding: "utf8", env: { HOME: root, GSTACK_HOME: state, PATH: "/usr/bin:/bin" }, timeout: 120_000, maxBuffer: 64 * MIB });

  test("link target, history-only link and file content are all redacted in history.txt and the history command", () => {
    const repo = path.join(root, "repo"),
      secrets = [j(VALUE, "1"), j(VALUE, "2"), j(VALUE, "3")];
    fs.mkdirSync(path.join(repo, "cfg"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "fixture@example.test");
    git(repo, "config", "user.name", "Fixture");
    fs.writeFileSync(path.join(repo, "README.md"), "readme\n");
    fs.symlinkSync(`../${kv(PASSWORD, secrets[0])}`, path.join(repo, "cfg", "up"));
    fs.symlinkSync(`a/${kv(TOKEN, secrets[1])}`, path.join(repo, "cfg", "gone"));
    fs.writeFileSync(path.join(repo, "cfg", "notes.txt"), `see path/${kv(API_KEY, secrets[2])}\nsrc/auth/token.ts\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "links");
    fs.unlinkSync(path.join(repo, "cfg", "gone"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "drop link");

    const started = cso(repo, ["start", "--repo", repo, "--scope", "auth", "--offline"]);
    expect(started.stderr).toBe("");
    expect(started.status).toBe(0);
    const run = JSON.parse(started.stdout),
      dir = path.join(state, "security", "cso", run.repoId, run.runId),
      history = fs.readFileSync(path.join(dir, "history.txt"), "utf8"),
      printed = cso(repo, ["history", run.runId]);
    expect(printed.status).toBe(0);
    for (const text of [history, printed.stdout]) {
      expect(text).toContain("Subject: drop link");
      expect(text).toContain("src/auth/token.ts");
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });
});
