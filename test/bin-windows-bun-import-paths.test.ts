/**
 * #1950 — Windows git-bash POSIX paths break `bun -e` module imports.
 *
 * Under git-bash, `pwd` yields /c/Users/... which Bun on Windows cannot
 * resolve as an ES module specifier. Any bash bin that interpolates
 * $SCRIPT_DIR into a `bun -e` import must normalize it via `cygpath -m`
 * first, or the bin exits 1 with "Cannot find module" — which, combined
 * with stderr swallowing, silently dropped every AI-logged learning.
 *
 * Two layers:
 *   1. Static invariant — every bash bin with a $SCRIPT_DIR bun-import
 *      interpolation carries the cygpath guard (catches future bins).
 *   2. Behavioral — gstack-learnings-log, invoked the way Windows CI
 *      invokes bash bins (spawnSync("bash", [path])), writes a learning
 *      and surfaces validation errors on stderr instead of swallowing
 *      them. This file is in the windows-free-tests workflow list, so the
 *      cygpath conversion is proven on the only platform where #1950
 *      exists.
 */

import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const BIN_DIR = join(ROOT, "bin");

const CYGPATH_GUARD = /cygpath/;
// A bun -e payload that imports through the interpolated $SCRIPT_DIR.
const BUN_IMPORT_INTERPOLATION = /bun -e "[^]*?from '\$SCRIPT_DIR\//;

function bashBins(): string[] {
  return readdirSync(BIN_DIR).filter((name) => {
    const p = join(BIN_DIR, name);
    if (!statSync(p).isFile()) return false;
    const head = readFileSync(p, "utf-8").slice(0, 64);
    return head.startsWith("#!") && head.includes("bash");
  });
}

describe("bin/ — Windows bun-import path guard (#1950)", () => {
  it("every bash bin that interpolates $SCRIPT_DIR into a bun -e import has the cygpath guard", () => {
    const offenders: string[] = [];
    for (const name of bashBins()) {
      const content = readFileSync(join(BIN_DIR, name), "utf-8");
      if (BUN_IMPORT_INTERPOLATION.test(content) && !CYGPATH_GUARD.test(content)) {
        offenders.push(name);
      }
    }
    expect(
      offenders,
      `bins interpolate $SCRIPT_DIR into a bun -e import without a cygpath guard ` +
        `(breaks on Windows git-bash, #1950): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("known-affected bins carry the guard explicitly", () => {
    for (const name of [
      "gstack-gbrain-capability-check",
      "gstack-learnings-log",
      "gstack-question-log",
    ]) {
      const content = readFileSync(join(BIN_DIR, name), "utf-8");
      expect(content).toContain("cygpath -m");
    }
  });

  it("capability temp paths are normalized before POSIX dirname/cd", () => {
    const content = readFileSync(join(BIN_DIR, "gstack-gbrain-capability-check"), "utf-8");
    expect(content).toContain('process.platform === "win32" ? created.replaceAll("\\\\", "/")');
  });
});

describe("gstack-learnings-log — behavioral (runs on Windows CI via git-bash)", () => {
  function runViaBash(input: string, gstackHome: string) {
    // spawnSync("bash", [path]) mirrors how git-bash users (and Windows CI)
    // execute the bin — Windows CreateProcess cannot parse shebangs.
    return spawnSync("bash", [join(BIN_DIR, "gstack-learnings-log"), input], {
      encoding: "utf-8",
      timeout: 20_000,
      cwd: ROOT,
      env: { ...process.env, GSTACK_HOME: gstackHome },
    });
  }

  it("writes a learning end-to-end (proves the bun import resolves on this platform)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gstack-win-learn-"));
    try {
      const r = runViaBash(
        JSON.stringify({
          skill: "test",
          type: "operational",
          key: "windows-path-check",
          insight: "cygpath guard keeps the bun import resolvable",
          confidence: 8,
          source: "observed",
        }),
        tmp,
      );
      expect(r.status).toBe(0);
      const projects = readdirSync(join(tmp, "projects"));
      expect(projects.length).toBeGreaterThan(0);
      const written = readFileSync(
        join(tmp, "projects", projects[0], "learnings.jsonl"),
        "utf-8",
      );
      expect(written).toContain("windows-path-check");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces validation errors on stderr instead of swallowing them", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gstack-win-learn-"));
    try {
      const r = runViaBash(
        JSON.stringify({ skill: "test", type: "not-a-type", key: "k", insight: "x", confidence: 5 }),
        tmp,
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("invalid type");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("gstack-gbrain-capability-check — behavioral on Windows git-bash", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "gstack-win-gbrain-cap-"));
    const fake = join(root, "fake-gbrain");
    const calls = join(root, "calls.log");
    const sourceId = join(root, "source-id");
    const sourcePath = join(root, "source-path");
    const state = join(root, ".gbrain");
    mkdirSync(state);
    writeFileSync(
      join(state, "config.json"),
      JSON.stringify({ engine: "pglite", database_path: join(state, "brain.pglite") }),
    );
    writeFileSync(fake, `#!/usr/bin/env bash
set -u
cmd="\${1:-}"
case "$cmd" in
  --version) echo 'gbrain 0.42.59.0' ;;
  doctor)
    printf 'doctor\n' >> "$FIXTURE_CALLS"
    printf '%s\n' '{"mode":"thin-client","status":"ok","checks":[{"name":"oauth_client_scopes_probe","status":"ok","detail":{"granted":"read,write","read_ok":true}}]}'
    ;;
  sources)
    case "\${2:-}" in
      add)
        id="$3"; path=""; shift 3
        while [ "$#" -gt 0 ]; do
          if [ "$1" = '--path' ]; then path="$2"; shift 2; else shift; fi
        done
        printf '%s' "$id" > "$FIXTURE_SOURCE_ID"
        printf '%s' "$path" > "$FIXTURE_SOURCE_PATH"
        printf 'add:%s\n' "$id" >> "$FIXTURE_CALLS"
        ;;
      list)
        if [ -f "$FIXTURE_SOURCE_ID" ]; then
          FIXTURE_JSON_ID="$(cat "$FIXTURE_SOURCE_ID")" \
          FIXTURE_JSON_PATH="$(cat "$FIXTURE_SOURCE_PATH")" \
          "$BUN_BIN" -e 'process.stdout.write(JSON.stringify({sources:[{id:process.env.FIXTURE_JSON_ID,local_path:process.env.FIXTURE_JSON_PATH}]}) + "\\n")'
        else
          printf '%s\n' '{"sources":[]}'
        fi
        ;;
      remove)
        printf 'remove:%s\n' "$3" >> "$FIXTURE_CALLS"
        rm -f "$FIXTURE_SOURCE_ID"
        ;;
      *) exit 9 ;;
    esac
    ;;
  put)
    slug="$2"; marker=$(cat); path=$(cat "$FIXTURE_SOURCE_PATH")
    [ -n "$marker" ] || exit 14
    printf '%s\n' "$marker" > "$path/$slug.md"
    printf '%s' "$slug" > "$FIXTURE_SLUG"
    printf 'put:%s\n' "$slug" >> "$FIXTURE_CALLS"
    ;;
  search)
    if [ "\${FIXTURE_MODE:-}" = 'thin' ]; then
      printf 'thin-search\n' >> "$FIXTURE_CALLS"
    else
      printf '[1.0] %s -- probe\n' "$(cat "$FIXTURE_SLUG")"
    fi
    ;;
  *) exit 9 ;;
