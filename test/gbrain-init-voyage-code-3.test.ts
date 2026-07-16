/**
 * Tests the voyage-code-3 default contract in setup-gbrain's PGLite init
 * sequences. The contract lives in the skill TEMPLATE (.tmpl), not in a TS
 * helper — the skill follows AI-readable instructions.
 *
 * Contract (asserted here):
 *   1. When VOYAGE_API_KEY is set, gstack's PGLite init passes
 *      --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024
 *   2. When VOYAGE_API_KEY is unset, those flags are omitted (gbrain's
 *      auto-selected provider chain takes over)
 *
 * Why a separate file from gbrain-init-rollback.test.ts: that file owns the
 * .bak-rollback contract (Step 1.5 / 4.5 plan D7). This file owns the
 * embedding-model selection contract. Both extract bash from the skill
 * template and execute it against a fake gbrain.
 *
 * The fake gbrain records argv to a sentinel file so the test can assert
 * exact flags. No Voyage API calls are made.
 */

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

interface FakeEnv {
  tmp: string;
  home: string;
  bindir: string;
  argvLog: string;
  cleanup: () => void;
}

function makeFakeEnv(): FakeEnv {
  const tmp = mkdtempSync(join(tmpdir(), "gbrain-voyage-init-"));
  const home = join(tmp, "home");
  const bindir = join(tmp, "bin");
  const argvLog = join(tmp, "gbrain-argv.log");
  mkdirSync(join(home, ".gbrain"), { recursive: true });
  mkdirSync(bindir, { recursive: true });

  // Fake gbrain logs every argv invocation to argvLog (one line per call),
  // succeeds on init (writes a sentinel pglite config), and returns canned
  // output for --version. Nothing else is needed for the shape test.
  const fake = `#!/bin/sh
echo "$@" >> "${argvLog}"
case "$1" in
  --version)
    echo "gbrain 0.37.1.0"
    exit 0
    ;;
  init)
    cat > "${home}/.gbrain/config.json" <<JSON
{"engine":"pglite","database_path":"${home}/.gbrain/brain.pglite"}
JSON
    echo '{"status":"success","engine":"pglite","pages":0}'
    exit 0
    ;;
esac
exit 0
`;
  writeFileSync(join(bindir, "gbrain"), fake);
  chmodSync(join(bindir, "gbrain"), 0o755);

  return {
    tmp,
    home,
    bindir,
    argvLog,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/**
 * Verbatim reimplementation of the skill template's voyage-code-3
 * conditional. The template (setup-gbrain/SKILL.md.tmpl Path 3, Step 1.5
 * inside the rollback wrapper, Step 4.5 Path 4 Yes branch) instructs the
 * model to execute this bash; we execute the same bash here and assert the
 * argv passed to gbrain matches the contract.
 *
 * If the template changes the flag set or the env-var name, this test
 * should fail until the shell here is updated too — by design.
 */
function runInitWithVoyageGate(env: FakeEnv, voyageKey: string | undefined): string[] {
  const script = `
set -u
GBRAIN_EMBED_FLAGS=""
if [ -n "\${VOYAGE_API_KEY:-}" ]; then
  GBRAIN_EMBED_FLAGS="--embedding-model voyage:voyage-code-3 --embedding-dimensions 1024"
fi
gbrain init --pglite --json $GBRAIN_EMBED_FLAGS
`;
  const baseEnv: Record<string, string> = {
    ...process.env,
    HOME: env.home,
    PATH: `${env.bindir}:/usr/bin:/bin`,
  };
  if (voyageKey === undefined) {
    delete baseEnv.VOYAGE_API_KEY;
  } else {
    baseEnv.VOYAGE_API_KEY = voyageKey;
  }
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: baseEnv,
  });
  if (result.status !== 0) {
    throw new Error(`init script exited ${result.status}: ${result.stderr}`);
  }
  return readFileSync(env.argvLog, "utf-8").trim().split("\n");
}

describe("voyage-code-3 default for gstack-driven PGLite init", () => {
  it("passes voyage-code-3 flags when VOYAGE_API_KEY is set", () => {
    const env = makeFakeEnv();
    try {
      const calls = runInitWithVoyageGate(env, "vk_test_set");
      expect(calls.length).toBe(1);
      const argv = calls[0];
      expect(argv).toContain("init --pglite --json");
      expect(argv).toContain("--embedding-model voyage:voyage-code-3");
      expect(argv).toContain("--embedding-dimensions 1024");
    } finally {
      env.cleanup();
    }
  });

  it("omits voyage flags when VOYAGE_API_KEY is unset", () => {
    const env = makeFakeEnv();
    try {
      const calls = runInitWithVoyageGate(env, undefined);
      expect(calls.length).toBe(1);
      const argv = calls[0];
      expect(argv).toContain("init --pglite --json");
      expect(argv).not.toContain("voyage");
      expect(argv).not.toContain("--embedding-model");
      expect(argv).not.toContain("--embedding-dimensions");
    } finally {
      env.cleanup();
    }
  });

  it("treats empty-string VOYAGE_API_KEY the same as unset (no false positive)", () => {
    const env = makeFakeEnv();
    try {
      const calls = runInitWithVoyageGate(env, "");
      expect(calls.length).toBe(1);
      expect(calls[0]).not.toContain("voyage");
    } finally {
      env.cleanup();
    }
  });
});

describe("template alignment: the .tmpl actually contains the voyage gate", () => {
  // Belt-and-suspenders: if someone edits the template and drops the
  // VOYAGE_API_KEY conditional without updating the test above, this catches
  // it. The shell snippet under test must literally appear in the .tmpl.
  const TEMPLATE_PATH = join(import.meta.dir, "..", "setup-gbrain", "SKILL.md.tmpl");
  const tmpl = readFileSync(TEMPLATE_PATH, "utf-8");

  it("setup-gbrain template gates the embedding-model flag on VOYAGE_API_KEY", () => {
    // Should appear at least once (currently 3 init sites use the same gate).
    expect(tmpl).toContain('if [ -n "${VOYAGE_API_KEY:-}" ]; then');
    expect(tmpl).toContain("--embedding-model voyage:voyage-code-3");
    expect(tmpl).toContain("--embedding-dimensions 1024");
  });

  it("setup-gbrain template uses the conditional gate at all 3 PGLite init sites", () => {
    // Count the gate occurrences. If a future edit adds/removes a PGLite
    // init site, update this expectation deliberately.
    const matches = tmpl.match(/if \[ -n "\$\{VOYAGE_API_KEY:-\}" \]; then/g);
    expect(matches?.length).toBe(3);
  });
});
