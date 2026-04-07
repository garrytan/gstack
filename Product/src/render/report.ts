/**
 * HTML report generator.
 * Creates a self-contained HTML file with embedded base64 images and check results.
 */

import type { CheckResult, InspectionReport } from "../types";

function verdictBadge(verdict: string): string {
  const colors: Record<string, string> = {
    pass: "#22c55e",
    fail: "#ef4444",
    warn: "#f59e0b",
    skip: "#9ca3af",
    error: "#8b5cf6",
  };
  const color = colors[verdict] || "#6b7280";
  return `<span style="background:${color};color:white;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">${verdict.toUpperCase()}</span>`;
}

function rankBadge(rank: string): string {
  const colors: Record<string, string> = {
    C: "#3b82f6",
    B: "#f59e0b",
    A: "#ef4444",
  };
  const color = colors[rank] || "#6b7280";
  return `<span style="background:${color};color:white;padding:2px 6px;border-radius:3px;font-size:11px;font-weight:700">${rank}</span>`;
}

function scoreBar(score: number, label: string): string {
  const pct = Math.round(score * 100);
  const color = pct >= 90 ? "#22c55e" : pct >= 70 ? "#f59e0b" : "#ef4444";
  return `<div style="margin:4px 0">
    <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:2px">
      <span>${label}</span><span>${pct}%</span>
    </div>
    <div style="background:#e5e7eb;border-radius:4px;height:8px">
      <div style="background:${color};border-radius:4px;height:8px;width:${pct}%"></div>
    </div>
  </div>`;
}

function checkResultRow(result: CheckResult): string {
  const evidenceHtml = result.evidence
    .map((e) => {
      const badge = e.severity === "critical"
        ? '<span style="color:#ef4444;font-weight:600">CRITICAL</span>'
        : e.severity === "major"
          ? '<span style="color:#f59e0b;font-weight:600">MAJOR</span>'
          : '<span style="color:#6b7280">minor</span>';
      const value = e.extractedValue ? ` <code>${e.extractedValue}</code>` : "";
      return `<li>${badge} ${e.description}${value}</li>`;
    })
    .join("");

  return `<tr style="border-bottom:1px solid #e5e7eb">
    <td style="padding:8px">${rankBadge(result.rank)}</td>
    <td style="padding:8px">${verdictBadge(result.verdict)}</td>
    <td style="padding:8px">
      <strong>${result.checkName}</strong>
      ${result.checkNameJa ? `<br><span style="color:#6b7280;font-size:12px">${result.checkNameJa}</span>` : ""}
    </td>
    <td style="padding:8px;font-size:13px">
      <ul style="margin:0;padding-left:16px">${evidenceHtml}</ul>
      ${result.reasoning ? `<div style="color:#6b7280;font-size:12px;margin-top:4px">${result.reasoning}</div>` : ""}
    </td>
    <td style="padding:8px;text-align:center">${Math.round(result.confidence * 100)}%</td>
  </tr>`;
}

export function generateReportHtml(
  report: InspectionReport,
  annotatedPageBase64?: string,
): string {
  const s = report.summary;

  const checksHtml = report.results.map(checkResultRow).join("");

  const annotatedImage = annotatedPageBase64
    ? `<div style="margin:20px 0">
        <h2>Annotated Drawing</h2>
        <img src="data:image/png;base64,${annotatedPageBase64}" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px" />
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Drawing Inspection Report — ${report.fileName}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f9fafb; color: #111827 }
  h1 { font-size: 24px; margin-bottom: 4px }
  h2 { font-size: 18px; margin-top: 24px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1) }
  th { background: #f3f4f6; padding: 10px 8px; text-align: left; font-size: 13px; font-weight: 600; color: #374151 }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin: 16px 0 }
  .summary-card { background: white; padding: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1) }
  .summary-card .number { font-size: 28px; font-weight: 700 }
  .summary-card .label { font-size: 13px; color: #6b7280 }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 12px }
</style>
</head>
<body>
<h1>Drawing Inspection Report</h1>
<p style="color:#6b7280;margin-top:0">
  File: <strong>${report.fileName}</strong> |
  Classification: <strong>${report.classification.category}</strong> (${report.classification.businessUnit}) |
  ${report.classification.material ? `Material: <strong>${report.classification.material}</strong> | ` : ""}
  Generated: ${new Date(report.timestamp).toLocaleString("ja-JP")}
</p>

<div class="summary-grid">
  <div class="summary-card">
    <div class="number">${s.totalChecks}</div>
    <div class="label">Total Checks</div>
  </div>
  <div class="summary-card">
    <div class="number" style="color:#22c55e">${s.passed}</div>
    <div class="label">Passed</div>
  </div>
  <div class="summary-card">
    <div class="number" style="color:#ef4444">${s.failed}</div>
    <div class="label">Failed</div>
  </div>
  <div class="summary-card">
    <div class="number" style="color:#f59e0b">${s.warnings}</div>
    <div class="label">Warnings</div>
  </div>
</div>

<h2>Accuracy by Rank</h2>
<div style="max-width:400px">
  ${scoreBar(s.cRankScore, "C-Rank (target: 95%)")}
  ${scoreBar(s.bRankScore, "B-Rank (target: 90%)")}
  ${scoreBar(s.aRankScore, "A-Rank (target: 70%)")}
</div>

${annotatedImage}

<h2>Check Results</h2>
<table>
  <thead>
    <tr>
      <th>Rank</th>
      <th>Result</th>
      <th>Check Item</th>
      <th>Evidence</th>
      <th>Confidence</th>
    </tr>
  </thead>
  <tbody>
    ${checksHtml}
  </tbody>
</table>

<footer style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px">
  Drawing Inspection Tool PoC | Report ID: ${report.id}
</footer>
</body>
</html>`;
}
