/**
 * Result codes for workflow commands: the sibling of lib/gate-outcomes.ts for
 * error lines that are not gate outcomes. Every error line a new bin prints
 * carries one of these codes in parentheses (`(COMPONENT_MISSING)`), a
 * `fix:` clause and a stable `<a id>` anchor in docs/troubleshooting.md;
 * test/troubleshooting-anchors.test.ts checks every anchor exists. Add a row
 * here before printing a new code anywhere. The Bash side reads the same
 * table from the generated bin/gstack-doctor-components.sh
 * (`gstack_result_anchor CODE`).
 */

export interface ResultCode {
  /** Stable `<a id>` in docs/troubleshooting.md. */
  anchor: string;
  /** What happened, in plain words. */
  summary: string;
  /** The default fix; a printer may substitute the exact command for the machine. */
  fix: string;
}

export const RESULT_CODES = {
  COMPONENT_MISSING: {
    anchor: 'doctor-component-missing',
    summary: 'a component the selected workflow needs is not installed, not built or not current',
    fix: 'run the command in the row\'s fix clause, then re-run gstack-doctor --check',
  },
  RUNTIME_BELOW_MINIMUM: {
    anchor: 'doctor-runtime-below-minimum',
    summary: 'the Bun on PATH is absent, below gstack\'s security floor, or below its supported minimum',
    fix: 'install the supported Bun through setup\'s checksum-verified recipe (bin/gstack-capy-install does this on Capy), then re-run ./setup',
  },
  PROJECT_PIN_MISMATCH: {
    anchor: 'doctor-project-pin-mismatch',
    summary: 'the running Bun or Node is outside a version the target project pins (package.json engines, .tool-versions, .nvmrc, .bun-version or a CI workflow)',
    fix: 'install the pinned version for this platform, or change the pin in the project',
  },
  REVISION_UNMET: {
    anchor: 'doctor-revision-unmet',
    summary: 'the installed gstack checkout is not at the revision --revision requested',
    fix: 'run /gstack-upgrade (or git -C <checkout> fetch && git checkout <ref>, then ./setup) to move the checkout',
  },
  RUNTIME_PIN_CONFLICT: {
    anchor: 'capy-install-runtime-conflict',
    summary: 'gstack\'s supported Bun minimum and the project\'s Bun pin cannot both be satisfied, so the installer changed nothing',
    fix: 'raise the project\'s pin to gstack\'s supported minimum, or install gstack on a machine whose Bun the project accepts',
  },
  BROWSER_UNAVAILABLE: {
    anchor: 'browser-ensure-failed',
    summary: 'Chromium could not be installed or launched by gstack-browser-ensure',
    fix: 'read the installer output above (offline, proxy, AppArmor); on Ubuntu 24.04+ try GSTACK_CHROMIUM_NO_SANDBOX=1, then re-run gstack-browser-ensure',
  },
  INSTALL_PREFLIGHT_FAILED: {
    anchor: 'capy-install-preflight-failed',
    summary: 'a tool the installer needs before ./setup (git, curl, node, jq) is missing, or the Bun install recipe failed its checksum',
    fix: 'install the named tool, then re-run bin/gstack-capy-install',
  },
} as const satisfies Record<string, ResultCode>;

export type ResultCodeId = keyof typeof RESULT_CODES;

export const TROUBLESHOOTING_DOC = 'https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md';

/** `(CODE; <doc>#anchor)` — the suffix every error line carries. */
export function resultCodeSuffix(code: ResultCodeId): string {
  return `(${code}; ${TROUBLESHOOTING_DOC}#${RESULT_CODES[code].anchor})`;
}
