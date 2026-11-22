/**
 * Regression tests for #2922 — runMemoryIngest() never passed --sources, so
 * every sync re-imported curated pages a registered federated gstack source
 * already indexes.
 *
 * Covers the resolver (from #2997), the default selection, and the behavior
 * of a real orchestrator memory stage against a fake gbrain: which pages get
 * staged for `gbrain import`, what the ingest state records, the dry-run
 * preview, and refusing to resume a staging dir prepared under a different
 * selection.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import {
  federatedCuratedSourceId,
  FEDERATED_CURATED_TYPES,
  MEMORY_INGEST_TYPES,
  resolveMemoryIngestSources,
} from "../bin/gstack-gbrain-sync";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "bin", "gstack-gbrain-sync.ts");
const ENV = "GSTACK_MEMORY_INGEST_SOURCES";

describe.skipIf(process.platform === "win32")("federatedCuratedSourceId honors GSTACK_BRAIN_SOURCE_ID (#4443)", () => {
  function probe(localPath: string, sourceId?: string, federated = true): string | null {
    const home = mkdtempSync(join(tmpdir(), "gstack-4443-"));
    try {
      const bin = join(home, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "gbrain"),
        `#!/bin/sh\n[ "$1" = sources ] && [ "$2" = list ] && echo '{"sources":[{"id":"acme-gstack-artifacts","local_path":"${localPath}","federated":${federated},"page_count":750}]}' && exit 0\nexit 1\n`,
      );
      chmodSync(join(bin, "gbrain"), 0o755);
      return federatedCuratedSourceId({
        HOME: home,
        GSTACK_HOME: join(home, ".gstack"),
        PATH: `${bin}:${process.env.PATH}`,
        ...(sourceId === undefined ? {} : { GSTACK_BRAIN_SOURCE_ID: sourceId }),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("a source at a host-side clone is found by the id the variable names", () => {
    expect(probe("/srv/brain/sources/acme-gstack-artifacts")).toBeNull();
    expect(probe("/srv/brain/sources/acme-gstack-artifacts", "acme-gstack-artifacts")).toBe("acme-gstack-artifacts");
  });

  test("a named source must still be federated, and an unknown id never falls back to the path match", () => {
    expect(probe("/srv/brain/sources/acme-gstack-artifacts", "acme-gstack-artifacts", false)).toBeNull();
    expect(probe("/srv/brain/sources/acme-gstack-artifacts", "other-source")).toBeNull();
  });
});

describe("resolveMemoryIngestSources (#2922)", () => {
  test("unset, empty, whitespace or `all` → null (full walk)", () => {
    expect(resolveMemoryIngestSources(undefined, ENV)).toBeNull();
    expect(resolveMemoryIngestSources("", ENV)).toBeNull();
    expect(resolveMemoryIngestSources("   ", ENV)).toBeNull();
    expect(resolveMemoryIngestSources("all", ENV)).toBeNull();
  });

  test("valid types are trimmed and deduplicated; unknown tokens dropped", () => {
    expect(resolveMemoryIngestSources("transcript, design-doc ,eureka,eureka,bogus", ENV)).toEqual([
      "transcript",
      "design-doc",
      "eureka",
    ]);
  });

  test("all unknown → null (full walk instead of failing the stage)", () => {
    expect(resolveMemoryIngestSources("bogus,nope", ENV)).toBeNull();
  });

  test("MEMORY_INGEST_TYPES stays in sync with memory-ingest ALL_TYPES", () => {
    const ingestSrc = readFileSync(join(ROOT, "bin", "gstack-memory-ingest.ts"), "utf-8");
    const m = ingestSrc.match(/const ALL_TYPES: MemoryType\[\] = \[([\s\S]*?)\];/);
    expect(m).not.toBeNull();
    const allTypes = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    expect(([...MEMORY_INGEST_TYPES] as string[]).sort()).toEqual(allTypes);
  });

  test("FEDERATED_CURATED_TYPES are exactly the markdown types the artifacts allowlist publishes", () => {
    // gbrain's markdown sync imports .md only, so a federated gstack source
    // indexes the allowlisted .md artifacts and none of the .jsonl ones.
    const init = readFileSync(join(ROOT, "bin", "gstack-artifacts-init"), "utf-8");
    const globs = init
      .split("\n")
      .filter((l) => /^(projects|retros|transcripts|[a-z-]+\.(md|jsonl|json))/.test(l))
      .map((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".+").replace(/\*/g, "[^/]+") + "$"));
    const representative: Record<string, string> = {
      "transcript": "/home/u/.claude/projects/x/s.jsonl",
      "eureka": "analytics/eureka.jsonl",
      "learning": "projects/acme/learnings.jsonl",
      "timeline": "projects/acme/timeline.jsonl",
      "ceo-plan": "projects/acme/ceo-plans/plan.md",
      "design-doc": "projects/acme/u-main-design-20260101.md",
      "retro": "projects/acme/retros/r.md",
      "builder-profile-entry": "builder-profile.jsonl",
    };
    const owned = MEMORY_INGEST_TYPES.filter((t) => {
      const p = representative[t];
      return p.endsWith(".md") && globs.some((g) => g.test(p));
    });
    expect(owned).toEqual([...FEDERATED_CURATED_TYPES]);
  });
});

