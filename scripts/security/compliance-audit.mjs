#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function getArg(name, defaultValue = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return defaultValue;
  return process.argv[index + 1];
}

function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function shaOf(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function parsePermissions(content) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^(\s*)permissions:\s*(.*)$/);
    if (!match) continue;

    const baseIndent = match[1].length;
    const rest = match[2].trim();
    if (rest && rest !== "{}") return { inline: rest };
    if (rest === "{}") return {};

    const permissions = {};
    for (let j = i + 1; j < lines.length; j += 1) {
      const inner = lines[j];
      if (!inner.trim()) continue;
      const leading = inner.search(/\S/);
      if (leading <= baseIndent && inner.trim()) break;
      const kv = inner.trim().match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (kv) permissions[kv[1]] = kv[2];
    }
    return permissions;
  }
  return null;
}

function normalizePermissionKey(key) {
  return key.toLowerCase().replace(/-/g, "_");
}

function validatePermissions(file, permissions) {
  const requirements = {
    "security-workflow.yml": {
      security_events: "write",
      contents: "read",
      actions: "read",
      checks: "read"
    },
    "compliance-workflow.yml": {
      contents: "read",
      actions: "read",
      checks: "read",
      pull_requests: "write"
    }
  };

  const required = requirements[file] ?? {};
  const findings = [];
  const normalized = {};
  if (permissions && !permissions.inline) {
    for (const [rawKey, value] of Object.entries(permissions)) {
      normalized[normalizePermissionKey(rawKey)] = value.toLowerCase();
    }
  }

  if (!permissions) {
    findings.push({
      severity: "high",
      message: "No workflow-level permissions block found. Default permissions are not explicit."
    });
    return findings;
  }

  if (permissions.inline) {
    if (permissions.inline.includes("write-all")) {
      findings.push({
        severity: "critical",
        message: "permissions is set to write-all at file level."
      });
    } else if (permissions.inline.includes("read-all")) {
      findings.push({
        severity: "high",
        message: "permissions is set to read-all at file level."
      });
    } else {
      findings.push({
        severity: "medium",
        message: "Inline permissions block is unusual and should be reviewed."
      });
    }
    return findings;
  }

  if (permissions && !Object.keys(permissions).length) {
    findings.push({
      severity: "medium",
      message: "Empty permissions block (`permissions: {}`). Consider explicit least-privilege grants."
    });
    return findings;
  }

  for (const [requiredKey, requiredValue] of Object.entries(required)) {
    const normalizedKey = normalizePermissionKey(requiredKey);
    const actual = normalized[normalizedKey];
    if (!actual) {
      findings.push({
        severity: "high",
        message: `Required permission ${requiredKey}: ${requiredValue} not found.`
      });
      continue;
    }

    if (requiredValue === "read" && actual !== "read") {
      findings.push({
        severity: "medium",
        message: `${requiredKey} is ${actual}, but workflow policy requires explicit ${requiredValue}.`
      });
    }
    if (requiredValue === "write" && actual !== "write") {
      findings.push({
        severity: "medium",
        message: `${requiredKey} is ${actual}, but workflow policy expects write.`
      });
    }
  }

  if (normalized.contents === "write" && required.contents === "read") {
    findings.push({
      severity: "medium",
      message: "contents: write is broader than required read for this workflow."
    });
  }

  if (normalized.security_events === "write-all" || normalized.security_events === "read-all") {
    findings.push({
      severity: "high",
      message: "security-events permission uses broad-all mode."
    });
  }

  return findings;
}

function parseChainRecords(chainPayload) {
  if (!chainPayload || !Array.isArray(chainPayload.records)) {
    return {
      valid: false,
      lastHash: "GENESIS",
      violations: [{
        severity: "critical",
        message: "Chain file is missing or has an invalid records array."
      }]
    };
  }

  if (chainPayload.records.length === 0) {
    return { valid: false, lastHash: "GENESIS", violations: [] };
  }

  const violations = [];
  for (let i = 1; i < chainPayload.records.length; i += 1) {
    const current = chainPayload.records[i];
    const previous = chainPayload.records[i - 1];
    const currentPrevious = current?.previous_record_hash;
    const expectedPrevious = previous?.record_hash || "GENESIS";
    if (!current || typeof current !== "object") {
      violations.push({
        severity: "critical",
        message: `Invalid chain record at index ${i}.`
      });
      continue;
    }
    if (currentPrevious !== expectedPrevious) {
      violations.push({
        severity: "critical",
        message: `Chain continuity broken at index ${i}. expected previous hash ${expectedPrevious}, got ${currentPrevious || "(missing)"}`
      });
    }
    if (!current.record_hash) {
      violations.push({
        severity: "high",
        message: `Chain record at index ${i} is missing record_hash.`
      });
    }
  }

  const last = chainPayload.records[chainPayload.records.length - 1];
  return {
    valid: violations.filter((v) => v.severity === "critical").length === 0,
    lastHash: last?.record_hash || "GENESIS",
    violations
  };
}

