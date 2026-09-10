/**
 * #2673: gstack-config set must reject malformed cross_project_learnings.
 *
 * Empty get is the first-run prompt sentinel (pinned in
 * gstack-config-defaults.test.ts). Skills only enable on the literal "true".
 * A typo used to store verbatim and exit 0, so the feature stayed off and
 * the prompt never returned. Unlike pair_agent / redact_prepush_hook, do
 * not coerce to a default — that would still persist a value and still
 * kill the sentinel. Follow codex_reviews: reject, leave existing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CONFIG = path.resolve(import.meta.dir, "..", "bin", "gstack-config");
let stateRoot: string;

function cfg(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(CONFIG, args, {
    timeout: 30_000,
    encoding: "utf8",
    env: { ...process.env, GSTACK_STATE_ROOT: stateRoot },
  });
  // null status = killed by signal, never success — map to -1, not 0.
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-config-xproj-"));
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

describe("cross_project_learnings set domain (#2673)", () => {
  test("empty get is still the first-run sentinel", () => {
    const r = cfg(["get", "cross_project_learnings"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  test("true and false round-trip", () => {
    expect(cfg(["set", "cross_project_learnings", "true"]).code).toBe(0);
    expect(cfg(["get", "cross_project_learnings"]).out).toBe("true");
    expect(cfg(["set", "cross_project_learnings", "false"]).code).toBe(0);
    expect(cfg(["get", "cross_project_learnings"]).out).toBe("false");
  });

  test("typo is rejected and does not write", () => {
    const r = cfg(["set", "cross_project_learnings", "ture"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not recognized");
    expect(r.err).toContain("cross_project_learnings");
    const got = cfg(["get", "cross_project_learnings"]);
    expect(got.code).toBe(0);
    expect(got.out).toBe("");
  });

  test("typo leaves an existing valid value unchanged", () => {
    expect(cfg(["set", "cross_project_learnings", "true"]).code).toBe(0);
    const r = cfg(["set", "cross_project_learnings", "yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Existing value left unchanged");
    expect(cfg(["get", "cross_project_learnings"]).out).toBe("true");
  });
});
