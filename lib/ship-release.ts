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
import { classifyPath } from './review-depth';
import { resolveStateRoot } from './state-root';
import { bumpVersion, cmpVersion, fmtVersion, parseVersion, versionWidth, type Bump } from './version-source';
import { bin, evidenceExempt, firstLine, flagReader, fragmentPath, gh, git, hostedOrigin, laneLine, lanes, releasePaths, Report, runLanes, sh, shipPolicy, short } from './ship-bin-common';

export const RELEASE_HELP = `gstack-ship-release — /ship Steps 12 and 15-17 (ship/SKILL.md)

  version --base <base> [--bump micro|patch|minor|major] [--version <v>] [--keep-current] [--accept-incomplete] [--why <text>]
      Step 12: classify, pick the queue-aware version, write it with --regen-digest --changelog, log the decision
  finish --base <base> --reviewed-tree <tree> --docs-post <post.json> [--lane <label>=<command>]... [--build <command>]...
         [--trailer <text>] [--docs-rechecked] [--no-lanes-approved]
      Step 15's release commit, Step 16 stages 1-4 (your builds, the reviewed-tree route, docs freshness,
      each lane's receipt run once if stale) and the pregate on the stamped tree
  push --branch <branch-name> [--gate-open <n>] [--gate-open-approved]
      Step 17 after its guard block: the saved-branch check, the open-gate check, the sealed guard, the idempotency check, git push -u

At most 30 lines each; STOP: names what the agent must decide or repair, and nothing after it ran.
Exit codes: 0 ok · 2 usage · 3 STOP`;

const LEVELS: Bump[] = ['micro', 'patch', 'minor', 'major'];

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
  const level = fresh ? asked ?? (policy?.bump === 'patch' ? 'patch' : undefined) : asked ?? derivedLevel(j.baseVersion, j.currentVersion) ?? undefined;
  if (!level) {
    const stat = git(cwd, ['diff', `origin/${base}`, '--shortstat']).stdout.trim();
    return r.stop(`BUMP_LEVEL needed (FRESH, ${stat || 'no diff'}): MICRO under 50 lines, PATCH 50+ with no feature signal, MINOR/MAJOR ask first (Step 12.2); rerun with --bump <level>`);
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
  bin(cwd, 'gstack-decision-log', [JSON.stringify({ decision: `Ship ${next} (${level})`, rationale: why, scope: 'repo', source: 'skill', confidence: 9 })], 30_000);
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

function route(cwd: string, reviewed: string, release: string[], docsRechecked: boolean, r: Report): boolean {
  const now = bin(cwd, 'gstack-wtree', [], 60_000).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(now)) { r.stop('gstack-wtree printed no tree; the stage 2 comparison is blocked'); return false; }
  const d = git(cwd, ['diff', '--name-only', reviewed, now]);
  if (d.status !== 0) { r.stop(`the reviewed tree ${reviewed} is unreadable (${firstLine(d.stderr)}): a missing snapshot blocks stage 2`); return false; }
  const changed = d.stdout.split('\n').filter(Boolean);
  const behavior = changed.filter(p => !release.includes(p) && classifyPath(p, cwd) !== 'docs');
  const docs = changed.filter(p => !release.includes(p) && classifyPath(p, cwd) === 'docs');
  r.add(`ROUTE: reviewed=${reviewed.slice(0, 12)} current=${now.slice(0, 12)} behavior=${behavior.length} docs=${docs.length} metadata=${changed.length - behavior.length - docs.length}`);
  if (behavior.length) { r.stop(`behavior, tests or build inputs changed since review (${short(behavior)}): insert 5–11.5 → 12–14 → 16 before Step 17 (stage 2.1)`); return false; }
  if (docs.length && !docsRechecked) { r.stop(`authored docs changed since review (${short(docs)}): recheck the plan items they touch (stage 2.2), then rerun with --docs-rechecked`); return false; }
  return true;
}

