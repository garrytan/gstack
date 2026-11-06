/**
 * ship-receipt-docs — the receipt's `docs` record (what /ship Step 14.5's
 * documentation audit concluded, and the owner's exception when it stayed
 * blocked) and the doc caps a repository declares in its ship policy
 * (`docs.caps`, docs/ship-policy.md#ship-receipt). Kept beside
 * lib/ship-receipt.ts so that module stays under the size ratchet.
 */
export const DOCS_STATUSES = ['updated', 'current', 'blocked'] as const;
export type DocsStatus = typeof DOCS_STATUSES[number];
/** Only the owner accepts a documentation risk; the record names who, when, where and why, and the PR body repeats it word for word. */
export interface DocsException { accepted_by: string; date: string; via: string; reason: string }
export interface ReceiptDocs { status: DocsStatus; scope: string; exception?: DocsException }
export type DocsParse = { ok: true; docs: ReceiptDocs } | { ok: false; code: 'RECEIPT_INVALID' | 'DOCS_AUDIT_BLOCKED'; message: string };

const EXCEPTION_KEYS = ['accepted_by', 'date', 'via', 'reason'] as const;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v);

/**
 * `write --docs` input: `{ status, scope, exception? }`. A blocked audit with
 * no exception is DOCS_AUDIT_BLOCKED, not a receipt: /ship Step 14.5 ends
 * blocked only when the owner has not accepted the named risk, and a receipt
 * written then would publish an unaudited release as audited.
 */
export function parseReceiptDocs(value: unknown): DocsParse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'RECEIPT_INVALID', message: '--docs needs a JSON object { status, scope[, exception] }' };
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!['status', 'scope', 'exception'].includes(key)) return { ok: false, code: 'RECEIPT_INVALID', message: `--docs: unknown key ${JSON.stringify(key)}` };
  if (!DOCS_STATUSES.includes(v.status as DocsStatus)) return { ok: false, code: 'RECEIPT_INVALID', message: `--docs status must be one of ${DOCS_STATUSES.join(' | ')}, got ${JSON.stringify(v.status)}` };
  if (!text(v.scope)) return { ok: false, code: 'RECEIPT_INVALID', message: '--docs scope must be a non-empty one-line string (the docs roots the audit covered)' };
  const docs: ReceiptDocs = { status: v.status as DocsStatus, scope: v.scope.trim() };
  if (v.exception !== undefined) {
    const e = v.exception as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, code: 'RECEIPT_INVALID', message: '--docs exception must be { accepted_by, date, via, reason }' };
    for (const key of Object.keys(e)) if (!(EXCEPTION_KEYS as readonly string[]).includes(key)) return { ok: false, code: 'RECEIPT_INVALID', message: `--docs exception: unknown key ${JSON.stringify(key)}` };
    for (const key of EXCEPTION_KEYS) if (!text(e[key])) return { ok: false, code: 'RECEIPT_INVALID', message: `--docs exception.${key} must be a non-empty one-line string` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date as string)) return { ok: false, code: 'RECEIPT_INVALID', message: '--docs exception.date must be YYYY-MM-DD' };
    docs.exception = { accepted_by: (e.accepted_by as string).trim(), date: e.date as string, via: (e.via as string).trim(), reason: (e.reason as string).trim() };
  }
  if (docs.status === 'blocked' && !docs.exception) return { ok: false, code: 'DOCS_AUDIT_BLOCKED', message: `the documentation audit is blocked (${docs.scope}) and no owner exception is recorded; repair the audit, or record the owner's acceptance as exception: { accepted_by, date, via, reason }` };
  return { ok: true, docs };
}

/** The line the PR body's `## Documentation` section must carry when an exception stands: the exception, word for word. */
export function docsExceptionLine(docs: ReceiptDocs): string | null {
  if (!docs.exception) return null;
  const e = docs.exception;
  return `Documentation exception: accepted by ${e.accepted_by} ${e.date} via ${e.via}: ${e.reason}`;
}

/** One earlier Step 14.5 audit of the same /ship run that a post snapshot carries (gstack-docs-candidate snapshot --carry, GST-1616). */
export interface CarriedAudit { run_id: string; audit_id: string; head: string; edited: Record<string, { before: string | null; after: string | null }> }

/** The earlier audits a post snapshot carries, oldest first, each of the snapshot's own run; a string says why they cannot be read. */
export function carriedAudits(post: { run_id?: unknown; audit_id?: unknown; earlier?: unknown }): CarriedAudit[] | string {
  if (post.earlier === undefined) return [];
  if (!Array.isArray(post.earlier)) return 'its earlier field is not a list of audits';
  if (!text(post.run_id)) return 'it carries earlier audits but names no run_id';
  const sha = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v);
  const seen = new Set([post.audit_id]);
  for (const e of post.earlier as Array<Record<string, any>>) {
    const edited = e?.edited;
    if (!e || typeof e !== 'object' || !text(e.audit_id) || !sha(e.head) || !edited || typeof edited !== 'object' || Array.isArray(edited)
      || !Object.values(edited).every((v: any) => v && typeof v === 'object' && (v.before === null || sha(v.before)) && (v.after === null || sha(v.after)))) return 'it carries an earlier audit that is not { run_id, audit_id, head, edited }';
    if (e.run_id !== post.run_id) return `it carries audit ${e.audit_id} of another /ship run (${String(e.run_id)}), not ${post.run_id}`;
    if (seen.has(e.audit_id)) return `it carries audit ${e.audit_id} twice`;
    seen.add(e.audit_id);
  }
  return post.earlier as CarriedAudit[];
}

// ---------------------------------------------------------------------------
// doc caps: `docs.caps` in .gstack/ship-policy.json
// ---------------------------------------------------------------------------
export interface DocsCap { path: string; max_bytes: number }
export interface DocsCapResult { path: string; bytes: number | null; max: number; verdict: 'ok' | 'over' }

/** Every declared cap against the candidate tree; a path the tree lacks is `over` (a cap on nothing is a policy mistake, not a pass). */
export function checkDocsCaps(caps: readonly DocsCap[], sizeOf: (rel: string) => number | null): DocsCapResult[] {
  return caps.map(cap => {
    const bytes = sizeOf(cap.path);
    return { path: cap.path, bytes, max: cap.max_bytes, verdict: bytes !== null && bytes <= cap.max_bytes ? 'ok' : 'over' };
  });
}

export function docsCapLine(r: DocsCapResult): string {
  return `DOCS_CAP: ${r.path} ${r.bytes === null ? 'absent' : r.bytes}/${r.max} ${r.verdict}`;
}
