import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  cleanupRuntime,
  ensureManagedHome,
  purgeManagedHomeUnlocked,
  setupRuntime,
  uninstallManagedRuntime,
} from "../runtime/index.js";

const roots: string[] = [];
const configBin = path.resolve(import.meta.dir, "../bin/gstack-config");
const gstackBin = path.resolve(import.meta.dir, "../bin/gstack");

async function root() {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), "gstack2-safety-config-"));
  roots.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("managed-home destructive boundary", () => {
  test("claims only a new or empty directory and leaves nonempty input untouched", async () => {
    const base = await root();
    const occupied = path.join(base, "occupied");
    await fs.mkdir(occupied);
    await fs.writeFile(path.join(occupied, "keep.txt"), "keep\n");
    await expect(ensureManagedHome(occupied)).rejects.toMatchObject({ code: "MANAGED_HOME_UNOWNED" });
    expect(await fs.readdir(occupied)).toEqual(["keep.txt"]);

    const empty = path.join(base, "empty");
    await fs.mkdir(empty);
    expect((await ensureManagedHome(empty)).created).toBe(true);
    expect((await ensureManagedHome(empty)).created).toBe(false);
  });

  test("cleanup refuses an unowned directory even when names match runtime scratch", async () => {
    const base = await root();
    const home = path.join(base, "unowned");
    const scratch = path.join(home, "tmp", "install-11111111-1111-4111-8111-111111111111");
    await fs.mkdir(scratch, { recursive: true });
    await expect(cleanupRuntime(home, { olderThanMs: 0 })).rejects.toMatchObject({ code: "MANAGED_HOME_UNOWNED" });
    expect((await fs.stat(scratch)).isDirectory()).toBe(true);
  });

  test("purge removes managed state but preserves unrelated entries", async () => {
    const base = await root();
    const home = path.join(base, "owned");
    await ensureManagedHome(home);
    await fs.mkdir(path.join(home, "projects", "fixture"), { recursive: true });
    await fs.writeFile(path.join(home, "unrelated.txt"), "keep\n");
    const result = await purgeManagedHomeUnlocked(home);
    expect(result.preserved).toEqual(["unrelated.txt"]);
    expect(await fs.readFile(path.join(home, "unrelated.txt"), "utf8")).toBe("keep\n");
    expect(await fs.stat(path.join(home, ".gstack-managed-home.json")).catch(() => null)).toBeNull();
  });

  test("recognized legacy config is adopted without purging pre-existing state", async () => {
    const base = await root();
    const home = path.join(base, ".gstack");
    await fs.mkdir(path.join(home, "projects", "legacy-project"), { recursive: true });
    await fs.writeFile(path.join(home, "config.yaml"), "telemetry: off\n");
    await fs.writeFile(path.join(home, "projects", "legacy-project", "notes.md"), "keep\n");
    const ownership = await ensureManagedHome(home);
    expect(ownership.sentinel).toMatchObject({
      adoptedLegacy: true,
      preexistingTopLevel: ["config.yaml", "projects"],
    });
    await fs.writeFile(path.join(home, "config.json"), "{}\n");
    const result = await purgeManagedHomeUnlocked(home);
    expect(result.preserved.sort()).toEqual(["config.yaml", "projects"]);
    expect(await fs.readFile(path.join(home, "projects", "legacy-project", "notes.md"), "utf8")).toBe("keep\n");
    expect(await fs.readFile(path.join(home, "config.yaml"), "utf8")).toBe("telemetry: off\n");
    expect(await fs.stat(path.join(home, "config.json")).catch(() => null)).toBeNull();
  });

  test("recognized legacy artifacts repo is adopted but near-misses remain unowned", async () => {
    const base = await root();
    const home = path.join(base, "artifacts");
    await fs.mkdir(path.join(home, ".git"), { recursive: true });
    await fs.writeFile(path.join(home, ".gitignore"), "# gstack-artifacts sync via .brain-allowlist\n*\n");
    await fs.writeFile(path.join(home, ".brain-allowlist"), "projects/*/learnings.jsonl\nretros/*.md\n");
    await fs.writeFile(path.join(home, ".brain-privacy-map.json"), JSON.stringify([
      { pattern: "projects/*/learnings.jsonl", class: "artifact" },
    ]));
    await fs.writeFile(path.join(home, ".gitattributes"), "*.jsonl merge=jsonl-append\n");
    await fs.mkdir(path.join(home, "projects", "legacy-project"), { recursive: true });
    await fs.writeFile(path.join(home, "projects", "legacy-project", "learnings.jsonl"), "{\"keep\":true}\n");

    const ownership = await ensureManagedHome(home);
    expect(ownership.sentinel).toMatchObject({
      adoptedLegacy: true,
      preexistingTopLevel: [
        ".brain-allowlist",
        ".brain-privacy-map.json",
        ".git",
        ".gitattributes",
        ".gitignore",
        "projects",
      ],
    });
    const purged = await purgeManagedHomeUnlocked(home);
    expect(purged.preserved.sort()).toEqual([
      ".brain-allowlist",
      ".brain-privacy-map.json",
      ".git",
      ".gitattributes",
      ".gitignore",
      "projects",
    ]);
    expect(await fs.readFile(path.join(home, "projects", "legacy-project", "learnings.jsonl"), "utf8")).toBe("{\"keep\":true}\n");

    const nearMiss = path.join(base, "near-miss");
    await fs.mkdir(path.join(nearMiss, ".git"), { recursive: true });
    await fs.writeFile(path.join(nearMiss, ".brain-allowlist"), "projects/*/learnings.jsonl\nretros/*.md\n");
    await expect(ensureManagedHome(nearMiss)).rejects.toMatchObject({ code: "MANAGED_HOME_UNOWNED" });
    expect((await fs.readdir(nearMiss)).sort()).toEqual([".brain-allowlist", ".git"]);
  });

  test("setup and purge serialize across the complete managed-home mutation", async () => {
    const base = await root();
    const home = path.join(base, "state");
    const project = path.join(base, "project");
    await fs.mkdir(project);

    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const git = async (args: string[]) => {
      const operation = args.at(-1);
      if (operation === "--show-toplevel") {
        enteredResolve();
        await release;
        return project;
      }
      return path.join(project, ".git");
    };

    const settingUp = setupRuntime({ home, cwd: project, git });
    await entered;
    let purgeFinished = false;
    const purging = uninstallManagedRuntime(home, { purge: true }).then((result) => {
      purgeFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(purgeFinished).toBe(false);
    expect(await fs.stat(path.join(home, ".gstack-managed-home.json"))).toBeTruthy();

    releaseResolve();
    await settingUp;
    await purging;
    expect(await fs.stat(path.join(home, ".gstack-managed-home.json")).catch(() => null)).toBeNull();
  });
});

describe("one config authority", () => {
  test("compatibility helper and runtime config share config.json", async () => {
    const home = path.join(await root(), "state");
    const run = (args: string[]) => spawnSync(configBin, args, {
      encoding: "utf8",
      env: { ...process.env, GSTACK_HOME: home },
    });
    expect(run(["set", "telemetry", "anonymous"]).status).toBe(0);
    expect(run(["get", "telemetry"]).stdout).toBe("anonymous");
    expect(JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8")).telemetry).toBe("anonymous");
    expect(await fs.stat(path.join(home, "config.yaml")).catch(() => null)).toBeNull();
  });

  test("public config set claims a managed home before writing and remains setup-compatible", async () => {
    const base = await root();
    const home = path.join(base, "state");
    const project = path.join(base, "project");
    await fs.mkdir(project);
    const run = (args: string[]) => spawnSync(process.execPath, [gstackBin, ...args], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, GSTACK_HOME: home },
    });

    const set = run(["config", "set", "telemetry", "anonymous"]);
    expect(set.status).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(home, ".gstack-managed-home.json"), "utf8"))).toMatchObject({
      kind: "gstack-managed-home",
      home,
    });
    expect(JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8")).telemetry).toBe("anonymous");
    const setup = run(["setup"]);
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("gstack is ready");
  });

  test("legacy YAML is read-only migration input and JSON takes authority on write", async () => {
    const home = path.join(await root(), "legacy");
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "config.yaml"), "telemetry: community\n");
    const get = spawnSync(configBin, ["get", "telemetry"], {
      encoding: "utf8",
      env: { ...process.env, GSTACK_HOME: home },
    });
    expect(get.status).toBe(0);
    expect(get.stdout).toBe("community");
    const set = spawnSync(configBin, ["set", "telemetry", "off"], {
      encoding: "utf8",
      env: { ...process.env, GSTACK_HOME: home },
    });
    expect(set.status).toBe(0);
    expect(await fs.readFile(path.join(home, "config.yaml"), "utf8")).toBe("telemetry: community\n");
    expect(JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8")).telemetry).toBe("off");
    const reread = spawnSync(configBin, ["get", "telemetry"], {
      encoding: "utf8",
      env: { ...process.env, GSTACK_HOME: home },
    });
    expect(reread.stdout).toBe("off");
    expect(JSON.parse(await fs.readFile(path.join(home, ".gstack-managed-home.json"), "utf8"))).toMatchObject({
      adoptedLegacy: true,
      preexistingTopLevel: ["config.yaml"],
    });
  });

  test("shipped runtime helper surface excludes host-specific skill installers", async () => {
    const install = await fs.readFile(path.resolve(import.meta.dir, "../runtime/install.js"), "utf8");
    const config = await fs.readFile(configBin, "utf8");
    expect(install).not.toContain('"gstack-team-init": helper');
    expect(config).not.toMatch(/\.claude\/skills|gstack-relink|gen:skill-docs:user/);
  });
});
