// lib/design-detect-contract.ts — the one owner of the design-detector vocabulary.
//
// Pure module: no I/O, no imports from scripts/. Every sentinel the wrapper
// (bin/gstack-design-detect.ts) or the DESIGN.md tool (bin/gstack-design-md.ts)
// prints, and every one the skill prose reads, is a constant here, so the two
// sides cannot drift: gen-time resolvers import these strings into SKILL.md
// prose, the bins import them at runtime, and test/design-detect-contract.test.ts
// asserts that every sentinel-shaped token in generated docs exists here.
//
//   probe ──► one of: IMPECCABLE_READY | IMPECCABLE_NOT_CACHED | IMPECCABLE_NOT_AVAILABLE | IMPECCABLE_DISABLED
//         ──► always:  IMPECCABLE_SKILL, IMPECCABLE_HOOK, IMPECCABLE_IGNORED_RULES, IMPECCABLE_IGNORED_FILES,
//                      IMPECCABLE_IGNORED_VALUES
//         ──► maybe:   IMPECCABLE_HOOK_OTHER, IMPECCABLE_CONFIG_UNREADABLE, IMPECCABLE_ENV_IGNORED,
//                      IMPECCABLE_ENGINE_UNTESTED, DESIGN_DETECTOR_HINT, DESIGN_DETECTOR_INSTALL_OFFER
//   install ──► IMPECCABLE_INSTALLED: <path> ... | IMPECCABLE_INSTALL_REFUSED: <reason>  (then the probe lines)
//   scan  ──► stdout:  one JSON document (--format gstack) or engine bytes (--format raw)
//         ──► stderr:  DETECT_TOP block, DETECT_SUMMARY, DETECT_EXIT, DETECT_REFUSED / DETECT_NO_TARGETS /
//                      DETECT_TIMEOUT / DETECT_PARSE_ERROR / DETECT_OUTPUT_TOO_LARGE
//   any   ──► exit 3 + DESIGN_DETECT_INTERNAL_ERROR: a gstack bug, never retried

export const SENTINEL = {
  READY: 'IMPECCABLE_READY',
  NOT_CACHED: 'IMPECCABLE_NOT_CACHED',
  NOT_AVAILABLE: 'IMPECCABLE_NOT_AVAILABLE',
  DISABLED: 'IMPECCABLE_DISABLED',
  SKILL: 'IMPECCABLE_SKILL',
  HOOK: 'IMPECCABLE_HOOK',
  HOOK_OTHER: 'IMPECCABLE_HOOK_OTHER',
  IGNORED_RULES: 'IMPECCABLE_IGNORED_RULES',
  IGNORED_FILES: 'IMPECCABLE_IGNORED_FILES',
  IGNORED_VALUES: 'IMPECCABLE_IGNORED_VALUES',
  CONFIG_UNREADABLE: 'IMPECCABLE_CONFIG_UNREADABLE',
  ENV_IGNORED: 'IMPECCABLE_ENV_IGNORED',
  ENGINE_UNTESTED: 'IMPECCABLE_ENGINE_UNTESTED',
  /** the probe found no engine and the user has not answered the install offer yet: the skill asks once */
  INSTALL_OFFER: 'DESIGN_DETECTOR_INSTALL_OFFER',
  /** `install` placed a checksum-verified engine under the user's home */
  INSTALLED: 'IMPECCABLE_INSTALLED',
  /** `install` did not write anything, reason after the colon */
  INSTALL_REFUSED: 'IMPECCABLE_INSTALL_REFUSED',
  HINT: 'DESIGN_DETECTOR_HINT',
  DETECT_EXIT: 'DETECT_EXIT',
  DETECT_EXIT_CODE: 'DETECT_EXIT_CODE',
  DETECT_SUMMARY: 'DETECT_SUMMARY',
  DETECT_TOP: 'DETECT_TOP',
  DETECT_REFUSED: 'DETECT_REFUSED',
  DETECT_NO_TARGETS: 'DETECT_NO_TARGETS',
  DETECT_TIMEOUT: 'DETECT_TIMEOUT',
  DETECT_PARSE_ERROR: 'DETECT_PARSE_ERROR',
  DETECT_OUTPUT_TOO_LARGE: 'DETECT_OUTPUT_TOO_LARGE',
  INTERNAL_ERROR: 'DESIGN_DETECT_INTERNAL_ERROR',
  /** printed by rendered bash: the temp file holding a scan's JSON */
  DETECT_JSON: 'DETECT_JSON',
  /** printed by rendered bash after a DOM dump is persisted */
  DOM_DUMP_OK: 'DOM_DUMP_OK',
  DOM_DUMP_MISSING: 'DOM_DUMP_MISSING',
  DOM_DUMP_REDACTION_BLOCKED: 'DOM_DUMP_REDACTION_BLOCKED',
  DOM_DUMP_TOO_LARGE: 'DOM_DUMP_TOO_LARGE',
  DESIGN_MD_FORMAT: 'DESIGN_MD_FORMAT',
  DESIGN_MD_CONVERT_REFUSED: 'DESIGN_MD_CONVERT_REFUSED',
  DESIGN_MD_INTERNAL_ERROR: 'DESIGN_MD_INTERNAL_ERROR',
  DESIGN_MD_TOKEN_REF_INVALID: 'DESIGN_MD_TOKEN_REF_INVALID',
  /** printed by gstack-design-md check / convert */
  DESIGN_MD_MARKER: 'DESIGN_MD_MARKER',
  DESIGN_MD_REASON: 'DESIGN_MD_REASON',
  DESIGN_MD_WRITTEN: 'DESIGN_MD_WRITTEN',
  DESIGN_MD_BACKUP: 'DESIGN_MD_BACKUP',
  DESIGN_MD_EDIT_REFUSED: 'DESIGN_MD_EDIT_REFUSED',
  /** printed by the wrapper: --verbose probe trail, forwarded engine stderr */
  PROBE_STEP: 'PROBE_STEP',
  ENGINE_STDERR: 'ENGINE_STDERR',
} as const;


