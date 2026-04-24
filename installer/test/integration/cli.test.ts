import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTmpDir, rmTmpDir, initGitRepo, write } from "../helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "..", "..", "dist", "cli.js");

interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
}

function runCli(args: string[], opts: RunOpts = {}) {
  const env = { ...process.env, ...(opts.env ?? {}) };
  const result = spawnSync("node", [CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env,
    encoding: "utf-8",
    timeout: 10_000,
  });
  return {
    code: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("cli: --help and --version", () => {
  test("--help exits 0 and prints usage", () => {
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("gstack");
    expect(r.stdout).toContain("Commands:");
    expect(r.stdout).toContain("install");
    expect(r.stdout).toContain("init");
  });

  test("-h works as --help", () => {
    const r = runCli(["-h"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Commands:");
  });

  test("--version prints the package version", () => {
    const r = runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("cli: unknown command", () => {
  test("exits 2 with error message", () => {
    const r = runCli(["bogus-command"]);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toContain("Unknown command");
  });
});

describe("cli: invalid args", () => {
  test("enable with no skill name exits 2", () => {
    const r = runCli(["enable"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage");
  });

  test("disable with no skill name exits 2", () => {
    const r = runCli(["disable"]);
    expect(r.code).toBe(2);
  });

  test("init with invalid --tier exits 2", () => {
    const r = runCli(["init", "--tier", "sometimes"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid --tier");
  });

  test("install with unknown --host exits 2", () => {
    const r = runCli(["install", "--host", "not-a-host"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown host");
  });
});

describe("cli: enable/disable flow", () => {
  let tmp: string;
  let homeTmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    homeTmp = makeTmpDir("gstack-home-");
    initGitRepo(tmp);
  });

  afterEach(() => {
    rmTmpDir(tmp);
    rmTmpDir(homeTmp);
  });

  test("disable creates settings.local.json with skill", () => {
    const r = runCli(["disable", "qa"], { cwd: tmp, env: { HOME: homeTmp } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Disabled /qa");
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmp, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.disabledSkills).toEqual(["qa"]);
  });

  test("enable removes disabled skill", () => {
    runCli(["disable", "qa"], { cwd: tmp, env: { HOME: homeTmp } });
    const r = runCli(["enable", "qa"], { cwd: tmp, env: { HOME: homeTmp } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Enabled /qa");
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmp, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.disabledSkills).toBeUndefined();
  });

  test("normalizes /-prefixed and gstack- prefixed names", () => {
    runCli(["disable", "/qa"], { cwd: tmp, env: { HOME: homeTmp } });
    runCli(["disable", "gstack-review"], { cwd: tmp, env: { HOME: homeTmp } });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmp, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.disabledSkills).toEqual(["qa", "review"]);
  });

  test("enable outside git repo exits 1", () => {
    const noRepo = makeTmpDir();
    try {
      const r = runCli(["enable", "qa"], { cwd: noRepo, env: { HOME: homeTmp } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Not inside a git repository");
    } finally {
      rmTmpDir(noRepo);
    }
  });
});

describe("cli: status with no install", () => {
  let homeTmp: string;

  beforeEach(() => {
    homeTmp = makeTmpDir("gstack-home-");
  });

  afterEach(() => {
    rmTmpDir(homeTmp);
  });

  test("exits cleanly with 'not installed' message", () => {
    const r = runCli(["status"], { env: { HOME: homeTmp } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("not installed");
  });
});

describe("cli: doctor with no install", () => {
  let homeTmp: string;

  beforeEach(() => {
    homeTmp = makeTmpDir("gstack-home-");
  });

  afterEach(() => {
    rmTmpDir(homeTmp);
  });

  test("exits 1 with install check failed", () => {
    const r = runCli(["doctor"], { env: { HOME: homeTmp } });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("install");
  });
});

describe("cli: list with no install", () => {
  let homeTmp: string;

  beforeEach(() => {
    homeTmp = makeTmpDir("gstack-home-");
  });

  afterEach(() => {
    rmTmpDir(homeTmp);
  });

  test("exits 1", () => {
    const r = runCli(["list"], { env: { HOME: homeTmp } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not installed");
  });
});

describe("cli: list against fake install", () => {
  let homeTmp: string;

  beforeEach(() => {
    homeTmp = makeTmpDir("gstack-home-");
    const gstackDir = path.join(homeTmp, ".claude", "skills", "gstack");
    fs.mkdirSync(gstackDir, { recursive: true });
    fs.writeFileSync(path.join(gstackDir, "VERSION"), "0.0.0-test");
    fs.mkdirSync(path.join(gstackDir, "qa"), { recursive: true });
    fs.writeFileSync(
      path.join(gstackDir, "qa", "SKILL.md"),
      "---\nname: qa\ndescription: Test QA skill\n---\nbody\n",
    );
    fs.mkdirSync(path.join(gstackDir, "ship"), { recursive: true });
    fs.writeFileSync(
      path.join(gstackDir, "ship", "SKILL.md"),
      "---\nname: ship\ndescription: |\n  Multiline\n  ship description\n---\n",
    );
  });

  afterEach(() => rmTmpDir(homeTmp));

  test("lists discovered skills with descriptions", () => {
    const r = runCli(["list"], { env: { HOME: homeTmp } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/qa");
    expect(r.stdout).toContain("Test QA skill");
    expect(r.stdout).toContain("/ship");
    expect(r.stdout).toContain("ship description");
  });

  test("status prints version and install path", () => {
    const r = runCli(["status"], { env: { HOME: homeTmp } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("0.0.0-test");
    expect(r.stdout).toContain("Skills:");
    expect(r.stdout).toContain("2");
  });
});

describe("cli: EPIPE handling", () => {
  let homeTmp: string;

  beforeEach(() => {
    homeTmp = makeTmpDir("gstack-home-");
    const gstackDir = path.join(homeTmp, ".claude", "skills", "gstack");
    fs.mkdirSync(gstackDir, { recursive: true });
    for (let i = 0; i < 50; i++) {
      fs.mkdirSync(path.join(gstackDir, `skill-${i}`), { recursive: true });
      fs.writeFileSync(
        path.join(gstackDir, `skill-${i}`, "SKILL.md"),
        `---\nname: skill-${i}\ndescription: skill number ${i}\n---\n`,
      );
    }
  });

  afterEach(() => rmTmpDir(homeTmp));

  test("does not crash when piped to a closed reader", () => {
    const result = spawnSync("bash", ["-c", `node ${CLI} list | head -1`], {
      env: { ...process.env, HOME: homeTmp },
      encoding: "utf-8",
      timeout: 10_000,
    });
    const combined = (result.stderr ?? "") + (result.stdout ?? "");
    expect(combined).not.toContain("EPIPE");
    expect(combined).not.toContain("Unhandled");
  });
});

describe("cli: uninstall --project", () => {
  let tmp: string;
  let homeTmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    homeTmp = makeTmpDir("gstack-home-");
    initGitRepo(tmp);

    fs.mkdirSync(path.join(tmp, ".claude", "skills", "gstack"), { recursive: true });
    write(tmp, ".claude/hooks/check-gstack.sh", "#!/bin/bash\necho gstack\n");
    write(
      tmp,
      ".claude/settings.json",
      JSON.stringify({
        theme: "dark",
        hooks: {
          PreToolUse: [
            { matcher: "Skill", hooks: [{ type: "command", command: "check-gstack.sh" }] },
          ],
        },
      }),
    );
    write(
      tmp,
      "CLAUDE.md",
      "# Project\n\n<!-- gstack:begin -->\ngstack section\n<!-- gstack:end -->\n\n# Rest\n",
    );
  });

  afterEach(() => {
    rmTmpDir(tmp);
    rmTmpDir(homeTmp);
  });

  test("removes artifacts, scrubs settings hook, preserves other settings", () => {
    const r = runCli(["uninstall", "--project", "--yes"], {
      cwd: tmp,
      env: { HOME: homeTmp },
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(tmp, ".claude", "skills", "gstack"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".claude", "hooks", "check-gstack.sh"))).toBe(false);

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.theme).toBe("dark");
    expect(settings.hooks).toBeUndefined();

    const claudeMd = fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("# Project");
    expect(claudeMd).toContain("# Rest");
    expect(claudeMd).not.toContain("gstack section");
  });

  test("--keep-claude-md preserves the gstack block", () => {
    const r = runCli(["uninstall", "--project", "--yes", "--keep-claude-md"], {
      cwd: tmp,
      env: { HOME: homeTmp },
    });
    expect(r.code).toBe(0);
    const claudeMd = fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("gstack section");
  });
});

describe("cli: no args launches wizard", () => {
  let homeTmp: string;

  beforeEach(() => {
    homeTmp = makeTmpDir("gstack-home-");
  });

  afterEach(() => {
    rmTmpDir(homeTmp);
  });

  test("prints wizard intro when stdin is closed", () => {
    const result = spawnSync("node", [CLI], {
      env: { ...process.env, HOME: homeTmp },
      encoding: "utf-8",
      timeout: 5_000,
      input: "",
    });
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("gstack");
  });
});
