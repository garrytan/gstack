import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RUNTIME_BUNDLE } from "../runtime/install.js";

const root = path.resolve(import.meta.dir, "..");
const dockerfile = fs.readFileSync(path.join(root, ".devcontainer", "Dockerfile"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "gstack2-gate.yml"), "utf8");
const devcontainerGate = fs.readFileSync(path.join(root, "scripts", "gstack2", "devcontainer-gate.sh"), "utf8");
const smoke = fs.readFileSync(path.join(root, "scripts", "gstack2", "runtime-install-smoke.sh"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const iosSources = [
  fs.readFileSync(path.join(root, "ios-qa", "daemon", "src", "devicectl.ts"), "utf8"),
  fs.readFileSync(path.join(root, "ios-qa", "scripts", "physical-device-smoke.ts"), "utf8"),
].join("\n");

describe("GStack 2 CI supply-chain and browser smoke", () => {
  test("pins the development-container base and installs locked Chromium", () => {
    expect(dockerfile).toMatch(/^FROM oven\/bun:1\.3\.14-debian@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toContain("PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers");
    expect(dockerfile).toContain("playwright@1.58.2 install --with-deps chromium");
  });

  test("grants the workflow only read access and pins every action", () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    const actionRefs = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/g)].map((match) => match[1]);
    expect(actionRefs.length).toBeGreaterThan(0);
    for (const reference of actionRefs) expect(reference).toMatch(/^[0-9a-f]{40}$/);
  });

  test("proves clean-checkout generation before the native GStack 2 gate", () => {
    const cleanProbe = workflow.indexOf("run: bun run verify:gstack2-clean-generation");
    const nativeGate = workflow.indexOf("run: bun run test:gstack2");
    expect(cleanProbe).toBeGreaterThan(-1);
    expect(nativeGate).toBeGreaterThan(cleanProbe);
  });

  test("mounts the checkout read-only for every development-container run", () => {
    const workspaceMounts = [...workflow.matchAll(/--volume "\$\{\{ github\.workspace \}\}:([^"]+)"/g)]
      .map((match) => match[1]);
    expect(workspaceMounts).toEqual(["/source:ro", "/source:ro"]);
    expect(workflow).toContain("/source/scripts/gstack2/devcontainer-gate.sh /source");
  });

  test("installs and tests in a disposable copy without git metadata or host dependencies", () => {
    expect(devcontainerGate).toContain("mktemp -d /tmp/gstack2-devcontainer-gate.XXXXXX");
    expect(devcontainerGate).toContain("--exclude='./.git'");
    expect(devcontainerGate).toContain("--exclude='./node_modules'");
    expect(devcontainerGate).toContain("trap cleanup EXIT");
    expect(devcontainerGate).toContain("printf 'gitdir: %s\\n'");
    expect(devcontainerGate).toContain('GSTACK_GATE_BASE_GIT:-$(command -v git)');
    expect(devcontainerGate).toContain('-c safe.directory="$SOURCE"');
    expect(devcontainerGate).toContain('-c safe.directory="$GSTACK_GATE_WORK_TREE"');
    if (process.platform === "win32") return;

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gstack2-devcontainer-gate-test-"));
    const source = path.join(fixtureRoot, "source");
    const stubBin = path.join(fixtureRoot, "commands");
    const callLog = path.join(fixtureRoot, "bun-calls.log");
    fs.mkdirSync(path.join(source, "node_modules", "host-only"), { recursive: true });
    fs.mkdirSync(stubBin, { recursive: true });
    fs.writeFileSync(path.join(source, "package.json"), "{}\n");
    const gitInit = spawnSync("git", ["init", "--quiet", "--initial-branch=main", source], { encoding: "utf8" });
    expect(gitInit.status).toBe(0);
    const realGit = process.env.GSTACK_GATE_BASE_GIT ?? (process.env.PATH ?? "").split(path.delimiter)
      .map((directory) => path.join(directory, "git"))
      .find((candidate) => fs.existsSync(candidate));
    expect(realGit).toBeDefined();
    fs.writeFileSync(path.join(source, ".git", "gstack-sentinel"), "host git metadata\n");
    fs.writeFileSync(path.join(source, "node_modules", "host-only", "sentinel"), "host dependency\n");
    fs.writeFileSync(path.join(stubBin, "bun"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' "$PWD" "$*" >> "$GSTACK_TEST_CALL_LOG"
test -e package.json
test -f .git
test ! -e .git/gstack-sentinel
test ! -e node_modules/host-only
if [[ "\${GSTACK_TEST_FAIL:-0}" == "1" ]]; then exit 23; fi
if [[ "$*" == "run test:gstack2" ]]; then test "$(git rev-parse --show-toplevel)" == "$PWD"; fi
mkdir -p node_modules
touch node_modules/container-only
`, { mode: 0o755 });
    fs.writeFileSync(path.join(stubBin, "git"), "#!/usr/bin/env bash\nexit 97\n", { mode: 0o755 });

    const runGate = (fail: boolean) => {
      fs.writeFileSync(callLog, "");
      const result = spawnSync("bash", [path.join(root, "scripts", "gstack2", "devcontainer-gate.sh"), source], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ""}`,
          GSTACK_TEST_CALL_LOG: callLog,
          GSTACK_TEST_FAIL: fail ? "1" : "0",
          GSTACK_GATE_BASE_GIT: realGit,
        },
      });
      const calls = fs.readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => {
          const [cwd, args] = line.split("\t");
          return { cwd, args };
        });
      return { calls, result };
    };

    try {
      const success = runGate(false);
      expect(success.result.stderr).toBe("");
      expect(success.result.status).toBe(0);
      expect(success.calls.map((call) => call.args)).toEqual(["install --frozen-lockfile", "run test:gstack2"]);
      expect(new Set(success.calls.map((call) => call.cwd)).size).toBe(1);
      expect(success.calls[0].cwd).not.toBe(source);
      expect(fs.existsSync(success.calls[0].cwd)).toBe(false);

      const failure = runGate(true);
      expect(failure.result.status).toBe(23);
      expect(failure.calls).toHaveLength(1);
      expect(fs.existsSync(failure.calls[0].cwd)).toBe(false);

      expect(fs.readFileSync(path.join(source, ".git", "gstack-sentinel"), "utf8")).toBe("host git metadata\n");
      expect(fs.readFileSync(path.join(source, "node_modules", "host-only", "sentinel"), "utf8")).toBe("host dependency\n");
      expect(fs.existsSync(path.join(source, "node_modules", "container-only"))).toBe(false);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("drives a loopback page through the installed browser", () => {
    expect(smoke).not.toContain("bun install --frozen-lockfile");
    expect(smoke).toContain('test ! -e "$REPO/node_modules/@anthropic-ai/claude-agent-sdk"');
    expect(smoke).toContain('test ! -e "$REPO/node_modules/@huggingface/transformers"');
    expect(smoke).toContain('test ! -e "$REPO/node_modules/onnxruntime-node"');
    expect(smoke).toContain('await import("@anthropic-ai/sdk"); await import("sharp"); await import("@ngrok/ngrok");');
    expect(smoke).toContain('server.listen(0, "127.0.0.1"');
    expect(smoke).toContain('"$HOME_DIR/bin/browse" goto "$FIXTURE_URL"');
    expect(smoke).toContain('"$HOME_DIR/bin/browse" fill "#name" "GStack 2"');
    expect(smoke).toContain('"$HOME_DIR/bin/browse" click "#verify"');
    expect(smoke).toContain('grep -F "verified:GStack 2"');
    expect(smoke).toContain('"$HOME_DIR/bin/browse" screenshot "$ROOT/runtime-full.png"');
  });

  test("runs installed runtime probes from the disposable copy without weakening Git trust", () => {
    expect(smoke).toContain('cp -R "$SOURCE/." "$REPO/"');
    expect(smoke).not.toContain('cp -a "$SOURCE/." "$REPO/"');
    expect(smoke).toContain(`(
  # Exercise project identity against the disposable, container-owned copy.
  # The workflow checkout is a read-only host bind mount whose ownership is
  # intentionally not trusted by Git inside the container.
  cd "$REPO"
  "$HOME_DIR/bin/gstack" setup
  "$HOME_DIR/bin/gstack" doctor --json
  "$HOME_DIR/bin/gstack" --version
)`);
    expect(smoke).not.toMatch(/git config[^\n]*safe\.directory/);
    expect(smoke).not.toContain("GIT_CONFIG_COUNT");
  });

  test("keeps cloud-browser and local-model packages outside the production runtime", () => {
    const productionDependencies = Object.keys(packageJson.dependencies ?? {});
    for (const forbidden of [
      "@browserbasehq/sdk",
      "browserbase",
      "browserless",
      "@huggingface/transformers",
      "onnxruntime-node",
    ]) expect(productionDependencies).not.toContain(forbidden);
    // The prompt-injection ML classifier was removed, so the huggingface
    // transformers dep is gone from BOTH production and dev dependencies.
    expect(packageJson.devDependencies?.["@huggingface/transformers"]).toBeUndefined();

    const bundlePaths = DEFAULT_RUNTIME_BUNDLE.map((entry) => entry.path).join("\n");
    expect(bundlePaths).not.toMatch(/browserbase|browserless|huggingface|onnxruntime/i);
  });

  test("retains CoreDevice as the only physical-iPhone backend", () => {
    expect(iosSources).toContain("xcrun");
    expect(iosSources).toContain("devicectl");
    for (const alternative of ["appium", "detox", "maestro", "idb"]) {
      expect(packageJson.dependencies?.[alternative]).toBeUndefined();
    }
    expect(iosSources).not.toMatch(/(?:from\s+|import\s*\(|spawn(?:Sync)?\s*\()[^\n]*(appium|detox|maestro|idb)/i);
  });
});