interface Sandbox {
  home: string;
  gstackHome: string;
  worktree: string;
  stagedList: string;
  calls: string;
  env: Record<string, string>;
  cleanup: () => void;
}

function sandbox(opts: { federated: boolean }): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "gstack-2922-"));
  const gstackHome = join(home, ".gstack");
  const worktree = join(home, ".gstack-brain-worktree");
  const bindir = join(home, "bin");
  const stagedList = join(home, "staged.list");
  const calls = join(home, "gbrain.calls");
  for (const d of [gstackHome, worktree, bindir, join(home, ".gbrain")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".gbrain", "config.json"), JSON.stringify({ engine: "pglite", database_url: "pglite:///test" }));

  const proj = join(gstackHome, "projects", "acme-app");
  mkdirSync(join(proj, "ceo-plans"), { recursive: true });
  writeFileSync(join(proj, "ceo-plans", "2026-09-01-brand.md"), "# Brand plan\n\nShip the brand refresh.\n");
  writeFileSync(join(proj, "garry-main-design-20260901-120000.md"), "# Design\n\nA design doc.\n");
  writeFileSync(
    join(proj, "learnings.jsonl"),
    JSON.stringify({ ts: "2026-09-01T00:00:00Z", skill: "review", type: "pitfall", key: "k", insight: "Check the lock first.", confidence: 8 }) + "\n",
  );

  const sources = opts.federated
    ? `{"sources":[{"id":"gstack-artifacts-garry","local_path":"${worktree}","federated":true,"page_count":12}]}`
    : `{"sources":[]}`;
  writeFileSync(join(bindir, "gbrain"), `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$1" in
  --version) echo "gbrain 0.60.28.0" ;;
  --help) printf 'Commands:\\n  import <dir>   Import markdown directory\\n' ;;
  sources) echo '${sources}' ;;
  import)
    ( cd "$2" && find . -name '*.md' -type f | sort ) > "${stagedList}"
    n=$(wc -l < "${stagedList}" | tr -d ' ')
    echo "{\\"status\\":\\"success\\",\\"imported\\":$n,\\"skipped\\":0,\\"errors\\":0,\\"total_files\\":$n}"
    ;;
  *) echo "unexpected gbrain $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bindir, "gbrain"), 0o755);
  return {
    home,
    gstackHome,
    worktree,
    stagedList,
    calls,
    env: {
      HOME: home,
      GSTACK_HOME: gstackHome,
      GBRAIN_HOME: "",
      GSTACK_MEMORY_INGEST_SOURCES: "",
      PATH: `${bindir}:${process.env.PATH || ""}`,
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function runSync(sb: Sandbox, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", [SCRIPT, "--no-code", "--no-brain-sync", ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    cwd: sb.home,
    env: { ...process.env, ...sb.env, ...env },
  });
}

function staged(sb: Sandbox): string {
  return existsSync(sb.stagedList) ? readFileSync(sb.stagedList, "utf-8") : "";
}

function memoryStage(sb: Sandbox): { ok: boolean; memory_sources?: string[] } {
  const state = JSON.parse(readFileSync(join(sb.gstackHome, ".gbrain-sync-state.json"), "utf-8"));
  return state.last_stages.find((s: { name: string }) => s.name === "memory");
}

function ingestedTypes(sb: Sandbox): string[] {
  const state = JSON.parse(readFileSync(join(sb.gstackHome, ".transcript-ingest-state.json"), "utf-8"));
  const keys = Object.keys(state.sessions ?? {});
  return [
    keys.some((k) => k.includes("ceo-plans")) && "ceo-plan",
    keys.some((k) => k.includes("-design-")) && "design-doc",
    keys.some((k) => k.endsWith("learnings.jsonl")) && "learning",
  ].filter(Boolean) as string[];
}

describe.skipIf(process.platform === "win32")("memory stage source selection (#2922)", () => {
  test("default sync with a federated gstack source stages no curated pages", () => {
    const sb = sandbox({ federated: true });
    try {
      const r = runSync(sb, ["--incremental"]);
      expect(r.status).toBe(0);
      const pages = staged(sb);
      expect(pages).not.toMatch(/ceo-plan|design/i);
      expect(pages).toMatch(/learning/);
      expect(ingestedTypes(sb)).toEqual(["learning"]);
      const stage = memoryStage(sb);
      expect(stage.ok).toBe(true);
      expect(stage.memory_sources).not.toContain("ceo-plan");
      expect(stage.memory_sources).not.toContain("design-doc");
      expect(r.stderr).toContain("already indexed by federated source gstack-artifacts-garry");
    } finally {
      sb.cleanup();
    }
  });

  test("without a federated source, the default still ingests every type", () => {
    const sb = sandbox({ federated: false });
    try {
      // Transcripts join the default selection only with consent.
      writeFileSync(join(sb.gstackHome, "config.yaml"), "transcript_ingest_mode: recent\n");
      const r = runSync(sb, ["--incremental"]);
      expect(r.status).toBe(0);
      expect(ingestedTypes(sb)).toEqual(["ceo-plan", "design-doc", "learning"]);
      expect(memoryStage(sb).memory_sources).toEqual([...MEMORY_INGEST_TYPES]);
    } finally {
      sb.cleanup();
    }
  });

  test("--sources all opts back into curated types; it wins over the env var", () => {
    const sb = sandbox({ federated: true });
    try {
      const r = runSync(sb, ["--incremental", "--sources", "all"], { GSTACK_MEMORY_INGEST_SOURCES: "learning" });
      expect(r.status).toBe(0);
      expect(ingestedTypes(sb)).toEqual(["ceo-plan", "design-doc", "learning"]);
    } finally {
      sb.cleanup();
    }
  });

  test("GSTACK_MEMORY_INGEST_SOURCES narrows the walk", () => {
    const sb = sandbox({ federated: false });
    try {
      const r = runSync(sb, ["--incremental"], { GSTACK_MEMORY_INGEST_SOURCES: "ceo-plan" });
      expect(r.status).toBe(0);
      expect(ingestedTypes(sb)).toEqual(["ceo-plan"]);
      expect(memoryStage(sb).memory_sources).toEqual(["ceo-plan"]);
    } finally {
      sb.cleanup();
    }
  });

  test("dry-run previews the explicit selection without spawning gbrain", () => {
    const sb = sandbox({ federated: true });
    try {
      const r = runSync(sb, ["--dry-run", "--sources", "transcript,learning"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("would: gstack-memory-ingest --probe --sources transcript,learning (--sources)");
      // The preview never asks gbrain which sources are registered.
      expect(existsSync(sb.calls) ? readFileSync(sb.calls, "utf-8") : "").not.toContain("sources");
    } finally {
      sb.cleanup();
    }
  });

  test("a checkpoint staged under a different selection is restaged, not resumed", () => {
    const sb = sandbox({ federated: true });
    try {
      const stagingDir = join(sb.gstackHome, ".staging-ingest-1-1");
      mkdirSync(join(stagingDir, "projects"), { recursive: true });
      writeFileSync(join(stagingDir, ".gstack-staging"), "");
      writeFileSync(join(stagingDir, "projects", "stale-ceo-plan.md"), "# stale\n");
      writeFileSync(join(sb.home, ".gbrain", "import-checkpoint.json"), JSON.stringify({ dir: stagingDir, processedIndex: 0, totalFiles: 1 }));
      writeFileSync(join(sb.gstackHome, ".gbrain-sync-state.json"), JSON.stringify({
        schema_version: 1,
        last_writer: "gstack-gbrain-sync",
        last_stages: [{ name: "memory", ran: true, ok: false, duration_ms: 1, summary: "timeout", memory_sources: [...MEMORY_INGEST_TYPES] }],
      }));
      const r = runSync(sb, ["--incremental"]);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("memory source selection changed since the checkpointed run");
      expect(staged(sb)).not.toContain("stale-ceo-plan");
      expect(ingestedTypes(sb)).toEqual(["learning"]);
    } finally {
      sb.cleanup();
    }
  });
});
