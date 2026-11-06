/**
 * ship-release — /ship Step 12 (version), Steps 15-16 (release commit, verification)
 * and Step 17 (push) as gstack-ship-release's three commands. They chain
 * gstack-ship-policy, gstack-version-bump, gstack-next-version, gstack-decision-log,
 * gstack-wtree, gstack-docs-candidate compare, gstack-evidence, gstack-pregate (the
 * stamped-tree rerun and the sealed guard) and git, print a compact result, and stop
 * with STOP: wherever the prose assigns the decision to the agent: the bump level, a
 * rebump, an incomplete queue, a sibling's claim, feature-commit grouping, a changed
 * reviewed tree, stale docs, failing or zero-run tests, the pre-push offer and pushes
 * that fail.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeChangelogs, normalizeChangelog } from './changelog-check';
import { versionAtRef } from './restamp';
import { classifyPath } from './review-depth';
import { matchesAny } from './ship-policy';
import { baseHolds, boundedPaths, comparePath, contextPacket, gateEditedPaths, isTestCode, PACKET_SECTION_CAP, readScopedReview, touchedPaths, type BoundedKind, type PatchSides } from './ship-patch';
import { heldBy } from './ship-receipt';
import { locate, readRecord } from './approval-record';
import { mechanicalPaths, writeMechanicalRecord } from './ship-mechanical';
import { uidSidecars } from './ship-sidecar';
import type { MechanicalConstant } from './ship-policy-mechanical';
import { reviewFreshness } from './review-evidence';
import { forbidSpecs } from './review-fetch';
import { readRuledNotes, ruledNoteText } from './ruled-notes';
import { parseReviewLoopException, type ReviewLoopException } from './ship-receipt-depth';
import { parseReceiptDocs, type ReceiptDocs } from './ship-receipt-docs';
import { resolveStateRoot } from './state-root';
import { bumpVersion, cmpVersion, fmtVersion, parseVersion, versionWidth, type Bump } from './version-source';
import { waitForRun } from './ci-carry';
import { lanesOnlyHeadPolicy } from './pregate/head-policy';
import { PREPUSH_CHECK_IDS } from './pregate/index';
import { buildRunCheck } from './pregate/run-check';
import { bin, carryLane, carryNoneLines, evidenceExempt, firstLine, flagReader, fragmentPath, gh, git, hostedOrigin, laneLine, lanes, mappedLanes, recordCiTimeout, releasePaths, Report, runLanes, sh, shipPolicy, shipRunMarker, short, stampedFiles } from './ship-bin-common';

export const RELEASE_HELP = `gstack-ship-release — /ship Steps 12 and 15-17 (ship/SKILL.md)

  version --base <base> [--bump micro|patch|minor|major] [--version <v>] [--keep-current] [--accept-incomplete] [--why <text>] [--answer <owner's words>]
      Step 12: classify, pick the queue-aware version, write it with --regen-digest --changelog, log the decision;
      --keep-current (or --version <current>) keeps VERSION; under bump ask a session no person answers needs --answer before a bump is written
  finish --base <base> --reviewed-tree <tree> [--reviewed-base <sha>] --docs-post <post.json> [--lane <label>=<command>]... [--build <command>]...
         [--trailer <text>] [--docs-rechecked] [--no-lanes-approved] [--context-reviewed <record.json>]
         [--docs-requested <path>... --docs-result <the audit's result JSON>] [--review-loop-exception <json|@file>]
      Step 15's release commit, Step 16 stages 1-4 (your builds, the reviewed-tree route, docs freshness,
      each lane's receipt run once if stale) and the pregate on the stamped tree; --reviewed-base (the merge base
      saved with the reviewed tree, or a stack parent's head once the parent landed: REVIEWED_BASE:) routes paths only the base moved as base=, and an adjacent base edit as context=;
      --review-loop-exception (the record write takes) routes paths the branch touched at fix_check.head (narrowed to fix_check.files when listed) and changed since as accepted=
      A lane the base branch maps in .gstack/pregate.json ship_lanes_from is carried from a verified CI run at this exact
      tree, else deferred (EVIDENCE: DEFERRED): the pregate then runs its preflight stage here and its tests stage in accept
  push --branch <branch-name> [--gate-open <n>] [--gate-open-approved] [--early [--base <base>]]
      Step 17 after its guard block: the saved-branch check, the open-gate check, the sealed guard, the pre-push housekeeping
      guards (gstack-pregate --stage guards; a pass at HEAD's tree is reused), the idempotency check, git push -u;
      --early (the Phase 2 push before review, so CI runs beside it) also runs pregate's secrets scan on the commits first
  accept --base <base> --lane <label>=<command>... [--wait <s>]
      after push: final-tree CI acceptance. Waits up to --wait seconds (default 170) for the CI run of each mapped profile at
      the pushed HEAD, carries each mapped lane from that run (a clean tree equal to the run's), reuses or runs the rest,
      checks every lane FRESH and reruns the pregate on the final tree (its tests stage carries the same run)

At most 30 lines each; STOP: names what the agent must decide or repair, and nothing after it ran.
Exit codes: 0 ok · 2 usage · 3 STOP`;

const LEVELS: Bump[] = ['micro', 'patch', 'minor', 'major'];
const KEPT_NEXT = 'Step 13: no version heading (the entry stays under ## [Unreleased], or is left to the repo\'s release process); an unprefixed Step 18 title and "version":null in Step 20';

function classify(cwd: string, base: string): { state?: string; json?: any; error?: string } {
  const c = bin(cwd, 'gstack-version-bump', ['classify', '--base', base], 60_000);
  if (c.status !== 0) return { error: firstLine(c.stderr) || `exit ${c.status}` };
  try { const json = JSON.parse(c.stdout); return { state: json.state, json }; } catch { return { error: 'classify printed no JSON' }; }
}

/** The first component that changed from base to current (an absent fourth is zero). */
function derivedLevel(base: string, current: string): Bump | null {
  const a = parseVersion(base), b = parseVersion(current);
  if (!a || !b) return null;
  const order: Bump[] = ['major', 'minor', 'patch', 'micro'];
  const i = a.findIndex((n, k) => n !== b[k]);
  return i < 0 ? null : order[i]!;
}

function queue(cwd: string, base: string, level: Bump, baseVersion: string): { version?: string; json?: any; note: string } {
  const r = bin(cwd, 'gstack-next-version', ['--base', base, '--bump', level, '--current-version', baseVersion], 180_000);
  let json: any;
  try { json = JSON.parse(r.stdout); } catch { return { note: `unverified (gstack-next-version exit ${r.status}, no JSON)` }; }
  const usable = r.status === 0 && typeof json.version === 'string' && parseVersion(json.version) && (json.offline === false || json.fallback === 'git');
  return usable ? { version: json.version, json, note: json.offline ? 'git-fallback' : 'live' } : { json, note: 'unverified (offline without the git fallback, or no valid version)' };
}

