/**
 * gstack-ship-release (GSTA-167 PR 4): /ship Step 12 (version), Steps 15-16 (finish) and
 * Step 17 (push). These are the checks those steps used to spell out as shell blocks,
 * moved into the bin; each STOP is a place the prose leaves the decision to the agent.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BUMP_NEVER_KEY_VERSION } from '../lib/ship-policy';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(60_000);
const fixtures: ShipFx[] = [];
const fx = (...a: Parameters<typeof shipFixture>) => { const f = shipFixture(...a); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const read = (f: ShipFx, p: string) => fs.readFileSync(path.join(f.work, p), 'utf8');
const wtree = (f: ShipFx) => f.run(path.join(path.dirname(RELEASE), 'gstack-wtree'), []).stdout.trim();
const snapshot = (f: ShipFx, name = 'post') => {
  const out = path.join(f.root, `${name}.json`);
  expect(f.run(path.join(path.dirname(RELEASE), 'gstack-docs-candidate'), ['snapshot', '--out', out, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
  return out;
};

describe('version (Step 12)', () => {
  // Value: protects=FRESH never picks a level itself (unless the policy pins patch), and a chosen level writes VERSION, the manifest and the CHANGELOG heading through gstack-version-bump; fails_when=the bin guesses a level, or hand-writes versions;
  //   why_new=moved from Step 12 items 1-5; seam=gstack-version-bump, gstack-next-version; no_claim=the queue's live host read
  test('FRESH stops for BUMP_LEVEL; --bump micro writes VERSION, package.json and moves [Unreleased]', () => {
    const f = fx();
    const ask = f.run(RELEASE, ['version', '--base', 'main']);
    expect(ask.status).toBe(3);
    expect(ask.stdout).toMatch(/^STOP: BUMP_LEVEL needed \(FRESH, /m);
    expect(read(f, 'VERSION')).toBe('1.0.0.0\n');
    const w = f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro', '--why', 'one line']);
    expect(w.status).toBe(0);
    expect(lineOf(w.stdout, 'VERSION')).toMatch(/^VERSION: 1\.0\.0\.0 -> 1\.0\.0\.1 level=micro state=FRESH /);
    expect(read(f, 'VERSION')).toBe('1.0.0.1\n');
    expect(JSON.parse(read(f, 'package.json')).version).toBe('1.0.0');
    expect(read(f, 'CHANGELOG.md')).toContain('1.0.0.1');
    expect(w.stdout).toContain('NEXT: Step 13');
  });

  // Value: protects=ALREADY_BUMPED keeps its version without a write, DRIFT_UNEXPECTED stops, stamp-at-merge skips, and an explicit version must be above base; fails_when=a re-run double-bumps, a manual manifest edit is overwritten, or a stamp-at-merge repo gets a version;
  //   why_new=moved from Step 12's state dispatch; seam=gstack-version-bump classify, gstack-ship-policy; no_claim=the rebump question's answer
  test('ALREADY_BUMPED keeps, DRIFT_UNEXPECTED stops, stamp-at-merge skips, a version at or below base stops', () => {
    const bumped = fx({}, { VERSION: '1.0.1.0\n', 'package.json': '{"name":"fx","version":"1.0.1"}\n' });
    const kept = bumped.run(RELEASE, ['version', '--base', 'main']);
    expect(lineOf(kept.stdout, 'VERSION')).toMatch(/^VERSION: 1\.0\.0\.0 -> 1\.0\.1\.0 level=patch state=ALREADY_BUMPED .*\(kept, no write\)$/);
    expect(read(bumped, 'VERSION')).toBe('1.0.1.0\n');
    const drift = fx({}, { 'package.json': '{"name":"fx","version":"9.0.0"}\n' });
    const d = drift.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro']);
    expect(d.status).toBe(3);
    expect(d.stdout).toContain('STOP: package.json disagrees with VERSION');
    const stamp = fx({ '.gstack/ship-policy.json': '{"queue_mode":"stamp-at-merge"}\n' });
    const s = stamp.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro']);
    expect(s.status).toBe(0);
    expect(lineOf(s.stdout, 'VERSION')).toContain('skipped (policy: queue_mode stamp-at-merge');
    expect(read(stamp, 'VERSION')).toBe('1.0.0.0\n');
    const low = fx();
    expect(low.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro', '--version', '0.9.0.0']).stdout).toContain('STOP: 0.9.0.0 is not above the base version 1.0.0.0');
  });
});

describe('version (Step 12): keeping VERSION and waiting for the bump answer (GST-380)', () => {
  const UNATTENDED = { GSTACK_SESSION_KIND: 'unattended' };
  const untouched = (f: ShipFx) => {
    expect(read(f, 'VERSION')).toBe('1.0.0.0\n');
    expect(JSON.parse(read(f, 'package.json')).version).toBe('1.0.0');
    expect(read(f, 'CHANGELOG.md')).toContain('## [Unreleased]');
    expect(f.git('status', '--porcelain').stdout).toBe('');
  };

  // Value: protects=a repo whose unit PRs never change VERSION can pass Step 12 with --keep-current or --version <current> on a FRESH branch, and nothing is written or claimed; fails_when=FRESH demands a level before it reads those flags (gstack-evals#85: BUMP_LEVEL needed for all three flags);
  //   why_new=GST-380; seam=gstack-version-bump classify; no_claim=the queue's live host read
  test('FRESH under bump ask: --keep-current and --version <current> keep VERSION with no write', () => {
    for (const args of [['--keep-current'], ['--version', '1.0.0.0']]) {
      const f = fx();
      const r = f.run(RELEASE, ['version', '--base', 'main', ...args]);
      expect([r.status, lineOf(r.stdout, 'VERSION')]).toEqual([0, expect.stringMatching(/^VERSION: 1\.0\.0\.0 kept \(FRESH, /)]);
      expect(r.stdout).toContain('NEXT: Step 13');
      untouched(f);
    }
    const g = fx();
    const incomplete = g.run(RELEASE, ['version', '--base', 'main', '--accept-incomplete']);
    expect([incomplete.status, incomplete.stdout.includes('--keep-current')]).toEqual([3, true]);
    untouched(g);
  });

  // Value: protects=in a session no person answers (unattended, spawned, OpenClaw, headless) a bump under bump ask waits for the owner's words before anything is written; fails_when=the bin writes VERSION on a --bump the agent took as the recommended option (gstack-evals#89 wrote 0.0.2 before anyone was asked);
  //   why_new=GST-380; seam=gstack-session-kind's classification, gstack-version-bump write; no_claim=that the words came from the owner
  test('an unattended --bump under bump ask stops with BUMP_ANSWER_REQUIRED and writes nothing until --answer', () => {
    const sessions: Record<string, string>[] = [UNATTENDED, { GSTACK_SESSION_KIND: 'spawned' }, { OPENCLAW_SESSION: '1' }, { GSTACK_HEADLESS: '1' }];
    for (const env of sessions) {
      const f = fx();
      const r = f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro', '--why', 'small'], env);
      expect([r.status, /^STOP: BUMP_ANSWER_REQUIRED/m.test(r.stdout), r.stdout.includes('--keep-current')]).toEqual([3, true, true]);
      untouched(f);
    }
    const f = fx();
    expect(f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro', '--answer', '--why', 'x'], UNATTENDED).status).toBe(2);
    for (const bad of [' ', 'a\nb', 'x'.repeat(201)]) expect(f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro', '--answer', bad], UNATTENDED).status).toBe(2);
    untouched(f);
    const ok = f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro', '--answer', 'micro is fine'], UNATTENDED);
    expect([ok.status, read(f, 'VERSION')]).toEqual([0, '1.0.0.1\n']);
    const rebump = f.run(RELEASE, ['version', '--base', 'main', '--version', '2.0.0.0'], UNATTENDED);
    expect([rebump.status, rebump.stdout.includes('BUMP_ANSWER_REQUIRED'), rebump.stdout.includes('Ask: --version 2.0.0.0 (recommended), keep 1.0.0.1'), read(f, 'VERSION')]).toEqual([3, true, true, '1.0.0.1\n']);
    expect(f.run(RELEASE, ['version', '--base', 'main', '--version', '1.0.0.0'], UNATTENDED).stdout).toContain('STOP: 1.0.0.0 is not above the base version 1.0.0.0');
    const rewritten = f.run(RELEASE, ['version', '--base', 'main', '--version', '2.0.0.0', '--answer', 'go to 2.0.0.0'], UNATTENDED);
    expect([rewritten.status, read(f, 'VERSION')]).toEqual([0, '2.0.0.0\n']);
    const both = fx().run(RELEASE, ['version', '--base', 'main', '--bump', 'micro', '--version', '1.0.0.5'], UNATTENDED);
    expect([both.status, both.stdout.includes('Ask: --bump micro --version 1.0.0.5 (recommended)')]).toEqual([3, true]);
    const patch = fx({ '.gstack/ship-policy.json': '{"bump":"patch"}\n' });
    expect([patch.run(RELEASE, ['version', '--base', 'main'], UNATTENDED).status, read(patch, 'VERSION')]).toEqual([0, '1.0.1.0\n']);
  });

  // Value: protects=bump never keeps VERSION with no flag and no question, refuses a bump or a different --version, and stops on a branch that moved VERSION; fails_when=a never repo gets a write, a question, or a silently kept bump;
  //   why_new=GST-380 added bump never; seam=gstack-ship-policy show-effective, gstack-version-bump classify; no_claim=the release process's own bump
  test('bump never keeps VERSION with no flag, refuses a bump, and stops on a bumped branch', () => {
    const policy = { '.gstack/ship-policy.json': JSON.stringify({ bump: 'never', min_gstack_version: BUMP_NEVER_KEY_VERSION }) + '\n' };
    const f = fx(policy);
    const kept = f.run(RELEASE, ['version', '--base', 'main'], UNATTENDED);
    expect([kept.status, lineOf(kept.stdout, 'VERSION')]).toEqual([0, 'VERSION: 1.0.0.0 kept (policy: bump never; no write)']);
    for (const args of [['--bump', 'micro', '--answer', 'yes'], ['--version', '1.0.0.1']]) {
      const r = f.run(RELEASE, ['version', '--base', 'main', ...args]);
      expect([r.status, r.stdout.includes('STOP: policy bump never: unit PRs keep VERSION at 1.0.0.0')]).toEqual([3, true]);
    }
    untouched(f);
    const bumped = fx(policy, { VERSION: '1.0.0.1\n' });
    const moved = bumped.run(RELEASE, ['version', '--base', 'main']);
    expect([moved.status, moved.stdout.includes('STOP: VERSION moved from 1.0.0.0 to 1.0.0.1 but the policy says bump never')]).toEqual([3, true]);
    const stale = fx(policy, { VERSION: '1.0.0.1\n', 'package.json': '{"name":"fx","version":"0.9.0"}\n' });
    const drift = stale.run(RELEASE, ['version', '--base', 'main']);
    expect([drift.status, drift.stdout.includes('but the policy says bump never'), drift.stdout.includes('REPAIR:')]).toEqual([3, true, false]);
  });

  // Value: protects=a --bump beside --keep-current or --version <current> is a contradiction the bin names instead of picking one; fails_when=it silently keeps or silently bumps;
  //   why_new=GST-380 review F8 (flag precedence); seam=none; no_claim=-
  test('--bump or --version <other> with --keep-current or --version <current> stops and writes nothing', () => {
    const f = fx();
    for (const args of [['--keep-current'], ['--version', '1.0.0.0']]) {
      const r = f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro', ...args]);
      expect([r.status, r.stdout.includes('STOP: --bump micro moves VERSION and')]).toEqual([3, true]);
    }
    const keepAndMove = f.run(RELEASE, ['version', '--base', 'main', '--keep-current', '--version', '1.0.0.5']);
    expect([keepAndMove.status, keepAndMove.stdout.includes('STOP: --version 1.0.0.5 moves VERSION and --keep-current keeps it')]).toEqual([3, true]);
    untouched(f);
  });
});

describe('finish (Steps 15-16)', () => {
  // Value: protects=finish commits only release metadata with the trailer, then checks the reviewed-tree route, docs freshness, each lane receipt and the pregate; fails_when=it commits feature files, skips a stage, or pushes;
  //   why_new=moved from Steps 15-16; seam=gstack-wtree, gstack-docs-candidate compare, gstack-evidence, gstack-pregate; no_claim=the stage 5 report
  test('commits release metadata with the trailer and clears stages 2-4 and the pregate; feature files stop it', () => {
    const f = fx();
    const reviewed = wtree(f);
    expect(f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro']).status).toBe(0);
    const post = snapshot(f);
    f.write({ 'src/c.ts': 'export const c = 3;\n' });
    const feature = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
    expect(feature.status).toBe(3);
    expect(feature.stdout).toContain('STOP: uncommitted changes outside release metadata: src/c.ts');
    fs.rmSync(path.join(f.work, 'src/c.ts'));
    const ok = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE, '--trailer', 'Co-Authored-By: Fixture Bot <bot@example.com>']);
    expect(ok.stdout).toMatch(/^COMMIT: [0-9a-f]{12} chore: bump version and changelog \(v1\.0\.0\.1\)/m);
    expect(f.git('log', '-1', '--format=%B').stdout).toContain('Co-Authored-By: Fixture Bot <bot@example.com>');
    expect(lineOf(ok.stdout, 'ROUTE')).toMatch(/behavior=0 docs=0 metadata=\d+/);
    expect(lineOf(ok.stdout, 'DOCS')).toContain('fresh');
    expect(ok.stdout).toMatch(/^(LANE: tests pass|EVIDENCE: FRESH label=tests)/m);
    expect(lineOf(ok.stdout, 'PREGATE')).not.toBe('');
    expect(ok.stdout).toContain('NEXT: Step 16 stage 5');
    expect(ok.status).toBe(0);
    expect(f.git('ls-remote', '--heads', 'origin', 'feat').stdout).toBe('');
  });

  // Value: protects=under changelog_fragments the branch's own fragment is release metadata: version writes nothing and names it in NEXT, finish commits it as the release commit and the route counts it as metadata, and another fragment is still a feature file; fails_when=finish stops on changelog.d/<slug>.md or routes it to re-review (/ship #3648 fix-check 4, CRITICAL);
  //   why_new=releasePaths predates changelog_fragments (#3654); seam=gstack-ship-policy show-effective, gstack-wtree; no_claim=the merge step's fold
  test('under changelog_fragments the branch fragment is release metadata and Step 12 names it', () => {
    const f = fx({ '.gstack/ship-policy.json': '{"changelog_fragments":{"dir":"changelog.d"},"min_gstack_version":"1.91.336.0"}\n', 'changelog.d/README.md': 'Fragments.\n' });
    const reviewed = wtree(f);
    const v = f.run(RELEASE, ['version', '--base', 'main']);
    expect(v.status).toBe(0);
    expect(lineOf(v.stdout, 'VERSION')).toContain('skipped (policy: changelog_fragments');
    expect(v.stdout).toContain('NEXT: Step 13: write the entry as changelog.d/feat.md');
    expect(read(f, 'VERSION')).toBe('1.0.0.0\n');
    const post = snapshot(f);
    const args = ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE];
    f.write({ 'changelog.d/other.md': 'Not this branch.\n' });
    expect(f.run(RELEASE, args).stdout).toContain('STOP: uncommitted changes outside release metadata: changelog.d/other.md');
    fs.rmSync(path.join(f.work, 'changelog.d/other.md'));
    f.write({ 'changelog.d/feat.md': 'One entry.\n' });
    const ok = f.run(RELEASE, args);
    expect(ok.stdout).toMatch(/^COMMIT: [0-9a-f]{12} chore: changelog and TODOS \(changelog\.d\/feat\.md\)/m);
    expect(lineOf(ok.stdout, 'ROUTE')).toMatch(/behavior=0 docs=0 metadata=1/);
    expect(ok.status).toBe(0);
  });

  // Value: protects=a behavior change after review inserts the re-review route, an authored doc change needs --docs-rechecked, stale docs and failing or absent lanes stop; fails_when=any of these continues to push;
  //   why_new=moved from Step 16 stages 2-4; seam=same; no_claim=the repair itself
  test('behavior after review, unrechecked docs, stale docs, a failing lane and no lanes each stop', () => {
    const f = fx();
    const reviewed = wtree(f);
    const post = snapshot(f);
    f.write({ 'src/a.ts': 'export const a = 9;\n' }); f.commit('late fix');
    const behavior = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
    expect(behavior.stdout).toContain('STOP: behavior, tests or build inputs changed since review (src/a.ts): insert 5–11.5 → 12–14 → 16');
    const g = fx();
    const reviewed2 = wtree(g);
    g.write({ 'docs/guide.md': '# guide\n' }); g.commit('docs');
    const post2 = snapshot(g, 'post2');
    const docs = g.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed2, '--docs-post', post2, '--lane', LANE]);
    expect(docs.stdout).toContain('STOP: authored docs changed since review (docs/guide.md)');
    g.write({ 'README.md': '# changed after the audit\n' }); g.commit('readme');
    const stale = g.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed2, '--docs-post', post2, '--lane', LANE, '--docs-rechecked']);
    expect(lineOf(stale.stdout, 'DOCS')).toBe('DOCS: stale (README.md)');
    expect(stale.stdout).toContain('STOP: documentation inputs changed since the accepted audit');
    const h = fx();
    const reviewed3 = wtree(h);
    const post3 = snapshot(h, 'post3');
    const failing = h.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed3, '--docs-post', post3, '--lane', 'tests=exit 1']);
    expect(failing.status).toBe(3);
    expect(failing.stdout).toContain('STOP: lane tests failed or ran zero tests');
    expect(h.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed3, '--docs-post', post3]).stdout).toContain("STOP: no test lanes: require Step 5's explicit untested-scope approval");
    expect(h.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed3]).status).toBe(2);
  });

  // Value: protects=a dependency or script edit to package.json, and any lockfile edit, after review takes the re-review route; a version-only bump stays release metadata; fails_when=finish treats package.json or bun.lock as metadata whatever changed in them (/ship #3648 pass-1 security, CRITICAL);
  //   why_new=releasePaths exempted the manifests and lockfiles by name; seam=gstack-wtree, git; no_claim=the re-review itself
  test('a script or dependency edit to package.json, or a bun.lock edit, after review stops finish', () => {
    for (const [file, text] of [['package.json', '{"name":"fx","version":"1.0.0","scripts":{"test":"exit 0"}}\n'], ['bun.lock', '{"lockfileVersion":1}\n']]) {
      const f = fx();
      const reviewed = wtree(f);
      const post = snapshot(f);
      f.write({ [file]: text }); f.commit(`late ${file}`);
      const r = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
      expect([r.status, r.stdout.includes(`STOP: behavior, tests or build inputs changed since review (${file})`)]).toEqual([3, true]);
    }
    const g = fx();
    const reviewed = wtree(g);
    const built = g.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', snapshot(g), '--lane', LANE, '--build', `printf '{"name":"fx","version":"1.0.0","scripts":{"postinstall":"x"}}\\n' > package.json`]);
    expect([built.status, built.stdout.includes('STOP: behavior, tests or build inputs changed since review (package.json)')]).toEqual([3, true]);
  });
});

describe('push (Step 17)', () => {
  // Value: protects=push refuses a branch other than Step 1's saved one, waits for the one-time guard offer, refuses open gate findings on a ready PR without approval, then pushes once and reports ALREADY_PUSHED after; fails_when=it pushes past an unanswered offer or a ready PR with open gate findings, or pushes twice;
  //   why_new=moved from Step 17's idempotency block; seam=gstack-config, gh, git ls-remote, gstack-pregate sealed; no_claim=the guard block's hook install
  test('an unanswered guard offer stops; open gate findings on a ready PR stop; then it pushes once', () => {
    const f = fx();
    expect(f.run(RELEASE, ['push']).status).toBe(2);
    const moved = f.run(RELEASE, ['push', '--branch', 'other']);
    expect(moved.status).toBe(3);
    expect(moved.stdout).toContain('STOP: HEAD is on feat, not the branch Step 1 saved (other)');
    const unanswered = f.run(RELEASE, ['push', '--branch', 'feat']);
    expect(unanswered.status).toBe(3);
    expect(unanswered.stdout).toContain("STOP: Step 17's one-time pre-push guard offer is unanswered");
    fs.mkdirSync(f.state, { recursive: true });
    fs.writeFileSync(path.join(f.state, '.redact-prepush-prompted'), '');
    f.gh('echo 12');
    const gate = f.run(RELEASE, ['push', '--branch', 'feat', '--gate-open', '2']);
    expect(gate.status).toBe(3);
    expect(gate.stdout).toContain('STOP: 2 open gate finding(s) and ready PR #12');
    const pushed = f.run(RELEASE, ['push', '--branch', 'feat']);
    expect(pushed.status).toBe(0);
    expect(lineOf(pushed.stdout, 'PUSH')).toMatch(/^PUSH: pushed [0-9a-f]{12} to origin\/feat$/);
    expect(lineOf(f.run(RELEASE, ['push', '--branch', 'feat']).stdout, 'PUSH')).toMatch(/^PUSH: ALREADY_PUSHED /);
  });

  // Value: protects=an unattended push defers the one-time guard offer instead of stopping, and leaves the offer open for the next interactive session (no marker, no hook); fails_when=unattended push stops on the offer (replays 8G #34, 8G #36 and 9G each spent calls on it), writes .redact-prepush-prompted, or installs a hook;
  //   why_new=the offer stopped every unattended run; seam=gstack-config, git push; no_claim=the interactive guard block
  test('unattended, an unanswered guard offer is deferred: it pushes, writes no marker and installs no hook', () => {
    const f = fx();
    const r = f.run(RELEASE, ['push', '--branch', 'feat'], { GSTACK_SESSION_KIND: 'unattended' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lineOf(r.stdout, 'REDACT_PREPUSH')).toBe('REDACT_PREPUSH: false prompted=no deferred=unattended');
    expect(lineOf(r.stdout, 'PUSH')).toMatch(/^PUSH: pushed [0-9a-f]{12} to origin\/feat$/);
    expect(fs.existsSync(path.join(f.state, '.redact-prepush-prompted'))).toBe(false);
    expect(fs.existsSync(path.join(f.work, '.git', 'hooks', 'pre-push'))).toBe(false);
  });

  // Value: protects=a rejected push stops with the merge-and-reverify route and never force-pushes; fails_when=the bin retries with force or reports success;
  //   why_new=moved from Step 17's failure rules; seam=git push; no_claim=the merge
  test('a non-fast-forward push stops with the merge route', () => {
    const f = fx();
    fs.mkdirSync(f.state, { recursive: true });
    fs.writeFileSync(path.join(f.state, '.redact-prepush-prompted'), '');
    expect(f.run(RELEASE, ['push', '--branch', 'feat']).status).toBe(0);
    f.git('reset', '-q', '--hard', 'HEAD~1');
    f.write({ 'src/z.ts': 'export const z = 1;\n' }); f.commit('diverge');
    const r = f.run(RELEASE, ['push', '--branch', 'feat']);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('STOP: non-fast-forward');
    expect(r.stdout).toContain('never force-push');
  });
});

describe('gstack-ship-release push: branch names', () => {
  // Value: protects=push's open-PR lookup passes the branch to gh as one argv item; fails_when=a branch named with $(...) runs a command before the push guards;
  //   why_new=GSTA-167 /ship review of #3633 (security, CRITICAL); seam=gh; no_claim=gh's own handling of the name
  test('a branch name with shell syntax is never executed by the gate lookup', () => {
    const f = fx();
    const name = 'x$(touch${IFS}PWNED)';
    expect(f.git('checkout', '-qb', name).status).toBe(0);
    fs.mkdirSync(f.state, { recursive: true });
    fs.writeFileSync(path.join(f.state, '.redact-prepush-prompted'), '');
    f.gh('echo 12');
    f.run(RELEASE, ['push', '--branch', name, '--gate-open', '1']);
    expect(fs.existsSync(path.join(f.work, 'PWNED'))).toBe(false);
  });
});

describe('GSTA-167 part 4a: the post-review route stays path-only', () => {
  // Value: protects=F1/F2, a data file edited after review sends the ship back through review even when no code names it,
  //   because the route never applies the data rule; fails_when=a JSON edit after review takes the docs-rechecked route; seam=classifyPath
  test('a JSON edited after review is a behavior change, not docs', () => {
    const f = fx();
    const reviewed = wtree(f);
    const post = snapshot(f);
    f.write({ 'wiki/post/data.json': '{"a": 1}\n' }); f.commit('late data');
    const r = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
    expect(r.stdout).toContain('STOP: behavior, tests or build inputs changed since review (wiki/post/data.json)');
  });
});
