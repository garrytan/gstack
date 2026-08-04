import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import {
  execGbrainText,
  spawnGbrain,
  spawnGbrainAsync,
} from "../lib/gbrain-exec";

const ARGS = [
  "search",
  "",
  "space separated",
  "ampersand&whoami",
  "pipe|whoami",
  "caret^value",
  "%PATH%",
  "!DELAYED!",
  "single'quote",
  'double"quote',
  "backslash\\value",
  "parentheses(value)",
];

function makeFakeGbrain(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "gstack-gbrain-argv-"));
  const capture = join(root, "capture.ts");
  writeFileSync(
    capture,
    [
      "const args = Bun.argv.slice(2);",
      'if (args[0] === "fail") {',
      '  console.error("expected failure");',
      "  process.exit(17);",
      "}",
      "console.log(JSON.stringify(args));",
      "",
    ].join("\n"),
  );

  if (process.platform === "win32") {
    writeFileSync(join(root, "gbrain.cmd"), `@echo off\r\nbun "${capture}" %*\r\n`);
  } else {
    const shim = join(root, "gbrain");
    writeFileSync(shim, `#!/usr/bin/env bun\nimport "${capture}";\n`);
    chmodSync(shim, 0o755);
  }

  return {
    root,
    env: {
      ...process.env,
      HOME: root,
      GBRAIN_HOME: join(root, ".gbrain"),
      PATH: `${root}${delimiter}${process.env.PATH || ""}`,
    },
  };
}

function captureAsync(
  child: ReturnType<typeof spawnGbrainAsync>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("gbrain argv integrity", () => {
  test("spawnGbrain passes shell metacharacters as literal argv", () => {
    const fake = makeFakeGbrain();
    try {
      const result = spawnGbrain(ARGS, { baseEnv: fake.env });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(ARGS);
    } finally {
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  test("execGbrainText preserves argv and exposes non-zero child metadata", () => {
    const fake = makeFakeGbrain();
    try {
      expect(JSON.parse(execGbrainText(ARGS, { baseEnv: fake.env }))).toEqual(ARGS);

      let failure: (Error & { status?: number; stderr?: string }) | undefined;
      try {
        execGbrainText(["fail"], { baseEnv: fake.env });
      } catch (error) {
        failure = error as Error & { status?: number; stderr?: string };
      }
      expect(failure?.status).toBe(17);
      expect(failure?.stderr).toContain("expected failure");
    } finally {
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  test("spawnGbrainAsync preserves literal argv", async () => {
    const fake = makeFakeGbrain();
    try {
      const result = await captureAsync(spawnGbrainAsync(ARGS, {
        baseEnv: fake.env,
        stdio: ["ignore", "pipe", "pipe"],
      }));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(ARGS);
    } finally {
      rmSync(fake.root, { recursive: true, force: true });
    }
  });
});
