/**
 * The branch's patch against its base, as the receipt carry and Step 11.5 compare it (docs/ship-policy.md#receipt-carry).
 * patchId hashes one diff with `git patch-id --verbatim`, which ignores the hunk line numbers a base merge shifts; the
 * product patch-id leaves out tests and release metadata (productSpec). baseMergeOnly (GST-3308, harness-evals#515) says
 * whether HEAD holds only clean merges of the base on top of a reviewed commit with the branch's own patch unchanged, the
 * head R51 counts as already reviewed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from './spawn-sync';
import { isRegistryUnavailable, loadRegistryFromBase } from './regen';
import { readPregateFile } from './pregate/index';
import { isUnavailable, loadPolicyFromBase, matchesAny, type ShipPolicy } from './ship-policy';
import { stampOnlyLine, type BranchSide } from './stamp-only';
import { CARRY_METADATA_GLOBS, CARRY_TEST_GLOBS, classifyCarryPath, landedStackParent } from './ship-receipt';

function git(args: string[], cwd?: string): string | undefined {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * One diff's patch-id over a pathspec; empty when the diff is empty. `--verbatim`
 * keeps whitespace in the hash (the default and `--stable` strip it, so a space
 * moved in a shell line would read as the same patch) while still ignoring the
 * hunk line numbers a base merge shifts. `--unified=3` pins the context a user's
 * diff.context could shrink, so base edits next to a hunk always reach the hash.
 */
