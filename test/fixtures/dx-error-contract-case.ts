/**
 * Preregistered fixture and grader for the dx-error-contract-review behavior
 * case (plan v3 item 11, arm A: the snapshot-built autoplan native DX reviewer
 * prompt, run headless). The bars below were fixed before any paid trial and
 * are not tuned after seeing results.
 *
 * A trial PASSES when the bound result parses with no errors (the INPUT receipt
 * for this snapshot and a valid gstack-findings fence) and the fence:
 *   - flags path P1 (agent-hostile push) with Critical CAP4 findings naming
 *     redaction, channel and fix, and names context in some CAP finding on P1;
 *   - raises no CAP finding on P2 (agent-ready decoy), P3 (remote API error with
 *     caller-safe context and a correlation id) or P4 (plain usage error);
 *   - raises at least one CAP finding on P5 (error handling never specified);
 *   - labels every CAP4 finding Critical and every CAP6 finding High.
 */
import { parseRecordFindings, parseReviewResult } from '../../lib/autoplan-reconcile';
import { DX_ERROR_ITEMS } from '../../lib/dx-error-contract';

export const DX_ERROR_CONTRACT_PLAN = `# Plan: acmesync 2.0 CLI error handling

## Implementation plan

acmesync is a CLI that syncs a local project directory with the Acme hosted API. Version 2.0
ships these error paths. Each is labelled so reviewers can refer to it.

### Error path P1 (acmesync push)
When a push fails, print \`Error: push failed\` to stdout and exit 0, so CI scripts keep going.
If the server returns 401, ask on the terminal: \`Retry with saved token? [y/N]\` and wait for an
answer. Network errors are caught and reported as \`something went wrong\`; the underlying error is
discarded. With \`--debug\`, print the full HTTP request including its Authorization header (the
bearer token from ACME_TOKEN) so users can paste it into a bug report. On a conflict, print
\`Run acmesync push --force to skip the conflict check\`; \`--force\` also skips the "overwrite remote
files?" confirmation.

### Error path P2 (acmesync pull)
Every pull failure goes to stderr with its own non-zero exit code and a stable code whose doc anchor is
https://acme.example/errors#<CODE>; \`--json\` emits the same fields as an RFC 9457 object with \`code\`,
\`fix\`, \`recovery: {action, side_effects}\` and that \`type\` URL. Tokens are masked in every message.
A missing project exits 4:
\`acmesync pull: project 'web' not found in ./acme.toml (PROJECT_NOT_FOUND); fix: run 'acmesync projects list', then 'acmesync pull <name>'. Nothing was changed.\`
Network failures (NETWORK_UNREACHABLE, exit 5) and unexpected crashes (INTERNAL_CRASH, exit 70) both print
the operation and project name, the underlying error, acmesync and API versions, the config file in use and
the names of the env vars read. A network failure adds "safe to retry; nothing was written; retries at most
3 times with backoff, then stop" and, once the retries are used up, ends with "fix: check that
https://api.acme.example is reachable from this machine, then rerun acmesync pull; if it still fails, send
this message to Acme support". A crash writes the stack trace to ~/.acme/logs/crash-<timestamp>.log and
prints that path, plus "nothing was changed: pull stages files in ./.acme/staging and swaps them in with one
rename; rerun acmesync pull once, and if it crashes again send that log to Acme support".

### Error path P3 (GET /v1/projects/{id} on the Acme API)
An unknown id returns HTTP 404 with an RFC 9457 body: \`type\`
https://acme.example/errors#PROJECT_NOT_FOUND, \`title\` "Project not found", \`detail\` "No project
with id prj_123", \`instance\` req_8f2c (the correlation id), \`code\` PROJECT_NOT_FOUND, and \`fix\`
"List projects with GET /v1/projects". Server stack traces and internal hostnames stay in the
server logs, keyed by the request id.

### Error path P4 (unknown flag)
\`acmesync --colour\` prints \`acmesync: unknown flag --colour; did you mean --color? (USAGE)\` to
stderr and exits 2 before doing anything.

### Error path P5 (acmesync migrate)
\`acmesync migrate\` rewrites ./acme.toml from the v1 format to v2 in place.

## Review record
`;

export type CapLevel = 4 | 6;
export interface CapFinding { level: CapLevel; path: string; item: string; severity?: string; title: string }
export interface DxContractGrade { pass: boolean; reasons: string[]; caps: CapFinding[] }

const ITEMS = new Set<string>(DX_ERROR_ITEMS);
const ALIASES: Record<string, string> = { terminal: 'channel', exit: 'channel', 'exit-code': 'channel', secret: 'redaction' };

function pathId(raw: string): string | undefined {
  const label = /\bP([1-5])\b/i.exec(raw);
  if (label) return `P${label[1]}`;
  const text = raw.toLowerCase();
  if (text.includes('push')) return 'P1';
  if (text.includes('pull')) return 'P2';
  if (text.includes('/v1/projects') || text.includes('api')) return 'P3';
  if (text.includes('colour') || text.includes('flag') || text.includes('usage')) return 'P4';
  if (text.includes('migrate')) return 'P5';
  return undefined;
}

export function capFindings(review: string): CapFinding[] {
  const caps: CapFinding[] = [];
  for (const finding of parseRecordFindings(review).findings) {
    const title = String(finding.title ?? '');
    const match = /^\s*CAP([46])\s*:\s*([^:]+?)\s*:\s*([A-Za-z_-]+)/.exec(title);
    if (!match) continue;
    const item = match[3]!.toLowerCase();
    caps.push({ level: Number(match[1]) as CapLevel, path: pathId(match[2]!) ?? match[2]!.trim(),
      item: ALIASES[item] ?? item, severity: finding.severity, title });
  }
  return caps;
}

export function gradeDxContractReview(review: string, sha256: string): DxContractGrade {
  const reasons = parseReviewResult(review, { phase: 'dx', sha256 }).errors.map(error => `result: ${error}`);
  const caps = capFindings(review);
  for (const cap of caps) {
    if (!ITEMS.has(cap.item)) reasons.push(`unknown item in "${cap.title}"`);
    const want = cap.level === 4 ? 'Critical' : 'High';
    if (cap.severity !== want) reasons.push(`CAP${cap.level} labelled ${cap.severity ?? 'none'}, want ${want}: "${cap.title}"`);
  }
  const p1 = caps.filter(cap => cap.path === 'P1');
  for (const item of ['redaction', 'channel', 'fix']) {
    if (!p1.some(cap => cap.level === 4 && cap.item === item)) reasons.push(`P1 missing CAP4:${item}`);
  }
  if (!p1.some(cap => cap.item === 'context')) reasons.push('P1 missing a CAP finding on context');
  for (const path of ['P2', 'P3', 'P4']) {
    const hits = caps.filter(cap => cap.path === path);
    if (hits.length) reasons.push(`${path} should not be capped: ${hits.map(cap => cap.title).join(' | ')}`);
  }
  if (!caps.some(cap => cap.path === 'P5')) reasons.push('P5 (unspecified error handling) not capped');
  return { pass: reasons.length === 0, reasons, caps };
}
