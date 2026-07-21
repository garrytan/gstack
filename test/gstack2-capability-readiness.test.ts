import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../runtime/cli.js";
import { capabilityReadiness, formatCapabilityReadiness } from "../runtime/doctor.js";
import { setupRuntime } from "../runtime/setup.js";

function report(checks: Array<Record<string, unknown>>) {
  return {
    ok: !checks.some((check) => check.status === "fail"),
    home: "/fixture/.gstack",
    checkedAt: "2026-07-20T00:00:00.000Z",
    checks,
  };
}

function capture() {
  let value = "";
  return { stream: { write: (chunk: string) => { value += chunk; } }, value: () => value };
}

describe("capability readiness", () => {
  test("keeps pure judgment, preview consent, and install consent separate when unavailable", () => {
    const result = capabilityReadiness(report([
      { id: "managed-runtime", status: "fail", message: "No active managed runtime" },
      { id: "capability:pdf", status: "warn", message: "not installed" },
    ]), "pdf");

    expect(result).toMatchObject({
      ok: false,
      judgment: { status: "available" },
      platform: { status: "supported" },
      consent: {
        preview: { status: "required", granted: false },
        install: { status: "required-after-preview", granted: false },
      },
      readiness: { status: "unavailable" },
    });
  });

  test("distinguishes ready, degraded, and failed runtime states", () => {
    const ready = capabilityReadiness(report([
      { id: "managed-runtime", status: "pass", message: "active" },
      { id: "capability:design", status: "pass", message: "runnable" },
    ]), "design");
    const degraded = capabilityReadiness(report([
      { id: "managed-runtime", status: "warn", message: "recovered" },
      { id: "capability:design", status: "pass", message: "runnable" },
    ]), "design");
    const failed = capabilityReadiness(report([
      { id: "managed-runtime", status: "pass", message: "active" },
      { id: "capability:diagram", status: "fail", message: "launcher metadata missing" },
    ]), "diagram");
    // A hard runtime failure under a launchable capability is not a warning:
    // it must not report ok:true, matching plain `gstack doctor`'s exit code.
    const runtimeFailed = capabilityReadiness(report([
      { id: "managed-runtime", status: "fail", message: "incompatible skill API" },
      { id: "capability:browser", status: "pass", message: "launched" },
    ]), "browser");

    expect(ready).toMatchObject({ ok: true, readiness: { status: "ready" } });
    expect(degraded).toMatchObject({ ok: true, readiness: { status: "degraded" } });
    expect(failed).toMatchObject({ ok: false, readiness: { status: "failed" } });
    expect(failed.consent.install.status).toBe("required-after-preview");
    expect(runtimeFailed).toMatchObject({ ok: false, readiness: { status: "failed" } });
  });

  test("reports physical iOS as unsupported without turning off pure judgment", () => {
    const result = capabilityReadiness(report([]), "ios", { platform: "linux" });
    expect(result).toMatchObject({
      ok: false,
      judgment: { status: "available" },
      platform: { status: "unsupported", platform: "linux" },
      consent: {
        preview: { status: "not-applicable" },
        install: { status: "not-applicable" },
      },
      readiness: { status: "unsupported" },
    });
  });

  test("human output exposes every state axis", () => {
    const result = capabilityReadiness(report([
      { id: "managed-runtime", status: "pass", message: "active" },
      { id: "capability:browser", status: "pass", message: "launched" },
    ]), "browser");
    expect(formatCapabilityReadiness(result)).toContain("judgment: available");
    expect(formatCapabilityReadiness(result)).toContain("preview consent: not-required");
    expect(formatCapabilityReadiness(result)).toContain("install consent: not-required");
    expect(formatCapabilityReadiness(result)).toContain("readiness: ready");
  });

  test("doctor capability JSON is non-mutating and uses the unified result envelope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-capability-doctor-"));
    const home = path.join(root, "home");
    const stdout = capture();
    const stderr = capture();
    try {
      await setupRuntime({ home, cwd: root });
      const exit = await main(["doctor", "--capability", "pdf", "--json"], {
        cwd: root,
        env: { ...process.env, GSTACK_HOME: home },
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      const result = JSON.parse(stdout.value());
      expect(exit).toBe(1);
      expect(stderr.value()).toBe("");
      expect(result).toMatchObject({
        schemaVersion: 1,
        status: "degraded",
        code: "CAPABILITY_UNAVAILABLE",
        data: {
          ok: false,
          capability: "pdf",
          judgment: { status: "available" },
          readiness: { status: "unavailable" },
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