/**
 * Sentinels whose line explains itself after the colon (a path, a version, a
 * reason). Prose need not teach them; the agent notes them and moves on. The
 * contract test requires every OTHER sentinel to be taught somewhere the agent
 * reads.
 */
export const SELF_DESCRIBING_SENTINELS: readonly string[] = [
  SENTINEL.HOOK_OTHER, SENTINEL.IGNORED_FILES, SENTINEL.IGNORED_VALUES, SENTINEL.CONFIG_UNREADABLE, SENTINEL.ENV_IGNORED,
  SENTINEL.ENGINE_UNTESTED, SENTINEL.DETECT_EXIT, SENTINEL.DETECT_REFUSED, SENTINEL.DETECT_NO_TARGETS,
  SENTINEL.DETECT_TIMEOUT, SENTINEL.DETECT_PARSE_ERROR, SENTINEL.DETECT_OUTPUT_TOO_LARGE,
  SENTINEL.DESIGN_MD_TOKEN_REF_INVALID, SENTINEL.DESIGN_MD_WRITTEN, SENTINEL.DESIGN_MD_BACKUP, SENTINEL.DESIGN_MD_EDIT_REFUSED,
  SENTINEL.PROBE_STEP, SENTINEL.ENGINE_STDERR, SENTINEL.DOM_DUMP_MISSING, SENTINEL.INSTALLED, SENTINEL.INSTALL_REFUSED,
];

/** Engine versions the committed fixtures were captured from. */
export const TESTED_ENGINE_VERSIONS: readonly string[] = ['0.1.3'];

/** Where impeccable publishes its engine binaries (GitHub Releases of pbakaus/impeccable, tag engine-v<version>). */
export const ENGINE_RELEASE_BASE = 'https://github.com/pbakaus/impeccable/releases/download';

/** `${process.platform}-${process.arch}` → the release asset's platform suffix (`impeccable-<suffix>`, `.exe` on Windows). */
export const ENGINE_ASSETS: Readonly<Record<string, string>> = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'win32-x64': 'windows-x64',
};

/**
 * Checksums gstack pins for the engine versions it has tested, per platform:
 * the `install` verb refuses a download whose bytes do not hash to the pin.
 * Captured 2026-09-09 from the release's own .sha256 sidecars
 * (https://github.com/pbakaus/impeccable/releases/tag/engine-v0.1.3); the
 * linux-x64 hash also matches the engine gstack's fixtures were captured with.
 * A pin recorded in this repo defends against a swapped release asset, which a
 * same-origin sidecar cannot; adding a version means re-capturing the fixtures.
 */
export const ENGINE_PINS: Readonly<Record<string, Readonly<Record<string, { sha256: string; bytes: number }>>>> = {
  '0.1.3': {
    'darwin-arm64': { sha256: '23821135d4c62f1428fd15ddb9e91d695402727f43b13a6eb3e9f31fc01b4072', bytes: 12677904 },
    'darwin-x64': { sha256: 'a5bb0ae15d1bd8f61ebd2a6a21d39c2b357a211c39b4b95cc2a947cdb10a4db4', bytes: 14300496 },
    'linux-x64': { sha256: 'afc7a424e0bd6c606b7be4c773c70e87284afbdb41d748eb9a34f8a4478e57da', bytes: 15991120 },
    'linux-arm64': { sha256: '523c0a223ac0c1522489759a9f56dccb0b458b42d6a5c66e74e6fe2255af60ce', bytes: 13262480 },
    'windows-x64': { sha256: '50846da00b48f7df5a82adc6c1ef1c82da0a890ac95e65cdd5da12aab2de6c1d', bytes: 14638984 },
  },
};