esac
`);
    chmodSync(fake, 0o755);
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      GBRAIN_BIN: fake,
      BUN_BIN: process.execPath,
      GBRAIN_HOME: root,
      GSTACK_HOME: join(root, "gstack-state"),
      GSTACK_GBRAIN_CAPABILITY_RETRY_DELAY_SECONDS: "0",
      FIXTURE_CALLS: calls,
      FIXTURE_SOURCE_ID: sourceId,
      FIXTURE_SOURCE_PATH: sourcePath,
      FIXTURE_SLUG: join(root, "slug"),
      FIXTURE_MODE: "local",
    };
    return { root, calls, sourcePath, env };
  }

  it.skipIf(process.platform !== "win32")(
    "runs the local add-put-search-readback-cleanup flow end-to-end on Windows",
    () => {
      const f = fixture();
      try {
        const r = spawnSync("bash", [join(BIN_DIR, "gstack-gbrain-capability-check")], {
          encoding: "utf-8",
          timeout: 20_000,
          cwd: ROOT,
          env: f.env,
        });
        expect(r.status, r.stderr).toBe(0);
        const calls = readFileSync(f.calls, "utf-8");
        expect(calls).toContain("add:");
        expect(calls).toContain("put:");
        expect(calls).toContain("remove:");
        const ownedPath = readFileSync(f.sourcePath, "utf-8");
        expect(existsSync(ownedPath)).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("runs the thin-client scope plus read probe without a remote write", () => {
    const f = fixture();
    try {
      const state = join(f.root, ".gbrain");
      writeFileSync(join(state, "config.json"), JSON.stringify({ remote_mcp: { mcp_url: "https://example.invalid/mcp" } }));
      f.env.FIXTURE_MODE = "thin";
      const r = spawnSync("bash", [join(BIN_DIR, "gstack-gbrain-capability-check")], {
        encoding: "utf-8",
        timeout: 20_000,
        cwd: ROOT,
        env: f.env,
      });
      expect(r.status, r.stderr).toBe(0);
      const calls = readFileSync(f.calls, "utf-8");
      expect(calls).toContain("doctor");
      expect(calls).toContain("thin-search");
      expect(calls).not.toContain("add:");
      expect(calls).not.toContain("put:");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
