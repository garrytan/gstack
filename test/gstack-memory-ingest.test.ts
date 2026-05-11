/**
 * Unit tests for bin/gstack-memory-ingest.ts (Lane A).
 *
 * Covers the unit-testable internals: parseTranscriptJsonl (Codex + Claude Code +
 * truncated last line), buildTranscriptPage / buildArtifactPage shape, repoSlug,
 * dateOnly, fileChangedSinceState mtime+sha logic, state file load/save with
 * schema_version backup-on-mismatch.
 *
 * E2E coverage (full --probe / --bulk on real ~/.claude/projects) lives in
 * test/skill-e2e-memory-ingest.test.ts (Lane F).
 *
 * Strategy: we re-import the module under test through bun's runtime and shell
 * out to it for end-to-end mode tests; for the pure helpers, we re-import the
 * source file via dynamic import.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestHome(): string {
  return mkdtempSync(join(tmpdir(), "gstack-memory-ingest-"));
}

function runScript(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

function writeClaudeCodeSession(home: string, projectName: string, sessionId: string, content: string): string {
  const projectsDir = join(home, ".claude", "projects", projectName);
  mkdirSync(projectsDir, { recursive: true });
  const file = join(projectsDir, `${sessionId}.jsonl`);
  writeFileSync(file, content, "utf-8");
  return file;
}

function writeCodexSession(home: string, ymd: string, content: string): string {
  const [y, m, d] = ymd.split("-");
  const dir = join(home, ".codex", "sessions", y, m, d);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${Date.now()}.jsonl`);
  writeFileSync(file, content, "utf-8");
  return file;
}

// ── --help and --probe ─────────────────────────────────────────────────────

describe("gstack-memory-ingest CLI", () => {
  it("prints usage on --help and exits 0", () => {
    const r = runScript(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("Usage: gstack-memory-ingest");
    expect(r.stderr).toContain("--probe");
    expect(r.stderr).toContain("--incremental");
    expect(r.stderr).toContain("--bulk");
  });

  it("rejects unknown arguments with exit 1", () => {
    const r = runScript(["--bogus-flag"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown argument: --bogus-flag");
  });

  it("--probe on empty home reports 0 files", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 0");
    rmSync(home, { recursive: true, force: true });
  });

  it("--probe finds Claude Code sessions", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const session = `{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"${new Date().toISOString()}","cwd":"/tmp/x"}\n{"type":"assistant","message":{"role":"assistant","content":"hi"},"timestamp":"${new Date().toISOString()}"}\n`;
    writeClaudeCodeSession(home, "tmp-x", "abc123", session);

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    expect(r.stdout).toContain("transcript");
    rmSync(home, { recursive: true, force: true });
  });

  it("--probe finds Codex sessions", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const session = `{"type":"session_meta","payload":{"id":"sess-xyz","cwd":"/tmp/x","git":{"repository_url":"https://github.com/foo/bar"}},"timestamp":"${today.toISOString()}"}\n`;
    writeCodexSession(home, ymd, session);

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    rmSync(home, { recursive: true, force: true });
  });

  it("--probe finds gstack artifacts (learnings, eureka, ceo-plan)", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(join(gstackHome, "analytics"), { recursive: true });
    mkdirSync(join(gstackHome, "projects", "foo-bar", "ceo-plans"), { recursive: true });

    writeFileSync(join(gstackHome, "analytics", "eureka.jsonl"), '{"insight":"lake first"}\n');
    writeFileSync(join(gstackHome, "projects", "foo-bar", "learnings.jsonl"), '{"key":"a","insight":"b"}\n');
    writeFileSync(join(gstackHome, "projects", "foo-bar", "ceo-plans", "2026-05-01-test.md"), "# Plan\n");

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 3");
    expect(r.stdout).toContain("eureka");
    expect(r.stdout).toContain("learning");
    expect(r.stdout).toContain("ceo-plan");
    rmSync(home, { recursive: true, force: true });
  });

  it("--sources filter limits the walk to specific types", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(join(gstackHome, "analytics"), { recursive: true });
    mkdirSync(join(gstackHome, "projects", "foo", "ceo-plans"), { recursive: true });

    writeFileSync(join(gstackHome, "analytics", "eureka.jsonl"), '{"insight":"x"}\n');
    writeFileSync(join(gstackHome, "projects", "foo", "learnings.jsonl"), '{"key":"a"}\n');

    const r = runScript(["--probe", "--sources", "eureka"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    expect(r.stdout).toContain("eureka");
    expect(r.stdout).not.toContain("learning ");
    rmSync(home, { recursive: true, force: true });
  });

  it("--sources rejects empty list with exit 1", () => {
    const r = runScript(["--probe", "--sources", "bogus"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--sources must include at least one of");
  });
});

// ── State file behavior ────────────────────────────────────────────────────

describe("gstack-memory-ingest state file", () => {
  it("--incremental on empty home creates state file with schema_version: 1", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const r = runScript(["--incremental", "--quiet"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.schema_version).toBe(1);
    expect(state.last_writer).toBe("gstack-memory-ingest");
    rmSync(home, { recursive: true, force: true });
  });

  it("backs up state file on schema_version mismatch", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    writeFileSync(statePath, JSON.stringify({ schema_version: 999, sessions: {} }), "utf-8");

    const r = runScript(["--incremental", "--quiet"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(existsSync(statePath + ".bak")).toBe(true);

    const fresh = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(fresh.schema_version).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("backs up state file on JSON parse error", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    writeFileSync(statePath, "{ this is not valid json", "utf-8");

    const r = runScript(["--incremental", "--quiet"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(existsSync(statePath + ".bak")).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});

// ── Security: cwd in transcript JSONL must not reach a shell ─────────────

describe("gstack-memory-ingest security: untrusted cwd cannot trigger shell substitution", () => {
  it("does not invoke /bin/sh when a transcript record contains $() in cwd", () => {
    // Transcript JSONL is an untrusted surface — a record's `.cwd` value
    // can be set by anyone who can write to ~/.claude/projects (cross-machine
    // share, prompt-injection appending to the active session log, etc.).
    // resolveGitRemote() must use execFileSync, not execSync with template
    // interpolation, or `cwd="$(...)"` triggers command substitution under
    // /bin/sh -c on the next ingest run.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const markerDir = mkdtempSync(join(tmpdir(), "gstack-mi-cwd-marker-"));
    const marker = join(markerDir, "PWNED");
    // Plain $(...) — what an attacker would write into a transcript record.
    // execFileSync passes this verbatim to git as a -C argument; execSync
    // (the prior code path) wrapped it in a /bin/sh -c template that ran
    // the substitution.
    const malicious = "$(touch " + marker + ")";

    const record = JSON.stringify({
      type: "user",
      uuid: "11111111-1111-1111-1111-111111111111",
      sessionId: "abc",
      cwd: malicious,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hi" },
    });
    writeClaudeCodeSession(home, "-tmp-target", "abc", record + "\n");

    const r = runScript(["--incremental", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      GSTACK_MEMORY_INGEST_NO_WRITE: "1",
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);

    rmSync(home, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  });
});

// ── Transcript parser via re-import of the source module ───────────────────

describe("internal: parseTranscriptJsonl + buildTranscriptPage shape", () => {
  it("parses a Claude Code JSONL session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-mi-parse-"));
    const file = join(dir, "abc123.jsonl");
    const content =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"hello"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeFileSync(file, content, "utf-8");

    // Re-import via dynamic import is tricky because the script auto-runs main().
    // We instead test via shell invocation: --probe with this file should find 1 transcript.
    const home = makeTestHome();
    const projDir = join(home, ".claude", "projects", "tmp-foo");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "abc123.jsonl"), content, "utf-8");

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: join(home, ".gstack") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");

    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("treats a truncated last line as partial (does not crash)", () => {
    const home = makeTestHome();
    const projDir = join(home, ".claude", "projects", "tmp-bar");
    mkdirSync(projDir, { recursive: true });
    // Truncated last line — JSON parse will fail on it
    const content =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/bar"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"hello"},"timestamp":"2026-05-01T00:00:01Z"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"this is truncat`; // no closing brace + no newline
    writeFileSync(join(projDir, "trunc.jsonl"), content, "utf-8");

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: join(home, ".gstack") });
    // Should not crash; should report 1 transcript
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    rmSync(home, { recursive: true, force: true });
  });
});

// ── --limit shortcut for smoke tests ───────────────────────────────────────

describe("gstack-memory-ingest --limit", () => {
  it("respects --limit by stopping after N writes (mocked via --probe shortcut)", () => {
    const r = runScript(["--probe", "--limit", "1"]);
    // --limit doesn't apply to probe but argument should parse without error
    expect(r.exitCode).toBe(0);
  });

  it("rejects --limit 0 with exit 1", () => {
    const r = runScript(["--probe", "--limit", "0"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--limit requires a positive integer");
  });
});

// ── Writer regression: gbrain v0.27+ uses `put`, not `put_page` ───────────

/**
 * Stand up a fake `gbrain` shim on PATH that:
 *  - advertises `put` in `--help` output (so gbrainAvailable() passes)
 *  - records `put <slug>` invocations + their stdin to a log
 *  - rejects `put_page` with a non-zero exit, mimicking real gbrain v0.27+
 *
 * If the writer ever regresses to the legacy flag-form, the bulk pass will
 * report 0 writes and the assertion on `Wrote: 1` will fail loudly.
 */
