/**
 * requiredReads enforcement (v2 plan T9, mitigation layer 5 — the only CI-failing
 * layer against silent section-skip).
 *
 * Given a /ship run's tool calls and the set of section files the run's SITUATION
 * required, assert the agent actually Read each one. The required set comes from
 * the TEST FIXTURE (which situation it set up), NOT from the manifest — the
 * manifest is passive (CM2). This keeps "when is a section required" in exactly
 * one machine-checkable place: the eval fixtures.
 *
 * Builds on extractSectionReads from transcript-section-logger so section-path
 * matching (the `/sections/<file>.md` segment, host-layout agnostic) lives in one
 * place.
 */

import { extractSectionReads, type TranscriptResultLike } from './transcript-section-logger';

export interface RequiredReadsResult {
  required: string[];
  read: string[];
  missing: string[];
  ok: boolean;
}

/**
 * @param result        the skill run (anything with toolCalls)
 * @param requiredFiles section basenames the situation required, e.g.
 *                      ['version-bump.md','changelog.md'] (or with a sections/
 *                      prefix — normalized to basename here)
 */
export function assertRequiredReads(
  result: TranscriptResultLike,
  requiredFiles: string[],
): RequiredReadsResult {
  const read = extractSectionReads(result);
  const readSet = new Set(read);
  const required = requiredFiles.map(f => f.replace(/^.*\//, '')); // tolerate sections/<f>
  const missing = required.filter(f => !readSet.has(f));
  return { required, read, missing, ok: missing.length === 0 };
}
