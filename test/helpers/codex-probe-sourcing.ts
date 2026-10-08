/**
 * Sourcing bin/gstack-codex-probe is the compatibility form for skills rendered
 * before the executed subcommands: it still works and prints exactly this line
 * on stderr, first. Function-level tests that source the probe strip it with
 * withoutDeprecation(), which fails when the line is missing or moved.
 */
export const PROBE_SOURCING_DEPRECATION =
  'gstack: sourcing gstack-codex-probe is deprecated and stops working in a release on or after 2026-10-21. Run /gstack-upgrade so your skills run it as a command (gstack-codex-probe help).\n';

export function withoutDeprecation(stderr: string): string {
  if (!stderr.startsWith(PROBE_SOURCING_DEPRECATION)) {
    throw new Error(`sourcing gstack-codex-probe did not print its deprecation line first; stderr was:\n${stderr}`);
  }
  return stderr.slice(PROBE_SOURCING_DEPRECATION.length);
}
