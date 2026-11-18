/**
 * Security findings stay out of public text (GST-3076). A PR body keeps every earlier version in its edit history, and a
 * ruled, dispositioned, deferred or noted security finding is often a live exposure outside the PR's own change, so its
 * location and reason never go into a line gstack renders for a PR body, its receipt block or a GitHub post. The public
 * form is an opaque id and REDACTED_REASON; the fingerprint and reason stay where they were recorded, in the private
 * approval record (`gstack-approvals list`) or the local review files. This holds on every repository, whatever its
 * visibility: the rendered lines are compared word for word at receipt write and at land, so they cannot depend on a
 * visibility lookup that can fail or change, and a private repository can go public with its PR history.
 */
import { createHash } from 'node:crypto';

/** The finding categories that are security class: the security, red-team and targeted auth and secret reviewers. */
export const SECURITY_CATEGORIES: readonly string[] = ['security', 'auth', 'secret', 'red-team'];
export const REDACTED_FINDING = 'redacted';
export const REDACTED_REASON = 'security finding, details recorded privately';
export const REDACTED_WORDS = 'recorded privately';

const FINGERPRINT_CATEGORY = /^.+:\d*:([^:\s]+)$/;
const RAW_FINGERPRINT = new RegExp(`[^\\s\`'"(\\[<>|]+:\\d+:(?:${SECURITY_CATEGORIES.join('|')})(?![\\w-])`, 'gi');

/** Whether a finding is security class, by its category, its reviewer or its fingerprint's `path:line:category`. */
export function isSecurityFinding(f: string | { fingerprint?: unknown; category?: unknown; specialist?: unknown }): boolean {
  const o = typeof f === 'string' ? { fingerprint: f } : f;
  const fromPrint = typeof o.fingerprint === 'string' ? FINGERPRINT_CATEGORY.exec(o.fingerprint)?.[1] : undefined;
  return [o.category, o.specialist, fromPrint].some(c => typeof c === 'string' && SECURITY_CATEGORIES.includes(c.toLowerCase()));
}

/** An id for a finding that names neither its location nor its text, and that cannot be guessed from the repository's paths alone. */
export const opaqueFindingId = (fingerprint: string, detail: string) => 'sf-' + createHash('sha256').update(`${fingerprint}\u0000${detail}`).digest('hex').slice(0, 12);

/** Every raw security-class fingerprint (`path:line:security` and the like) in text bound for a public surface. */
export const securityFingerprints = (text: string): string[] => [...new Set(text.match(RAW_FINGERPRINT) ?? [])];