export function version(argv: readonly string[], cwd: string): Report {
  const { flag, has } = flagReader(argv);
  const base = flag('--base')!;
  const r = new Report();
  const policy = shipPolicy(cwd, base);
  const fragment = fragmentPath(policy, cwd);
  if (policy?.queue_mode === 'stamp-at-merge' || fragment) return r.add(`VERSION: skipped (policy: ${fragment ? 'changelog_fragments' : 'queue_mode stamp-at-merge'} replaces Step 12 items 1-4; the merge stamps it)`).next(fragment ? `Step 13: write the entry as ${fragment} (entry text only, no heading), never an [Unreleased] section` : 'Step 13: write the CHANGELOG entry under ## [Unreleased]');
  let c = classify(cwd, base);
  if (c.error) return r.stop(`a configured version file is missing, empty, unreadable or malformed: ${c.error}; fix it or its pin, then rerun (never substitute 0.0.0.0)`);
  const never = policy?.bump === 'never';
  if (never && (c.state === 'ALREADY_BUMPED' || c.state === 'DRIFT_STALE_PKG')) return r.stop(`VERSION moved from ${c.json.baseVersion} to ${c.json.currentVersion} but the policy says bump never: put VERSION and the manifest back to the base version, or change the policy`);
  if (c.state === 'DRIFT_STALE_PKG') {
    const rep = bin(cwd, 'gstack-version-bump', ['repair'], 60_000);
    r.add(`REPAIR: ${rep.status === 0 ? 'package manifest synced to VERSION' : `failed (${firstLine(rep.stderr)})`}`);
    if (rep.status !== 0) return r.stop('gstack-version-bump repair failed; fix the manifest, then rerun');
    c = classify(cwd, base);
    if (c.error || c.state !== 'ALREADY_BUMPED') return r.stop(`after repair the state is ${c.state ?? c.error}; reconcile by hand, then rerun`);
  }
  const j = c.json;
  if (c.state === 'NO_VERSION') return r.add(`VERSION: skipped (no version source: ${j.versionSource?.path ?? '-'}, ${j.versionSource?.reason ?? '-'})`).next('ship without a version change: no Step 13 entry heading, an unprefixed Step 18 title, "version":null in Step 20');
  if (c.state === 'DRIFT_UNEXPECTED') return r.stop('package.json disagrees with VERSION while VERSION matches base: reconcile the manual edit, then rerun');
  if (c.state !== 'FRESH' && c.state !== 'ALREADY_BUMPED') return r.stop(`unknown classify state ${c.state}`);
  const explicit = flag('--version');
  if (explicit && !parseVersion(explicit)) return r.stop(`--version ${explicit} is not a version`);
  const fresh = c.state === 'FRESH';
  const asked = flag('--bump') as Bump | undefined;
  if (asked && !LEVELS.includes(asked)) return r.stop(`--bump ${asked} is not micro, patch, minor or major`);
  if (never) {
    if (asked || (explicit && cmpVersion(parseVersion(explicit)!, parseVersion(j.baseVersion)!) !== 0)) return r.stop(`policy bump never: unit PRs keep VERSION at ${j.baseVersion}; a release bump belongs to the release process (gstack-version-bump write), never Step 12`);
    return r.add(`VERSION: ${j.baseVersion} kept (policy: bump never; no write)`).next(KEPT_NEXT);
  }
  const atBase = !!explicit && cmpVersion(parseVersion(explicit)!, parseVersion(j.baseVersion)!) === 0;
  const keep = fresh && (has('--keep-current') || atBase);
  const mover = asked ? `--bump ${asked}` : explicit && !atBase ? `--version ${explicit}` : '';
  if (keep && mover) return r.stop(`${mover} moves VERSION and ${has('--keep-current') ? '--keep-current' : `--version ${explicit}`} keeps it: pass one`);
  if (keep) return r.add(`VERSION: ${j.baseVersion} kept (FRESH, ${has('--keep-current') ? '--keep-current' : `--version ${explicit}`}; no write)`).next(KEPT_NEXT);
  const level = fresh ? asked ?? (policy?.bump === 'patch' ? 'patch' : undefined) : asked ?? derivedLevel(j.baseVersion, j.currentVersion) ?? undefined;
  if (!level) {
    const stat = git(cwd, ['diff', `origin/${base}`, '--shortstat']).stdout.trim();
    return r.stop(`BUMP_LEVEL needed (FRESH, ${stat || 'no diff'}): MICRO under 50 lines, PATCH 50+ with no feature signal, MINOR/MAJOR ask first (Step 12.2); rerun with --bump <level>, or with --keep-current to leave VERSION at ${j.baseVersion}`);
  }
  const answer = flag('--answer');
  if (explicit && cmpVersion(parseVersion(explicit)!, parseVersion(j.baseVersion)!) <= 0) return r.stop(`${explicit} is not above the base version ${j.baseVersion}`);
  const rewrites = fresh ? !!asked : !!explicit && cmpVersion(parseVersion(explicit)!, parseVersion(j.currentVersion)!) !== 0;
  if (rewrites && policy?.bump !== 'patch' && !answer) {
    const kind = bin(cwd, 'gstack-session-kind', [], 30_000).stdout.trim() || 'unknown';
    const pick = [asked && `--bump ${asked}`, explicit && `--version ${explicit}`].filter(Boolean).join(' ');
    if (kind !== 'interactive') return r.stop(`BUMP_ANSWER_REQUIRED (${kind} session, bump ask): a version Step 12 writes is the owner's approval, and a brief's "take the recommended option" is not an answer. Ask: ${pick} (recommended), keep ${fresh ? j.baseVersion : j.currentVersion} (--keep-current), or stop; then rerun with ${pick} --answer "<their words>". A repo whose unit PRs never bump sets bump never; one that always takes PATCH sets bump patch`);
  }
  let q = queue(cwd, base, level, j.baseVersion);
  if (q.json?.complete === false) q = queue(cwd, base, level, j.baseVersion);
  if (q.json?.complete === false && !has('--accept-incomplete')) return r.stop(`the queue read is incomplete (unknown_claims=${(q.json.unknown_claims ?? []).join(',')}): ask to use ${q.version ?? 'the pick'} (recommended; Version Gate rereads the queue) and rerun with --accept-incomplete, or stop`);
  for (const w of (q.json?.warnings ?? []).slice(0, 3)) r.add(`QUEUE_WARNING: ${String(w).slice(0, 200)}`);
  let next = explicit ?? (fresh ? q.version ?? fmtVersion(bumpVersion(parseVersion(j.baseVersion)!, level, versionWidth(j.baseVersion)), versionWidth(j.baseVersion)) : j.currentVersion);
  if (!fresh && !explicit && q.version && q.version !== j.currentVersion && !has('--keep-current')) {
    return r.stop(`ALREADY_BUMPED at ${j.currentVersion} but the queue picks ${q.version}: ask to rebump (rerun with --version ${q.version}; refresh the CHANGELOG and PR title) or keep (rerun with --keep-current; CI rejects a collision)`);
  }
  const sibling = (q.json?.active_siblings ?? []).find((s: any) => s.version && parseVersion(s.version) && cmpVersion(parseVersion(s.version)!, parseVersion(next)!) >= 0);
  if (sibling && !explicit) return r.stop(`sibling ${sibling.branch} holds ${sibling.version} >= ${next}: choose to advance past it (rerun with --version <v>) or stop and sync`);
  if (!fresh && explicit === undefined) {
    r.add(`VERSION: ${j.baseVersion} -> ${next} level=${level} state=ALREADY_BUMPED queue=${q.note} (kept, no write)`);
    return r.next(`Step 13: CHANGELOG entry under ${next}`);
  }
  if (cmpVersion(parseVersion(next)!, parseVersion(j.baseVersion)!) <= 0) return r.stop(`${next} is not above the base version ${j.baseVersion}`);
  const changelog = typeof policy?.changelog === 'string' ? policy.changelog : 'CHANGELOG.md';
  let w = bin(cwd, 'gstack-version-bump', ['write', '--version', next, '--regen-digest', '--changelog', changelog], 300_000);
  if (w.status === 3) {
    bin(cwd, 'gstack-version-bump', ['repair'], 60_000);
    w = classify(cwd, base).state === 'ALREADY_BUMPED' ? { ...w, status: 0, stdout: w.stdout || '{}' } : w;
  }
  if (w.status !== 0) return r.stop(`gstack-version-bump write exited ${w.status}: ${firstLine(w.stderr)}${w.status === 2 ? ' (nothing was written)' : ''}`);
  let wrote: any = {};
  try { wrote = JSON.parse(w.stdout); } catch { /* reported below */ }
  r.add(`VERSION: ${j.baseVersion} -> ${next} level=${level} state=${c.state} queue=${q.note} wrote=${wrote.wrote ?? next}`);
  if (wrote.agentsDigest === false) r.next('run bun --no-env-file --config=/dev/null scripts/gen-agents-digest.ts and stage the digest with the bump');
  const why = flag('--why') ?? `${level} bump from the diff`;
  bin(cwd, 'gstack-decision-log', [JSON.stringify({ decision: `Ship ${next} (${level})`, rationale: answer ? `${why}; owner: ${answer}` : why, scope: 'repo', source: 'skill', confidence: 9 })], 30_000);
  return r.next(`Step 13: CHANGELOG entry under ${next}`);
}

function commitRelease(cwd: string, release: string[], trailer: string | undefined, r: Report): boolean {
  const dirty = git(cwd, ['status', '--porcelain', '-z']).stdout.split('\0').filter(Boolean).map(l => l.slice(3));
  const feature = dirty.filter(p => !release.includes(p));
  if (feature.length) { r.stop(`uncommitted changes outside release metadata: ${short(feature, 8)}; commit them in bisectable chunks with their tests and docs (Step 15), then rerun`); return false; }
  const meta = dirty.filter(p => release.includes(p));
  if (!meta.length) { r.add('COMMIT: nothing left to commit'); return true; }
  git(cwd, ['add', '--', ...meta]);
  const v = meta.includes('VERSION') && fs.existsSync(path.join(cwd, 'VERSION')) ? fs.readFileSync(path.join(cwd, 'VERSION'), 'utf8').trim() : null;
  const msg = `${v ? `chore: bump version and changelog (v${v})` : 'chore: changelog and TODOS'}${trailer ? `\n\n${trailer}` : ''}`;
  const c = git(cwd, ['commit', '-q', '-m', msg]);
  if (c.status !== 0) { r.stop(`release commit failed: ${firstLine(c.stderr || c.stdout)}`); return false; }
  r.add(`COMMIT: ${git(cwd, ['rev-parse', '--short=12', 'HEAD']).stdout.trim()} ${msg.split('\n')[0]} (${short(meta, 5)})`);
  return true;
}

/**
 * A harness pin edit that only records changed harness files as non-behavioral at the same version and patterns (GST-1031): release
 * metadata, like a version stamp. The pins live one file per harness file under scripts/harness-pins/ (GST-1084), beside a manifest
 * holding only version and patterns. A bump, a pattern change or a pin without its reason is behavior.
 */
const HARNESS_MANIFEST = 'scripts/harness-version.json';
const HARNESS_PINS = 'scripts/harness-pins/';
function harnessRepin(cwd: string, from: string, to: string, p: string): boolean {
  if (p !== HARNESS_MANIFEST && !(p.startsWith(HARNESS_PINS) && p.endsWith('.json'))) return false;
  const read = (tree: string, file: string): any => { const s = git(cwd, ['show', `${tree}:${file}`]); if (s.status !== 0) return undefined; try { return JSON.parse(s.stdout); } catch { return null; } };
  const a = read(from, HARNESS_MANIFEST), b = read(to, HARNESS_MANIFEST);
  if (!a || !b || Object.keys(b).sort().join() !== 'patterns,version' || a.version !== b.version || JSON.stringify(a.patterns) !== JSON.stringify(b.patterns)) return false;
  if (p === HARNESS_MANIFEST) return true;
  const e = read(to, p);
  return e === undefined || JSON.stringify(read(from, p)) === JSON.stringify(e)
    || (e?.since === b.version && typeof e?.nonBehavioral === 'string' && e.nonBehavioral.trim().length >= 10);
}