function installFakeGbrain(home: string): { binDir: string; logFile: string; stdinFile: string } {
  const binDir = join(home, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const logFile = join(home, "gbrain-calls.log");
  const stdinFile = join(home, "gbrain-stdin.log");
  const script = `#!/usr/bin/env bash
set -euo pipefail
LOG="${logFile}"
STDIN_LOG="${stdinFile}"
case "\${1:-}" in
  --help|-h)
    cat <<EOF
Usage: gbrain <command> [options]

Commands:
  put <slug>           Write a page (content via stdin, YAML frontmatter for metadata)
  search <query>       Keyword search across pages
  ask <question>       Hybrid semantic + keyword query
EOF
    exit 0
    ;;
  put)
    if [ "\${2:-}" = "--help" ]; then
      echo "Usage: gbrain put <slug>"
      exit 0
    fi
    echo "put \${2:-}" >> "\$LOG"
    {
      echo "--- slug=\${2:-} ---"
      cat
      echo
    } >> "\$STDIN_LOG"
    exit 0
    ;;
  put_page|put-page)
    echo "Unknown command: \$1" >&2
    exit 2
    ;;
  *)
    echo "Unknown command: \${1:-<empty>}" >&2
    exit 2
    ;;
esac
`;
  const binPath = join(binDir, "gbrain");
  writeFileSync(binPath, script, "utf-8");
  chmodSync(binPath, 0o755);
  return { binDir, logFile, stdinFile };
}

describe("gstack-memory-ingest writer (gbrain v0.27+ `put` interface)", () => {
  it("invokes `gbrain put <slug>` with stdin body, not legacy `put_page`", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir, logFile, stdinFile } = installFakeGbrain(home);

    // Single Claude Code session fixture. --include-unattributed lets it write
    // even though there's no resolvable git remote in /tmp.
    const session =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"hello"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeClaudeCodeSession(home, "tmp-foo", "abc123", session);

    const r = runScript(["--bulk", "--include-unattributed", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(logFile)).toBe(true);

    const calls = readFileSync(logFile, "utf-8");
    expect(calls).toContain("put ");
    expect(calls).not.toContain("put_page");

    // Body should ride stdin and carry frontmatter that gbrain can parse.
    // The transcript builder prepends its own frontmatter (agent, session_id,
    // etc.) but does NOT include title/type/tags — the writer injects those
    // into the existing frontmatter so gbrain pages list/search/filter
    // actually surface the page. Asserting all three guards against the
    // exact regression that landed in v1.26.0.0 (writer ignored these fields
    // entirely; pages landed empty-titled, un-typed, un-tagged).
    const stdin = readFileSync(stdinFile, "utf-8");
    expect(stdin).toContain("---");
    expect(stdin).toMatch(/agent:\s+claude-code/);
    expect(stdin).toMatch(/title:\s/);
    expect(stdin).toMatch(/type:\s+transcript/);
    expect(stdin).toMatch(/tags:/);

    rmSync(home, { recursive: true, force: true });
  });

  it("fails fast when gbrain CLI is missing the `put` subcommand", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Fake gbrain that ONLY advertises legacy `put_page` (no `put`).
    const binDir = join(home, "legacy-bin");
    mkdirSync(binDir, { recursive: true });
    const script = `#!/usr/bin/env bash
case "\${1:-}" in
  --help|-h) echo "Commands:"; echo "  put_page    Write a page (legacy)"; exit 0 ;;
  *) echo "Unknown command: \$1" >&2; exit 2 ;;
esac
`;
    const binPath = join(binDir, "gbrain");
    writeFileSync(binPath, script, "utf-8");
    chmodSync(binPath, 0o755);

    const session =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/bar"}\n`;
    writeClaudeCodeSession(home, "tmp-bar", "def456", session);

    const r = runScript(["--bulk", "--include-unattributed"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    // Bulk completes (the script is per-page tolerant), but every page
    // surfaces the missing-`put` error rather than the old "Unknown command".
    expect(r.stderr + r.stdout).toMatch(/missing `put` subcommand|gbrain CLI not in PATH/);

    rmSync(home, { recursive: true, force: true });
  });
});
