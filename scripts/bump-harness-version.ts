#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Keep HARNESS_VERSION honest (CEO-27/ENG-3/DX-6). scripts/harness-version.json
 * holds the version and the harness `patterns`; scripts/harness-pins/<path>.json
 * pins the blob of every shared-harness file (GLOBAL_TOUCHFILES plus those
 * patterns). test/harness-version.test.ts fails when a harness file changes
 * without a decision, and this script records the decision:
 *
 *   --bump "<reason>"            the change alters how cases behave: version + 1,
 *                                which starts a new pass-rate series for every case
 *   --non-behavioral "<reason>"  the change cannot alter a verdict (refactor,
 *                                comment, logging): the new blobs are recorded as
 *                                compatible and no series resets
 *   --check                      print drift and the fix; exit 1 on drift
 *
 * Each pin is its own file (GST-1084), so two PRs touching different harness
 * files never edit the same file and merge cleanly. When both bump, or both
 * touch one file, git conflicts on the manifest or that pin: take the higher
 * version, then rerun this script.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessFiles, treeEntries, type TreeEntry } from './eval-trial-series';

const ROOT = path.resolve(import.meta.dir, '..');
export const MANIFEST = 'scripts/harness-version.json';
export const PINS_DIR = 'scripts/harness-pins';
export const DOC_ANCHOR = 'docs/TESTING_INTERNALS.md#harness-version';

export interface ManifestEntry { blob: string; since: number; nonBehavioral?: string }
export interface HarnessManifest { version: number; patterns: string[]; files: Record<string, ManifestEntry> }
export interface Drift { changed: string[]; added: string[]; removed: string[] }

const pinPath = (root: string, file: string) => path.join(root, PINS_DIR, `${file}.json`);

/** The pin files under root's PINS_DIR, keyed by pinned path; any file that is not <path>.json is an error. */
function readPins(root: string): Record<string, ManifestEntry> {
  const dir = path.join(root, PINS_DIR);
  const files: Record<string, ManifestEntry> = {};
  for (const rel of (fs.readdirSync(dir, { recursive: true }) as string[]).map(f => f.split(path.sep).join('/')).sort()) {
    if (fs.statSync(path.join(dir, rel)).isDirectory()) continue;
    if (!rel.endsWith('.json')) throw new Error(`${PINS_DIR}/${rel}: every harness pin is <pinned path>.json`);
    try {
      files[rel.slice(0, -'.json'.length)] = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    } catch (e) {
      throw new Error(`${PINS_DIR}/${rel}: ${(e as Error).message}`);
    }
  }
  return files;
}

export function readManifest(root = ROOT): HarnessManifest {
  const head = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
  if (Object.keys(head).sort().join() !== 'patterns,version') throw new Error(`${MANIFEST} holds only version and patterns; pins live in ${PINS_DIR}/<path>.json`);
  return { version: head.version, patterns: head.patterns, files: readPins(root) };
}