function riskFromFindings(items) {
  const counts = { critical: 0, high: 0, medium: 0 };
  for (const item of items) counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  const riskScore = counts.critical * 35 + counts.high * 20 + counts.medium * 5;
  const level = riskScore >= 80 ? "critical" : riskScore >= 40 ? "high" : riskScore >= 20 ? "medium" : "low";
  return { counts, riskScore, level };
}

async function safeReadJson(filePath, fallback = null) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

function buildDashboardMarkdown({
  repo,
  runId,
  pullRequest,
  generatedAt,
  controls,
  score,
  rbac,
  auditLog,
  chainHash,
  reportHash
}) {
  const statusLine = [
    "| Control | Status | Detail |",
    "| --- | --- | --- |",
    ...controls.map((control) => `| ${control.name} | ${control.status} | ${control.detail} |`)
  ];
  return [
    "# Vulnerability & Compliance Dashboard",
    `- Repo: ${repo}`,
    `- Workflow run: ${runId}`,
    `- Pull request: ${pullRequest}`,
    `- Generated: ${generatedAt}`,
    "",
    `- Security score: ${score}`,
    `- RBAC risk: ${rbac.level} (${rbac.counts.critical}/${rbac.counts.high}/${rbac.counts.medium})`,
    `- Chain record hash: ${chainHash}`,
    `- Report checksum: ${reportHash}`,
    "",
    "## Control Matrix",
    ...statusLine,
    "",
    "## Audit logging integrity",
    auditLog.integrity === "pass" ? "✅ PASS" : "⚠️ WARN",
    "",
    `- Logged files: ${(auditLog.logged_files || []).join(", ")}`
  ].join("\n");
}

