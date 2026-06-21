#!/usr/bin/env node
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

function getArg(name, defaultValue = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return defaultValue;
  return process.argv[index + 1];
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function main() {
  const outputDir = getArg("output-dir", "artifacts/security");
  const repo = getArg("repo", "unknown");
  const branch = getArg("branch", "unknown");
  const sha = getArg("sha", "unknown");
  const runId = getArg("run-id", "unknown");
  const pullRequest = getArg("pull-request", "not-pr");
  const gitleaksFindings = toInt(getArg("gitleaks-findings", "0"));
  const dependencyFindings = toInt(getArg("dependency-findings", "0"));
  const codeqlStatus = getArg("codeql-status", "passed");
  const generatedAt = new Date().toISOString();

  await fs.mkdir(outputDir, { recursive: true });

  const findings = [
    {
      control: "Secret and credential scanning",
      status: gitleaksFindings === 0 ? "PASS" : "FAIL",
      details: `Gitleaks detected ${gitleaksFindings} finding(s).`
    },
    {
      control: "Dependency vulnerability scanning",
      status: dependencyFindings === 0 ? "PASS" : "FAIL",
      details: `Trivy detected ${dependencyFindings} high/critical finding(s).`
    },
    {
      control: "CodeQL analysis",
      status: codeqlStatus === "passed" ? "PASS" : "FAIL",
      details: "CodeQL workflow completed and uploaded to GitHub Security alerts."
    }
  ];

  const severity = {
    pass: 0,
    fail: 0,
    unknown: 0
  };
  for (const item of findings) {
    if (item.status === "PASS") severity.pass += 1;
    else if (item.status === "FAIL") severity.fail += 1;
    else severity.unknown += 1;
  }

  const overallStatus = severity.fail === 0 && gitleaksFindings === 0 && dependencyFindings === 0 ? "PASS" : "FAIL";
  const riskLevel = severity.fail === 0 ? "low" : "critical";

  const report = {
    generated_at: generatedAt,
    workflow: "Security Workflow",
    run_id: runId,
    pull_request: pullRequest,
    repo,
    branch,
    sha,
    overall_status: overallStatus,
    risk_level: riskLevel,
    findings,
    summary: {
      pass: severity.pass,
      fail: severity.fail,
      unknown: severity.unknown,
      secret_findings: gitleaksFindings,
      dependency_findings: dependencyFindings,
      critical: Math.max(gitleaksFindings, dependencyFindings),
      controls: findings.length
    }
  };

  const summaryChecksum = crypto
    .createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex");

  report.report_checksum = summaryChecksum;

  const summaryPath = path.join(outputDir, "security-summary.json");
  await fs.writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`);

  const markdown = [
    "# Security Workflow Summary",
    `- Generated at: ${generatedAt}`,
    `- Repo: ${repo}`,
    `- Branch: ${branch}`,
    `- SHA: ${sha}`,
    `- Pull request: ${pullRequest}`,
    `- Workflow run: ${runId}`,
    `- Overall status: **${overallStatus}**`,
    `- Risk level: **${riskLevel}**`,
    "",
    "## Control Matrix",
    "| Control | Status | Details |",
    "| --- | --- | --- |",
    ...findings.map((item) => `| ${item.control} | ${item.status} | ${item.details} |`),
    "",
    "## Report Checksum",
    "",
    `\`${summaryChecksum}\``
  ].join("\n");

  const markdownPath = path.join(outputDir, "security-summary.md");
  await fs.writeFile(markdownPath, `${markdown}\n`);
}

main().catch((error) => {
  console.error(`[security-summary] failed: ${error.message}`);
  process.exit(1);
});
