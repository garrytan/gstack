/**
 * The file that marks a test fixture root (GST-1695). test-setup.ts writes it into the one per-process directory every
 * test's temp paths land under, and the fetch sweep (lib/review-sweep.ts) treats a directory below a sweep root that
 * carries it as a test fixture, never a reader's fetch, so a concurrent or leftover `bun test` cannot quarantine a stage.
 */
export const FIXTURE_MARKER = '.gstack-test-fixture';
