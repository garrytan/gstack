/** Redaction of the producer's provider output and error text before a receipt binds them. */
import { join } from 'node:path';
import { readBoundedStable } from '../lib/cso/bounded-file';
import { CsoError, MAX_OUTPUT } from '../lib/cso/contracts';
import { redactFindingSpans, scan } from '../lib/redact-engine';

/**
 * Identifiers the CSO helper emits by schema, which the redactor's PII shapes misread: `<epoch ms>-<hex>` run and
 * replay IDs and the 13-digit epoch in them (pii.phone.e164), `cso-eval-<runId>-<sha12>` catalog revisions,
 * `<tool>-<hex16>-<hex16>` artifact IDs, and hex finding, review and content IDs (pii.wallet).
 */
const HELPER_ID = /(?<![A-Za-z0-9])(?:\d{13}-[a-f0-9]{16}|cso-eval-\d{1,20}-[a-f0-9]{12}|(?:[a-z]+-)+[a-f0-9]{16}-[a-f0-9]{16}|[a-f0-9]{16,64})(?![A-Za-z0-9])/g;

export interface OutputRedaction {
  /** The text as a receipt may bind it. */
  text: string;
  /** Matched rule IDs with their counts, e.g. `pii.phone.e164×2`; never the matched text. */
  rules: string[];
  /** True when a credential-class (`secret`) rule matched: the text must be withheld, not span-redacted. */
  secret: boolean;
}

const tally = (ids: string[]): string[] => {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left < right ? -1 : 1).map(([id, count]) => `${id}×${count}`);
};

const ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*["']?([^\s"'#]{8,})/;

/**
 * Values assigned to credential-shaped names (the env.kv rule) in the cell's verified source, such as a planted
 * canary. Quoted without its name, such a value reads as prose to every rule, so the output check matches it exactly.
 */
export function sourceCredentialValues(root: string, paths: string[]): string[] {
  const values = new Set<string>();
  for (const path of paths) {
    if (path === '.git' || path.startsWith('.git/')) continue;
    const contents = readBoundedStable(join(root, ...path.split('/')), 2 * 1024 * 1024, 'Producer source file');
    if (contents.includes(0)) continue;
    const text = contents.toString('utf8'), lines = text.split('\n');
    for (const finding of scan(text, { maxBytes: 2 * 1024 * 1024 }).findings) {
      const value = finding.id === 'env.kv' ? ASSIGNMENT.exec(lines[finding.line - 1] ?? '')?.[1] : undefined;
      if (value) values.add(value);
    }
  }
  return [...values];
}

/**
 * Credential classes are judged on the unmasked text, so masking can never hide one. Only when none matched are the
 * helper's identifiers set aside and the remaining PII, internal, legal and hygiene spans replaced in place.
 */
export function redactProducerText(value: string, sourceCredentials: string[] = []): OutputRedaction {
  const findings = scan(value, { maxBytes: MAX_OUTPUT });
  if (findings.oversize) throw new CsoError('REDACTION_FAILED', 'Producer output withheld because it exceeds the redaction limit');
  const secretIds = findings.findings.filter(finding => finding.category === 'secret').map(finding => finding.id);
  for (const credential of sourceCredentials) secretIds.push(...Array(value.split(credential).length - 1).fill('source.env.kv'));
  if (secretIds.length) return { text: '', rules: tally(secretIds), secret: true };
  const identifiers: string[] = [];
  const letters = (index: number): string => (index >= 26 ? letters(Math.floor(index / 26) - 1) : '') + String.fromCharCode(97 + (index % 26));
  const masked = value.replace(HELPER_ID, match => `GSTACKHELPERID${letters(identifiers.push(match) - 1)}Z`);
  const masking = scan(masked, { maxBytes: MAX_OUTPUT }).findings;
  const redacted = redactFindingSpans(masked, { maxBytes: MAX_OUTPUT });
  if (redacted === null) throw new CsoError('REDACTION_FAILED', 'Producer output withheld because redaction could not safely locate every span');
  const indexOf = (code: string): number => [...code].reduce((total, char) => total * 26 + char.charCodeAt(0) - 96, 0) - 1;
  const text = redacted.replace(/GSTACKHELPERID([a-z]+)Z/g, (whole, code: string) => identifiers[indexOf(code)] ?? whole);
  return { text, rules: tally(masking.map(finding => finding.id)), secret: false };
}