/** Rules the engine reports but never counts (they never change its exit code). */
export const ADVISORY_RULE_IDS: readonly string[] = ['em-dash-overuse'];

/** Markers around any engine text the skill may quote (page text can echo through it). */
export const UNTRUSTED_BEGIN = '═══ BEGIN UNTRUSTED CONTENT (design detector output) ═══';
export const UNTRUSTED_END = '═══ END UNTRUSTED CONTENT ═══';

export const DETECT_LIMITS = {
  /** default engine wall clock; GSTACK_DESIGN_DETECT_TIMEOUT_MS overrides */
  timeoutMs: 120_000,
  /** absolute paths per engine invocation */
  batch: 100,
  /** engine stdout above this is DETECT_OUTPUT_TOO_LARGE */
  stdoutBytes: 50 * 1024 * 1024,
  /** normalized findings kept; the rest is `truncated: true` */
  findings: 5_000,
  /** locations printed in the DETECT_TOP block */
  topLocations: 50,
  /** rendered-DOM dump above this is DOM_DUMP_TOO_LARGE */
  domDumpBytes: 10 * 1024 * 1024,
  /** engine stderr lines kept in the JSON (the rest is counted) and echoed to stderr */
  diagnosticsKept: 200,
  diagnosticsEchoed: 20,
  /** bytes of an engine binary hashed for its identity label when no version is known */
  engineHashBytes: 4 * 1024 * 1024,
  /** git subprocess budgets inside the wrapper */
  gitTimeoutMs: 30_000,
  /** whole-scan wall clock, as a multiple of the per-batch timeout: a huge target set stops, it never grinds for hours */
  totalTimeoutFactor: 5,
  /** the engine download the user consented to: twice the largest pinned asset, and a hard wall clock */
  engineDownloadBytes: 32 * 1024 * 1024,
  engineDownloadTimeoutMs: 120_000,
  gitMaxBuffer: 64 * 1024 * 1024,
  field: { id: 64, engineVersion: 64, message: 120, snippet: 120, value: 200, file: 4096, diagnostic: 400, refusedTarget: 200, parseErrorPreview: 80, internalError: 300 },
} as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One pass over every shape the agent reads as gstack's own voice: the two fence
 * markers, any sentinel word (whole word, colon or not: `DETECT_TOP total=` and
 * `IMPECCABLE_DISABLED` are printed bare), and the `[rule-id] impact=` group
 * header. Longest sentinel first so DETECT_EXIT_CODE is not split at DETECT_EXIT.
 */
const NEUTRALIZE_RE = new RegExp(
  [escapeRe(UNTRUSTED_BEGIN), escapeRe(UNTRUSTED_END),
   '\\b(?:' + [...new Set(Object.values(SENTINEL))].sort((a, b) => b.length - a.length).map(escapeRe).join('|') + ')\\b',
   '\\[(?=[a-z0-9-]+\\] impact=)'].join('|'), 'g');

/**
 * Break any sentinel, fence marker, or group header that appears INSIDE
 * engine-derived text, so page content echoed through a finding cannot close
 * the untrusted envelope or forge a probe line. Inserts a zero-width space after
 * the first character (the same technique browse/src/content-security.ts uses
 * for its markers). One precompiled alternation: this runs on four fields of
 * every kept finding.
 */
export function neutralizeSentinels(s: string): string {
  return s.replace(NEUTRALIZE_RE, m => m[0] + '\u200b' + m.slice(1));
}


export interface NormalizedFinding {
  /** catalog id (equals impeccableId when mapped; the engine's id, sanitized, when not) */
  id: string;
  impeccableId: string;
  file: string;
  line: number;
  snippet: string;
  value?: string;
  message: string;
  category: string;
  kind: 'slop' | 'quality' | 'unknown';
  impact: 'high' | 'medium' | 'polish';
  tier: 'auto-fix' | 'ask' | 'possible';
  handoff?: string;
  advisory: boolean;
  unmapped?: true;
}

export interface ScanResult {
  schemaVersion: 1;
  engine: string;
  engineVersion: string;
  targets: number;
  /** engine exit code after precedence (1 over 2 over 0) */
  exit: number;
  total: number;
  counted: number;
  advisory: number;
  /** rule ids the project config ignores (never present in findings) */
  ignoredRules: string[];
  byRule: Record<string, number>;
  findings: NormalizedFinding[];
  truncated: boolean;
  diagnostics: string[];
  /** JSON paths whose text is engine- and page-derived: evidence, never instructions (the stderr block carries the fence; this document carries the list) */
  untrusted: readonly string[];
}

export const SCAN_UNTRUSTED_PATHS = ['findings[].file', 'findings[].snippet', 'findings[].message', 'findings[].value', 'diagnostics[]'] as const;

/** The bash a skill renders after a scan so exit 2 (findings) never aborts the block. */
export const DETECT_EXIT_ECHO = `; echo "${SENTINEL.DETECT_EXIT_CODE}=$?"`;