async function main() {
  const outputDir = getArg("output-dir", "artifacts/compliance");
  const securityReportPath = getArg("security-report", "artifacts/security/security-summary.json");
  const pullRequest = getArg("pull-request", "not-pr");
  const runId = getArg("run-id", "unknown");
  const repo = getArg("repo", "unknown");
  const actor = getArg("actor", "unknown");
  const workflow = getArg("workflow", "compliance-workflow");
  const runAttempt = getArg("run-attempt", "1");
  const workflowRunDir = getArg("workflow-run-dir", ".");
  const baseDir = getArg("repo-root", ".");
  const generatedAt = new Date().toISOString();
  const previousChainPath = getArg("previous-chain", path.join(baseDir, ".github", "security", "chain-latest.json"));

  await fs.mkdir(outputDir, { recursive: true });

  const summary = (await safeReadJson(securityReportPath, null)) ?? {
    overall_status: "UNKNOWN",
    summary: {}
  };
  const summaryHasChecksum = typeof summary?.report_checksum === "string" && summary.report_checksum.length > 0;
  if (!summaryHasChecksum) {
    console.error("[compliance-audit] Security summary report missing report_checksum field");
  }

  const controls = [];
  const violations = [];
  const auditArtifacts = [{ name: "security-summary", path: securityReportPath }];

  const securityPayload = await safeReadJson(securityReportPath, null);
  if (!securityPayload) {
    violations.push({
      severity: "critical",
      message: `Security summary report is missing or invalid JSON: ${securityReportPath}`
    });
  } else {
    const reportCopy = { ...securityPayload };
    delete reportCopy.report_checksum;
    const computedChecksum = crypto.createHash("sha256").update(JSON.stringify(reportCopy)).digest("hex");
    if (securityPayload.report_checksum && securityPayload.report_checksum !== computedChecksum) {
      violations.push({
        severity: "high",
        message: "Security summary checksum mismatch; integrity check failed."
      });
    }
  }

  const requiredDocs = [
    [".github/SECURITY.md", "Security policy is present"],
    [".github/dependabot.yml", "Dependabot security updates configured"],
    ["docs/security/SECURITY_AUTOMATION.md", "Security runbooks documented"]
  ];

  for (const [docPath, label] of requiredDocs) {
    const exists = await fileExists(path.join(baseDir, docPath));
    controls.push({ name: label, status: exists ? "pass" : "fail", detail: exists ? "Present" : "Missing" });
    if (!exists) {
      violations.push({ severity: "high", message: `${docPath} is missing` });
    }
  }

  const chainPayload = await safeReadJson(previousChainPath, { records: [] });
  const chainValidation = parseChainRecords(chainPayload);
  violations.push(...chainValidation.violations);
  controls.push({
    name: "Chain-of-custody continuity",
    status: chainValidation.valid ? "pass" : "fail",
    detail: chainValidation.violations.length === 0
      ? `Chain baseline verified. Latest record hash: ${chainValidation.lastHash}`
      : chainValidation.violations.map((v) => v.message).join("; ")
  });

  const workflowPaths = ["security-workflow.yml", "compliance-workflow.yml"];
  for (const workflowPath of workflowPaths) {
    const abs = path.join(baseDir, ".github", "workflows", workflowPath);
    const exists = await fileExists(abs);
    const item = {
      name: `RBAC workflow policy: ${workflowPath}`,
      status: "pass",
      detail: exists ? "Validated" : "Missing workflow file"
    };
    if (!exists) {
      item.status = "fail";
      item.detail = "Workflow file missing";
      violations.push({
        severity: "critical",
        message: `Workflow file ${workflowPath} is required for security controls`
      });
      controls.push(item);
      continue;
    }

    const content = await fs.readFile(abs, "utf8");
    const parsed = parsePermissions(content);
    const workflowViolations = validatePermissions(workflowPath, parsed);
    violations.push(...workflowViolations.map((v) => ({ ...v })));
    item.detail = workflowViolations.length === 0
      ? "Validated permissions"
      : workflowViolations.map((v) => v.message).join("; ");
    if (workflowViolations.length > 0) {
      const hasCritical = workflowViolations.some((v) => v.severity === "critical");
      item.status = hasCritical ? "fail" : "warn";
    }
    controls.push(item);
  }

  const securityControls = [
    {
      name: "Exposed secret scan",
      status: (summary?.findings || []).find((f) => f.control === "Secret and credential scanning")?.status || "unknown",
      detail: (summary?.summary?.secret_findings || 0) > 0
        ? `${summary?.summary?.secret_findings || 0} secret findings`
        : "No critical findings reported"
    },
    {
      name: "Dependency risk scan",
      status: (summary?.findings || []).find((f) => f.control === "Dependency vulnerability scanning")?.status || "unknown",
      detail: "Dependency scan completed via Trivy"
    },
    {
      name: "Code scanning",
      status: summary?.findings?.find((f) => f.control === "CodeQL analysis")?.status || "unknown",
      detail: "CodeQL workflow executed"
    }
  ];
  controls.push(...securityControls);

  const auditPaths = [
    path.join(workflowRunDir, "security-artifacts", "evidence", "gitleaks", "gitleaks.sarif"),
    path.join(workflowRunDir, "security-artifacts", "evidence", "trivy", "trivy.sarif")
  ];
  for (const filePath of auditPaths) {
    auditArtifacts.push({ name: path.basename(filePath), path: filePath });
  }

  const auditedFiles = [];
  for (const entry of auditArtifacts) {
    if (await fileExists(entry.path)) {
      const checksum = await shaOf(entry.path);
      auditedFiles.push({ ...entry, checksum });
    } else {
      violations.push({
        severity: "medium",
        message: `Expected evidence artifact missing: ${entry.path}`
      });
    }
  }

  const dependencyFindings = summary?.summary?.dependency_findings || 0;
  const secretFindings = summary?.summary?.secret_findings || 0;
  const codeqlStatus = summary?.findings?.find((item) => item.control === "CodeQL analysis")?.status || "unknown";

  const rbac = riskFromFindings(violations.filter((v) => v.severity !== "unknown"));
  const complianceRiskScore = Math.min(
    100,
    rbac.riskScore +
      (dependencyFindings > 0 ? 25 : 0) +
      (secretFindings > 0 ? 35 : 0) +
      (codeqlStatus === "FAIL" ? 20 : 0)
  );
  const complianceRisk = complianceRiskScore >= 80
    ? "critical"
    : complianceRiskScore >= 50
      ? "high"
      : complianceRiskScore >= 25
        ? "medium"
        : "low";

  controls.push({
    name: "Audit logging integrity",
    status: violations.length === 0 ? "pass" : "warn",
    detail: violations.length === 0
      ? "No missing/invalid audit artifacts detected."
      : `${violations.length} audit/compliance issue(s) found.`
  });

  const report = {
    generated_at: generatedAt,
    workflow,
    run_id: runId,
    run_attempt: runAttempt,
    actor,
    repo,
    pull_request: pullRequest,
    controls,
    violations,
    risk: {
      score: complianceRiskScore,
      level: complianceRisk,
      rbac
    },
    audit_log: {
      integrity: violations.length === 0 ? "pass" : "warn",
      artifact_count: auditedFiles.length,
      logged_files: auditedFiles.map((entry) => entry.path),
      generated_findings: secretFindings + dependencyFindings
    }
  };

  const chainRecordPayload = {
    run_id: runId,
    workflow_run_at: generatedAt,
    pull_request: pullRequest,
    summary_checksum: summary?.report_checksum || "unknown",
    violations,
    evidence: auditedFiles.map((entry) => ({ path: entry.path, checksum: entry.checksum }))
  };
  const recordHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(chainRecordPayload))
    .digest("hex");
  const chainRecord = {
    run_id: runId,
    generated_at: generatedAt,
    workflow,
    record_hash: recordHash,
    previous_record_hash: chainValidation.lastHash,
    evidence_checksums: chainRecordPayload.evidence
  };

  const chainBase = await safeReadJson(previousChainPath, { records: [] });
  const previousChainRaw = chainBase;
  const priorRecords = Array.isArray(chainBase?.records) ? chainBase.records : [];

  const chainState = {
    ...(chainBase && typeof chainBase === "object" ? chainBase : { records: [] }),
    generated_at: generatedAt,
    records: [...priorRecords, chainRecord]
  };

  const reportPath = path.join(outputDir, "risk-assessment-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const markdownPath = path.join(outputDir, "risk-assessment-report.md");
  const dashboardPath = path.join(outputDir, "vulnerability-dashboard.md");
  const dashboard = buildDashboardMarkdown({
    repo,
    runId,
    pullRequest,
    generatedAt,
    controls,
    score: `${complianceRiskScore}/100`,
    rbac,
    auditLog: report.audit_log,
    chainHash: recordHash,
    reportHash: summary?.report_checksum || "unknown"
  });
  await fs.writeFile(dashboardPath, `${dashboard}\n`);

  const findingsLines = [
    "# Risk Assessment Report",
    `- Generated: ${generatedAt}`,
    `- Repo: ${repo}`,
    `- Run: ${runId}`,
    `- Workflow: ${workflow}`,
    `- Pull request: ${pullRequest}`,
    `- Actor: ${actor}`,
    "",
    `## Risk Level: ${complianceRisk.toUpperCase()}`,
    `- Score: ${complianceRiskScore}/100`,
    "",
    "## Compliance controls",
    ...controls.map((control) => `- [${control.status.toUpperCase()}] ${control.name} — ${control.detail}`),
    "",
    "## Violations",
    ...(violations.length === 0 ? ["- No violations detected."] : violations.map((item) => `- (${item.severity}) ${item.message}`)),
    "",
    "## Chain-of-custody record",
    `- Previous hash: ${chainValidation.lastHash}`,
    `- Current hash: ${recordHash}`,
    "",
    "## Integrity summary",
    `- Status: ${report.audit_log.integrity}`,
    `- Logged files: ${report.audit_log.artifact_count}`
  ];
  await fs.writeFile(markdownPath, `${findingsLines.join("\n")}\n`);
  await fs.writeFile(path.join(outputDir, "chain-entry.json"), `${JSON.stringify(chainRecord, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, "chain-state.json"), `${JSON.stringify(chainState, null, 2)}\n`);

  console.log(`COMPLIANCE_RISK_SCORE=${complianceRiskScore}`);
  console.log(`COMPLIANCE_RISK_LEVEL=${complianceRisk}`);
  console.log(`CHAIN_HASH=${recordHash}`);
}

main().catch((error) => {
  console.error(`[compliance-audit] failed: ${error.message}`);
  process.exit(1);
});
