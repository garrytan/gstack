#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, arg, idx, arr) => {
      if (arg.startsWith("--") && arr[idx + 1] && !arr[idx + 1].startsWith("--")) {
        acc.push([arg.replace(/^--/, ""), arr[idx + 1]]);
      } else if (arg.startsWith("--")) {
        acc.push([arg.replace(/^--/, ""), "true"]);
      }
      return acc;
    }, [])
);

const outputDir = args["output-dir"] || "deployment-artifacts";
const repo = args.repo || process.env.GITHUB_REPOSITORY || "local";
const runId = args["run-id"] || "local";
const sha = args.sha || process.env.GITHUB_SHA || "local";
const ref = args.ref || process.env.GITHUB_REF_NAME || "local";

const requiredFiles = [
  ".github/workflows/security-workflow.yml",
  ".github/workflows/compliance-workflow.yml",
  ".github/workflows/testing-workflow.yml",
  ".github/workflows/deployment-safety-workflow.yml",
  "docs/RELEASE_CHECKLIST.md",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/github-skills-roadmap-for-ammor.md",
];

const optionalProviderFiles = [
  "railway.toml",
  "vercel.json",
  "supabase/config.toml",
];

const riskySqlPatterns = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bTRUNCATE\s+/i,
  /\bDELETE\s+FROM\b/i,
];

function exists(p) {
  return fs.existsSync(path.join(process.cwd(), p));
}

function collectMigrationFiles() {
  const roots = ["supabase", "db", "migrations", "sql"];
  const matches = [];
  for (const root of roots) {
    if (!exists(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (full.endsWith(".sql") || full.endsWith(".psql") || full.endsWith(".ddl")) {
          matches.push(full);
        }
      }
    }
  }
  return matches;
}

const now = new Date().toISOString();
const checks = [];
const violations = [];
let blockingChecks = 0;
let warningCount = 0;

for (const file of requiredFiles) {
  if (exists(file)) {
    checks.push({ name: `required:${file}`, status: "pass" });
  } else {
    const violation = {
      severity: "high",
      check: `required:${file}`,
      detail: "Missing required deployment safety artifact or governance file."
    };
    checks.push({ name: `required:${file}`, status: "fail" });
    violations.push(violation);
    blockingChecks += 1;
  }
}

const providers = optionalProviderFiles.filter(exists);
checks.push({
  name: "providerConfig",
  status: providers.length > 0 ? "pass" : "warn",
  detail: providers.length > 0 ? providers.join(", ") : "No provider config file detected",
});
if (providers.length === 0) {
  warningCount += 1;
}

const migrationFiles = collectMigrationFiles();
let destructiveMigrationHits = 0;
for (const sqlFile of migrationFiles) {
  const content = fs.readFileSync(sqlFile, "utf8");
  for (const pattern of riskySqlPatterns) {
    if (pattern.test(content)) {
      destructiveMigrationHits += 1;
      violations.push({
        severity: "medium",
        check: `migration:${sqlFile}`,
        detail: "Potential destructive migration statement detected."
      });
      warningCount += 1;
      break;
    }
  }
}
checks.push({
  name: "migrationScan",
  status: destructiveMigrationHits === 0 ? "pass" : "warn",
  detail: `${destructiveMigrationHits} migration files contain destructive SQL patterns`,
});

const releaseChecklist = exists("docs/RELEASE_CHECKLIST.md");
checks.push({
  name: "releaseChecklistPresent",
  status: releaseChecklist ? "pass" : "fail",
  detail: releaseChecklist ? "Release checklist exists" : "Release checklist is required before deployment."
});
if (!releaseChecklist) blockingChecks += 1;

const envExample = exists(".env.example") ? fs.readFileSync(".env.example", "utf8") : "";
const hasRequiredExample = envExample.includes("ANTHROPIC_API_KEY");
checks.push({
  name: "envExample",
  status: hasRequiredExample ? "pass" : "warn",
  detail: hasRequiredExample ? "Required service key placeholder exists" : "No ANTHROPIC_API_KEY placeholder found in .env.example"
});
if (!hasRequiredExample) warningCount += 1;

const status =
  blockingChecks > 0 ? "fail" : warningCount > 5 ? "warning" : "pass";

const payload = {
  repository: repo,
  runId,
  commit: sha,
  ref,
  generatedAt: now,
  status,
  checks,
  blockingChecks,
  warningCount,
  violations,
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "deployment-safety.json"), JSON.stringify(payload, null, 2), "utf8");
fs.writeFileSync(
  path.join(outputDir, "deployment-safety.md"),
  [
    "# AMMOR Deployment Safety Report",
    "",
    `- Repository: ${repo}`,
    `- Run ID: ${runId}`,
    `- Commit: ${sha}`,
    `- Branch/ref: ${ref}`,
    `- Status: ${status}`,
    `- Blocking checks: ${blockingChecks}`,
    `- Warnings: ${warningCount}`,
    "",
    "## Checks",
    "",
    ...checks.map((entry) => `- ${entry.name}: ${entry.status}${entry.detail ? ` (${entry.detail})` : ""}`),
    "",
    "## Violations",
    "",
    ...(violations.length > 0
      ? violations.map((v) => `- [${v.severity.toUpperCase()}] ${v.check}: ${v.detail}`)
      : ["- none"]),
  ].join("\n")
);

if (status === "fail") {
  process.exit(1);
}
