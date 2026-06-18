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

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { cycleCompleted } from "../lib/gbrain-sources";

interface FakeSetup {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/**
 * Fake `gbrain`:
 *   doctor --json --fast   → echo $DOCTOR_JSON (or exit $DOCTOR_EXIT if set)
 *   anything else          → exit 1
 * The doctor payload is baked into the script so each test gets its own shim.
 */
function makeFakeGbrain(opts: { doctorJson?: string; doctorExit?: number }): FakeSetup {
  const tmp = mkdtempSync(join(tmpdir(), "gbrain-cycle-test-"));
  const bindir = join(tmp, "bin");
  mkdirSync(bindir, { recursive: true });

  const exit = opts.doctorExit ?? 0;
  // Single-quote the JSON for the heredoc-free echo; escape embedded single quotes.
  const payload = (opts.doctorJson ?? "").replace(/'/g, "'\\''");
  const fake = `#!/bin/sh
case "$1 $2 $3" in
  "doctor --json --fast")
    if [ ${exit} -ne 0 ]; then exit ${exit}; fi
    printf '%s' '${payload}'
    exit 0
    ;;
esac
echo "fake gbrain: unknown command: $@" >&2
exit 1
`;
  const fakePath = join(bindir, "gbrain");
  writeFileSync(fakePath, fake);
  chmodSync(fakePath, 0o755);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bindir}:${process.env.PATH || ""}` };
  return { env, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
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
