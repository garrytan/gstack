#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const workspace = getArg("workspace", "");
const workspaceId = getArg("workspace-id", path.basename(workspace || "root"));
const evidenceRoot = getArg("evidence-root", "qa-artifacts");
const baseUrl = getArg("base-url", process.env.AMMOR_UX_BASE_URL || "");
const runId = getArg("run-id", process.env.GITHUB_RUN_ID || "local");
const sha = getArg("sha", process.env.GITHUB_SHA || "local");
const enforceStrict = String(process.env.AMMOR_ENFORCE_UX_TEST_SCRIPTS || "true").toLowerCase() === "true";

if (!workspace) {
  console.error("No workspace provided.");
  process.exit(1);
}

const workspacePath = path.join(process.cwd(), workspace);
const packagePath = path.join(workspacePath, "package.json");
const evidencePath = path.join(process.cwd(), evidenceRoot, "ammor-product-tests");
fs.mkdirSync(evidencePath, { recursive: true });

const result = {
  workspace,
  workspaceId,
  generatedAt: new Date().toISOString(),
  runId,
  sha,
  baseUrl: baseUrl || "not-configured",
  commands: [],
  status: "passed",
  reason: null,
  checks: {
    hasVisualScripts: false,
    hasA11yScripts: false,
    hasPlaywrightConfig: false,
  },
};

if (!fs.existsSync(workspacePath) || !fs.existsSync(packagePath)) {
  result.status = "skipped";
  result.reason = "No package.json found for workspace. Visual/a11y gates deferred.";
  fs.writeFileSync(path.join(evidencePath, `${workspaceId}-ux-gates.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

let scripts = {};
try {
  scripts = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  scripts = scripts.scripts || {};
} catch {
  result.status = "skipped";
  result.reason = "Unable to parse workspace package.json. Skipping UX gates.";
  fs.writeFileSync(path.join(evidencePath, `${workspaceId}-ux-gates.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

const visualScripts = ["test:visual", "test:visual-regression", "test:ui", "test:e2e:visual", "test:ux"];
const a11yScripts = ["test:a11y", "test:accessibility", "test:wcag", "test:axe"];
const selectedVisual = visualScripts.filter((command) => Object.prototype.hasOwnProperty.call(scripts, command));
const selectedA11y = a11yScripts.filter((command) => Object.prototype.hasOwnProperty.call(scripts, command));
const selected = [...selectedVisual, ...selectedA11y];

if (selectedVisual.length > 0) result.checks.hasVisualScripts = true;
if (selectedA11y.length > 0) result.checks.hasA11yScripts = true;

if (fs.existsSync(path.join(workspacePath, "playwright.config.ts")) || fs.existsSync(path.join(workspacePath, "playwright.config.js"))) {
  result.checks.hasPlaywrightConfig = true;
}

if (selected.length === 0 && !result.checks.hasPlaywrightConfig) {
  result.status = "skipped";
  result.reason = "No visual/a11y scripts detected and no Playwright config present. Add visual/a11y scripts (e.g. test:visual, test:a11y, test:wcag) to enable UX gates.";
  fs.writeFileSync(path.join(evidencePath, `${workspaceId}-ux-gates.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

if (enforceStrict && !result.checks.hasVisualScripts && !selectedVisual.length) {
  result.status = "failed";
  result.reason = "Strict UX gate: missing visual script in package.json (test:visual/test:visual-regression/test:ux/test:e2e:visual).";
  fs.writeFileSync(path.join(evidencePath, `${workspaceId}-ux-gates.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}

if (enforceStrict && !result.checks.hasA11yScripts && !selectedA11y.length) {
  result.status = "failed";
  result.reason = "Strict UX gate: missing accessibility script in package.json (test:a11y/test:accessibility/test:wcag/test:axe).";
  fs.writeFileSync(path.join(evidencePath, `${workspaceId}-ux-gates.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}

if (result.status === "passed" && result.checks.hasPlaywrightConfig && selected.length === 0) {
  result.status = "warning";
  result.reason = "Playwright config found but no named visual/a11y scripts were configured. Add commands for deterministic checks.";
}

for (const command of selected) {
  const child = spawnSync("bun", ["run", command, ...(baseUrl ? ["--", `--base-url=${baseUrl}`] : [])], {
    cwd: workspacePath,
    encoding: "utf8",
    stdio: "pipe",
  });
  result.commands.push({ command, exitCode: child.status, stdout: child.stdout || "", stderr: child.stderr || "" });
  if (child.status !== 0) {
    result.status = "failed";
    result.reason = `Failed UX gate command: bun run ${command}`;
    break;
  }
}

fs.writeFileSync(path.join(evidencePath, `${workspaceId}-ux-gates.json`), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(
  path.join(evidencePath, `${workspaceId}-ux-gates.md`),
  [
    `# AMMOR UX/Accessibility Gate Report (${workspace})`,
    `- Workspace: ${workspace}`,
    `- Run ID: ${runId}`,
    `- Commit: ${sha}`,
    `- Status: ${result.status}`,
    result.reason ? `- Notes: ${result.reason}` : "",
    "",
    `- Base URL: ${result.baseUrl}`,
    "",
    "## Checks",
    `- Visual scripts: ${result.checks.hasVisualScripts ? "detected" : "missing"}`,
    `- Accessibility scripts: ${result.checks.hasA11yScripts ? "detected" : "missing"}`,
    `- Playwright config: ${result.checks.hasPlaywrightConfig ? "present" : "missing"}`,
    "",
    "## Commands",
    ...result.commands.map((cmd) => `- \`${cmd.command}\` (${cmd.exitCode === 0 ? "pass" : "fail"})`),
    "",
  ].join("\n"),
);

if (result.status === "failed") process.exit(1);
process.exit(0);
