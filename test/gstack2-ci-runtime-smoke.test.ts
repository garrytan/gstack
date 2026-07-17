import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RUNTIME_BUNDLE } from "../runtime/install.js";

const root = path.resolve(import.meta.dir, "..");
const dockerfile = fs.readFileSync(path.join(root, ".devcontainer", "Dockerfile"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "gstack2-gate.yml"), "utf8");
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

  test("keeps cloud-browser and local-model packages outside the production runtime", () => {
    const productionDependencies = Object.keys(packageJson.dependencies ?? {});
    for (const forbidden of [
      "@browserbasehq/sdk",
      "browserbase",
      "browserless",
      "@huggingface/transformers",
      "onnxruntime-node",
    ]) expect(productionDependencies).not.toContain(forbidden);
    expect(packageJson.devDependencies?.["@huggingface/transformers"]).toBeDefined();

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
