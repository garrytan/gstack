/** Shared shapes of the gate-edit detector (lib/gate-diff/*). */

export type DiffLineKind = 'ctx' | 'del' | 'add';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface Hunk {
  /** The `@@ -a,b +c,d @@ …` header as git printed it. */
  header: string;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';

/** Why a path has no readable hunks. Named coverage, never zero hunks. */
export type Unsupported = 'binary' | 'symlink' | 'submodule' | 'undecodable';

export interface FileDiff {
  /** Path before the change; equals newPath unless renamed. `/dev/null` is never used: added files carry newPath in both. */
  oldPath: string;
  newPath: string;
  status: FileStatus;
  hunks: Hunk[];
  unsupported?: Unsupported;
}

export interface CommitInfo {
  sha: string;
  /** Full message body. */
  message: string;
}

export type Level = 'listed' | 'read';

export interface ListedHunk {
  id: string;
  path: string;
  oldPath: string;
  level: Level;
  tags: string[];
  old: string[];
  new: string[];
  citation: string | null;
  /** Human-readable facts beside a tag (RH-15 key, values and direction). */
  notes: string[];
  header: string;
  /** Floor class that admitted the hunk, when any. */
  floor: string | null;
  unsupported?: Unsupported;
  /** Approximate byte size of old+new lines, for the 200 KB read budget. */
  bytes: number;
}

export interface ScanSummary {
  listed: number;
  eligible: number;
  inspected: number;
  unread: number;
  tagged: Record<string, number>;
  unmatched: number;
  coverage: string[];
  languagesUnlisted: string[];
  candidate: string;
  artifact: string;
}

export interface ScanResult {
  summary: ScanSummary;
  hunks: ListedHunk[];
  /** Changed paths that matched no floor class and carried no tag. */
  unmatchedPaths: string[];
  /** Paths with no readable hunks and why. */
  unsupportedPaths: { path: string; reason: Unsupported }[];
}
