/**
 * Tests for lib/code-intelligence — the OPTIONAL, repo-oriented provider contract.
 *
 * Load-bearing properties:
 *  - Every provider advertises the four required capabilities; optional ops are
 *    declined with a typed CAPABILITY_UNSUPPORTED, never a silent no-op.
 *  - Sourcebot/Graphify are phase-1 capability declarations: they prove contract
 *    fit and throw PROVIDER_UNAVAILABLE until a host MCP transport is wired.
 *  - The picker recommends GBrain first and resolves to null (provider-OFF) when
 *    GBrain is unavailable.
 *  - Non-local providers refuse to move repo content off the machine without
 *    explicit per-repo consent (PROVIDER_NOT_CONSENTED).
 *  - The GBrain adapter works end-to-end against a fake `gbrain` shim on PATH.
 *  - Missing CLI degrades (PROVIDER_UNAVAILABLE), never crashes.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  assertRequiredCapabilities,
  CodeProviderError,
  REQUIRED_CAPABILITIES,
  GbrainProvider,
  SourcebotProvider,
  GraphifyProvider,
  parseGbrainSearch,
  recommendCodeProvider,
  resolveCodeProvider,
  RECOMMENDED_ORDER,
} from "../lib/code-intelligence";

describe("capability matrix invariants", () => {
  test("every provider advertises the four required capabilities", () => {
    for (const p of [new GbrainProvider(), new SourcebotProvider(), new GraphifyProvider()]) {
      for (const cap of REQUIRED_CAPABILITIES) expect(p.has(cap)).toBe(true);
    }
  });

  test("GBrain advertises all seven (document axis)", () => {
    const g = new GbrainProvider();
    for (const cap of ["add", "delete", "export"] as const) expect(g.has(cap)).toBe(true);
    expect(g.local).toBe(false);
  });

  test("Sourcebot is search-only: declines add/delete/export", () => {
    const s = new SourcebotProvider();
    expect(s.has("add")).toBe(false);
    expect(s.has("delete")).toBe(false);
    expect(s.has("export")).toBe(false);
    expect(s.local).toBe(false);
  });

  test("Graphify is local, exports, declines add/delete", () => {
    const g = new GraphifyProvider();
    expect(g.local).toBe(true);
    expect(g.has("export")).toBe(true);
    expect(g.has("add")).toBe(false);
    expect(g.has("delete")).toBe(false);
  });

  test("assertRequiredCapabilities rejects an incomplete provider", () => {
    expect(() => assertRequiredCapabilities("sourcebot", new Set(["search"]))).toThrow(/missing required/);
  });

  test("CodeProviderError rejects an unknown failure code", () => {
    // @ts-expect-error deliberately invalid code
    expect(() => new CodeProviderError("NOPE", "x")).toThrow(/Unknown code-provider failure/);
  });
});

describe("optional ops decline with a typed failure", () => {
  test("Sourcebot declines add/delete/export with CAPABILITY_UNSUPPORTED", async () => {
    const s = new SourcebotProvider();
    await expect(s.add({ slug: "x", body: "y" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(s.delete("x")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(s.export({ id: "x" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  test("Graphify advertises export → not CAPABILITY_UNSUPPORTED, but unwired in phase 1", async () => {
    await expect(new GraphifyProvider().export({ id: "x" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("phase-1 declaration adapters degrade to PROVIDER_UNAVAILABLE", () => {
  test("Sourcebot.search is unwired until a transport lands", async () => {
    await expect(new SourcebotProvider().search("q")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("empty query short-circuits to no hits (no throw)", async () => {
    expect(await new SourcebotProvider().search("   ")).toEqual([]);
  });

  test("status is partial + unknown (no live probe yet)", async () => {
    const s = await new GraphifyProvider().status({ id: "repo" });
    expect(s).toMatchObject({ id: "repo", state: "unknown", partial: true });
  });
});

describe("egress consent gate", () => {
  test("non-local registerSource without consent → PROVIDER_NOT_CONSENTED", async () => {
    await expect(new SourcebotProvider().registerSource({ id: "repo", path: "/repo" })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
  });

  test("local provider (Graphify) skips the egress gate (falls through to unwired)", async () => {
    // Local means nothing leaves the machine, so consent is not required — it
    // reaches the phase-1 PROVIDER_UNAVAILABLE, NOT a consent rejection.
    await expect(new GraphifyProvider().registerSource({ id: "repo", path: "/repo" })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});

describe("parseGbrainSearch (text surface)", () => {
  const sample = ["[0.91] slug/a -- snippet one", "banner", "[0.05] slug/b -- below floor"].join("\n");
  test("parses scored lines, applies floor + limit", () => {
    expect(parseGbrainSearch(sample, 0.1, 10)).toEqual([
      { ref: "slug/a", score: 0.91, snippet: "snippet one", kind: "document" },
    ]);
    expect(parseGbrainSearch(sample, 0.0, 1)).toHaveLength(1);
  });
});

describe("picker — recommend GBrain first", () => {
  test("RECOMMENDED_ORDER puts GBrain first", () => {
    expect(RECOMMENDED_ORDER[0]).toBe("gbrain");
    expect([...RECOMMENDED_ORDER]).toEqual(["gbrain", "sourcebot", "graphify"]);
  });

  test("GBrain resolves when usable", () => {
    expect(recommendCodeProvider({ gbrainStatus: "ok" }).map((p) => p.id)).toEqual(["gbrain"]);
    expect(resolveCodeProvider({ gbrainStatus: "ok" })?.id).toBe("gbrain");
  });

  test("timeout status counts as usable (engine slow, not absent)", () => {
    expect(resolveCodeProvider({ gbrainStatus: "timeout" })?.id).toBe("gbrain");
  });

  test("provider-OFF: GBrain down → resolveCodeProvider null", () => {
    expect(recommendCodeProvider({ gbrainStatus: "no-cli" })).toEqual([]);
    expect(resolveCodeProvider({ gbrainStatus: "no-cli" })).toBeNull();
    expect(resolveCodeProvider({ gbrainStatus: "missing-config" })).toBeNull();
  });
});

describe("GBrain adapter end-to-end (fake shim on PATH)", () => {
  let binDir: string;
  let homeDir: string;

  function writeShim(body: string): void {
    const p = path.join(binDir, "gbrain");
    fs.writeFileSync(p, body, { mode: 0o755 });
    fs.chmodSync(p, 0o755);
  }
  function env(): NodeJS.ProcessEnv {
    return { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir };
  }

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gbrain-shim-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gbrain-home-"));
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test("search scopes to source and parses hits", async () => {
    writeShim(`#!/usr/bin/env bash
if [ "$1" = "search" ]; then
  if printf '%s ' "$@" | grep -q -- "--source code"; then
    echo "[0.88] src/x.ts -- match in code source"
  else
    echo "[0.10] wrong -- unscoped"
  fi
  exit 0
fi
exit 1
`);
    const hits = await new GbrainProvider().search("where", { env: env(), source: "code" });
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toBe("src/x.ts");
  });

  test("status(source) reports ready + page_count", async () => {
    writeShim(`#!/usr/bin/env bash
if [ "$1" = "sources" ]; then echo '{"sources":[{"id":"code","local_path":"/repo","page_count":42}]}'; exit 0; fi
exit 1
`);
    const s = await new GbrainProvider().status({ id: "code" }, { env: env() });
    expect(s.state).toBe("ready");
    expect(s.itemCount).toBe(42);
  });

  test("status(source) reports absent for an unregistered id", async () => {
    writeShim(`#!/usr/bin/env bash
if [ "$1" = "sources" ]; then echo '{"sources":[]}'; exit 0; fi
exit 1
`);
    expect((await new GbrainProvider().status({ id: "nope" }, { env: env() })).state).toBe("absent");
  });

  test("missing CLI degrades to PROVIDER_UNAVAILABLE", async () => {
    // No shim written; PATH points only at an empty dir.
    await expect(
      new GbrainProvider().search("q", { env: { PATH: binDir, HOME: homeDir } }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("registerSource requires egress consent (GBrain is non-local)", async () => {
    await expect(
      new GbrainProvider().registerSource({ id: "code", path: "/repo" }, { env: env() }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONSENTED" });
  });
});
