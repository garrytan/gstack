#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * free-seed-allowlist — bring the seed allowlist in line with a fresh recording
 * (docs/TESTING_INTERNALS.md#free-suite-duration-seed).
 *
 *   bun run scripts/free-seed-allowlist.ts --reconcile --recording <run url>
 *
 * Reads scripts/free-test-durations.json, drops allowlist entries for files no
 * longer over the 60 s ceiling, admits each unlisted file over it as an
 * annotated exception naming the recording, rewrites the allowlist, and prints
 * one ADMITTED or PRUNED line per change. The weekly recorder runs it so its
 * seed PR passes the ratchet; the admitted files stay listed for splitting.
 */
import * as fs from 'fs';
import * as path from 'path';
import { formatSeedAllowlist, parseSeedAllowlist, reconcileSeedAllowlist, SEED_ALLOWLIST_FILE } from './lib/free-ci-health';

const ROOT = path.resolve(import.meta.dir, '..');

if (import.meta.main) {
  const args = process.argv.slice(2);
  const recording = args[args.indexOf('--recording') + 1];
  if (args[0] !== '--reconcile' || args.length !== 3 || args[1] !== '--recording' || !recording) {
    console.error('usage: free-seed-allowlist.ts --reconcile --recording <run url>');
    process.exit(2);
  }
  const durations = (JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/free-test-durations.json'), 'utf8')) as { durations: Record<string, number> }).durations;
  const file = path.join(ROOT, SEED_ALLOWLIST_FILE);
  const { entries, admitted, pruned } = reconcileSeedAllowlist(durations, parseSeedAllowlist(fs.readFileSync(file, 'utf8')), (name, ms) => ({
    file: name,
    reason: `${Math.round(ms / 1000)}s in the weekly recording ${recording}; admitted by the recorder so the refreshed seed can land`,
    todo: 'split or speed up until it runs under 60 s, then delete this entry',
  }));
  if (admitted.length || pruned.length) fs.writeFileSync(file, formatSeedAllowlist(entries));
  for (const name of admitted) console.log(`ADMITTED ${name} ${Math.round(durations[name] / 1000)}s`);
  for (const name of pruned) console.log(`PRUNED ${name}`);
}
