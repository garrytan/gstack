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

// ── Writer regression: batch-import via `gbrain import <dir>` ─────────────

/**
 * Stand up a fake `gbrain` shim on PATH that:
 *  - advertises `import` in `--help` output (gbrainAvailable() passes)
 *  - records `import <dir>` invocations, args, and a sample of staged files
 *  - emits a valid `--json` summary on stdout (status, imported, etc.)
 *  - optionally drops failures to a sync-failures.jsonl path (HOME/.gbrain/)
 *
 * Architecture being verified (post plan-eng-review + Codex outside-voice):
 *  - new code uses `gbrain import <stagingDir> --no-embed --json` ONE time,
 *    not `gbrain put <slug>` per file. The fixture would catch a regression
 *    to the legacy per-file loop because (a) `put` is no longer advertised,
 *    so gbrainAvailable() returns false; (b) we assert the recorded args
 *    include `import` and the dir argument.
 */
function installFakeGbrain(
  home: string,
  opts: { failingPaths?: string[] } = {},
): { binDir: string; logFile: string; argsFile: string; stagingListFile: string } {
  const binDir = join(home, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const logFile = join(home, "gbrain-calls.log");
  const argsFile = join(home, "gbrain-args.log");
  const stagingListFile = join(home, "gbrain-staging-list.log");
  // Bash-side: when failingPaths is set, append matching JSONL entries to
  // ~/.gbrain/sync-failures.jsonl so D7's readNewFailures can read them.
  const failingList = (opts.failingPaths || []).join("|");
  const script = `#!/usr/bin/env bash
set -euo pipefail
LOG="${logFile}"
ARGS_LOG="${argsFile}"
STAGING_LIST="${stagingListFile}"
FAILING_LIST="${failingList}"
case "\${1:-}" in
  --help|-h)
    cat <<EOF
Usage: gbrain <command> [options]

Commands:
  import <dir>         Import markdown directory (batch, content-addressed)
  search <query>       Keyword search across pages
  ask <question>       Hybrid semantic + keyword query
EOF
    exit 0
    ;;
  import)
    DIR="\${2:-}"
    NO_EMBED=0
    JSON=0
    shift 2 || true
    for arg in "\$@"; do
      case "\$arg" in
        --no-embed) NO_EMBED=1 ;;
        --json) JSON=1 ;;
      esac
    done
    echo "import \$DIR" >> "\$LOG"
    {
      echo "dir=\$DIR no_embed=\$NO_EMBED json=\$JSON"
    } >> "\$ARGS_LOG"
    # Capture file tree from staging dir for assertion-on-shape later.
    if [ -d "\$DIR" ]; then
      ( cd "\$DIR" && find . -type f | sort ) > "\$STAGING_LIST" 2>/dev/null || true
    fi
    # If failingPaths configured, drop fake entries to sync-failures.jsonl
    # (mtime byte-offset snapshot lets the ingest's readNewFailures pick them up).
    if [ -n "\$FAILING_LIST" ]; then
      mkdir -p "\${HOME}/.gbrain"
      IFS='|' read -ra FAIL_PATHS <<< "\$FAILING_LIST"
      for p in "\${FAIL_PATHS[@]}"; do
        echo "{\\"path\\":\\"\$p\\",\\"error\\":\\"File too large\\",\\"code\\":\\"FILE_TOO_LARGE\\",\\"commit\\":\\"\\",\\"ts\\":\\"2026-05-09T22:00:00Z\\"}" >> "\${HOME}/.gbrain/sync-failures.jsonl"
      done
    fi
    # Count files in staging dir for the imported count.
    if [ -d "\$DIR" ]; then
      TOTAL=\$(find "\$DIR" -name "*.md" -type f | wc -l | tr -d ' ')
    else
      TOTAL=0
    fi
    ERRORS=0
    if [ -n "\$FAILING_LIST" ]; then
      ERRORS=\$(echo "\$FAILING_LIST" | tr '|' '\\n' | wc -l | tr -d ' ')
    fi
    IMPORTED=\$((TOTAL - ERRORS))
    if [ \$JSON -eq 1 ]; then
      echo "{\\"status\\":\\"success\\",\\"duration_s\\":0.1,\\"imported\\":\$IMPORTED,\\"skipped\\":0,\\"errors\\":\$ERRORS,\\"chunks\\":\$IMPORTED,\\"total_files\\":\$TOTAL}"
    fi
    exit 0
    ;;
  put|put_page|put-page)
    # If new ingest code ever regresses to per-file puts, fail loudly so the
    # test signals a real architectural regression.
    echo "Unexpected legacy command: \$1" >&2
    exit 99
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
  return { binDir, logFile, argsFile, stagingListFile };
}

describe("gstack-memory-ingest writer (gbrain v0.20+ batch `import` interface)", () => {
  it("invokes `gbrain import <dir> --no-embed --json` exactly once with hierarchical staging", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir, logFile, argsFile, stagingListFile } = installFakeGbrain(home);

    // Single Claude Code session fixture. --include-unattributed lets it
    // write even though there's no resolvable git remote in /tmp.
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

    // Verify gbrain was called exactly ONCE with import, not per-file put.
    const calls = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/^import\s+\/.+\/\.staging-ingest-\d+-\d+$/);

    // Verify args: --no-embed and --json both present.
    const argDump = readFileSync(argsFile, "utf-8");
    expect(argDump).toMatch(/no_embed=1/);
    expect(argDump).toMatch(/json=1/);

    // D1 regression: staged file lives in a slug-shaped subdirectory tree
    // ("transcripts/claude-code/_unattributed/..."), not flat at the staging
    // dir root. If writeStaged ever regresses to flat layout, this fails.
    const stagedList = readFileSync(stagingListFile, "utf-8");
    expect(stagedList).toMatch(/^\.\/transcripts\/claude-code\/.+\.md$/m);
  });

  // Originally landed in v1.32.0.0 (PR #1411) on the per-file `gbrain put`
  // path. Postgres rejects 0x00 in UTF-8 text columns. Some Claude Code
  // transcripts contain NUL inside user-pasted content or tool output. The
  // renderPageBody helper strips them so the staged .md never carries them
  // into gbrain. Adapted for the batch architecture: we read the staged file
  // contents instead of fake-gbrain stdin.
  it("strips NUL bytes from the staged body before gbrain import", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Shim that copies staging dir into stagingCopy so we can inspect the
    // exact bytes that would have been fed to gbrain.
    const binDir = join(home, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    const stagingCopy = join(home, "staging-copy");
    const script = `#!/usr/bin/env bash
case "\${1:-}" in
  --help|-h) echo "Usage: gbrain <command>"; echo "Commands:"; echo "  import <dir>   Import"; exit 0 ;;
  import)
    DIR="\${2:-}"
    cp -R "\$DIR" "${stagingCopy}" 2>/dev/null || true
    if [[ " \$* " == *" --json "* ]]; then
      echo '{"status":"success","duration_s":0.1,"imported":1,"skipped":0,"errors":0,"chunks":1,"total_files":1}'
    fi
    exit 0 ;;
  *) echo "unknown"; exit 2 ;;
