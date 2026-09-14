/**
 * Timeline Stop hook persistent gate (#2677).
 *
 * --no-team is a one-shot teardown: every later bare ./setup — including the
 * ones /gstack-upgrade runs — re-registered the Stop hook with no way to say
 * "never". The gate mirrors the plan_tune_hooks pattern: flag > env
 * (GSTACK_TIMELINE_STOP_HOOK) > saved config (timeline_stop_hook) > default
 * yes; an explicit FLAG persists to config; an explicit "no" also REMOVES a
 * live registration (reconciliation), so the opt-out works against installs
 * registered by an older setup.
 *
 * Static pins on `setup` + real gstack-config runs — driving full ./setup in
 * a unit test is disproportionate; the wiring shapes below are the contract.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const setupSrc = fs.readFileSync(path.join(ROOT, "setup"), "utf-8");
const CONFIG = path.join(ROOT, "bin", "gstack-config");

describe("setup: timeline Stop hook gate (#2677)", () => {
  test("flags parse: --timeline-stop-hook / --no-timeline-stop-hook / = form", () => {
    expect(setupSrc).toContain('--timeline-stop-hook)    TIMELINE_STOP_HOOK_MODE="yes"');
    expect(setupSrc).toContain('--no-timeline-stop-hook) TIMELINE_STOP_HOOK_MODE="no"');
    expect(setupSrc).toContain('--timeline-stop-hook=*)  TIMELINE_STOP_HOOK_MODE=');
  });

  test("resolution order: flag > env > config, normalized, default yes", () => {
    const block = setupSrc.slice(setupSrc.indexOf("#2677: PERSISTENT gate"));
    const flag = block.indexOf('TL_DECISION="$TIMELINE_STOP_HOOK_MODE"');
    const env = block.indexOf('TL_DECISION="${GSTACK_TIMELINE_STOP_HOOK}"');
    const cfg = block.indexOf("get timeline_stop_hook");
    expect(flag).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(flag);
    expect(cfg).toBeGreaterThan(env);
    // Negative-value normalization uses the shared set.
    expect(block).toContain('n|no|false|skip|off|0) TL_DECISION="no"');
  });

  test("registration guard requires TL_DECISION != no; explicit flag persists to config", () => {
    expect(setupSrc).toMatch(
      /\[ "\$NO_TEAM_MODE" -ne 1 \] && \[ "\$TL_DECISION" != "no" \] && \[ -x "\$SETTINGS_HOOK" \]/,
    );
    expect(setupSrc).toContain('"$GSTACK_CONFIG" set timeline_stop_hook "$TL_DECISION"');
  });

  test("reconciliation arm: explicit no removes a live registration", () => {
    const noArm = setupSrc.indexOf('[ "$TL_DECISION" = "no" ] && [ -x "$SETTINGS_HOOK" ]');
    expect(noArm).toBeGreaterThan(-1);
    const arm = setupSrc.slice(noArm, noArm + 400);
    expect(arm).toContain("remove-source --source gstack-timeline-stop");
  });

  test("--no-team semantics unchanged: NO_TEAM_MODE stays a hardcoded initializer", () => {
    expect(setupSrc).toContain("NO_TEAM_MODE=0");
    expect(setupSrc).not.toMatch(/NO_TEAM_MODE=\$\(/);
  });
});

describe("gstack-config: timeline_stop_hook key surface", () => {
  function runConfig(args: string[], home: string): { stdout: string; stderr: string; status: number | null } {
    const r = spawnSync(CONFIG, args, {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, GSTACK_HOME: home, GSTACK_STATE_ROOT: home },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
  }

  test("default is yes; set/get round-trips; list and defaults enumerate the key", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-tlhook-"));
    try {
      expect(runConfig(["get", "timeline_stop_hook"], home).stdout.trim()).toBe("yes");
      expect(runConfig(["defaults"], home).stdout).toContain("timeline_stop_hook:");
      runConfig(["set", "timeline_stop_hook", "no"], home);
      expect(runConfig(["get", "timeline_stop_hook"], home).stdout.trim()).toBe("no");
      expect(runConfig(["list"], home).stdout).toContain("timeline_stop_hook:");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("malformed values warn and default to yes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-tlhook-"));
    try {
      const r = runConfig(["set", "timeline_stop_hook", "banana"], home);
      expect(r.stderr).toContain("not recognized");
      expect(runConfig(["get", "timeline_stop_hook"], home).stdout.trim()).toBe("yes");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
