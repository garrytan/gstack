/**
 * Unit tests for cycleCompleted() in lib/gbrain-sources.ts.
 *
 * cycleCompleted reads `gbrain doctor --json --fast` and decides whether a
 * source's call graph (the brain-global resolve_symbol_edges phase) has been
 * built. We put a fake `gbrain` on PATH that emits canned doctor JSON so the
 * decision table can be exercised without a live brain. Same PATH-injection
 * trick as test/gbrain-sources.test.ts (Bun's spawn caches PATH at process
 * start; explicit env is the only reliable redirect).
 */

import { afterAll, describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { spawnSync } from "child_process";

import { cycleCompleted } from "../lib/gbrain-sources";

const FAKE_BUILD_ROOT = mkdtempSync(join(tmpdir(), "gbrain-cycle-fake-bin-"));
const FAKE_SOURCE = join(FAKE_BUILD_ROOT, "fake-gbrain.ts");
const FAKE_BINARY = join(FAKE_BUILD_ROOT, process.platform === "win32" ? "gbrain.exe" : "gbrain");

writeFileSync(
  FAKE_SOURCE,
  `const args = process.argv.slice(2);
if (args.join(" ") !== "doctor --json --fast") process.exit(1);
const exitCode = Number(process.env.FAKE_GBRAIN_DOCTOR_EXIT || "0");
if (exitCode !== 0) process.exit(exitCode);
process.stdout.write(process.env.FAKE_GBRAIN_DOCTOR_JSON || "");
`,
);
const fakeBuild = spawnSync(
  process.execPath,
  ["build", FAKE_SOURCE, "--compile", "--outfile", FAKE_BINARY],
  { encoding: "utf-8", timeout: 30_000 },
);
if (fakeBuild.status !== 0) {
  throw new Error(`Could not build fake gbrain: ${fakeBuild.stderr || fakeBuild.stdout}`);
}
chmodSync(FAKE_BINARY, 0o755);

afterAll(() => rmSync(FAKE_BUILD_ROOT, { recursive: true, force: true }));

interface FakeSetup {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/**
 * Fake `gbrain`:
 *   doctor --json --fast   → echo $DOCTOR_JSON (or exit $DOCTOR_EXIT if set)
 *   anything else          → exit 1
 * Each test supplies its doctor result through the child environment while all
 * tests reuse one compiled, cross-platform executable shim.
 */
function makeFakeGbrain(opts: { doctorJson?: string; doctorExit?: number }): FakeSetup {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${FAKE_BUILD_ROOT}${delimiter}${process.env.PATH || ""}`,
    FAKE_GBRAIN_DOCTOR_EXIT: String(opts.doctorExit ?? 0),
    FAKE_GBRAIN_DOCTOR_JSON: opts.doctorJson ?? "",
  };
  return { env, cleanup: () => undefined };
}

const SRC = "gstack-code-gstack-c5994d95";

function doctor(check: { name: string; status: string; message?: string } | null): string {
  return JSON.stringify({ checks: check ? [check] : [] });
}

describe("cycleCompleted", () => {
  it("returns 'completed' when cycle_freshness is ok", () => {
    const fake = makeFakeGbrain({
      doctorJson: doctor({ name: "cycle_freshness", status: "ok", message: "all sources fresh" }),
    });
    expect(cycleCompleted(SRC, fake.env)).toBe("completed");
    fake.cleanup();
  });

  it("returns 'never' when cycle_freshness fails AND names this source", () => {
    const fake = makeFakeGbrain({
      doctorJson: doctor({
        name: "cycle_freshness",
        status: "fail",
        message: `Source '${SRC}' has never completed a full cycle. Run gbrain dream.`,
      }),
    });
    expect(cycleCompleted(SRC, fake.env)).toBe("never");
    fake.cleanup();
  });

  it("returns 'unknown' when cycle_freshness fails but names only OTHER sources", () => {
    const fake = makeFakeGbrain({
      doctorJson: doctor({
        name: "cycle_freshness",
        status: "fail",
        message: "Source 'some-other-source' has never completed a full cycle.",
      }),
    });
    // A real failure that doesn't mention us must NOT be read as completed.
    expect(cycleCompleted(SRC, fake.env)).toBe("unknown");
    fake.cleanup();
  });

  it("returns 'unknown' when the cycle_freshness check is absent", () => {
    const fake = makeFakeGbrain({
      doctorJson: doctor({ name: "engine_health", status: "ok" }),
    });
    expect(cycleCompleted(SRC, fake.env)).toBe("unknown");
    fake.cleanup();
  });

  it("returns 'unknown' when doctor exits non-zero", () => {
    const fake = makeFakeGbrain({ doctorExit: 1 });
    expect(cycleCompleted(SRC, fake.env)).toBe("unknown");
    fake.cleanup();
  });

  it("returns 'unknown' when doctor emits non-JSON", () => {
    const fake = makeFakeGbrain({ doctorJson: "not json at all" });
    expect(cycleCompleted(SRC, fake.env)).toBe("unknown");
    fake.cleanup();
  });

  it("matches the source id as a LITERAL substring (regex metachars are inert)", () => {
    // An id containing regex metachars must match literally, not as a pattern.
    const metaId = "gstack-code-a.b+c";
    const fake = makeFakeGbrain({
      doctorJson: doctor({
        name: "cycle_freshness",
        status: "warn",
        message: `Source '${metaId}' has never completed a full cycle.`,
      }),
    });
    expect(cycleCompleted(metaId, fake.env)).toBe("never");
    // A different id that a regex 'a.b+c' would also match must NOT match literally.
    expect(cycleCompleted("gstack-code-aXbc", fake.env)).toBe("unknown");
    fake.cleanup();
  });
});