export async function finish(argv: readonly string[], cwd: string): Promise<Report> {
  const { flag, all, has } = flagReader(argv);
  const base = flag('--base')!;
  const r = new Report();
  const list = lanes(argv) as { label: string; command: string }[];
  const policy = shipPolicy(cwd, base);
  if (!commitRelease(cwd, releasePaths(policy, cwd, 'HEAD'), flag('--trailer'), r)) return r;
  for (const cmd of all('--build')) {
    const b = sh(cwd, cmd);
    r.add(`BUILD: ${b.status === 0 ? 'ok' : `FAIL exit=${b.status}`} ${cmd.slice(0, 120)}`);
    if (b.status !== 0) return r.stop(`Build failed or prerequisite missing: ${firstLine(b.stderr || b.stdout)}; repair it, then repeat stage 1`);
  }
  if (!all('--build').length) r.add('BUILD: none passed (record the inspected sources, or pass --build per declared command)');
  const release = releasePaths(policy, cwd, flag('--reviewed-tree')!);
  if (!route(cwd, flag('--reviewed-tree')!, release, has('--docs-rechecked'), r)) return r;
  const cmp = bin(cwd, 'gstack-docs-candidate', ['compare', flag('--docs-post')!], 120_000);
  let stale: string[] | null = null;
  try { stale = JSON.parse(cmp.stdout).content_changed; } catch { stale = null; }
  if (stale === null) return r.stop(`gstack-docs-candidate compare failed: ${firstLine(cmp.stderr)}; documentation freshness is unknown (stage 3)`);
  r.add(`DOCS: ${stale.length ? `stale (${short(stale)})` : 'fresh against the Step 14.5 post-audit snapshot'}`);
  if (stale.length) return r.stop('documentation inputs changed since the accepted audit: use stage 3 recovery (the remaining re-audit, or a named risk); never refresh hashes');
  if (!list.length && !has('--no-lanes-approved')) return r.stop('no test lanes: require Step 5\'s explicit untested-scope approval (rerun with --no-lanes-approved) or run Steps 5-15');
  const allow = evidenceExempt(release).join(',');
  const check = (l: { label: string; command: string }) => bin(cwd, 'gstack-evidence', ['check', '--label', l.label, '--expect-cmd', l.command, '--max-age', '24', '--allow-paths', allow], 60_000).stdout;
  for (const l of list) {
    let e = check(l);
    if (!/EVIDENCE: FRESH/.test(e)) {
      const ran = laneLine((await runLanes(cwd, [l]))[0]!);
      r.add(ran.line);
      if (!ran.ok) return r.stop(`lane ${l.label} failed or ran zero tests: STOP publication; run Steps 5-15 from Step 5's triage, then Step 16 stage 1`);
      e = check(l);
    }
    const line = /^EVIDENCE: .*$/m.exec(e)?.[0] ?? `EVIDENCE: unreadable label=${l.label}`;
    r.add(line.replace(/ log=\S+/, ''));
    if (!/EVIDENCE: FRESH/.test(line)) return r.stop(`lane ${l.label} is not FRESH after one rerun: Step 16 stage 4 recovery`);
  }
  const v = bin(cwd, 'gstack-pregate', ['verify'], 60_000);
  if (v.status === 0) r.add('PREGATE: verify ok on the stamped tree');
  else {
    const pg = bin(cwd, 'gstack-pregate', ['--allow-repo-commands', '--base', base], 3_600_000);
    const verdict = /^PREGATE: (.+?) tree=/m.exec(pg.stdout + pg.stderr)?.[1] ?? `unreadable (exit ${pg.status})`;
    r.add(`PREGATE: ${verdict} (rerun on the stamped tree)`);
    if (!/^(pass|warn|requires-remote cleared)/.test(verdict)) return r.stop(`pregate ${verdict} on the stamped tree: fix it${/uncleared/.test(verdict) ? ', or gstack-pregate clear with the remote run URL' : ''}, then rerun finish`);
  }
  return r.next('Step 16 stage 5: paste these results and the two-line honesty inventory, then run Step 17\'s guard block and gstack-ship-release push');
}

export function push(argv: readonly string[], cwd: string): Report {
  const { flag, has } = flagReader(argv);
  const r = new Report();
  const branch = git(cwd, ['branch', '--show-current']).stdout.trim();
  if (!branch) return r.stop('detached HEAD: push needs the feature branch');
  if (branch !== flag('--branch')) return r.stop(`HEAD is on ${branch}, not the branch Step 1 saved (${flag('--branch')}): check out the saved branch, then rerun push`);
  const guard = bin(cwd, 'gstack-config', ['get', 'redact_prepush_hook'], 30_000).stdout.trim() || 'false';
  const prompted = fs.existsSync(path.join(resolveStateRoot(process.env), '.redact-prepush-prompted'));
  r.add(`REDACT_PREPUSH: ${guard} prompted=${prompted ? 'yes' : 'no'}`);
  if (guard !== 'true' && !prompted) return r.stop('Step 17\'s one-time pre-push guard offer is unanswered: run the guard block and ask it, then rerun push');
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
  if (typeof lanes(rest) === 'string') return usage(lanes(rest) as string);
  if (cmd === 'finish' && (!flag('--reviewed-tree') || !flag('--docs-post'))) return usage('finish needs --reviewed-tree <the tree saved before Step 12> and --docs-post <Step 14.5\'s post-audit snapshot>');
  const r = cmd === 'version' ? version(rest, cwd) : cmd === 'finish' ? await finish(rest, cwd) : cmd === 'push' ? push(rest, cwd) : null;
  if (!r) return usage(`unknown command ${cmd}; run gstack-ship-release --help`);
  return { text: r.render(), exit: r.exit };
}