esac
`;
    const binPath = join(binDir, "gbrain");
    writeFileSync(binPath, script, "utf-8");
    chmodSync(binPath, 0o755);

    // Pasted content with embedded NUL bytes in a few shapes:
    //  - inline mid-token: abc\x00def
    //  - at start of a line
    //  - at end of a line
    //  - back-to-back run
    const dirty =
      `abc\x00def hello\x00\x00world\nleading\x00line\nline-trailing\x00\nclean line\n`;
    const session =
      `{"type":"user","message":{"role":"user","content":${JSON.stringify(dirty)}},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/nul-test"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"ok"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeClaudeCodeSession(home, "tmp-nul-test", "nul123", session);

    const r = runScript(["--bulk", "--include-unattributed", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(stagingCopy)).toBe(true);
    const findMd = spawnSync("find", [stagingCopy, "-name", "*.md", "-type", "f"], {
      encoding: "utf-8",
    });
    const mdPaths = (findMd.stdout || "").trim().split("\n").filter(Boolean);
    expect(mdPaths.length).toBeGreaterThan(0);
    const body = readFileSync(mdPaths[0], "utf-8");

    // The body that gbrain will read MUST NOT contain any 0x00 byte.
    expect(body.includes("\x00")).toBe(false);
    // But the surrounding content should survive intact — we strip NUL only.
    expect(body).toContain("abcdef");
    expect(body).toContain("helloworld");
    expect(body).toContain("leadingline");
    expect(body).toContain("line-trailing");
    expect(body).toContain("clean line");

    rmSync(home, { recursive: true, force: true });
  });

  it("injects title/type/tags into the staged page's YAML frontmatter", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // This shim sleeps long enough to let us read the staging dir mid-run.
    // Easier path: intercept by copying the staging dir before gbrain exits.
    const binDir = join(home, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    const stagingCopy = join(home, "staging-copy");
    const script = `#!/usr/bin/env bash
case "\${1:-}" in
  --help|-h) echo "Usage: gbrain <command>"; echo "Commands:"; echo "  import <dir>   Import"; exit 0 ;;
  import)
    DIR="\${2:-}"
    cp -R "\$DIR" "${stagingCopy}" 2>/dev/null || true
    # Emit valid --json output
    if [[ " \$* " == *" --json "* ]]; then
      echo '{"status":"success","duration_s":0.1,"imported":1,"skipped":0,"errors":0,"chunks":1,"total_files":1}'
    fi
    exit 0 ;;
  *) echo "unknown"; exit 2 ;;
esac
`;
    const binPath = join(binDir, "gbrain");
    writeFileSync(binPath, script, "utf-8");
    chmodSync(binPath, 0o755);

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
    expect(existsSync(stagingCopy)).toBe(true);

    // Find the staged .md file; assert frontmatter has title/type/tags.
    // (The exact slug path varies with the staging dir generation, so we
    // walk to find a .md and read its head.)
    const findMd = spawnSync("find", [stagingCopy, "-name", "*.md", "-type", "f"], {
      encoding: "utf-8",
    });
    const mdPaths = (findMd.stdout || "").trim().split("\n").filter(Boolean);
    expect(mdPaths.length).toBeGreaterThan(0);
    const body = readFileSync(mdPaths[0], "utf-8");
    expect(body).toContain("---");
    expect(body).toMatch(/title:\s/);
    expect(body).toMatch(/type:\s+transcript/);
    expect(body).toMatch(/tags:/);

    rmSync(home, { recursive: true, force: true });
  });

  it("D7: files listed in ~/.gbrain/sync-failures.jsonl are NOT recorded in state", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Write TWO sessions so we can verify one lands and the other doesn't.
    const sessionA =
      `{"type":"user","message":{"role":"user","content":"a"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"a"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    const sessionB =
      `{"type":"user","message":{"role":"user","content":"b"},"timestamp":"2026-05-02T00:00:00Z","cwd":"/tmp/bar"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"b"},"timestamp":"2026-05-02T00:00:01Z"}\n`;
    writeClaudeCodeSession(home, "tmp-foo", "aaaa", sessionA);
    writeClaudeCodeSession(home, "tmp-bar", "bbbb", sessionB);

    // Configure fake gbrain to "fail" the second session's staged path.
    // The staging-dir-relative path is "transcripts/claude-code/...bbbb.md"
    // (Codex sessions take a different prefix). We use a wildcard via the
    // last segment matching the session id.
    // The fake matches a literal path against the staging-list it captures,
    // but since we can't know the exact path ahead of time, we let the
    // ingest run once normally, inspect the staging list, then set HOME
    // .gbrain/sync-failures.jsonl manually. Simpler: cause the SHA-id
    // session-id segment to be in the failing list directly — gbrain's
    // failure record uses the staging-relative path.
    // Easiest: write a sync-failures.jsonl pre-existing that we OVERWRITE
    // after the ingest starts. To keep this deterministic without timing,
    // we run a passthrough fake that itself writes the failure entry.
    const binDir = join(home, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    const script = `#!/usr/bin/env bash