/**
 * Step 16 stage 2's route. With --reviewed-base, a path whose branch patch is the reviewed one counts as base (lib/ship-patch.ts).
 * A code or test path a granted fix-check read counts as fix_checked (fixChecked: the newest completed clean review-fix-check
 * row, chained through earlier rows back to the reviewed tree, each under its own approved review_loop_grant): the owner's
 * granted fix-check after Step 11 is a review (GST-1130, GST-1627). A finding on a link the owner ruled a disclosed note (an
 * approved gstack-approvals rule row whose stop head lies inside that link's range_base..commit, never the row's own claim) is closed, and every ruling
 * prints as RULED_NOTE (GST-1537). Authored docs keep the stage 2.2 recheck.
 */
type FixCheckException = ReviewLoopException & { fix_check: NonNullable<ReviewLoopException['fix_check']> };
type Routed = Record<'behavior' | 'docs' | 'metadata' | 'tests' | 'base' | 'context' | 'bounded' | 'mechanical' | 'accepted' | 'fix_checked' | 'sidecar', string[]>;
type ReviewedBase = { commit: string; parent: boolean };
type RouteOpts = { docsRechecked: boolean; contextReviewed?: string; loop?: FixCheckException; audited: Record<string, string | null> | null; bookkeeping: readonly string[]; mechanical: readonly MechanicalConstant[]; testCode: readonly string[]; excluded: readonly string[]; baseRelease?: string[] };

/**
 * The --reviewed-base commit: one on the base, or a landed stack parent (GST-1399). A child reviewed against its parent
 * branch saves the parent's head; once the parent squash-merges and the child merges the base, that head is on no base
 * history, but the branch contains it and a base commit holds its change outside release metadata (heldBy), changelog
 * fragments included, since a release folds every fragment on the base.
 * Each side's patch then runs from the parent, so the parent's and the base's edits are base, and a parent the base never
 * received, or any other commit off the base, still stops. The route then also reads every path the branch ships against
 * the base, unchanged since review or not, so a parent change the base never received, or a merge that kept a line the
 * base changed since, still stops even when the landed check's metadata exclusions let the parent through.
 */
function reviewedBaseCommit(cwd: string, baseRef: string, reviewedBase: string, metadata: string[], r: Report): ReviewedBase | null {
  const rb = git(cwd, ['rev-parse', '--verify', '--quiet', `${reviewedBase}^{commit}`]).stdout.trim();
  if (!rb) { r.stop(`--reviewed-base ${reviewedBase.slice(0, 40)} is not a commit in this clone: pass the merge base saved with the reviewed tree (git merge-base ${baseRef} HEAD at Step 11)`); return null; }
  if (git(cwd, ['merge-base', '--is-ancestor', rb, baseRef]).status === 0) return { commit: rb, parent: false };
  const cb = git(cwd, ['merge-base', baseRef, 'HEAD']).stdout.trim();
  const at = cb && git(cwd, ['merge-base', '--is-ancestor', rb, 'HEAD']).status === 0 ? heldBy(cwd, rb, cb, [':(top)', ...metadata]) : null;
  if (at) {
    r.add(`REVIEWED_BASE: stack parent ${rb.slice(0, 12)} landed on ${baseRef} at ${at.slice(0, 12)}`);
    return { commit: rb, parent: true };
  }
  r.stop(`--reviewed-base ${rb.slice(0, 12)} is not on ${baseRef}, nor a landed stack parent (a commit this branch contains whose change ${baseRef} already holds): pass the merge base saved with the reviewed tree (git merge-base <the review's base> HEAD at Step 11)`);
  return null;
}

/** Where a branch commit's own patch starts: its merge base with the base, or the landed stack parent when the commit holds it and forked before it. */
function patchBase(cwd: string, baseRef: string, commit: string, parent: string | undefined): string {
  const fork = git(cwd, ['merge-base', baseRef, commit]).stdout.trim();
  const holds = (a: string, d: string) => git(cwd, ['merge-base', '--is-ancestor', a, d]).status === 0;
  return parent && fork && holds(parent, commit) && holds(fork, parent) ? parent : fork;
}

type FixLink = { row: Record<string, any>; commit: string; from: string };

/**
 * The granted fix-checks finish counts (GST-1130, GST-1627): the newest review-fix-check row and, while its range_base does
 * not hold the reviewed tree, the newest earlier row whose commit is that range_base, back to a row whose range_base holds
 * it. Every link must be a completed clean read on committed branch content with its own approved review_loop_grant, a stop
 * head inside its range_base..commit (before the commit for an earlier link, since that commit is the next link's start);
 * a grant counts for one link only, the newest link that names it, so one grant naming two links' commits covers one.
 * A range_base no earlier row ends at is a gap, and the chain does not count. A path counts as fix_checked when a link's
 * range touched it and it is unchanged since that link, or its patch against the base is still the one the link read.
 */
function fixChecked(cwd: string, o: { reviewed: string; now: string; baseRef: string; parent?: string; currentBase?: string; candidates: string[] }, r: Report): { counted: boolean; paths: string[] } | null {
  const rows: Record<string, any>[] = bin(cwd, 'gstack-review-read', [], 60_000).stdout.split('\n---CONFIG---')[0].split('\n')
    .flatMap(l => { try { const v = JSON.parse(l); return v?.skill === 'review-fix-check' ? [v] : []; } catch { return []; } });
  const commitOf = (c: unknown) => typeof c === 'string' && /^[0-9a-f]{7,64}$/.test(c) ? git(cwd, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]).stdout.trim() : '';
  const ancestor = (a: string, d: string) => git(cwd, ['merge-base', '--is-ancestor', a, d]).status === 0;
  const onBranch = (c: string) => !!c && ancestor(c, 'HEAD');
  const commits = rows.map(row => commitOf(row.commit_full));
  const chain: FixLink[] = [];
  let gap = '';
  for (let i = rows.length - 1; i >= 0;) {
    const link = { row: rows[i]!, commit: commits[i]!, from: commitOf(rows[i]!.range_base) };
    chain.unshift(link);
    if (!onBranch(link.from) || git(cwd, ['rev-parse', `${link.from}^{tree}`]).stdout.trim() === o.reviewed) break;
    i = commits.slice(0, i).lastIndexOf(link.from);
    if (i < 0) gap = `range_base ${link.from.slice(0, 12)} does not hold the reviewed tree`;
  }
  const inRange = (l: FixLink, c: string) => !!l.from && !!l.commit && ancestor(l.from, c) && ancestor(c, l.commit);
  const rulings = readRuledNotes(cwd).map(n => ({ ...n, links: chain.filter(l => inRange(l, n.head)) }));
  for (const n of rulings) r.add(`RULED_NOTE: ${ruledNoteText(n)}${chain.length && !n.links.length ? ' (outside this fix-check\'s range; not applied)' : ''}`);
  const grants = chain.length ? (loc => 'file' in loc ? readRecord(loc).rows : [])(locate({ cwd, env: process.env })).filter(g => g.outcome === 'approved' && `${g.ask} ${g.scope}`.includes('review_loop_grant')) : [];
  const granted: (typeof grants[number] | undefined)[] = [];
  const used = new Set<string>();
  for (let k = chain.length - 1; k >= 0; k--) {
    const l = chain[k]!;
    const g = grants.filter(g => !used.has(g.id))
      .flatMap(g => (`${g.ask} ${g.scope}`.match(/\b[0-9a-f]{7,40}\b/g) ?? []).map(commitOf).filter(c => !!c && inRange(l, c) && (k === chain.length - 1 || c !== l.commit)).map(stop => ({ g, stop })))
      .reduce<{ g: typeof grants[number]; stop: string } | undefined>((best, c) => (!best || ancestor(best.stop, c.stop) ? c : best), undefined)?.g;
    if (g) used.add(g.id);
    granted[k] = g;
  }
  const why = (l: FixLink) => {
    const fresh = reviewFreshness(l.row, l.row.wtree, new Set(rulings.filter(n => n.links.includes(l)).map(n => n.finding)));
    return fresh?.status !== 'CURRENT' ? fresh?.reason ?? 'not a review row'
      : l.row.tree !== l.row.wtree || !onBranch(l.commit) ? 'the row was logged on content no branch commit holds'
      : !onBranch(l.from) ? 'the row names no range_base commit on this branch' : '';
  };
  const at = (l: FixLink) => (chain.length > 1 ? `; fix-check at ${l.commit.slice(0, 12)}, link ${chain.indexOf(l) + 1} of ${chain.length}` : '');
  const newestFirst = [...chain].reverse();
  const stale = newestFirst.map(l => ({ l, w: why(l) })).find(x => x.w);
  const ungranted = newestFirst.find(l => !granted[chain.indexOf(l)]);
  const notCounted = !chain.length ? '' : stale ? `${stale.w}${at(stale.l)}` : gap ? `${gap}${at(chain[0]!)}`
    : ungranted ? `no approved review_loop_grant names a stop head inside its range_base..commit${at(ungranted)}` : '';
  if (notCounted) r.add(`FIX_CHECK: not counted (${notCounted})`);
  if (!chain.length || notCounted) return { counted: false, paths: [] };
  const read: ((p: string) => boolean)[] = [];
  for (const l of chain) {
    const range = touchedPaths(cwd, l.from, l.commit), after = touchedPaths(cwd, l.commit, o.now);
    if (!range || !after) { r.stop(`git could not diff the fix-check range ${l.from.slice(0, 12)}..${l.commit.slice(0, 12)} against the reviewed and current trees: stage 2 is blocked`); return null; }
    const sides = { reviewedBase: patchBase(cwd, o.baseRef, l.commit, o.parent), reviewed: l.commit, currentBase: o.currentBase ?? git(cwd, ['merge-base', o.baseRef, 'HEAD']).stdout.trim(), current: o.now };
    read.push(p => range.has(p) && (!after.has(p) || (!!sides.reviewedBase && !!sides.currentBase && comparePath(cwd, sides, p) === 'same')));
  }
  const paths = o.candidates.filter(p => read.some(f => f(p))).sort();
  const list = paths.length ? short(paths) : 'none';
  r.add(chain.length === 1 ? `FIX_CHECK: reviewed ${list} (fix-check at ${chain[0]!.commit.slice(0, 12)}, range from ${chain[0]!.from.slice(0, 12)}, grant ${granted[0]!.id})`
    : `FIX_CHECK: reviewed ${list} (fix-check chain of ${chain.length} from ${chain[0]!.from.slice(0, 12)}: ${chain.map((l, k) => `at ${l.commit.slice(0, 12)} grant ${granted[k]!.id}`).join('; ')})`);
  return { counted: true, paths };
}

