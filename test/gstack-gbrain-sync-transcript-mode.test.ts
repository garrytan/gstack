/**
 * Transcript consent (transcript_ingest_mode) in the memory stage.
 *
 * Transcripts ingest only for a stored `recent` (last 90 days) or `all` (all
 * history). An absent key, `off`, legacy gate values and anything else skip
 * transcripts while the other memory types still sync, and the sync prints a
 * notice naming how to choose. Runs the real orchestrator and memory ingest
 * against a stub gbrain in a temp HOME / GSTACK_HOME.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";

import {
  MEMORY_INGEST_TYPES,
  applyTranscriptConsent,
  transcriptConsentNotice,
} from "../bin/gstack-gbrain-sync";
import { normalizeTranscriptConsent } from "../bin/gstack-memory-ingest";

const ROOT = join(import.meta.dir, "..");
const SYNC = join(ROOT, "bin", "gstack-gbrain-sync.ts");
const INGEST = join(ROOT, "bin", "gstack-memory-ingest.ts");
const HINT =
  "To choose: run /sync-gbrain, or gstack-config set transcript_ingest_mode recent|all|off. Details: setup-gbrain/memory.md#transcripts";
const notice = (value: string) =>
  `gbrain-sync: transcripts skipped (transcript_ingest_mode=${value}). Other memory still syncs. ${HINT}`;

describe("normalizeTranscriptConsent", () => {
  const consent = (yaml: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-consent-"));
    try {
      if (yaml !== null) writeFileSync(join(dir, "config.yaml"), yaml);
      return normalizeTranscriptConsent({ GSTACK_STATE_ROOT: dir, HOME: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("only recent and all are consent", () => {
    expect(consent("transcript_ingest_mode: recent\n")).toEqual({ affirmative: true, window: "recent", reason: "recent", value: "recent" });
    expect(consent("transcript_ingest_mode: all\n")).toEqual({ affirmative: true, window: "all", reason: "all", value: "all" });
    expect(consent("transcript_ingest_mode: off\n")).toMatchObject({ affirmative: false, window: null, reason: "off" });
    expect(consent(null)).toEqual({ affirmative: false, window: null, reason: "not-set", value: null });
    expect(consent("telemetry: off\n")).toMatchObject({ affirmative: false, reason: "not-set" });
  });

  test("legacy gate values, any case and padding, need a new choice", () => {
    for (const v of [" A ", "b", "C", "D", "e", "incremental", "Incremental"]) {
      expect(consent(`transcript_ingest_mode: ${v}\n`)).toMatchObject({ affirmative: false, window: null, reason: "legacy" });
    }
  });

  test("anything else is unrecognized, not consent", () => {
    for (const v of ["yes", "new-only", "90d", "true"]) {
      expect(consent(`transcript_ingest_mode: ${v}\n`)).toMatchObject({ affirmative: false, reason: "unrecognized", value: v });
    }
  });

  test("the last line wins, like gstack-config get", () => {
    expect(consent("transcript_ingest_mode: all\ntranscript_ingest_mode: off\n")).toMatchObject({ reason: "off" });
  });
});

describe("applyTranscriptConsent", () => {
  const yes = { affirmative: true, window: "recent" as const, reason: "recent" as const, value: "recent" };
  const no = { affirmative: false, window: null, reason: "not-set" as const, value: null };

  test("without consent, transcript leaves the default and the rest is pinned as an explicit list", () => {
    const r = applyTranscriptConsent({ sources: null, why: "default: no federated gstack source registered" }, no);
    expect(r.sources).toEqual(MEMORY_INGEST_TYPES.filter((t) => t !== "transcript"));
    expect(r.selected).toEqual(r.sources!);
    expect(r.override).toBe(false);
  });

  test("with consent, the default stays null so the ingest walks its own default", () => {
    const r = applyTranscriptConsent({ sources: null, why: "default: no federated gstack source registered" }, yes);
    expect(r.sources).toBeNull();
    expect(r.selected).toEqual([...MEMORY_INGEST_TYPES]);
  });

  test("an explicit list naming transcript overrides; a derived list does not", () => {
    expect(applyTranscriptConsent({ sources: ["transcript", "learning"], why: "--sources" }, no)).toMatchObject({ override: true, sources: ["transcript", "learning"] });
    expect(applyTranscriptConsent({ sources: ["transcript"], why: "GSTACK_MEMORY_INGEST_SOURCES" }, no)).toMatchObject({ override: true });
    const federated = applyTranscriptConsent({ sources: ["transcript", "learning"], why: "default: ceo-plan,design-doc already indexed" }, no);
    expect(federated).toMatchObject({ override: false, sources: ["learning"] });
  });

  test("notice copy", () => {
    expect(transcriptConsentNotice(no, true)).toBe(notice("not set"));
    expect(transcriptConsentNotice({ ...no, reason: "legacy", value: "A" }, false)).toBe(notice("A"));
    expect(transcriptConsentNotice({ ...no, reason: "off", value: "off" }, false)).toBe("gbrain-sync: transcripts off (your choice)");
    expect(transcriptConsentNotice({ ...no, reason: "off", value: "off" }, true)).toBeNull();
    expect(transcriptConsentNotice(yes, false)).toBeNull();
  });
});

interface Sandbox {
  home: string;
  gstackHome: string;
  stagedList: string;
  calls: string;
  env: Record<string, string>;
  cleanup: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function sandbox(opts: { federated?: boolean; mode?: string } = {}): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "gstack-tmode-"));
  const gstackHome = join(home, ".gstack");
  const worktree = join(home, ".gstack-brain-worktree");
  const bindir = join(home, "bin");
  const stagedList = join(home, "staged.list");
  const calls = join(home, "gbrain.calls");
  for (const d of [gstackHome, worktree, bindir, join(home, ".gbrain")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".gbrain", "config.json"), JSON.stringify({ engine: "pglite", database_url: "pglite:///test" }));
  if (opts.mode !== undefined) writeFileSync(join(gstackHome, "config.yaml"), `transcript_ingest_mode: ${opts.mode}\n`);

  // Curated memory: one learning and one CEO plan.
  const proj = join(gstackHome, "projects", "acme-app");
  mkdirSync(join(proj, "ceo-plans"), { recursive: true });
  writeFileSync(join(proj, "ceo-plans", "2026-09-01-brand.md"), "# Brand plan\n\nShip the brand refresh.\n");
  writeFileSync(
    join(proj, "learnings.jsonl"),
    JSON.stringify({ ts: "2026-09-01T00:00:00Z", skill: "review", type: "pitfall", key: "k", insight: "Check the lock first.", confidence: 8 }) + "\n",
  );

  // Two attributable Claude Code sessions: one recent, one 200 days old.
  const repo = join(home, "work", "acme");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8", timeout: 30_000 });
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/acme/app.git");
  git("config", "--local", "url.https://github.com/acme/app.git.insteadOf", "https://github.com/acme/app.git");
  const sessionDir = join(home, ".claude", "projects", "work-acme");
  mkdirSync(sessionDir, { recursive: true });
  const session = (id: string, text: string) =>
    `{"type":"user","message":{"role":"user","content":"${text}"},"timestamp":"2026-09-01T00:00:00Z","cwd":"${repo}","sessionId":"${id}"}\n` +
    `{"type":"assistant","message":{"role":"assistant","content":"ok"},"timestamp":"2026-09-01T00:00:01Z"}\n`;
  writeFileSync(join(sessionDir, "recent0001.jsonl"), session("recent0001", "recent session"));
  const old = join(sessionDir, "old000000001.jsonl");
  writeFileSync(old, session("old000000001", "old session"));
  const oldTime = new Date(Date.now() - 200 * DAY_MS);
  utimesSync(old, oldTime, oldTime);

  // Stub gbrain. With GBRAIN_PAUSE_DIR set, `sources list` (the first gbrain
  // call of the memory stage) waits until the test releases it.
  const sources = opts.federated
    ? `{"sources":[{"id":"gstack-artifacts-acme","local_path":"${worktree}","federated":true,"page_count":12}]}`
    : `{"sources":[]}`;
  writeFileSync(join(bindir, "gbrain"), `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$1" in
  --version) echo "gbrain 0.60.28.0" ;;
  --help) printf 'Commands:\\n  import <dir>   Import markdown directory\\n' ;;
  sources)
    if [ -n "$GBRAIN_PAUSE_DIR" ]; then
      touch "$GBRAIN_PAUSE_DIR/paused"
      i=0
      while [ ! -e "$GBRAIN_PAUSE_DIR/release" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    fi
    echo '${sources}' ;;
  import)
    # One import per gbrain source (A4): pages of one ingest run accumulate;
    # a new run (different parent pid) starts a fresh list.
    if [ "$(cat "${stagedList}.ppid" 2>/dev/null)" != "$PPID" ]; then echo "$PPID" > "${stagedList}.ppid"; : > "${stagedList}"; fi
    ( cd "$2" && find . -name '*.md' -type f | sort ) >> "${stagedList}"
    n=$( cd "$2" && find . -name '*.md' -type f | wc -l | tr -d ' ')
    echo "{\\"status\\":\\"success\\",\\"imported\\":$n,\\"skipped\\":0,\\"errors\\":0,\\"total_files\\":$n}"
    ;;
  *) echo "unexpected gbrain $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bindir, "gbrain"), 0o755);
  return {
    home,
    gstackHome,
    stagedList,
    calls,
    env: {
      HOME: home,
      GSTACK_HOME: gstackHome,
      GBRAIN_HOME: "",
      GSTACK_MEMORY_INGEST_SOURCES: "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      PATH: `${bindir}:${process.env.PATH || ""}`,
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function runSync(sb: Sandbox, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", [SYNC, "--no-code", "--no-brain-sync", ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    cwd: sb.home,
    env: { ...process.env, ...sb.env, ...env },
  });
}

function staged(sb: Sandbox): string {
  return existsSync(sb.stagedList) ? readFileSync(sb.stagedList, "utf-8") : "";
}

function memoryStage(sb: Sandbox): { ok: boolean; memory_sources?: string[]; transcript_consent?: Record<string, unknown> } {
  const state = JSON.parse(readFileSync(join(sb.gstackHome, ".gbrain-sync-state.json"), "utf-8"));
  return state.last_stages.find((s: { name: string }) => s.name === "memory");
}

const transcripts = (sb: Sandbox) => staged(sb).split("\n").filter((l) => l.includes("transcripts/"));

describe.skipIf(process.platform === "win32")("memory stage transcript consent", () => {
  test("absent key: transcripts skipped, other memory syncs, notice prints under --quiet", () => {
    const sb = sandbox();
    try {
      const r = runSync(sb, ["--incremental", "--quiet"]);
      expect(r.status).toBe(0);
      expect(transcripts(sb)).toEqual([]);
      expect(staged(sb)).toMatch(/learning/);
      expect(staged(sb)).toMatch(/ceo-plan/);
      expect(r.stderr).toContain(notice("not set"));
      const stage = memoryStage(sb);
      expect(stage.memory_sources).not.toContain("transcript");
      expect(stage.transcript_consent).toEqual({ mode: "not-set", window: null, skip_reason: "not-set" });
    } finally {
      sb.cleanup();
    }
  });

  test("stored off: skipped; neutral line only without --quiet", () => {
    const sb = sandbox({ mode: "off" });
    try {
      const loud = runSync(sb, ["--incremental"]);
      expect(loud.status).toBe(0);
      expect(transcripts(sb)).toEqual([]);
      expect(loud.stderr).toContain("gbrain-sync: transcripts off (your choice)");
      expect(loud.stderr).not.toContain("transcripts skipped");
      const quiet = runSync(sb, ["--incremental", "--quiet"]);
      expect(quiet.status).toBe(0);
      expect(quiet.stderr).not.toContain("gbrain-sync: transcripts");
      expect(memoryStage(sb).transcript_consent).toEqual({ mode: "off", window: null, skip_reason: "off" });
    } finally {
      sb.cleanup();
    }
  });

  test("legacy values are not consent", () => {
    for (const mode of [" A ", "b", "D", "incremental"]) {
      const sb = sandbox({ mode });
      try {
        const r = runSync(sb, ["--full", "--no-dream", "--quiet"]);
        expect(r.status).toBe(0);
        expect(transcripts(sb)).toEqual([]);
        expect(staged(sb)).toMatch(/learning/);
        expect(r.stderr).toContain(notice(mode.trim()));
        expect(memoryStage(sb).transcript_consent).toMatchObject({ mode: "legacy", skip_reason: "legacy" });
      } finally {
        sb.cleanup();
      }
    }
  });

  test("recent: the 90-day window, on --full too", () => {
    const sb = sandbox({ mode: "recent" });
    try {
      const r = runSync(sb, ["--full", "--no-dream", "--quiet"]);
      expect(r.status).toBe(0);
      expect(transcripts(sb).join("\n")).toMatch(/recent0001/);
      expect(transcripts(sb).join("\n")).not.toMatch(/old00000000/);
      expect(r.stderr).not.toContain("gbrain-sync: transcripts");
      expect(memoryStage(sb).transcript_consent).toEqual({ mode: "recent", window: "recent" });
    } finally {
      sb.cleanup();
    }
  });

  test("all: --full walks all history", () => {
    const sb = sandbox({ mode: "all" });
    try {
      const r = runSync(sb, ["--full", "--no-dream", "--quiet"]);
      expect(r.status).toBe(0);
      expect(transcripts(sb).join("\n")).toMatch(/recent0001/);
      expect(transcripts(sb).join("\n")).toMatch(/old00000000/);
      expect(memoryStage(sb).transcript_consent).toEqual({ mode: "all", window: "all" });
    } finally {
      sb.cleanup();
    }
  });

  test("an explicit list naming transcript overrides an absent key; the notice still prints", () => {
    for (const [args, env, why] of [
      [["--sources", "transcript,learning"], {}, "--sources"],
      [[], { GSTACK_MEMORY_INGEST_SOURCES: "transcript" }, "GSTACK_MEMORY_INGEST_SOURCES"],
    ] as const) {
      const sb = sandbox();
      try {
        const r = runSync(sb, ["--incremental", "--quiet", ...args], { ...env });
        expect(r.status).toBe(0);
        expect(transcripts(sb).join("\n")).toMatch(/recent0001/);
        expect(r.stderr).toContain(`gbrain-sync: transcripts ingested because ${why} names transcript (transcript_ingest_mode=not set). ${HINT}`);
        expect(memoryStage(sb).transcript_consent).toEqual({ mode: "not-set", window: null });
      } finally {
        sb.cleanup();
      }
    }
  });

  test("--sources all, an empty env list and an invalid-only list do not override", () => {
    for (const [args, env] of [
      [["--sources", "all"], {}],
      [[], { GSTACK_MEMORY_INGEST_SOURCES: "" }],
      [["--sources", "bogus"], {}],
      [[], { GSTACK_MEMORY_INGEST_SOURCES: "nope" }],
    ] as const) {
      const sb = sandbox();
      try {
        const r = runSync(sb, ["--incremental", "--quiet", ...args], { ...env });
        expect(r.status).toBe(0);
        expect(transcripts(sb)).toEqual([]);
        expect(staged(sb)).toMatch(/learning/);
        expect(r.stderr).toContain(notice("not set"));
      } finally {
        sb.cleanup();
      }
    }
  });

  test("federated source registered + absent key: no curated pages, no transcripts", () => {
    const sb = sandbox({ federated: true });
    try {
      const r = runSync(sb, ["--incremental", "--quiet"]);
      expect(r.status).toBe(0);
      expect(staged(sb)).toMatch(/learning/);
      expect(staged(sb)).not.toMatch(/ceo-plan/);
      expect(transcripts(sb)).toEqual([]);
      expect(memoryStage(sb).memory_sources).toEqual(
        MEMORY_INGEST_TYPES.filter((t) => !["transcript", "ceo-plan", "design-doc"].includes(t)),
      );
    } finally {
      sb.cleanup();
    }
  });

  test("a config change during the run does not add transcripts to it", async () => {
    const sb = sandbox();
    const pause = join(sb.home, "pause");
    mkdirSync(pause);
    try {
      const child = spawn("bun", [SYNC, "--no-code", "--no-brain-sync", "--incremental", "--quiet"], {
        cwd: sb.home,
        env: { ...process.env, ...sb.env, GBRAIN_PAUSE_DIR: pause },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.stdout.resume();
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(pause, "paused")) && Date.now() < deadline) await Bun.sleep(50);
      expect(existsSync(join(pause, "paused"))).toBe(true);
      writeFileSync(join(sb.gstackHome, "config.yaml"), "transcript_ingest_mode: all\n");
      writeFileSync(join(pause, "release"), "");
      expect(await exited).toBe(0);
      expect(transcripts(sb)).toEqual([]);
      expect(staged(sb)).toMatch(/learning/);
      expect(stderr).toContain(notice("not set"));
      expect(memoryStage(sb).transcript_consent).toMatchObject({ mode: "not-set" });
    } finally {
      sb.cleanup();
    }
  }, 60_000);

  describe("checkpoint resume requires the same consent policy", () => {
    function checkpoint(sb: Sandbox, previous: { memory_sources: string[]; transcript_consent?: Record<string, unknown> }): void {
      const stagingDir = join(sb.gstackHome, ".staging-ingest-1-1");
      mkdirSync(join(stagingDir, "projects"), { recursive: true });
      writeFileSync(join(stagingDir, ".gstack-staging"), "");
      writeFileSync(join(stagingDir, "projects", "stale-page.md"), "# stale\n");
      writeFileSync(join(sb.home, ".gbrain", "import-checkpoint.json"), JSON.stringify({ dir: stagingDir, processedIndex: 0, totalFiles: 1 }));
      writeFileSync(join(sb.gstackHome, ".gbrain-sync-state.json"), JSON.stringify({
        schema_version: 1,
        last_writer: "gstack-gbrain-sync",
        last_stages: [{ name: "memory", ran: true, ok: false, duration_ms: 1, summary: "timeout", ...previous }],
      }));
    }

    test("same types and policy resume the checkpoint", () => {
      const sb = sandbox({ mode: "recent" });
      try {
        checkpoint(sb, { memory_sources: [...MEMORY_INGEST_TYPES], transcript_consent: { mode: "recent", window: "recent" } });
        // The fixture's staging dir is not a real interrupted import, so the
        // import's page accounting fails afterwards; the decision is what counts.
        const r = runSync(sb, ["--incremental", "--quiet"]);
        expect(r.stderr).toContain("resuming from gbrain checkpoint");
        expect(r.stderr).not.toContain("transcript consent changed");
        expect(staged(sb)).toContain("stale-page");
      } finally {
        sb.cleanup();
      }
    });

    test("recent → all restages once and says so", () => {
      const sb = sandbox({ mode: "all" });
      try {
        checkpoint(sb, { memory_sources: [...MEMORY_INGEST_TYPES], transcript_consent: { mode: "recent", window: "recent" } });
        const r = runSync(sb, ["--incremental", "--quiet"]);
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("gbrain-sync: transcript consent changed since the interrupted import (recent → all)");
        expect(r.stderr).not.toContain("resuming from gbrain checkpoint");
        expect(staged(sb)).not.toContain("stale-page");
      } finally {
        sb.cleanup();
      }
    });

    test("all → off restages, with the skip notice first", () => {
      const sb = sandbox({ mode: "off" });
      try {
        checkpoint(sb, { memory_sources: [...MEMORY_INGEST_TYPES], transcript_consent: { mode: "all", window: "all" } });
        const r = runSync(sb, ["--incremental"]);
        expect(r.status).toBe(0);
        const offAt = r.stderr.indexOf("gbrain-sync: transcripts off (your choice)");
        const restageAt = r.stderr.indexOf("gbrain-sync: transcript consent changed since the interrupted import (all → off)");
        expect(offAt).toBeGreaterThanOrEqual(0);
        expect(restageAt).toBeGreaterThan(offAt);
        expect(staged(sb)).not.toContain("stale-page");
        expect(transcripts(sb)).toEqual([]);
      } finally {
        sb.cleanup();
      }
    });
  });

  test("gstack-memory-ingest --bulk with the key absent ingests no transcripts", () => {
    const sb = sandbox();
    try {
      const r = spawnSync("bun", [INGEST, "--bulk"], { encoding: "utf-8", timeout: 60_000, cwd: sb.home, env: { ...process.env, ...sb.env } });
      expect(r.status).toBe(0);
      expect(transcripts(sb)).toEqual([]);
      expect(staged(sb)).toMatch(/learning/);
      expect(r.stderr).toContain("gstack-memory-ingest: transcripts skipped (transcript_ingest_mode=not set)");
    } finally {
      sb.cleanup();
    }
  });

  test("gstack-memory-ingest --bulk with all walks all history", () => {
    const sb = sandbox({ mode: "all" });
    try {
      const r = spawnSync("bun", [INGEST, "--bulk", "--quiet"], { encoding: "utf-8", timeout: 60_000, cwd: sb.home, env: { ...process.env, ...sb.env } });
      expect(r.status).toBe(0);
      expect(transcripts(sb).join("\n")).toMatch(/old00000000/);
    } finally {
      sb.cleanup();
    }
  });
});