/** The tracked harness files with blobs of their working-tree bytes (an unstaged edit counts; a deleted file drops out). */
export function workingHarnessFiles(root: string, patterns: readonly string[]): TreeEntry[] {
  const tracked = harnessFiles(treeEntries(root), undefined, patterns).filter(entry => fs.existsSync(path.join(root, entry.file)));
  if (tracked.length === 0) return [];
  const hashed = spawnSync('git', ['hash-object', '--', ...tracked.map(entry => entry.file)], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (hashed.status !== 0) throw new Error(`git hash-object failed: ${hashed.stderr}`);
  const blobs = hashed.stdout.trim().split('\n');
  return tracked.map((entry, index) => ({ file: entry.file, blob: blobs[index]! }));
}

/** Harness files whose blob differs from, is missing from, or no longer matches an entry in the manifest; a pin ahead of the manifest version (a bump that failed partway) counts as changed. */
export function harnessDrift(manifest: HarnessManifest, files: TreeEntry[]): Drift {
  const current = new Map(files.map(entry => [entry.file, entry.blob]));
  return {
    changed: files.filter(entry => manifest.files[entry.file] && (manifest.files[entry.file]!.blob !== entry.blob || manifest.files[entry.file]!.since > manifest.version)).map(entry => entry.file).sort(),
    added: files.filter(entry => !manifest.files[entry.file]).map(entry => entry.file).sort(),
    removed: Object.keys(manifest.files).filter(file => !current.has(file)).sort(),
  };
}

export const hasDrift = (drift: Drift) => drift.changed.length + drift.added.length + drift.removed.length > 0;

/** Problem, offending files, both fix commands and the docs anchor (DX-6). */
export function formatDrift(drift: Drift, version: number): string {
  const list = (label: string, files: string[]) => files.length ? [`  ${label}: ${files.join(', ')}`] : [];
  return [
    `Shared-harness files changed without a HARNESS_VERSION decision (${MANIFEST}, version ${version}):`,
    ...list('changed', drift.changed), ...list('added', drift.added), ...list('removed', drift.removed),
    'Fix (pick one):',
    '  bun run scripts/bump-harness-version.ts --non-behavioral "<why no verdict can change>"   # refactor/comment/logging: no series reset',
    '  bun run scripts/bump-harness-version.ts --bump "<what behavior changed>"                # starts a new pass-rate series for every case',
    `Merge conflict in ${MANIFEST} or ${PINS_DIR}/: take the higher version, then rerun the script. See ${DOC_ANCHOR}.`,
  ].join('\n');
}

/** Record a decision over the current harness files; returns the new manifest. */
export function decide(manifest: HarnessManifest, files: TreeEntry[], decision: 'bump' | 'non-behavioral', reason: string): HarnessManifest {
  if (reason.trim().length < 10) throw new Error('a reason of at least 10 characters is required');
  const drift = harnessDrift(manifest, files);
  if (decision === 'bump') {
    const version = manifest.version + 1;
    return { ...manifest, version, files: Object.fromEntries(files.map(entry => [entry.file, { blob: entry.blob, since: version }])) };
  }
  const touched = new Set([...drift.changed, ...drift.added]);
  return { ...manifest, files: Object.fromEntries(files.map(entry => [entry.file, touched.has(entry.file)
    ? { blob: entry.blob, since: manifest.version, nonBehavioral: reason.trim() }
    : manifest.files[entry.file]!])) };
}

/** Write one pin file per harness file (rewriting only pins whose bytes change, deleting dropped ones), then the manifest head, so a failed pin write never moves the version. */
export function writeManifest(root: string, manifest: HarnessManifest): void {
  for (const file of Object.keys(readPins(root))) if (!manifest.files[file]) fs.rmSync(pinPath(root, file));
  for (const [file, entry] of Object.entries(manifest.files)) {
    const target = pinPath(root, file), text = `${JSON.stringify(entry)}\n`;
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === text) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  fs.writeFileSync(path.join(root, MANIFEST), `${JSON.stringify({ version: manifest.version, patterns: manifest.patterns }, null, 2)}\n`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const manifest = readManifest();
  const files = workingHarnessFiles(ROOT, manifest.patterns);
  const drift = harnessDrift(manifest, files);
  const mode = argv[0];
  if (mode === '--check' || mode === undefined) {
    if (hasDrift(drift)) { console.error(formatDrift(drift, manifest.version)); process.exit(1); }
    console.log(`harness version ${manifest.version}: ${files.length} pinned file(s), no drift`);
    process.exit(0);
  }
  if (mode !== '--bump' && mode !== '--non-behavioral') {
    console.error('usage: bun run scripts/bump-harness-version.ts --check | --bump "<reason>" | --non-behavioral "<reason>"');
    process.exit(2);
  }
  if (mode === '--non-behavioral' && !hasDrift(drift)) { console.log('no harness drift: nothing to record'); process.exit(0); }
  const next = decide(manifest, files, mode === '--bump' ? 'bump' : 'non-behavioral', argv[1] ?? '');
  writeManifest(ROOT, next);
  console.log(mode === '--bump'
    ? `HARNESS_VERSION ${manifest.version} -> ${next.version}: every case starts a new pass-rate series (reason: ${argv[1]})`
    : `recorded ${drift.changed.length + drift.added.length} file(s) as non-behavioral at HARNESS_VERSION ${next.version}${drift.removed.length ? `, dropped ${drift.removed.length} removed file(s)` : ''}`);
}