export function patchId(repoRoot: string, from: string, to: string, pathspec: string[]): string | { error: string } {
  const firstLine = (s: string | null | undefined, fallback: string) => (s ?? '').trim().split('\n')[0]?.slice(0, 200) || fallback;
  const root = path.resolve(repoRoot, git(['rev-parse', '--git-path', 'gstack-patch-id'], repoRoot)?.trim() || '.git/gstack-patch-id');
  sweepStalePatchDirs(root);
  let dir: string;
  try { fs.mkdirSync(root, { recursive: true }); dir = fs.mkdtempSync(path.join(root, 'run-')); } catch (e) { return { error: `cannot create a temp file under ${root} (${firstLine((e as Error).message, 'mkdtemp failed')}); make that directory writable` }; }
  const file = path.join(dir, 'diff.patch');
  let fd: number | undefined;
  try {
    const diff = spawnSync('git', ['diff', '--no-color', '--no-ext-diff', '--full-index', '--unified=3', `--output=${file}`, from, to, '--', ...pathspec], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
    if (diff.status !== 0) return { error: `git diff ${from.slice(0, 12)} ${to.slice(0, 12)}: ${firstLine(diff.stderr, diff.signal ? `killed by ${diff.signal}` : `exit ${diff.status}`)}` };
    fd = fs.openSync(file, 'r');
    const id = spawnSync('git', ['patch-id', '--verbatim'], { cwd: repoRoot, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000 });
    if (id.status !== 0) return { error: `git patch-id --verbatim: ${firstLine(id.stderr, id.signal ? `killed by ${id.signal}` : `exit ${id.status}`)}` };
    return id.stdout.trim().split(/\s+/)[0] ?? '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A carry killed mid patch-id (preflight's timeout) skips patchId's `finally`; its product diff is removed by the next run once an hour old. */
let swept = false;
function sweepStalePatchDirs(root: string): void {
  if (swept) return;
  swept = true;
  const cutoff = Date.now() - 60 * 60 * 1000;
  let names: string[] = [];
  try { names = fs.readdirSync(root).filter(n => n.startsWith('run-')); } catch { return; }
  for (const n of names) {
    const p = path.join(root, n);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch { /* another run removed it */ }
  }
}

/**
 * Generated outputs the carry may set aside as metadata: the paths the pregate
 * passed for HEAD proved (its regen check deleted each touched output and the
 * entry's command recreated it byte-identically), when that check ran
 * origin/<base>'s `.gstack/generated.json` at the commit this carry reads and the
 * path is an output of an entry with a `command` there. A proven name with glob
 * syntax is product too: the carry uses these paths as pathspec globs.
 */
export function verifiedOutputs(repoRoot: string, base: string, pregateFile: string | undefined): string[] {
  if (!pregateFile) return [];
  const regen = readPregateFile(pregateFile).file?.checks.find(c => c.id === 'regen');
  if (!regen || regen.status !== 'pass' || !regen.proven?.length) return [];
  const load = loadRegistryFromBase(repoRoot, base);
  if (isRegistryUnavailable(load) || load.errors.length || regen.inputs?.registry !== load.source.label) return [];
  const owned = load.registry.entries.filter(e => e.command).flatMap(e => e.outputs);
  return regen.proven.filter(p => !/[*?[\]\\]/.test(p) && matchesAny(owned, p));
}

const HARNESS_MANIFEST = 'scripts/harness-version.json';
const HARNESS_PIN = /^scripts\/harness-pins\/(.+)\.json$/;

/**
 * A harness pin a base merge only re-recorded (GSTA-749, #4652): at both heads the pin's `blob` is its pinned file's blob,
 * its other fields are the reviewed ones, and the harness manifest's version and patterns did not move. The pin is then a
 * function of the pinned file's bytes, so it is a regenerated output, but only when the pinned file is itself product: a
 * pinned test or metadata file carries on its own, so its re-pin is the only change that stops an unreviewed harness edit.
 * The pin must be a regular file at both heads, since the harness reads a symlinked pin through its target while git shows the
 * link text, and both pinned blobs must resolve. Anything else is product.
 */
function rederivedHarnessPin(repoRoot: string, from: string, to: string, p: string, extra: ProductRules['extra']): boolean {
  const pinned = HARNESS_PIN.exec(p)?.[1];
  if (!pinned || classifyCarryPath(pinned, extra) !== 'product') return false;
  if (![from, to].every(ref => git(['ls-tree', ref, '--', p], repoRoot)?.startsWith('100644 blob '))) return false;
  const json = (ref: string, rel: string): any => { const r = spawnSync('git', ['show', `${ref}:${rel}`], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }); try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
  const [ma, mb] = [json(from, HARNESS_MANIFEST), json(to, HARNESS_MANIFEST)];
  if (!ma || !mb || ma.version !== mb.version || JSON.stringify(ma.patterns) !== JSON.stringify(mb.patterns)) return false;
  const [a, b] = [json(from, p), json(to, p)];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const { blob: blobA, ...restA } = a;
  const { blob: blobB, ...restB } = b;
  const [pinnedA, pinnedB] = [from, to].map(ref => git(['rev-parse', '--verify', '--quiet', `${ref}:${pinned}`], repoRoot));
  return !!pinnedA && !!pinnedB && blobA === pinnedA && blobB === pinnedB && JSON.stringify(restA) === JSON.stringify(restB);
}

export interface ProductRules { extra: { metadata: string[]; outputs: readonly string[]; fragments?: string }; metadata: string[]; templates: readonly string[]; placeholders: readonly string[] }
export function productRules(repoRoot: string, base: string, outputs: readonly string[]): ProductRules {
  const load = loadPolicyFromBase(repoRoot, base);
  const policy: ShipPolicy | null = isUnavailable(load) ? null : load.policy;
  const fragments = policy?.changelog_fragments?.dir.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const extra = { metadata: [...(policy?.stamp_files ?? []), ...(policy?.stamp_paths ?? []), ...(policy?.release_outputs ?? []), ...(policy?.changelog ? [policy.changelog] : [])], outputs, fragments };
  return { extra, metadata: [...CARRY_METADATA_GLOBS, ...extra.metadata, ...(fragments ? [`${fragments}/*.md`] : []), ...outputs], templates: policy?.stamp_patterns ?? [], placeholders: policy?.stamp_placeholders ?? [] };
}

/**
 * The product pathspec between two commits: every path but tests and release
 * metadata, where a metadata-listed path whose change from `from` to `to` is
 * not a stamp stays product (every glob that matches it leaves the exclusion).
 * With `branch` (the paths the branch itself changed against the base, and its
 * base..head ranges), only the branch's own non-stamp changes demote a glob: a
 * touched path whose change is not a stamp on either side, or between the two
 * heads. A path only a base merge brought in has the same patch against the base
 * at both heads, and demoting its glob would pull a matching path the branch did
 * change, such as a CHANGELOG fragment next to the base's changelog.d/README.md
 * (GST-343, #3606), into the product patch-id at one head only.
 */
export function productSpec(repoRoot: string, rules: ProductRules, from: string, to: string, branch?: { touched: ReadonlySet<string>; sides: ReadonlyArray<readonly [string, string]>; own: (rel: string) => BranchSide | undefined }): { changed: Array<{ path: string; class: ReturnType<typeof classifyCarryPath> }>; product: string[]; tests: string[]; demoted: string[]; ownRows: string[] } | undefined {
  const changedRaw = git(['diff', '--name-only', from, to], repoRoot);
  if (changedRaw === undefined) return undefined;
  const blobAt = (ref: string, p: string): string | null => { const r = spawnSync('git', ['show', `${ref}:${p}`], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
  const versionAt = (ref: string): string | null => {
    const file = blobAt(ref, 'VERSION');
    if (file !== null) return file.trim() || null;
    try { const v = JSON.parse(blobAt(ref, 'package.json') ?? 'null')?.version; return typeof v === 'string' ? v : null; } catch { return null; }
  };
  const versions = new Map<string, string | null>();
  const version = (ref: string) => { if (!versions.has(ref)) versions.set(ref, versionAt(ref)); return versions.get(ref)!; };
  const stamped = (p: string) => matchesAny(rules.metadata, p) && !matchesAny(rules.extra.outputs, p);
  const classify = (p: string, a: string, b: string) => classifyCarryPath(p, rules.extra, stamped(p) ? { before: blobAt(a, p), after: blobAt(b, p), oldVersion: version(a), newVersion: version(b), templates: rules.templates, placeholders: rules.placeholders, side: a === from && b === to ? branch?.own(p) : undefined } : undefined);
  // A stamp file the branch changed on neither side beyond a stamp against that side's base (back at the base's content
  // after a changelog-fragment conversion, or only its version moved) holds none of the branch's product: whatever else
  // differs between the two heads came from the base (GST-1210).
  // The same `ls-tree` entry (mode and object id, empty when absent) is an unchanged side; a failed read never is.
  const entryAt = (ref: string, p: string) => git(['ls-tree', ref, '--', p], repoRoot);
  const sameEntry = (a: string, b: string, p: string) => { const x = entryAt(a, p); return x !== undefined && x === entryAt(b, p); };
  const ownStampOnly = (p: string) => !!branch?.touched.has(p) && stamped(p) && branch.sides.every(([a, b]) => sameEntry(a, b, p) || classify(p, a, b) === 'metadata');
  const changed = changedRaw.split('\n').filter(Boolean).map(p => ({ path: p, class: ownStampOnly(p) ? 'metadata' as const : branch && rederivedHarnessPin(repoRoot, from, to, p, rules.extra) ? 'generated' as const : classify(p, from, to) }));
  const repinned = changed.filter(c => c.class === 'generated' && HARNESS_PIN.test(c.path)).map(c => `:(exclude,literal)${c.path}`);
  const excludeGlobs = (globs: readonly string[]) => globs.map(g => `:(exclude,glob)${g}`);
  const demoted = !branch ? changed.filter(c => c.class === 'product' && matchesAny(rules.metadata, c.path)).map(c => c.path)
    : [...branch.touched].filter(p => stamped(p) && (changed.some(c => c.path === p && c.class === 'product') || branch.sides.some(([a, b]) => blobAt(a, p) !== blobAt(b, p) && classify(p, a, b) === 'product')));
  const metadataGlobs = rules.metadata.filter(g => !demoted.some(p => matchesAny([g], p)));
  // A demoted path whose from-to change is, line for line, a stamp on the branch's own rows (named by their position in
  // `from`), a regular file with the reviewed mode at both heads (GST-980): never the whole-text version swap.
  const ownRows = demoted.filter(p => {
    const side = branch?.own(p);
    const mode = (ref: string) => /^(100644|100755) blob /.exec(git(['ls-tree', ref, '--', p], repoRoot) ?? '')?.[1];
    const before = blobAt(from, p), after = blobAt(to, p), oldVersion = version(from), newVersion = version(to);
    if (!side || before === null || after === null || !oldVersion || !newVersion || !mode(from) || mode(from) !== mode(to)) return false;
    const was = before.split('\n');
    const now = after.split('\n');
    const lines = was.map((_, i) => i).filter(i => was[i] !== now[i]);
    return was.length === now.length && lines.length > 0 && lines.every(i => side.at.has(i + 1) && stampOnlyLine(was[i]!, now[i]!, oldVersion, newVersion, rules.templates, side, i + 1, rules.placeholders));
  });
  return { changed, product: ['.', ...excludeGlobs(CARRY_TEST_GLOBS), ...excludeGlobs(metadataGlobs), ...repinned], tests: [...CARRY_TEST_GLOBS.map(g => `:(glob)${g}`), ...excludeGlobs(metadataGlobs), ...repinned], demoted, ownRows };
}

/** A commit's product patch-id against its merge base with the base ('' for no product diff), as write records it and a rewritten-history carry recomputes it. */
export function productPatchAgainstBase(repoRoot: string, rules: ProductRules, baseRef: string, commit: string): string | { error: string } {
  const mergeBase = git(['merge-base', baseRef, commit], repoRoot);
  if (!mergeBase) return { error: `cannot resolve the merge base of ${baseRef} and ${commit.slice(0, 12)}` };
  const spec = productSpec(repoRoot, rules, mergeBase, commit);
  if (!spec) return { error: `git diff ${mergeBase.slice(0, 12)} ${commit.slice(0, 12)} failed` };
  return patchId(repoRoot, mergeBase, commit, spec.product);
}


export type BaseMergeOnly = { ok: true; note: string } | { ok: false; why: string };

/**
 * Whether HEAD is the reviewed commit plus clean merges of origin/<base> and nothing else: every first-parent commit after
 * it is a two-parent merge whose second parent the base holds and whose tree is exactly what `git merge-tree` writes for
 * its parents (no conflict resolution, no edit inside the merge), the working tree is HEAD's, and the branch's patch
 * against the base is the reviewed one: the product patch-id the carry compares, and the patch-id over every path, so a
 * test, release-metadata or gate path the product patch-id leaves out stays covered too. A reviewed range that held a stack
 * parent which has since landed on the base is measured from that parent, as the carry measures it (landedStackParent).
 */
export function baseMergeOnly(cwd: string, base: string, reviewed: unknown, reviewedTree: string, currentWtree: string): BaseMergeOnly {
  const no = (why: string): BaseMergeOnly => ({ ok: false, why });
  const repoRoot = git(['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) return no('not inside a git checkout');
  if (typeof reviewed !== 'string' || !/^[0-9a-f]{40,64}$/.test(reviewed)) return no('the row names no full reviewed commit');
  if (git(['rev-parse', '--verify', '--quiet', `${reviewed}^{commit}`], repoRoot) !== reviewed) return no(`the reviewed commit ${reviewed.slice(0, 12)} is not in this clone`);
  if (git(['rev-parse', `${reviewed}^{tree}`], repoRoot) !== reviewedTree) return no(`the review read content its commit ${reviewed.slice(0, 12)} does not hold`);
  const head = git(['rev-parse', 'HEAD'], repoRoot);
  if (!head || git(['rev-parse', 'HEAD^{tree}'], repoRoot) !== currentWtree) return no('the working tree has changes HEAD does not hold');
  const baseRef = `origin/${base.replace(/^origin\//, '')}`;
  if (!git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], repoRoot)) return no(`${baseRef} does not resolve (fetch it)`);
  const ancestor = (a: string, d: string) => spawnSync('git', ['merge-base', '--is-ancestor', a, d], { cwd: repoRoot, timeout: 30_000 }).status === 0;
  if (!ancestor(reviewed, head)) return no(`the reviewed commit ${reviewed.slice(0, 12)} is not an ancestor of HEAD (rebased or force-pushed)`);
  const chain = (git(['rev-list', '--first-parent', '--parents', `${reviewed}..${head}`], repoRoot) ?? '').split('\n').filter(Boolean).map(l => l.split(' '));
  if (!chain.length || chain.at(-1)![1] !== reviewed) return no(`HEAD's first-parent history does not run back to the reviewed commit ${reviewed.slice(0, 12)}`);
  for (const [commit, ...parents] of chain) {
    const c = commit!.slice(0, 12);
    if (parents.length !== 2) return no(`commit ${c} after the reviewed one is not a merge of ${baseRef}`);
    if (!ancestor(parents[1]!, baseRef)) return no(`merge ${c} brings in ${parents[1]!.slice(0, 12)}, which ${baseRef} does not hold`);
    const replay = spawnSync('git', ['merge-tree', '--write-tree', '--no-messages', parents[0]!, parents[1]!], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
    if (replay.status === 1) return no(`merge ${c} had conflicts, so its resolution is unreviewed`);
    if (replay.status !== 0) return no(`git merge-tree --write-tree could not replay merge ${c} (git 2.39 or later)`);
    if (replay.stdout.split('\n')[0]!.trim() !== git(['rev-parse', `${commit}^{tree}`], repoRoot)) return no(`merge ${c} holds changes its clean merge does not (an edit inside the merge)`);
  }
  const rules = productRules(repoRoot, base, []);
  const [reviewedBase, headBase] = [git(['merge-base', baseRef, reviewed], repoRoot), git(['merge-base', baseRef, head], repoRoot)];
  if (!reviewedBase || !headBase) return no(`cannot resolve the merge base with ${baseRef}`);
  const patches = (from: string, to: string): { product: string; whole: string; spec: string[] } | string => {
    const spec = productSpec(repoRoot, rules, from, to);
    if (!spec) return `git diff ${from.slice(0, 12)} ${to.slice(0, 12)} failed`;
    const product = patchId(repoRoot, from, to, spec.product), whole = patchId(repoRoot, from, to, ['.']);
    if (typeof product !== 'string') return product.error;
    return typeof whole === 'string' ? { product, whole, spec: spec.product } : whole.error;
  };
  const now = patches(headBase, head);
  let rangeBase = reviewedBase;
  let then = patches(rangeBase, reviewed);
  if (typeof then !== 'string' && typeof now !== 'string' && (then.product !== now.product || then.whole !== now.whole)) {
    const parent = landedStackParent(repoRoot, { rangeBase, reviewed, currentBase: headBase }, then.spec);
    if (parent) { rangeBase = parent; then = patches(parent, reviewed); }
  }
  if (typeof then === 'string' || typeof now === 'string') return no(`git could not compute the branch's patch-id: ${typeof then === 'string' ? then : now}`);
  if (then.product !== now.product) return no(`the branch's product patch changed (patch-id ${then.product.slice(0, 12) || 'none'} reviewed, ${now.product.slice(0, 12) || 'none'} now)`);
  if (then.whole !== now.whole) return no('the branch\'s patch on a path the product patch-id leaves out (tests, release metadata) changed');
  const landed = rangeBase === reviewedBase ? '' : `, its stack parent ${rangeBase.slice(0, 12)} having landed on ${baseRef}`;
  return { ok: true, note: `HEAD ${head.slice(0, 12)} adds only ${chain.length} clean merge(s) of ${baseRef} to the reviewed commit ${reviewed.slice(0, 12)}${landed}, and the branch's patch is unchanged (product patch-id ${now.product.slice(0, 12) || 'none'}); save the reviewed base ${rangeBase} for finish's --reviewed-base` };
}