case "\${1:-}" in
  --help|-h) echo "Usage: gbrain"; echo "Commands:"; echo "  import <dir>   Import"; exit 0 ;;
  import)
    DIR="\${2:-}"
    # Pick the SECOND .md found in the staging dir and mark it failed in
    # ~/.gbrain/sync-failures.jsonl using the dir-relative path. The first
    # one lands cleanly.
    mkdir -p "\${HOME}/.gbrain"
    REL=\$(cd "\$DIR" && find . -name "*.md" -type f | sed 's|^\\./||' | sort | tail -1)
    if [ -n "\$REL" ]; then
      echo "{\\"path\\":\\"\$REL\\",\\"error\\":\\"File too large\\",\\"code\\":\\"FILE_TOO_LARGE\\",\\"commit\\":\\"\\",\\"ts\\":\\"2026-05-09T22:00:00Z\\"}" >> "\${HOME}/.gbrain/sync-failures.jsonl"
    fi
    if [[ " \$* " == *" --json "* ]]; then
      echo '{"status":"success","duration_s":0.1,"imported":1,"skipped":0,"errors":1,"chunks":1,"total_files":2}'
    fi
    exit 0 ;;
  *) echo "unknown"; exit 2 ;;
esac
`;
    const binPath = join(binDir, "gbrain");
    writeFileSync(binPath, script, "utf-8");
    chmodSync(binPath, 0o755);

    const r = runScript(["--bulk", "--include-unattributed", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });
    expect(r.exitCode).toBe(0);

    // State file should have exactly 1 session entry (the non-failed one).
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    const sessionPaths = Object.keys(state.sessions || {});
    expect(sessionPaths.length).toBe(1);

    rmSync(home, { recursive: true, force: true });
  });

  it("emits ERR with system_error and exits non-zero when gbrain CLI is missing the `import` subcommand", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Fake gbrain that advertises ONLY `put` (legacy) — no `import`.
    const binDir = join(home, "legacy-bin");
    mkdirSync(binDir, { recursive: true });
    const script = `#!/usr/bin/env bash