function route(cwd: string, base: string, reviewed: string, reviewedBase: ReviewedBase | undefined, release: string[], opts: RouteOpts, r: Report): Routed | null {
  const now = bin(cwd, 'gstack-wtree', [], 60_000).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(now)) { r.stop('gstack-wtree printed no tree; the stage 2 comparison is blocked'); return null; }
  const changedSet = touchedPaths(cwd, reviewed, now);
  if (!changedSet) { r.stop(`the reviewed tree ${reviewed} is unreadable: a missing snapshot blocks stage 2`); return null; }
  const baseRef = `origin/${base.replace(/^origin\//, '')}`;
  let sides: PatchSides | undefined;
  let touched = new Set<string>();
  let shipped = new Set<string>();
  const parent = reviewedBase?.parent ? reviewedBase.commit : undefined;
  if (reviewedBase !== undefined) {
    const cb = git(cwd, ['merge-base', baseRef, 'HEAD']).stdout.trim();
    const a = touchedPaths(cwd, reviewedBase.commit, reviewed);
    const b = cb ? touchedPaths(cwd, cb, now) : null;
    if (!a || !b) { r.stop(`git could not diff the branch against ${baseRef} (fetch it first): stage 2 is blocked`); return null; }
    sides = { reviewedBase: reviewedBase.commit, reviewed, currentBase: cb, current: now };
    touched = new Set([...a, ...b]);
    shipped = b;
  }
  const by: Routed = { behavior: [], docs: [], metadata: [], tests: [], base: [], context: [], bounded: [], mechanical: [], accepted: [], fix_checked: [], sidecar: [] };
  const onlyShipped = new Set(parent ? [...shipped].filter(p => !changedSet.has(p)) : []);
  for (const p of [...changedSet, ...onlyShipped].sort()) {
    const verdict = sides ? (!touched.has(p) || (parent && !shipped.has(p) && baseHolds(cwd, sides, p)) ? 'same' : comparePath(cwd, sides, p)) : 'changed';
    const metadata = parent && shipped.has(p) ? opts.baseRelease!.includes(p) || harnessRepin(cwd, sides!.currentBase, now, p) : release.includes(p) || harnessRepin(cwd, reviewed, now, p);
    by[verdict === 'same' ? 'base' : metadata ? 'metadata' : sides && isTestCode(p, opts.testCode) ? 'tests' : classifyPath(p, cwd) === 'docs' && !matchesAny(opts.bookkeeping, p) ? 'docs' : verdict === 'context' ? 'context' : 'behavior'].push(p);
  }
  const shippedTests = by.tests.filter(p => onlyShipped.has(p));
  const gated = new Set([...(gateEditedPaths(cwd, reviewed, now, by.tests.filter(p => !onlyShipped.has(p))) ?? by.tests), ...(gateEditedPaths(cwd, sides?.currentBase ?? reviewed, now, shippedTests) ?? shippedTests)]);
  by.behavior.push(...by.tests.filter(p => gated.has(p)));
  by.tests = by.tests.filter(p => !gated.has(p));
  const mech = mechanicalPaths(cwd, { sides, base, candidates: parent ? [] : [...by.behavior, ...by.tests, ...by.docs], declared: opts.mechanical });
  by.mechanical = Object.keys(mech.proven).sort();
  for (const k of ['behavior', 'tests', 'docs'] as const) by[k] = by[k].filter(p => !Object.hasOwn(mech.proven, p));
  const bounded = boundedPaths(cwd, { sides, reviewed, now, base: baseRef, candidates: parent ? [] : by.behavior, audited: opts.audited, bookkeeping: opts.bookkeeping });
  by.bounded = Object.keys(bounded.kinds).sort();
  by.behavior = by.behavior.filter(p => !by.bounded.includes(p));
  const late = (): Record<string, BoundedKind> => Object.fromEntries(by.bounded.map(p => [p, bounded.kinds[p]!]));
  const packetBody = sides && (by.context.length || by.tests.length || by.bounded.length) ? contextPacket(cwd, sides, by.context, by.tests, late()) : null;
  if (packetBody?.over.length) {
    r.add(`SCOPED_REVIEW: too large for the scoped review (over ${PACKET_SECTION_CAP} lines in a section): ${short(packetBody.over)}`);
    by.behavior.push(...packetBody.over);
    for (const k of ['context', 'tests', 'bounded'] as const) by[k] = by[k].filter(p => !packetBody.over.includes(p));
  }
  const fix = fixChecked(cwd, { reviewed, now, baseRef, parent, currentBase: sides?.currentBase, candidates: [...by.behavior, ...by.tests, ...by.context, ...by.bounded] }, r);
  if (!fix) return null;
  const counted = fix.counted;
  by.fix_checked = fix.paths;
  for (const k of ['behavior', 'tests', 'context', 'bounded'] as const) by[k] = by[k].filter(p => !by.fix_checked.includes(p));
  const ancestor = (a: string, d: string) => git(cwd, ['merge-base', '--is-ancestor', a, d]).status === 0;
  const loop = opts.loop;
  if (loop) {
    const head = loop.fix_check.head;
    const since = touchedPaths(cwd, head, now);
    const fork = git(cwd, ['merge-base', baseRef, head]).stdout.trim();
    const own = fork ? touchedPaths(cwd, fork, head) : null;
    const fromParent = parent && ancestor(parent, head) ? touchedPaths(cwd, parent, head) : own;
    const atHead = own && fromParent ? new Set([...own].filter(p => fromParent.has(p))) : null;
    if (!since || !atHead) { r.stop(`git could not list the paths changed since fix-check ${head.slice(0, 12)} or the paths the branch touched at it against ${baseRef}: stage 2 is blocked`); return null; }
    const listed = loop.fix_check.files;
    const unscanned = [...by.behavior, ...by.docs].filter(p => isTestCode(p, opts.testCode));
    const forced = new Set([...gated, ...(packetBody?.over ?? []), ...(gateEditedPaths(cwd, reviewed, now, unscanned) ?? unscanned)]);
    by.accepted = [...by.behavior, ...by.docs].filter(p => since.has(p) && atHead.has(p) && (!listed || listed.includes(p)) && !forced.has(p)).sort();
    by.behavior = by.behavior.filter(p => !by.accepted.includes(p));
    by.docs = by.docs.filter(p => !by.accepted.includes(p));
  }
  const uid = uidSidecars(cwd, { sides, candidates: parent ? [] : by.behavior, accepted: by.accepted, excluded: opts.excluded });
  by.sidecar = Object.keys(uid.proven).sort();
  by.behavior = by.behavior.filter(p => !by.sidecar.includes(p));
  r.add(`ROUTE: reviewed=${reviewed.slice(0, 12)} current=${now.slice(0, 12)} behavior=${by.behavior.length} docs=${by.docs.length} metadata=${by.metadata.length} tests=${by.tests.length} base=${sides ? by.base.length : 'unknown'} context=${by.context.length}${by.bounded.length ? ` bounded=${by.bounded.length}` : ''}${by.mechanical.length ? ` mechanical=${by.mechanical.length}` : ''}${counted ? ` fix_checked=${by.fix_checked.length}` : ''}${loop ? ` accepted=${by.accepted.length}` : ''}${by.sidecar.length ? ` sidecar=${by.sidecar.length}` : ''}`);
  if (loop) r.add(`REVIEW_LOOP_EXCEPTION: accepted ${by.accepted.length ? short(by.accepted) : 'none'} (changed since fix-check ${loop.fix_check.head.slice(0, 12)}; accepted by ${loop.accepted_by} ${loop.date} via ${loop.via})`);
  for (const x of bounded.refused) if (by.behavior.includes(x.path)) r.add(`ROUTE_BOUNDED_REFUSED: ${x.path} ${x.reason} (fix: ${x.fix}; docs/troubleshooting.md#route-bounded-refused)`);
  for (const p of by.mechanical) r.add(`MECHANICAL: ${p} (${mech.proven[p]})`);
  for (const x of mech.refused) r.add(`ROUTE_MECHANICAL_REFUSED: ${x.path} ${x.reason} (docs/troubleshooting.md#route-mechanical-refused)`);
  for (const p of by.sidecar) r.add(`UID_SIDECAR: ${p} (beside ${uid.proven[p]})`);
  for (const x of uid.refused) r.add(`ROUTE_SIDECAR_REFUSED: ${x.path} ${x.reason} (docs/troubleshooting.md#route-sidecar-refused)`);
  if (by.behavior.length) { r.stop(`behavior, tests or build inputs changed since review (${short(by.behavior.sort())}): insert 5–11.5 → 12–14 → 16 before Step 17; plan that Step 9 with gstack-review-plan --post-review, which at the round cap stops for the owner's grant of one scoped fix-check (stage 2.1)`); return null; }
  const kept = by.mechanical.length || by.sidecar.length ? writeMechanicalRecord(cwd, now, mech.proven, uid.proven) : null;
  if (kept) { r.stop(`the mechanical and sidecar paths cannot be recorded for gstack-ship-receipt write (${kept}): make that directory writable, then rerun finish (stage 2.1)`); return null; }
  const scoped = [...by.context, ...by.tests, ...by.bounded].sort();
  if (scoped.length && sides) {
    const packet = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', `gstack/scoped-review-${now.slice(0, 12)}.md`]).stdout.trim() || `.git/gstack/scoped-review-${now.slice(0, 12)}.md`);
    const built = contextPacket(cwd, sides, by.context, by.tests, late());
    if (!opts.contextReviewed) {
      const why = [by.context.length ? `base context moved next to the reviewed hunks in ${short(by.context)}` : '', by.tests.length ? `test code changed since review in ${short(by.tests)}` : '',
        by.bounded.length ? `bounded edits since review in ${by.bounded.map(p => `${p} (${bounded.kinds[p]})`).join(', ')}` : ''].filter(Boolean).join('; ');
      try {
        fs.mkdirSync(path.dirname(packet), { recursive: true });
        fs.writeFileSync(packet, built.text);
      } catch (e) {
        r.stop(`${why}, but the scoped-review packet ${packet} cannot be written (${firstLine((e as Error).message)}): make its directory writable, then rerun finish (stage 2.1)`);
        return null;
      }
      r.stop(`${why}: one scoped reader (not a review round) reads ${packet}, then rerun with --context-reviewed <record.json> written beside the packet, outside the worktree ({"tree":"${now}","paths":[…],"reviewer":"<model>","verdict":"clean","packet_sha256":"${built.sha256}"}); a blocking finding is a behavior change (stage 2.1)`);
      return null;
    }
    const review = readScopedReview(opts.contextReviewed, { tree: now }, scoped);
    if (!review.ok) { r.stop(`--context-reviewed: ${review.message}`); return null; }
    if (by.bounded.length && review.review.packet_sha256 !== built.sha256) { r.stop(`--context-reviewed: the record's packet_sha256 is ${review.review.packet_sha256?.slice(0, 12) ?? 'missing'}, not ${built.sha256.slice(0, 12)}: bounded edits need a record bound to the packet the reader read (${packet}); rerun the reader on it (stage 2.1)`); return null; }
    r.add(`SCOPED_REVIEW: clean by ${review.review.reviewer} (${short(scoped)})`);
  }
  if (by.docs.length && !opts.docsRechecked) { r.stop(`authored docs changed since review (${short(by.docs)}): recheck the plan items they touch (stage 2.2), then rerun with --docs-rechecked`); return null; }
  return by;
}

