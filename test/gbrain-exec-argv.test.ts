import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { spawnGbrain } from "../lib/gbrain-exec";

describe("gbrain argv integrity", () => {
  test("passes Windows shell metacharacters as literal argv", () => {
    const root = mkdtempSync(join(tmpdir(), "gstack-gbrain-argv-"));
    try {
      const capture = join(root, "capture.ts");
      writeFileSync(capture, 'console.log(JSON.stringify(Bun.argv.slice(2)));\n');

      if (process.platform === "win32") {
        writeFileSync(join(root, "gbrain.cmd"), `@echo off\r\nbun "${capture}" %*\r\n`);
      } else {
        const shim = join(root, "gbrain");
        writeFileSync(shim, `#!/usr/bin/env bun\nimport "${capture}";\n`);
        chmodSync(shim, 0o755);
      }

      const args = [
        "search",
        "space separated",
        "ampersand&whoami",
        "pipe|whoami",
        "caret^value",
        "%PATH%",
        "!DELAYED!",
        'quote"value',
        "parentheses(value)",
      ];
      const result = spawnGbrain(args, {
        baseEnv: {
          ...process.env,
          HOME: root,
          GBRAIN_HOME: join(root, ".gbrain"),
          PATH: `${root}${delimiter}${process.env.PATH || ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