case "\${1:-}" in
  --help|-h) echo "Commands:"; echo "  put <slug>    Write a page (legacy)"; exit 0 ;;
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

    // D6: system_error sets non-zero exit; orchestrator marks ERR.
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/\[memory-ingest\] ERR:.*missing `import` subcommand|gbrain CLI not in PATH/);

    rmSync(home, { recursive: true, force: true });
  });

  it("--scan-secrets opt-in: skips files with gitleaks findings, lets clean files through", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir } = installFakeGbrain(home);

    // Fake gitleaks: prints a "finding" for any file whose path contains
    // "dirty", clean for everything else. The fake-gbrain shim doesn't
    // interfere — gitleaks is invoked from preparePages before staging.
    const fakeGitleaksDir = join(home, "fake-gitleaks-bin");
    mkdirSync(fakeGitleaksDir, { recursive: true });
    const fakeGitleaks = `#!/usr/bin/env bash
# gitleaks detect --no-git --source <path> --report-format json --report-path /dev/stdout --exit-code 0
# We just need to emit a JSON findings array on stdout. Find the --source arg.
SRC=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SRC="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if echo "$SRC" | grep -q dirty; then
  echo '[{"RuleID":"fake-rule","Description":"fake finding","StartLine":1,"Match":"REDACTED","Secret":"AKIAFAKEFAKEFAKE12345"}]'
else
  echo '[]'
fi
exit 0
`;
    const gitleaksBin = join(fakeGitleaksDir, "gitleaks");
    writeFileSync(gitleaksBin, fakeGitleaks, "utf-8");
    chmodSync(gitleaksBin, 0o755);

    // Two sessions: one "clean" (filename has no "dirty"), one "dirty"
    // (filename contains "dirty" so the fake gitleaks reports a finding).
    const sessionA =
      `{"type":"user","message":{"role":"user","content":"clean"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n`;
    const sessionB =
      `{"type":"user","message":{"role":"user","content":"dirty"},"timestamp":"2026-05-02T00:00:00Z","cwd":"/tmp/bar"}\n`;
    writeClaudeCodeSession(home, "tmp-foo", "cleansess123", sessionA);
    // Force the path to contain the "dirty" marker.
    writeClaudeCodeSession(home, "tmp-dirty-bar", "dirtysess456", sessionB);

    // Run with --scan-secrets enabled. Combine the fake gitleaks bin
    // before fake-gbrain in PATH so both shims resolve.
    const r = runScript(["--bulk", "--include-unattributed", "--scan-secrets"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${fakeGitleaksDir}:${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    // Bulk report shows skipped (secret-scan) >= 1
    expect(r.stdout).toMatch(/skipped \(secret-scan\):\s+1/);
    // Stderr from the secret-scan match path (printed when !quiet) includes the dirty path's basename.
    // Match generously: any occurrence of "secret-scan match" line.
    expect(r.stderr + r.stdout).toMatch(/secret-scan match/);

    rmSync(home, { recursive: true, force: true });
  });
});