/**
 * Step 16 stage 3. Test code, paths only the base or a stamp moved, a slot restamp after the audit (the CHANGELOG's heading
 * move or re-heading after the restamp writer's own merge of the base's CHANGELOG into the audited one, the version file's
 * version, each against the audited bytes; GST-906), and --docs-requested fixes the audit's own result asked for do not
 * stale the audit (GST-391).
 */
function docsFresh(cwd: string, base: string, postFile: string, moved: readonly string[], requested: string[], resultFile: string | undefined, loopAccepted: readonly string[] | undefined, parent: string | undefined, testCode: readonly string[], r: Report): boolean {
  const cmp = bin(cwd, 'gstack-docs-candidate', ['compare', postFile], 120_000);
  let stale: string[] | null = null;
  try { stale = JSON.parse(cmp.stdout).content_changed; } catch { stale = null; }
  if (stale === null) { r.stop(`gstack-docs-candidate compare failed: ${firstLine(cmp.stderr)}; documentation freshness is unknown (stage 3)`); return false; }
  const record = JSON.parse(fs.readFileSync(postFile, 'utf8'));
  const auditFile = path.join(cwd, '.gstack/tmp/docs-audit.json');
  let docsAudit: ReceiptDocs | null = null;
  if (fs.existsSync(auditFile)) {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(auditFile, 'utf8')); } catch { raw = undefined; }
    const parsed = parseReceiptDocs(raw);
    if (!parsed.ok) { r.stop(`.gstack/tmp/docs-audit.json: ${parsed.message}; documentation status is unknown (stage 3)`); return false; }
    docsAudit = parsed.docs;
  }
  const accepted = docsAudit?.exception;
  if (accepted || record.exception) {
    const same = !!accepted && !!record.exception && docsAudit!.status === 'blocked' && record.exception.scope === docsAudit!.scope
      && (['accepted_by', 'date', 'via', 'reason'] as const).every(k => record.exception[k] === accepted[k]);
    if (!same) {
      r.stop(accepted
        ? `the Step 14.5 audit is blocked and ${postFile} names no matching owner-accepted exception: snapshot with --exception .gstack/tmp/docs-audit.json (documentation.md Blocked recovery step 3)`
        : `${postFile} names a documentation exception but .gstack/tmp/docs-audit.json is not the blocked record carrying it: rerun Step 14.5`);
      return false;
    }
  }
  const baseRef = `origin/${base.replace(/^origin\//, '')}`;
  const nul = (out: string) => out.split('\0').filter(Boolean);
  const auditBase = patchBase(cwd, baseRef, record.head, parent);
  const nowBase = git(cwd, ['merge-base', baseRef, 'HEAD']).stdout.trim();
  const nowTree = bin(cwd, 'gstack-wtree', [], 60_000).stdout.trim();
  const atAudit = auditBase ? touchedPaths(cwd, auditBase, record.head) : new Set<string>();
  const nowDiff = nowBase ? git(cwd, ['diff', '-z', '--name-only', '--no-renames', nowBase]) : null;
  if (!atAudit || (nowDiff && nowDiff.status !== 0)) { r.stop(`git could not list the paths the branch touched against ${baseRef}; documentation freshness is unknown (stage 3)`); return false; }
  const branchAtAudit = new Set([...atAudit, ...record.staged, ...record.unstaged, ...record.untracked]);
  const branchNow = new Set([...(nowDiff ? nul(nowDiff.stdout) : []), ...nul(git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']).stdout)]);
  const changelog = shipPolicy(cwd, base)?.changelog;
  const versionFile = versionAtRef(cwd, 'HEAD');
  const restamped = stale.filter(p => {
    const isChangelog = p === changelog;
    if (!isChangelog && !('rel' in versionFile && p === versionFile.rel)) return false;
    const audited = typeof record.hashes?.[p] === 'string' ? git(cwd, ['cat-file', 'blob', record.hashes[p]]) : null;
    if (audited?.status !== 0) return false;
    let now: string;
    try { now = fs.readFileSync(path.join(cwd, p), 'utf8'); } catch { return false; }
    if (!isChangelog) return !!parseVersion(audited.stdout.trim()) && !!parseVersion(now.trim());
    const [atAuditBase, atNowBase] = [auditBase, nowBase].map(b => b ? git(cwd, ['show', `${b}:${p}`]) : null);
    if (atAuditBase?.status !== 0 || atNowBase?.status !== 0) return false;
    if (atAuditBase.stdout === atNowBase.stdout) return normalizeChangelog(audited.stdout) === normalizeChangelog(now);
    const kept = mergeChangelogs(audited.stdout, atAuditBase.stdout, atAuditBase.stdout);
    const merged = mergeChangelogs(audited.stdout, atNowBase.stdout, atAuditBase.stdout);
    return kept !== null && merged !== null && normalizeChangelog(kept) === normalizeChangelog(audited.stdout) && normalizeChangelog(merged) === normalizeChangelog(now);
  });
  const carried = { tests: stale.filter(p => isTestCode(p, testCode)), base: stale.filter(p => !isTestCode(p, testCode) && (moved.includes(p) || restamped.includes(p) || (!!auditBase && !!nowBase && !branchAtAudit.has(p) && !branchNow.has(p))
    || (!!auditBase && !!nowBase && /^[0-9a-f]{40,64}$/.test(nowTree) && ![...record.staged, ...record.unstaged, ...record.untracked].includes(p) && comparePath(cwd, { reviewedBase: auditBase, reviewed: record.head, currentBase: nowBase, current: nowTree }, p) === 'same'))), requested: [] as string[], accepted: [] as string[] };
  carried.accepted = stale.filter(p => loopAccepted?.includes(p) && !carried.tests.includes(p) && !carried.base.includes(p));
  let audit: any = null;
  try { audit = resultFile ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null; } catch { audit = null; }
  for (const p of requested.filter(q => stale!.includes(q) && !carried.tests.includes(q) && !carried.base.includes(q) && !carried.accepted.includes(q))) {
    const asked = [...(Array.isArray(audit?.blockers) ? audit.blockers : []), ...(Array.isArray(audit?.decisions) ? audit.decisions : [])].filter((s: unknown) => typeof s === 'string');
    const token = new RegExp(`(^|[\\s\`'"(\\[])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s\`'")\\]]|[,.:;](?:$|\\s))`);
    const stat = git(cwd, ['diff', '--numstat', '--no-renames', record.head, '--', `:(literal)${p}`]).stdout.trim().split(/\s+/);
    const lines = Number(stat[0]) + Number(stat[1]);
    const why = !audit ? 'needs --docs-result <the audit\'s saved result JSON>'
      : audit.audit_id !== record.audit_id ? `is backed by the result of audit ${String(audit.audit_id)}, not ${String(record.audit_id)}`
      : !asked.some((s: string) => token.test(s)) ? 'is not named in the audit result\'s blockers or decisions'
      : classifyPath(p, cwd) !== 'docs' ? 'is not an authored doc'
      : [...record.staged, ...record.unstaged, ...record.untracked].includes(p) ? 'was not clean at the post-audit snapshot'
      : !(lines <= 5) ? `changed ${Number.isFinite(lines) ? lines : 'unknown'} lines since the audit (at most 5)` : null;
    if (why) { r.stop(`--docs-requested ${p} ${why}: use stage 3 recovery`); return false; }
    carried.requested.push(p);
  }
  if (carried.requested.length && bin(cwd, 'gstack-ship-receipt', ['docs-caps', '--base', base], 60_000).status !== 0) { r.stop('a --docs-requested fix breaks a doc cap (gstack-ship-receipt docs-caps): trim the file, then rerun finish'); return false; }
  const left = stale.filter(p => !carried.tests.includes(p) && !carried.base.includes(p) && !carried.requested.includes(p) && !carried.accepted.includes(p));
  const note = left.length || stale.length === 0 ? '' : ` (carried: tests=${carried.tests.length} base=${carried.base.length} requested=${carried.requested.length}${loopAccepted ? ` accepted=${carried.accepted.length}` : ''})`;
  const exception = record.exception ? ` (blocked; documentation exception accepted by ${record.exception.accepted_by} ${record.exception.date} via ${record.exception.via})` : '';
  r.add(`DOCS: ${left.length ? `stale (${short(left)})` : `fresh against the Step 14.5 post-audit snapshot${note}${exception}`}`);
  if (left.length) { r.stop('documentation inputs changed since the accepted audit: use stage 3 recovery (the remaining re-audit, a fix the audit\'s result asked for via --docs-requested <path> --docs-result <audit-id>-result.json, or a named risk); never refresh hashes'); return false; }
  return true;
}

/** Steps 15-16; once they pass, the /ship run's preflight marker is cleared, so a full preflight may merge the base again (GST-1204). */
export async function finish(argv: readonly string[], cwd: string): Promise<Report> {
  const r = await finishStages(argv, cwd);
  const marker = r.exit === 0 && shipRunMarker(cwd);
  if (marker) fs.rmSync(marker, { force: true });
  return r;
}

async function finishStages(argv: readonly string[], cwd: string): Promise<Report> {
  const { flag, all, has } = flagReader(argv);
  const base = flag('--base')!;
  const r = new Report();
  const list = lanes(argv) as { label: string; command: string }[];
  let loop: FixCheckException | undefined;
  const loopArg = flag('--review-loop-exception');
  if (loopArg !== undefined) {
    let raw: unknown;
    try { raw = JSON.parse(loopArg.startsWith('@') ? fs.readFileSync(path.resolve(cwd, loopArg.slice(1)), 'utf8') : loopArg); } catch (e) { return r.stop(`--review-loop-exception: ${firstLine((e as Error).message)}`); }
    const parsed = parseReviewLoopException(raw);
    if (!parsed.ok) return r.stop(`--review-loop-exception: ${parsed.message}`);
    const fixCheck = parsed.exception.fix_check;
    if (!fixCheck) return r.stop('--review-loop-exception: finish routes edits made after a fix-check; a second_pass exception accepts an open finding, not edits, so run finish without it and pass it to gstack-ship-receipt write');
    if (Array.isArray((raw as { fix_check?: { files?: unknown } }).fix_check?.files) && !fixCheck.files) return r.stop('--review-loop-exception: fix_check.files lists no paths; omit it to accept the paths the branch touched at fix_check.head');
    if (git(cwd, ['merge-base', '--is-ancestor', fixCheck.head, 'HEAD']).status !== 0) return r.stop(`--review-loop-exception: fix_check.head ${fixCheck.head.slice(0, 12)} is not HEAD or an ancestor of it`);
    loop = { ...parsed.exception, fix_check: fixCheck };
  }
  const policy = shipPolicy(cwd, base);
  if (!commitRelease(cwd, releasePaths(policy, cwd, 'HEAD', base), flag('--trailer'), r)) return r;
  for (const cmd of all('--build')) {
    const b = sh(cwd, cmd);
    r.add(`BUILD: ${b.status === 0 ? 'ok' : `FAIL exit=${b.status}`} ${cmd.slice(0, 120)}`);
    if (b.status !== 0) return r.stop(`Build failed or prerequisite missing: ${firstLine(b.stderr || b.stdout)}; repair it, then repeat stage 1`);
  }
  if (!all('--build').length) r.add('BUILD: none passed (record the inspected sources, or pass --build per declared command)');
  const release = releasePaths(policy, cwd, flag('--reviewed-tree')!, base);
  let audited: Record<string, string | null> | null = null;
  try { const h = JSON.parse(fs.readFileSync(flag('--docs-post')!, 'utf8')).hashes; audited = h && typeof h === 'object' && !Array.isArray(h) ? h : null; } catch { audited = null; }
  const globs = (key: string): string[] => Array.isArray(policy?.[key]) ? policy![key].filter((g: unknown): g is string => typeof g === 'string') : [];
  const bookkeeping = globs('bookkeeping');
  const forbidden = forbidSpecs({ forbid_paths: Array.isArray(policy?.readers?.forbid_paths) ? policy!.readers.forbid_paths.filter((g: unknown): g is string => typeof g === 'string') : [] }).map(s => s.slice(':(top,exclude,glob)'.length));
  const mechanical: MechanicalConstant[] = Array.isArray(policy?.mechanical_retake) ? policy!.mechanical_retake : [];
  const reviewedBaseArg = flag('--reviewed-base');
  const fragments = typeof policy?.changelog_fragments?.dir === 'string' ? [`:(top,exclude,glob)${policy.changelog_fragments.dir.replace(/\/+$/, '')}/*.md`] : [];
  const reviewedBase = reviewedBaseArg === undefined ? undefined : reviewedBaseCommit(cwd, `origin/${base.replace(/^origin\//, '')}`, reviewedBaseArg, [...releasePaths(policy, cwd, flag('--reviewed-tree')!, base, true).map(p => `:(top,exclude,literal)${p}`), ...fragments], r);
  if (reviewedBase === null) return r;
  const baseRelease = reviewedBase?.parent ? releasePaths(policy, cwd, git(cwd, ['merge-base', `origin/${base.replace(/^origin\//, '')}`, 'HEAD']).stdout.trim(), base, true) : undefined;
  const routed = route(cwd, base, flag('--reviewed-tree')!, reviewedBase, release, { docsRechecked: has('--docs-rechecked'), contextReviewed: flag('--context-reviewed'), loop, audited, bookkeeping, mechanical, testCode: globs('test_code'), excluded: [...globs('review_exclude_paths'), ...forbidden], baseRelease }, r);
  if (!routed) return r;
  if (!docsFresh(cwd, base, flag('--docs-post')!, [...routed.base, ...routed.context, ...routed.mechanical, ...stampedFiles(policy, cwd, flag('--reviewed-tree')!, base)], all('--docs-requested'), flag('--docs-result'), loop ? routed.accepted : undefined, reviewedBase?.parent ? reviewedBase.commit : undefined, globs('test_code'), r)) return r;
  if (!list.length && !has('--no-lanes-approved')) return r.stop('no test lanes: require Step 5\'s explicit untested-scope approval (rerun with --no-lanes-approved) or run Steps 5-15');
  const allow = evidenceExempt(release).join(',');
  const check = (l: { label: string; command: string }) => bin(cwd, 'gstack-evidence', ['check', '--label', l.label, '--expect-cmd', l.command, '--max-age', '24', '--allow-paths', allow], 60_000).stdout;
  const mapped = mappedLanes(cwd, base, list);
  const deferred: string[] = [];
  for (const l of list) {
    let e = check(l);
    if (!/EVIDENCE: FRESH/.test(e)) {
      const m = mapped.get(l.label);
      const res = m ? carryLane(cwd, base, l) : (await runLanes(cwd, [l], Infinity, { base }))[0]!;
      if (m && !res.carried) {
        r.add(`EVIDENCE: DEFERRED label=${l.label} (${short([res.carryNone ?? 'not carried'], 1).slice(0, 160)}): CI at the pushed head carries it in accept`);
        deferred.push(l.label);
        continue;
      }
      const ran = laneLine(res);
      r.add(ran.line);
      if (!ran.ok) return r.stop(`lane ${l.label} failed or ran zero tests: STOP publication; run Steps 5-15 from Step 5's triage, then Step 16 stage 1`);
      e = check(l);
    }
    const line = /^EVIDENCE: .*$/m.exec(e)?.[0] ?? `EVIDENCE: unreadable label=${l.label}`;
    r.add(line.replace(/ log=\S+/, ''));
    if (!/EVIDENCE: FRESH/.test(line)) return r.stop(`lane ${l.label} is not FRESH after one rerun: Step 16 stage 4 recovery`);
  }
  const laneArgs = list.map(l => `--lane '${l.label}=${l.command.replace(/'/g, `'\\''`)}'`).join(' ');
  if (deferred.length) {
    const out = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'gstack/pregate-finish-preflight.json']).stdout.trim() || '.git/gstack/pregate-finish-preflight.json');
    const pg = bin(cwd, 'gstack-pregate', ['--allow-repo-commands', '--base', base, '--stage', 'preflight', '--out', out], 3_600_000);
    const verdict = /^PREGATE: (.+?) tree=/m.exec(pg.stdout + pg.stderr)?.[1] ?? `unreadable (exit ${pg.status})`;
    r.add(`PREGATE: preflight ${verdict} on the stamped tree (the tests stage runs in accept, carried from CI)`);
    if (!/^(pass|warn)/.test(verdict)) return r.stop(`pregate preflight ${verdict} on the stamped tree: fix it, then rerun finish`);
    return r.next(`Step 16 stage 5, then Step 17's guard block and gstack-ship-release push; then gstack-ship-release accept --base ${base} ${laneArgs} carries ${deferred.join(', ')} from CI at the pushed head${loop ? '; Step 18 records the same exception with gstack-ship-receipt write --review-loop-exception' : ''}`);
  }
  const v = bin(cwd, 'gstack-pregate', ['verify'], 60_000);
  if (v.status === 0) r.add('PREGATE: verify ok on the stamped tree');
  else {
    const policy = lanesOnlyHeadPolicy(cwd, base);
    if (policy.line) r.add(policy.line);
    const pg = bin(cwd, 'gstack-pregate', ['--allow-repo-commands', '--base', base, ...(policy.head ? ['--policy-from', 'head'] : [])], 3_600_000);
    const verdict = /^PREGATE: (.+?) tree=/m.exec(pg.stdout + pg.stderr)?.[1] ?? `unreadable (exit ${pg.status})`;
    r.add(`PREGATE: ${verdict} (rerun on the stamped tree)`);
    if (!/^(pass|warn|requires-remote cleared)/.test(verdict)) return r.stop(`pregate ${verdict} on the stamped tree: fix it${/uncleared/.test(verdict) ? ', or gstack-pregate clear with the remote run URL' : ''}, then rerun finish`);
  }
  return r.next(`Step 16 stage 5: paste these results and the two-line honesty inventory, then run Step 17's guard block and gstack-ship-release push${loop ? '; Step 18 records the same exception with gstack-ship-receipt write --review-loop-exception' : ''}`);
}

/**
 * Final-tree CI acceptance (design fix A1): after push, each mapped lane is carried only from a green run at the pushed
 * HEAD's exact, clean tree; the rest are reused or run; every lane must be FRESH, and the pregate reruns on that tree.
 */
export async function accept(argv: readonly string[], cwd: string): Promise<Report> {
  const { flag } = flagReader(argv);
  const base = flag('--base')!;
  const list = lanes(argv) as { label: string; command: string }[];
  const r = new Report();
  const branch = git(cwd, ['branch', '--show-current']).stdout.trim();
  if (!branch) return r.stop('detached HEAD: accept needs the feature branch');
  const head = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  const remote = git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], 120_000);
  if (remote.status !== 0) return r.stop(`cannot read origin/${branch} (${firstLine(remote.stderr)}): restore access, then rerun accept`);
  if (remote.stdout.split(/\s/)[0] !== head) return r.stop(`HEAD ${head.slice(0, 12)} is not origin/${branch}: run gstack-ship-release push first; accept carries only a run at the pushed head`);
  const mapped = mappedLanes(cwd, base, list);
  if (!mapped.size) return r.stop(`no --lane command is a key of origin/${base}'s .gstack/pregate.json ship_lanes_from: nothing comes from CI, so finish runs every lane here`);
  const runCheck = buildRunCheck(cwd, null, true, base);
  if ('error' in runCheck) return r.stop(`run profiles unavailable (${runCheck.error}): carry needs them; fix it, or run the lanes here with gstack-ship-preflight --tests-only`);
  const waitS = Number(flag('--wait') ?? '170');
  if (!Number.isFinite(waitS) || waitS < 0 || waitS > 3600) return r.stop(`--wait ${flag('--wait')} is not 0-3600 seconds`);
  for (const name of [...new Set([...mapped.values()].flatMap(m => m.profiles))]) {
    const p = runCheck.profiles[name];
    if (!p) return r.stop(`ship_lanes_from names ${name}, which is not a run_profiles entry on origin/${base}`);
    const w = await waitForRun(runCheck.deps, { workflow: p.workflow, events: p.events, head, timeoutMs: waitS * 1000, intervalMs: 15_000, sleep: ms => new Promise(res => setTimeout(res, ms)), clock: Date.now });
    r.add(`CI_WAIT: ${w.state} ${name} ${'run' in w ? `run=${w.run.id}/${w.run.run_attempt}` : w.reason}`);
    if (w.state === 'running') return r.stop(`${p.workflow} run ${w.run.id} at ${head.slice(0, 12)} is still running: rerun accept (or gstack-ci-carry wait --base ${base} in the background, then accept)`);
    if (w.state === 'red') return r.stop(`${p.workflow} run ${w.run.id} failed (${short(w.failing, 4) || 'no failing job named'}): Step 5 triage on its logs; fix, commit, push, then accept again`);
    if (w.state === 'none') return r.stop(`${w.reason}: push the branch (a pull_request or workflow_dispatch run must exist at HEAD), then accept again`);
  }
  const recordCi = recordCiTimeout(shipPolicy(cwd, base), base);
  r.add(recordCi.line);
  const exceptions: string[] = [];
  for (const l of list) {
    const m = mapped.get(l.label);
    const res = m ? carryLane(cwd, base, l, recordCi.seconds) : (await runLanes(cwd, [l], Infinity, { base }))[0]!;
    if (m && !res.carried) { for (const line of carryNoneLines(res)) r.add(line); return r.stop(`lane ${l.label} was not carried from the green run (${short([res.carryNone ?? ''], 1).slice(0, 120)}): fix the cause, or run it here with gstack-ship-preflight --tests-only`); }
    const ran = laneLine(res);
    r.add(ran.line);
    if (res.exception) { r.add(`TEST_LANE_EXCEPTION: ${res.exception}`); exceptions.push(res.exception); }
    if (!ran.ok) return r.stop(`lane ${l.label} failed or ran zero tests: Step 5 triage, then push and accept again`);
    const e = bin(cwd, 'gstack-evidence', ['check', '--label', l.label, '--expect-cmd', l.command, '--max-age', '24'], 60_000).stdout;
    const line = /^EVIDENCE: .*$/m.exec(e)?.[0] ?? `EVIDENCE: unreadable label=${l.label}`;
    r.add(line.replace(/ log=\S+/, ''));
    if (!/EVIDENCE: FRESH/.test(line)) return r.stop(`lane ${l.label} is not FRESH at the pushed head: Step 16 stage 4 recovery`);
  }
  const policy = lanesOnlyHeadPolicy(cwd, base);
  if (policy.line) r.add(policy.line);
  const pg = bin(cwd, 'gstack-pregate', ['--allow-repo-commands', '--base', base, ...(policy.head ? ['--policy-from', 'head'] : [])], 3_600_000);
  const out = pg.stdout + pg.stderr;
  const verdict = /^PREGATE: (.+?) tree=/m.exec(out)?.[1] ?? `unreadable (exit ${pg.status})`;
  const clip = (line: string, n: number) => (line.length > n ? `${line.slice(0, n)}…` : line);
  const carried = /^CI_CARRY: (?:accepted |none \().*$/m.exec(out)?.[0];
  const tests = /^PREGATE: tests (.+?) in ([\d.]+)s/m.exec(out);
  if (carried && (carried.startsWith('CI_CARRY: accepted') || !tests)) r.add(clip(carried, 240));
  else if (tests) r.add(`${carried ? clip(carried, 200) : 'CI_CARRY: none (the pregate policy declares no run_profiles)'}; the final pregate's tests stage ran here instead: tests ${tests[1]} in ${tests[2]}s (docs/pregate.md#accept-local-tests)`);
  for (const line of out.match(/^PREGATE_CLEAR_KEPT: .*$/gm) ?? []) r.add(clip(line, 240));
  r.add(`PREGATE: ${verdict} (final tree)`);
  if (!/^(pass|warn|requires-remote cleared)/.test(verdict)) return r.stop(`pregate ${verdict} on the final tree: fix it, then rerun accept`);
  return r.next(`Step 18: the receipt records ci_carried from the ledger${exceptions.length ? `; the PR body carries ${exceptions.map(e => JSON.stringify(`Test-lane exception: ${e}`)).join(' and ')} verbatim, one line each, or the receipt write refuses` : ''}`);
}

/**
 * The pre-push housekeeping guards (docs/pregate.md#prepush): `gstack-pregate --stage guards` before every push, early or
 * final, so a stale golden, a size ratchet or a type error fails here instead of a CI round. A pass recorded at HEAD's
 * exact tree by this step or by finish's preflight (both under .git, which no commit can carry) is reused, never rerun.
 */
function prepushGuards(cwd: string, branch: string, base: string | undefined): { line: string; stop?: string } {
  const gitPath = (name: string) => path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', `gstack/${name}`]).stdout.trim() || `.git/gstack/${name}`);
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const out = gitPath('pregate-guards.json');
  for (const file of [out, gitPath('pregate-finish-preflight.json')]) {
    let rec: { tree?: string; checks?: { id: string; status: string; detail?: string }[] };
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const rows = PREPUSH_CHECK_IDS.map(id => rec.checks?.find(c => c.id === id));
    if (tree && rec.tree === tree && rows.every(row => row?.status === 'pass')) return { line: `GUARDS: pass (reused from ${path.basename(file)} at tree ${tree.slice(0, 12)}: ${rows.map(row => `${row!.id} ${row!.detail ?? 'pass'}`).join('; ')})` };
  }
  fs.rmSync(out, { force: true });
  const pg = bin(cwd, 'gstack-pregate', ['--stage', 'guards', '--allow-repo-commands', '--json', '--out', out, ...(base ? ['--base', base] : [])], 3_600_000);
  let res: { status?: string; verdict?: string; tree?: string; code?: string; detail?: string; fix?: string; checks?: { id: string; status: string; detail?: string; fix?: string }[] } = {};
  try { res = JSON.parse(pg.stdout.trim().split('\n').pop() ?? ''); } catch { /* unreadable: stops below */ }
  const heads = res.status === 'refused' && res.code === 'POLICY_SOURCE_UNAVAILABLE' ? git(cwd, ['ls-remote', '--heads', 'origin'], 120_000) : null;
  if (heads && heads.status !== 0) return { line: 'GUARDS: not run (origin unreachable)', stop: `cannot verify the remote branch (${firstLine(heads.stderr)}): restore access before pushing` };
  if (heads && heads.stdout.split('\n').every(l => !l.trim() || l.trim().endsWith(`\trefs/heads/${branch}`))) return { line: `GUARDS: not run (origin has no branch but ${branch}, so no base to read guards from)` };
  if (res.status === 'refused') return { line: `GUARDS: refused ${res.code}`, stop: `the pre-push guards could not run (${res.detail}; fix: ${res.fix}): repair it, then rerun push` };
  const bad = (res.checks ?? []).filter(c => c.status !== 'pass' && c.status !== 'warn').map(c => `${c.id}: ${c.fix ?? c.detail ?? c.status}`).join('; ');
  if (res.tree && res.tree !== tree) return { line: `GUARDS: not certified (they checked the working tree ${res.tree.slice(0, 12)}, not HEAD's tree ${tree.slice(0, 12)})`, stop: `the working tree differs from HEAD (uncommitted or untracked files): commit or stash them, then rerun push${bad ? `; the guards also reported ${bad}` : ''}` };
  if (git(cwd, ['rev-parse', 'HEAD^{tree}']).stdout.trim() !== tree) return { line: 'GUARDS: not certified (HEAD moved while the guards ran)', stop: 'HEAD changed while the guards ran: rerun push' };
  const verdict = res.verdict ?? `unreadable (exit ${pg.status}: ${firstLine(pg.stderr)})`;
  const line = `GUARDS: ${verdict}${res.checks ? ` (${res.checks.map(c => `${c.id} ${c.detail ?? c.status}`).join('; ')})` : ''}`;
  if (pg.status === 0 && /^(pass|warn)/.test(verdict)) return { line };
  return { line, stop: `the pre-push guards did not pass (${bad || firstLine(pg.stderr || pg.stdout)}): fix it, commit, then rerun push` };
}

export function push(argv: readonly string[], cwd: string): Report {
  const { flag, has } = flagReader(argv);
  const r = new Report();
  const branch = git(cwd, ['branch', '--show-current']).stdout.trim();
  if (!branch) return r.stop('detached HEAD: push needs the feature branch');
  if (branch !== flag('--branch')) return r.stop(`HEAD is on ${branch}, not the branch Step 1 saved (${flag('--branch')}): check out the saved branch, then rerun push`);
  const guard = bin(cwd, 'gstack-config', ['get', 'redact_prepush_hook'], 30_000).stdout.trim() || 'false';
  const prompted = fs.existsSync(path.join(resolveStateRoot(process.env), '.redact-prepush-prompted'));
  const deferred = guard !== 'true' && !prompted && process.env.GSTACK_SESSION_KIND === 'unattended';
  r.add(`REDACT_PREPUSH: ${guard} prompted=${prompted ? 'yes' : 'no'}${deferred ? ' deferred=unattended' : ''}`);
  if (guard !== 'true' && !prompted && !deferred) return r.stop('Step 17\'s one-time pre-push guard offer is unanswered: run the guard block and ask it, then rerun push');
  const gateOpen = Number(flag('--gate-open') ?? '0');
  if (gateOpen > 0) {
    if (!hostedOrigin(cwd)) return r.stop('open-PR lookup unavailable: origin is a local path, not a hosted remote gh can map; it must succeed before pushing open gate findings');
    const pr = gh(cwd, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,isDraft', '--jq', '[.[] | select(.isDraft | not) | .number] | first // empty']);
    if (pr.status !== 0) return r.stop(`open-PR lookup failed (${firstLine(pr.stderr)}): it must succeed before pushing open gate findings`);
    if (pr.stdout.trim() && !has('--gate-open-approved')) return r.stop(`${gateOpen} open gate finding(s) and ready PR #${pr.stdout.trim()}: spawned/headless sessions stop here; otherwise ask (resolve now, or publish with the banner and rerun with --gate-open-approved)`);
  }
  const sealed = bin(cwd, 'gstack-pregate', ['sealed'], 120_000);
  r.add(`SEALED: ${sealed.status === 0 ? 'clear' : sealed.status === 1 ? 'refused' : `not checked (exit ${sealed.status})`}`);
  if (sealed.status === 1) return r.stop(`sealed output would be published: ${firstLine(sealed.stderr)}; remove it from the commits, then repeat Step 16`);
  if (sealed.status !== 0) return r.stop(`the sealed-output guard did not run (exit ${sealed.status}: ${firstLine(sealed.stderr || sealed.stdout)}); repair it, then rerun push`);
  if (has('--early')) {
    const out = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'gstack/pregate-early-push.json']).stdout.trim() || '.git/gstack/pregate-early-push.json');
    const scan = bin(cwd, 'gstack-pregate', ['--stage', 'preflight', '--only', 'secrets', '--out', out, ...(flag('--base') ? ['--base', flag('--base')!] : [])], 600_000);
    const verdict = /^PREGATE: (.+?) tree=/m.exec(scan.stdout + scan.stderr)?.[1] ?? `unreadable (exit ${scan.status})`;
    r.add(`SECRETS: ${verdict} (early push)`);
    if (scan.status !== 0 || !/^(pass|warn)/.test(verdict)) return r.stop(`the secrets scan did not pass before the early push (${firstLine(scan.stderr) || verdict}): remove the finding from the commits, then rerun push --early`);
  }
  const guards = prepushGuards(cwd, branch, flag('--base'));
  r.add(guards.line);
  if (guards.stop) return r.stop(guards.stop);
  const local = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  const remote = git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], 120_000);
  if (remote.status !== 0) return r.stop(`cannot verify the remote branch (${firstLine(remote.stderr)}): restore access before pushing`);
  if (remote.stdout.split(/\s/)[0] === local) return r.add(`PUSH: ALREADY_PUSHED ${local.slice(0, 12)}`).next('Step 18');
  const p = git(cwd, ['push', '-u', 'origin', branch], 600_000);
  if (p.status !== 0) {
    const nff = /non-fast-forward|fetch first|rejected/.test(p.stderr);
    return r.stop(nff ? 'non-fast-forward: fetch and merge the remote under Step 3\'s conflict rules, run Steps 5-16, then push again; never force-push'
      : `push failed (${firstLine(p.stderr)}): repair the auth, hook or network cause, repeat Step 16, then push; never bypass a guard`);
  }
  return r.add(`PUSH: pushed ${local.slice(0, 12)} to origin/${branch}`).next('Step 18');
}

