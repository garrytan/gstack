import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";

import codex from "../hosts/codex";
import { planGbrainSpawn } from "../lib/gbrain-exec";
import { sourcePathsEqual } from "../lib/gbrain-sources";
import { planSourceScopedDream } from "../bin/gstack-gbrain-sync";

const ROOT = join(import.meta.dir, "..");
const SETUP = readFileSync(join(ROOT, "setup"), "utf-8");

function setupFunction(name: string): string {
  const start = SETUP.indexOf(`${name}() {`);
  const end = SETUP.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${name} from setup`);
  return SETUP.slice(start, end + 2);
}

function bashExecutable(): string {
  if (process.platform === "win32") {
    const git = Bun.which("git");
    if (git) {
      const gitBash = resolve(dirname(git), "..", "bin", "bash.exe");
      if (existsSync(gitBash)) return gitBash;
    }
  }
  return Bun.which("bash") || "bash";
}

describe("DEV-206 Windows Codex runtime and GBrain regressions", () => {
  test("Codex runtime metadata and setup include lib beside imported bin scripts", () => {
    expect(codex.runtimeRoot.globalSymlinks).toContain("lib");
    expect(codex.sidecar?.symlinks).toContain("lib");

    const runtimeStart = SETUP.indexOf("create_codex_runtime_root() {");
    const runtimeEnd = SETUP.indexOf("\n}\n", runtimeStart);
    const runtimeBody = SETUP.slice(runtimeStart, runtimeEnd);
    expect(runtimeBody).toContain('_link_or_copy "$gstack_dir/lib" "$codex_gstack/lib"');

    const sidecarStart = SETUP.indexOf("create_agents_sidecar() {");
    const sidecarEnd = SETUP.indexOf("\n}\n", sidecarStart);
    const sidecarBody = SETUP.slice(sidecarStart, sidecarEnd);
    expect(sidecarBody).toMatch(/for asset in[^\n]*\blib\b/);
  });

  test("simulated Windows Codex install and upgrade preserve lib imports", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gstack-dev-206-runtime-"));
    try {
      const source = join(tmp, "source");
      const runtime = join(tmp, "codex runtime");
      mkdirSync(join(source, ".agents", "skills", "gstack"), { recursive: true });
      mkdirSync(join(source, "bin"), { recursive: true });
      mkdirSync(join(source, "lib"), { recursive: true });
      writeFileSync(join(source, ".agents", "skills", "gstack", "SKILL.md"), "---\nname: gstack\n---\n");
      writeFileSync(join(source, "lib", "runtime-marker.ts"), 'export const marker = "runtime-ok";\n');
      const detector = join(source, "bin", "gstack-gbrain-detect");
      writeFileSync(
        detector,
        '#!/usr/bin/env bun\nimport { marker } from "../lib/runtime-marker.ts";\nconsole.log(marker);\n',
      );
      chmodSync(detector, 0o755);

      const shell = [
        "set -e",
        "IS_WINDOWS=1",
        setupFunction("_link_or_copy"),
        setupFunction("create_codex_runtime_root"),
        'create_codex_runtime_root "$1" "$2"',
      ].join("\n");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const install = spawnSync(bashExecutable(), ["-c", shell, "dev-206", source, runtime], {
          encoding: "utf-8",
          timeout: 15_000,
        });
        expect(install.status).toBe(0);
        expect(install.stderr).toBe("");
      }

      const run = spawnSync(process.execPath, [join(runtime, "bin", "gstack-gbrain-detect")], {
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("runtime-ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("equivalent Windows slash and case forms compare as one resolved source", () => {
    expect(sourcePathsEqual("C:\\Work Trees\\Example Repo", "c:/work trees/example repo", "win32")).toBe(true);
    expect(sourcePathsEqual("C:\\Work Trees\\Example Repo", "D:/work trees/example repo", "win32")).toBe(false);
  });

  test("Windows source registration keeps a path containing spaces as one argv value", () => {
    const sourcePath = "C:\\Work Trees\\Example Repo";
    const args = ["sources", "add", "gstack-code-test", "--path", sourcePath, "--federated"];
    const plan = planGbrainSpawn(args, "C:\\Program Files\\Bun\\gbrain.exe", "win32");

    expect(plan.command).toBe("C:\\Program Files\\Bun\\gbrain.exe");
    expect(plan.args).toEqual(args);
    expect(plan.args[4]).toBe(sourcePath);
    expect(plan.shell).toBe(false);
  });

  test("dream capability planning refuses a brain-wide fallback", () => {
    const supported = planSourceScopedDream(
      "gstack-code-test",
      0,
      "Usage: gbrain dream [--source <id>]",
    );
    expect(supported).toEqual({ ok: true, args: ["dream", "--source", "gstack-code-test"] });

    const brainWideOnly = planSourceScopedDream(
      "gstack-code-test",
      0,
      "Usage: gbrain dream",
    );
    expect(brainWideOnly.ok).toBe(false);
    if (!brainWideOnly.ok) {
      expect(brainWideOnly.error).toContain("does not support --source");
      expect(brainWideOnly.error).toContain("refusing to widen scope");
    }
  });
});
