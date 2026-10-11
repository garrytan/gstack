/**
 * Spec-review loop at the cap (plan B8). When the loop stops with blocking
 * findings (MAX_ITERATIONS or CONVERGENCE) the unresolved gaps are listed by
 * number and one of two recorded paths follows, never a resample of unchanged
 * input and never another model launch: a deterministic verification that each
 * listed fix landed in the design (`issues verified: k of N`), or
 * `N fixes unconfirmed` with the approval gate blocked by a
 * `spec not re-verified` decision. Verification checks applied edits only; it
 * is never promoted to a review verdict.
 */
import type { OfficeHoursReview } from './office-hours-review';

export interface SpecFix { id: string; applied_text: string }
export interface SpecCapGap { id: string; dimension: string; severity: string; problem: string; remedy: string }
export interface SpecCapVerification {
  round: number;
  gaps: SpecCapGap[];
  verified: string[];
  unconfirmed: string[];
  design_changed: boolean;
  /** `issues verified: k of N` or `N fixes unconfirmed`, as the plan names them. */
  line: string;
  decision: 'spec not re-verified' | null;
}

export const SPEC_NOT_REVERIFIED = 'spec not re-verified' as const;
const flat = (value: string) => value.replace(/\s+/g, '');

export function parseSpecFixes(value: unknown): SpecFix[] {
  if (!Array.isArray(value)) throw new Error('fixes must be a JSON array of {id, applied_text}');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`fixes[${index}] must be an object`);
    const { id, applied_text } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim()) throw new Error(`fixes[${index}].id must be a finding id`);
    if (typeof applied_text !== 'string' || flat(applied_text).length < 8) throw new Error(`fixes[${index}].applied_text must be a verbatim excerpt of at least 8 characters`);
    return { id, applied_text };
  });
}

/** Null when the last round has no blocking finding: PASS needs no cap record. */
export function verifySpecFixesAtCap(last: OfficeHoursReview, snapshot: string, current: string, fixes: SpecFix[] | null): SpecCapVerification | null {
  const gaps = last.findings.filter(f => f.severity === 'blocking').map(f => ({ id: f.id, dimension: f.dimension, severity: f.severity, problem: f.problem, remedy: f.remedy }));
  if (!gaps.length) return null;
  const flatCurrent = flat(current), flatSnapshot = flat(snapshot);
  const changed = flatCurrent !== flatSnapshot;
  const verified: string[] = [], unconfirmed: string[] = [];
  for (const gap of gaps) {
    const fix = changed ? fixes?.find(f => f.id === gap.id) : undefined;
    const landed = !!fix && flatCurrent.includes(flat(fix.applied_text)) && !flatSnapshot.includes(flat(fix.applied_text));
    (landed ? verified : unconfirmed).push(gap.id);
  }
  const n = gaps.length, k = verified.length;
  const line = k === n ? `issues verified: ${k} of ${n}`
    : `${n - k} fixes unconfirmed${k ? ` (issues verified: ${k} of ${n})` : ''}${changed ? '' : ` (design unchanged since round ${last.round})`}`;
  return { round: last.round, gaps, verified, unconfirmed, design_changed: changed, line, decision: k === n ? null : SPEC_NOT_REVERIFIED };
}

export function renderSpecCap(cap: SpecCapVerification): string {
  const list = cap.gaps.map((gap, i) => `${i + 1}. ${gap.id} — ${gap.dimension} (${gap.severity}): ${gap.problem.split(/\r?\n/)[0]}`).join('\n');
  const basis = `Verification is deterministic: a fix counts when its \`applied_text\` is in the current design and absent from the round-${cap.round} snapshot. It confirms applied edits, never a review verdict; no reviewer was launched past the cap.`;
  const decision = cap.decision ? `\n\nDecision: ${cap.decision} — the approval gate stays blocked until a changed-input re-review or an explicit owner acceptance of the unconfirmed fixes (${cap.unconfirmed.join(', ')}).` : '';
  return `### Unresolved at the cap\n\n${list}\n\n${cap.line}\n\n${basis}${decision}`;
}
