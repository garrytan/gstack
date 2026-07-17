import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../runtime/cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed runtime asset resolution", () => {
  test("resolves only an existing asset inside the active immutable version", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-runtime-path-"));
    roots.push(root);
    const home = path.join(root, "home with spaces");
    const versionRoot = path.join(home, "versions", "2.0.0");
    const asset = path.join(versionRoot, "lib", "diagram-render", "dist", "diagram-render.html");
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, "offline diagram bundle\n");
    await fs.writeFile(path.join(home, "versions", "current.json"), `${JSON.stringify({ current: "2.0.0" })}\n`);

    let stdout = "";
    let stderr = "";
    const output = { write(value: string) { stdout += value; } };
    const errors = { write(value: string) { stderr += value; } };
    const options = { env: { GSTACK_HOME: home }, cwd: root, stdout: output, stderr: errors };

    expect(await main(["runtime", "path", "lib/diagram-render/dist/diagram-render.html"], options)).toBe(0);
    expect(stdout.trim()).toBe(asset);
    expect(stderr).toBe("");

    stdout = "";
    expect(await main(["runtime", "path", "../secrets.json"], options)).toBe(2);
    expect(stderr).toContain("safe relative path");

    stderr = "";
    expect(await main(["runtime", "path", "missing.txt"], options)).toBe(1);
    expect(stderr).toContain("Managed runtime asset is unavailable");
  });

  test("does not follow a managed asset symlink", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-runtime-path-link-"));
    roots.push(root);
    const home = path.join(root, "home");
    const versionRoot = path.join(home, "versions", "2.0.0");
    await fs.mkdir(versionRoot, { recursive: true });
    await fs.writeFile(path.join(root, "outside"), "private\n");
    await fs.symlink(path.join(root, "outside"), path.join(versionRoot, "asset"));
    await fs.writeFile(path.join(home, "versions", "current.json"), `${JSON.stringify({ current: "2.0.0" })}\n`);
    let stderr = "";
    const sink = { write(_value: string) {} };
    const errors = { write(value: string) { stderr += value; } };
    expect(await main(["runtime", "path", "asset"], {
      env: { GSTACK_HOME: home }, cwd: root, stdout: sink, stderr: errors,
    })).toBe(1);
    expect(stderr).toContain("Managed runtime asset is unavailable");
  });
});
