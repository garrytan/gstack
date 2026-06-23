/**
 * Unit tests for `buildGbrainEnv` in lib/gbrain-exec.ts.
 *
 * The helper is the single source of truth for "what DATABASE_URL does
 * gbrain see when spawned from gstack." The bug it prevents: gbrain's
 * dotenv autoload pulls a host project's `.env.local` `DATABASE_URL`
 * instead of gbrain's own `~/.gbrain/config.json`. Every helper test
 * asserts on the **effective value** of the returned env, never object
 * identity — Codex review #11 flagged that returning the same mutable
 * object can leak later mutation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildGbrainEnv, isTransactionModePooler } from "../lib/gbrain-exec";

describe("buildGbrainEnv", () => {
  let home: string;
  let gbrainHome: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gstack-build-env-"));
    gbrainHome = join(home, ".gbrain");
    mkdirSync(gbrainHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("seeds DATABASE_URL from ~/.gbrain/config.json when caller env has no DATABASE_URL", () => {
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: "postgresql://gbrain/db" }));
    const baseEnv = { HOME: home };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.DATABASE_URL).toBe("postgresql://gbrain/db");
  });

  it("overrides caller's DATABASE_URL when config differs", () => {
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: "postgresql://gbrain/db" }));
    const baseEnv = { HOME: home, DATABASE_URL: "postgresql://app-local/wrong" };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.DATABASE_URL).toBe("postgresql://gbrain/db");
  });

  it("leaves DATABASE_URL untouched when GSTACK_RESPECT_ENV_DATABASE_URL=1", () => {
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: "postgresql://gbrain/db" }));
    const baseEnv = {
      HOME: home,
      DATABASE_URL: "postgresql://intentional/app-db",
      GSTACK_RESPECT_ENV_DATABASE_URL: "1",
    };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.DATABASE_URL).toBe("postgresql://intentional/app-db");
  });

  it("returns caller env unchanged when config file is missing", () => {
    // No config.json written.
    const baseEnv = { HOME: home, DATABASE_URL: "postgresql://app/db" };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.DATABASE_URL).toBe("postgresql://app/db");
  });

  it("returns caller env unchanged when config file is unparseable", () => {
    writeFileSync(join(gbrainHome, "config.json"), "{not json");
    const baseEnv = { HOME: home, DATABASE_URL: "postgresql://app/db" };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.DATABASE_URL).toBe("postgresql://app/db");
  });

  it("returns caller env unchanged when config has no database_url field", () => {
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ engine: "pglite" }));
    const baseEnv = { HOME: home, DATABASE_URL: "postgresql://app/db" };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.DATABASE_URL).toBe("postgresql://app/db");
  });

  it("honors GBRAIN_HOME when set (config aligned with detectEngineTier)", () => {
    // Move the config to an alternate dir; set GBRAIN_HOME to point at it.
    const altGbrainHome = join(home, "alt-gbrain");
    mkdirSync(altGbrainHome, { recursive: true });
    writeFileSync(join(altGbrainHome, "config.json"), JSON.stringify({ database_url: "postgresql://alt/db" }));
    // No file at the default ~/.gbrain location.
    const baseEnv = { HOME: home, GBRAIN_HOME: altGbrainHome };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.DATABASE_URL).toBe("postgresql://alt/db");
  });

  it("returns a fresh env object — never the caller's env by identity", () => {
    // Codex review #11: object-identity equality lets later mutation of the
    // returned env leak back into the caller's view. The helper MUST clone.
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: "postgresql://gbrain/db" }));
    const baseEnv: NodeJS.ProcessEnv = { HOME: home, FOO: "bar" };
    const result = buildGbrainEnv({ baseEnv });
    expect(result).not.toBe(baseEnv);
    // Mutating result must not affect baseEnv.
    result.FOO = "changed";
    expect(baseEnv.FOO).toBe("bar");
  });

  it("preserves unrelated env vars from the base env", () => {
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: "postgresql://gbrain/db" }));
    const baseEnv = { HOME: home, PATH: "/usr/bin", FOO: "bar" };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.PATH).toBe("/usr/bin");
    expect(result.FOO).toBe("bar");
    expect(result.HOME).toBe(home);
  });

  it("does not modify DATABASE_URL when caller's value already matches config", () => {
    // Subtle: helper should be a no-op when caller already has the right value.
    // Lets us skip the stderr announce on idempotent re-invocation.
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: "postgresql://gbrain/db" }));
    const baseEnv = { HOME: home, DATABASE_URL: "postgresql://gbrain/db" };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.DATABASE_URL).toBe("postgresql://gbrain/db");
  });

  // --- GBRAIN_PREPARE is never auto-set (#1965) ---
  // gbrain auto-disables prepared statements on transaction-mode poolers;
  // forcing GBRAIN_PREPARE=true there breaks every write with "prepared
  // statement does not exist". The helper must leave the variable alone in
  // all cases — a caller-set value (the documented session-mode-on-6543
  // override) passes through untouched.

  it("does not set GBRAIN_PREPARE when DATABASE_URL targets port 6543 (transaction-mode pooler)", () => {
    const poolerUrl = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: poolerUrl }));
    const baseEnv = { HOME: home };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.DATABASE_URL).toBe(poolerUrl);
    expect(result.GBRAIN_PREPARE).toBeUndefined();
  });

  it("does not set GBRAIN_PREPARE when DATABASE_URL targets port 5432 (session-mode pooler)", () => {
    const sessionUrl = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: sessionUrl }));
    const baseEnv = { HOME: home };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.GBRAIN_PREPARE).toBeUndefined();
  });

  it("does not set GBRAIN_PREPARE for pglite (no port in URL)", () => {
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: "postgresql://gbrain/db" }));
    const baseEnv = { HOME: home };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.GBRAIN_PREPARE).toBeUndefined();
  });

  it("passes through caller's explicit GBRAIN_PREPARE=false", () => {
    const poolerUrl = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: poolerUrl }));
    const baseEnv = { HOME: home, GBRAIN_PREPARE: "false" };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.GBRAIN_PREPARE).toBe("false");
  });

  it("passes through caller's explicit GBRAIN_PREPARE=true (session-mode-on-6543 override)", () => {
    const poolerUrl = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    writeFileSync(join(gbrainHome, "config.json"), JSON.stringify({ database_url: poolerUrl }));
    const baseEnv = { HOME: home, GBRAIN_PREPARE: "true" };
    const result = buildGbrainEnv({ baseEnv });
    expect(result.GBRAIN_PREPARE).toBe("true");
  });
});

describe("isTransactionModePooler", () => {
  it("returns true for Supabase transaction-mode pooler URL (port 6543)", () => {
    expect(isTransactionModePooler(
      "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres"
    )).toBe(true);
  });

  it("returns false for session-mode pooler URL (port 5432)", () => {
    expect(isTransactionModePooler(
      "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    )).toBe(false);
  });

  it("returns false for pglite-style URL (no port)", () => {
    expect(isTransactionModePooler("postgresql://gbrain/db")).toBe(false);
  });

  it("returns false for unparseable URL", () => {
    expect(isTransactionModePooler("not-a-url")).toBe(false);
  });

  it("handles postgres:// scheme (without 'ql')", () => {
    expect(isTransactionModePooler(
      "postgres://postgres.abc:pw@host:6543/postgres"
    )).toBe(true);
  });
});