export async function release(argv: readonly string[], cwd: string): Promise<{ text: string; exit: number }> {
  const [cmd, ...rest] = argv;
  const { flag, has } = flagReader(rest);
  if (!cmd || cmd === '--help' || cmd === '-h' || has('--help')) return { text: RELEASE_HELP + '\n', exit: cmd ? 0 : 2 };
  const usage = (m: string) => ({ text: `gstack-ship-release: ${m}\n`, exit: 2 });
  if (cmd !== 'push' && !flag('--base')) return usage(`${cmd} needs --base <base>`);
  if (cmd === 'push' && !flag('--branch')) return usage('push needs --branch <the branch Step 1 saved>');
  if (cmd === 'accept' && !(lanes(rest) as unknown[]).length) return usage('accept needs at least one --lane <label>=<command> (the Step 5 lanes)');
  if (typeof lanes(rest) === 'string') return usage(lanes(rest) as string);
  const answer = flag('--answer');
  if (has('--answer') && (!answer?.trim() || answer.startsWith('--') || /[\r\n]/.test(answer) || answer.length > 200)) return usage('--answer needs the owner\'s words: one non-empty line of at most 200 characters');
  if (cmd === 'finish' && (!flag('--reviewed-tree') || !flag('--docs-post'))) return usage('finish needs --reviewed-tree <the tree saved before Step 12> and --docs-post <Step 14.5\'s post-audit snapshot>');
  const r = cmd === 'version' ? version(rest, cwd) : cmd === 'finish' ? await finish(rest, cwd) : cmd === 'push' ? push(rest, cwd) : cmd === 'accept' ? await accept(rest, cwd) : null;
  if (!r) return usage(`unknown command ${cmd}; run gstack-ship-release --help`);
  return { text: r.render(), exit: r.exit };
}
