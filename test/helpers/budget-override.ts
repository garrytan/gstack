/**
 * Budget override audit trail (v1.45.0.0 T5).
 *
 * Records uses of GSTACK_SIZE_BUDGET_OVERRIDE_REASON or
 * EVALS_BUDGET_OVERRIDE_REASON so a reviewer can see what was waived,
 * by whom, and why. Append-only JSONL at ~/.gstack/analytics/spend-overrides.jsonl.
 *
 * Why audit: a hard cap with no escape valve becomes operationally hostile
 * (legit price changes, longer transcripts, new required evals can all
 * blow the cap). An escape valve with no audit becomes "everyone overrides
 * everything and we lose the gate." This module is the audit half.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BudgetOverrideEntry {
  scope: string;             // e.g. 'skill-size-budget', 'evals-cost-cap'
  reason: string;            // user-supplied REASON env var
  details?: Record<string, unknown>; // numbers / regressions
}

function getAuditPath(): string {
  const base = process.env.GSTACK_HOME || path.join(os.homedir(), '.gstack');
  return path.join(base, 'analytics', 'spend-overrides.jsonl');
}

export function logBudgetOverride(entry: BudgetOverrideEntry): void {
  try {
    const auditPath = getAuditPath();
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      scope: entry.scope,
      reason: entry.reason,
      details: entry.details ?? {},
      // Capture provenance: who/where/which CI ran
      ci: process.env.CI === 'true',
      runner: process.env.GITHUB_ACTIONS ? 'github-actions' : process.env.CI_RUNNER || 'local',
      branch: process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_REF_NAME || 'unknown',
      commit: process.env.GITHUB_SHA?.slice(0, 8) || process.env.CI_COMMIT_SHORT_SHA || 'unknown',
    }) + '\n';
    fs.appendFileSync(auditPath, line);
  } catch (err) {
    // Best-effort logging; don't fail the test on audit-write errors.
    // eslint-disable-next-line no-console
    console.warn(`[budget-override] could not write audit log: ${(err as Error).message}`);
  }
}
