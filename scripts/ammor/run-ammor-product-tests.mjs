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
const runId = getArg("run-id", process.env.GITHUB_RUN_ID || "local");
const sha = getArg("sha", process.env.GITHUB_SHA || "local");
const enforceStrict = String(process.env.AMMOR_ENFORCE_PRODUCT_TEST_SCRIPTS || "true").toLowerCase() === "true";

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
  commands: [],
  requiredCommands: [],
  status: "passed",
  reason: null,
};

if (!fs.existsSync(workspacePath) || !fs.existsSync(packagePath)) {
  result.status = "skipped";
  result.reason =
    "No package.json found for workspace. App-level test coverage deferred until AMMOR product code exists in this workspace.";
  fs.writeFileSync(path.join(evidencePath, `${workspaceId}-results.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

let scripts;
try {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  scripts = pkg.scripts || {};
} catch (error) {
  result.status = "skipped";
  result.reason = `Unable to parse workspace package.json: ${error.message}`;
  fs.writeFileSync(path.join(evidencePath, `${workspaceId}-results.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

const requiredCommands = [
  "test:claims",
  "test:cases",
  "test:api",
  "test:ai",
  "test:dashboard",
  "test:e2e",
];
const optionalCommands = ["test:evidence", "test:human-review", "test:ui", "test"];
result.requiredCommands = requiredCommands;

const presentRequired = requiredCommands.filter((cmd) => Object.prototype.hasOwnProperty.call(scripts, cmd));
const missingRequired = requiredCommands.filter((cmd) => !Object.prototype.hasOwnProperty.call(scripts, cmd));
const commands = [
  ...presentRequired,
  ...optionalCommands.filter((cmd) => Object.prototype.hasOwnProperty.call(scripts, cmd)),
];

if (presentRequired.length === 0) {
  const missingMessage = `Required AMMOR scripts are missing: ${requiredCommands.join(", ")}.`;
  if (enforceStrict) {
    result.status = "failed";
    result.reason = `${missingMessage} Add them to package.json before running AMMOR product gates.`;
    fs.writeFileSync(path.join(evidencePath, `${workspaceId}-results.json`), `${JSON.stringify(result, null, 2)}\n`);
    process.exit(1);
  }

  result.status = "skipped";
  result.reason = `${missingMessage} Add these scripts, or set AMMOR_ENFORCE_PRODUCT_TEST_SCRIPTS=false for discovery-only runs while AMMOR app code is being onboarded.`;
  fs.writeFileSync(path.join(evidencePath, `${workspaceId}-results.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

if (enforceStrict && missingRequired.length > 0) {
  result.status = "failed";
  result.reason = `Missing required AMMOR flow scripts: ${missingRequired.join(", ")}.`;
  fs.writeFileSync(path.join(evidencePath, `${workspaceId}-results.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}

for (const command of commands) {
  const start = new Date().toISOString();
  const child = spawnSync("bun", ["run", command], {
    cwd: workspacePath,
    encoding: "utf8",
    stdio: "pipe",
  });

  const commandResult = {
    workspace,
    command,
    start,
    exitCode: child.status,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
  };
  result.commands.push(commandResult);

  if (child.status !== 0) {
    result.status = "failed";
    result.reason = `Failed command: bun run ${command}`;
    break;
  }
}

fs.writeFileSync(path.join(evidencePath, `${workspaceId}-results.json`), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(
  path.join(evidencePath, `${workspaceId}-summary.md`),
  [
    `# AMMOR Product Flow Test Report (${workspace})`,
    `- Workspace: ${workspace}`,
    `- Run ID: ${runId}`,
    `- Commit: ${sha}`,
    `- Status: ${result.status}`,
    result.reason ? `- Notes: ${result.reason}` : "",
    "",
    "## Commands",
    ...result.commands.map((cmd) => `- \`${cmd.command}\` (${cmd.exitCode === 0 ? "pass" : "fail"})`),
    "",
  ].join("\n"),
);

if (result.status === "failed") process.exit(1);
process.exit(0);
