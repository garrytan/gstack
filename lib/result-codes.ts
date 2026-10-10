/**
 * Result codes for the unattended workflow commands (gstack-artifact,
 * gstack-gate, gstack-autoplan-timing, gstack-review-log --findings, and the
 * skill-start guard line). Sibling of lib/gate-outcomes.ts, whose `state`
 * enum is for gate outcomes only: a result code has no state, just one
 * stable anchor in docs/troubleshooting.md, a summary and a `fix:` clause.
 * Every error line a workflow command prints ends with `(<CODE>)` so a parent
 * agent greps the code, never the prose. test/troubleshooting-anchors.test.ts
 * checks every anchor exists; add a row here before printing a new code.
 */
export interface ResultCode {
  /** Stable `<a id>` in docs/troubleshooting.md. */
  anchor: string;
  /** What happened, in plain words; `<detail>` adds the real value. */
  summary: string;
  fix: string;
}

export const RESULT_CODES = {
  ARTIFACT_INVALID_JSON: {
    anchor: 'artifact-invalid-json',
    summary: 'the manifest or a JSON artifact is not valid JSON',
    fix: 'regenerate the run with the tool that writes it; never hand-edit a manifest',
  },
  ARTIFACT_UNSUPPORTED_VERSION: {
    anchor: 'artifact-unsupported-version',
    summary: 'the artifact declares a schema_version this gstack does not read',
    fix: 'run /gstack-upgrade on the consumer, or regenerate the run with this gstack',
  },
  ARTIFACT_SCHEMA: {
    anchor: 'artifact-schema',
    summary: 'a required field is missing or holds a value outside its enum',
    fix: 'compare the row with `gstack-artifact schema <name>` and regenerate it',
  },
  ARTIFACT_MISSING: {
    anchor: 'artifact-missing',
    summary: 'an artifact named by the manifest is not in the run directory',
    fix: 'copy the whole run directory, not single files; rerun the phase that writes the missing file',
  },
  ARTIFACT_STALE: {
    anchor: 'artifact-stale',
    summary: 'an artifact’s bytes no longer match the hash the manifest recorded',
    fix: 'treat the run as tampered or partially rewritten; regenerate it or re-bind the file through the tool that wrote it',
  },
  ARTIFACT_PATH_ESCAPE: {
    anchor: 'artifact-path-escape',
    summary: 'an artifact path resolves outside the run directory (a `..` segment, an absolute path or a symlink)',
    fix: 'keep every artifact inside the run directory and name it with a plain relative path',
  },
  ARTIFACT_MALFORMED_JSONL: {
    anchor: 'artifact-malformed-jsonl',
    summary: 'a JSONL artifact has a line (usually the tail) that is not one JSON object',
    fix: 'the writer was interrupted mid-append; rerun the phase that writes the file',
  },
  ARTIFACT_DUPLICATE_ID: {
    anchor: 'artifact-duplicate-id',
    summary: 'two rows share one id',
    fix: 'ids are run-bound and unique per file; regenerate the rows with the tool that assigns them',
  },
  ARTIFACT_UNBOUND_ID: {
    anchor: 'artifact-unbound-id',
    summary: 'a row id does not start with the run id',
    fix: 'ids are `<run>-...`; regenerate the row with the run id the manifest names',
  },
  ARTIFACT_DANGLING_REF: {
    anchor: 'artifact-dangling-ref',
    summary: 'a row references an id no artifact in this run defines',
    fix: 'write the referenced finding, decision or task first, or drop the reference',
  },
  ARTIFACT_DEPENDENCY_CYCLE: {
    anchor: 'artifact-dependency-cycle',
    summary: 'tasks depend on each other in a cycle',
    fix: 'break the cycle in `depends_on`; a lane cannot start a task that waits on itself',
  },
  ARTIFACT_COUNT_MISMATCH: {
    anchor: 'artifact-count-mismatch',
    summary: 'a count in run.json disagrees with the rows in the file it summarizes',
    fix: 'regenerate run.json after the last row was written; a count never replaces the file',
  },
  ARTIFACT_RUN_INTERRUPTED: {
    anchor: 'artifact-run-interrupted',
    summary: 'the run did not reach a terminal status or a reviewer never returned',
    fix: 'resume the run (`gstack-autoplan resume --out <dir>`) or treat its artifacts as partial',
  },
  ARTIFACT_REVIEWER_MISSING: {
    anchor: 'artifact-reviewer-missing',
    summary: 'a required phase or one of its voices has no terminal outcome or no bound output file',
    fix: 'finish the phase; a missing voice is missing coverage, never N/A by default',
  },
  ARTIFACT_GUARD_LINE_MISSING: {
    anchor: 'artifact-guard-line-missing',
    summary: 'an unattended run’s review-record.md does not state that the publication guard was not enforced',
    fix: 'start the run through gstack-skill-start so the GUARD_NOT_INSTALLED line is recorded',
  },
  GUARD_NOT_INSTALLED: {
    anchor: 'guard-not-installed',
    summary: 'this host does not execute the autoplan publication hook, so phase publication order is unverified',
    fix: 'nothing to do on this host; the run record carries this line, and the snapshot hashes per phase stand in for the guard',
  },
  REVIEW_STATUS_MISMATCH: {
    anchor: 'review-status-mismatch',
    summary: 'the review-log row claims a status or count that its findings file contradicts',
    fix: 'log through `--findings <file>` and let the row be derived; fix the findings file, not the claim',
  },
  GATE_REV_STALE: {
    anchor: 'gate-rev-stale',
    summary: 'the reply answers an older revision of the gate list',
    fix: 'render the current gate list, read it, and reply with its gate_rev',
  },
  GATE_REPLY_UNPARSED: {
    anchor: 'gate-reply-unparsed',
    summary: 'part of the reply matched no gate item or option, so nothing was applied',
    fix: 'reply with `all`, `<id><option>` tokens (for example `d3b uc1a`), or `all except <tokens>`; bare yes/no is ambiguous',
  },
} as const satisfies Record<string, ResultCode>;

export type ResultCodeName = keyof typeof RESULT_CODES;

/** One error line: `<context>: <summary>[ (<detail>)]; fix: <fix> (<CODE>)`. */
export function resultLine(context: string, code: ResultCodeName, detail?: string): string {
  const row: ResultCode = RESULT_CODES[code];
  const what = detail ? `${row.summary} (${detail})` : row.summary;
  return `${context}: ${what}; fix: ${row.fix} (${code})`;
}
