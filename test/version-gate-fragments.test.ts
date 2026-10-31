/**
 * Version Gate under changelog_fragments (docs/ship-policy.md#changelog-fragments): an unstamped head
 * keeps its release-version fields at its merge base and carries a fragment (or a legacy [Unreleased]
 * entry, or is a bot PR); other manifest edits pass; a merge-step stamp commit must carry base plus the
 * effective bump of the fragments its pin folds.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASE_POLICY, cleanup, makeFixtureRepo, ROOT, type FixtureRepo } from './helpers/restamp-fixture';

const SCRIPT = path.join(ROOT, 'scripts', 'compare-pr-version.ts');
const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.91.336.0' };
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const fixture = () => { const r = makeFixtureRepo({ policy: POLICY, prefix: 'version-gate-frag-' }); repos.push(r); return r; };
const write = (r: FixtureRepo, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(r.work, rel)), { recursive: true }); fs.writeFileSync(path.join(r.work, rel), text); };
const commit = (r: FixtureRepo, msg: string) => { r.git('add', '-A'); r.git('commit', '-q', '-m', msg); return r.git('rev-parse', 'HEAD'); };
function run(r: FixtureRepo, head: string, extra: Record<string, string> = {}, claimed: unknown[] = []) {
  const next = path.join(r.root, 'next.json');
  fs.writeFileSync(next, JSON.stringify({ version: '1.2.4.0', base_version: '1.2.3.0', claimed }));
  const prVersion = r.git('show', head + ':VERSION').trim();
  const out = Bun.spawnSync([process.execPath, 'run', SCRIPT, next, '3600'], { cwd: r.work, env: { ...process.env, ...r.env, PR_VERSION: prVersion, BASE_REF: 'main', HEAD_SHA: head, PR_AUTHOR: 'garrytan', ...extra }, timeout: 30_000, stdout: 'pipe', stderr: 'pipe' });
  return { code: out.exitCode, out: out.stdout.toString() + out.stderr.toString() };
}

describe('version gate: changelog fragments', () => {
  test('a fragment head passes, a dependency or script edit beside it too', () => {
    const r = fixture();
    r.git('checkout', '-q', '-b', 'f');
    write(r, 'changelog.d/f.md', '- f\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(r.work, 'package.json'), 'utf8'));
    pkg.dependencies['right-pad'] = '2.0.0'; pkg.scripts.build = 'node build.js';
    write(r, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
    const res = run(r, commit(r, 'f'));
    expect(res.code).toBe(0);
    expect(res.out).toContain('its entry is 1 CHANGELOG fragment(s)');
  });

  test('a premature version change fails; no entry fails for a person and passes for a bot', () => {
    const r = fixture();
    r.git('checkout', '-q', '-b', 'g');
    write(r, 'changelog.d/g.md', '- g\n');
    write(r, 'VERSION', '1.2.9.0\n');
    const early = run(r, commit(r, 'g'));
    expect(early.code).toBe(1);
    expect(early.out).toContain('under changelog_fragments only the merge step stamps');
    r.git('checkout', '-q', '-B', 'self', 'origin/main');
    write(r, 'VERSION', '1.2.4.0\n'); write(r, 'self.txt', 'self\n');
    const self = run(r, commit(r, 'a lane stamps the expected version itself, with no fragment'));
    expect(self.code).toBe(1);
    expect(self.out).toContain('under changelog_fragments only the merge step stamps');
    r.git('checkout', '-q', '-B', 'h', 'origin/main');
    write(r, 'h.txt', 'h\n');
    const head = commit(r, 'h');
    const none = run(r, head);
    expect(none.code).toBe(1);
    expect(none.out).toContain('add a CHANGELOG fragment: changelog.d/<slug>.md');
    expect(run(r, head, { PR_AUTHOR: 'dependabot[bot]' }).code).toBe(0);
  });

  test('an unchanged branch on an advanced base passes; an invalid fragment fails', () => {
    const r = fixture();
    r.git('checkout', '-q', '-b', 'k');
    write(r, 'changelog.d/k.md', '- k\n');
    const head = commit(r, 'k');
    r.git('checkout', '-q', 'main');
    write(r, 'VERSION', '1.2.4.0\n'); write(r, 'other.txt', 'x\n');
    commit(r, 'main moves'); r.git('push', '-q', 'origin', 'main');
    expect(run(r, head).code).toBe(0);
    r.git('checkout', '-q', '-B', 'bad', 'origin/main');
    write(r, 'changelog.d/bad.md', '## [9.9.9.9]\n- bad\n');
    const bad = run(r, commit(r, 'bad'));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('changelog.d/bad.md: a fragment carries no release heading');
  });

  test('a merge-step stamp commit [pin, base] carries base plus its fragments\' effective bump', () => {
    const r = fixture();
    r.git('checkout', '-q', '-b', 'm');
    write(r, 'changelog.d/m.md', '---\nbump: minor\n---\n- m\n');
    const pin = commit(r, 'm');
    const stamp = (version: string) => {
      r.git('checkout', '-q', '-f', '--detach', pin);
      fs.rmSync(path.join(r.work, 'changelog.d', 'm.md'));
      write(r, 'VERSION', version + '\n');
      write(r, 'CHANGELOG.md', fs.readFileSync(path.join(r.work, 'CHANGELOG.md'), 'utf8').replace('# Changelog\n\n', '# Changelog\n\n## [' + version + '] - 2026-10-29\n\n- m\n\n'));
      r.git('add', '-A');
      return r.git('commit-tree', r.git('write-tree'), '-p', pin, '-p', r.git('rev-parse', 'origin/main'), '-m', 'v' + version + ' stamp');
    };
    expect(run(r, stamp('1.3.0.0')).code).toBe(0);
    const claimedToo = run(r, stamp('1.3.0.0'), {}, [{ pr: 77, branch: 'legacy', version: '1.3.0.0' }]);
    expect(claimedToo.code).toBe(0);
    expect(claimedToo.out).toContain('the land lock serializes allocation, so open claims do not apply');
    const wrong = run(r, stamp('1.2.4.0'));
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain('must carry v1.3.0.0');
  });

  test('a stacked child\'s stamp counts only its own fragment once its parent has landed', () => {
    const r = fixture();
    const release = (version: string, line: string) => write(r, 'CHANGELOG.md', fs.readFileSync(path.join(r.work, 'CHANGELOG.md'), 'utf8').replace('# Changelog\n\n', '# Changelog\n\n## [' + version + '] - 2026-10-29\n\n' + line + '\n\n'));
    r.git('checkout', '-q', '-b', 'p');
    write(r, 'changelog.d/p.md', '---\nbump: minor\n---\n- p\n');
    commit(r, 'p');
    r.git('checkout', '-q', '-b', 'c');
    write(r, 'changelog.d/c.md', '- c\n');
    const child = commit(r, 'c');
    r.git('checkout', '-q', '-B', 'main', 'origin/main');
    write(r, 'VERSION', '1.3.0.0\n');
    release('1.3.0.0', '- p');
    commit(r, 'v1.3.0.0 (#p)');
    r.git('push', '-q', 'origin', 'main');
    r.git('checkout', '-q', '-f', '--detach', child);
    fs.rmSync(path.join(r.work, 'changelog.d'), { recursive: true });
    r.git('checkout', 'origin/main', '--', 'CHANGELOG.md');
    write(r, 'VERSION', '1.3.1.0\n');
    release('1.3.1.0', '- c');
    r.git('add', '-A');
    const stamp = r.git('commit-tree', r.git('write-tree'), '-p', child, '-p', r.git('rev-parse', 'origin/main'), '-m', 'v1.3.1.0 stamp');
    const res = run(r, stamp);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain('carries v1.3.1.0');
  });

  test('the workflow runs on every PR (no path filter), so a PR without a release file still proves its fragment', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'version-gate.yml'), 'utf8')) as any;
    expect(workflow.on.pull_request.paths).toBeUndefined();
    expect(workflow.on.pull_request.branches).toEqual(['main']);
  });
});

// Generated by /ship Step 7 coverage audit (GSTA-154 PR A, pass 1).
describe('version gate: legacy entries under changelog fragments', () => {
  // Value: protects=a person's PR with a legacy [Unreleased] entry and no fragment still passes once fragments are on;
  // fails_when=the [Unreleased] fallback in classifyTrainHead is dropped, so in-flight PRs fail with "add a CHANGELOG fragment";
  // why_new=existing gate tests cover fragment, bot and no-entry heads only; seam=none; no_claim=GitHub workflow wiring (script run directly)
  test('an [Unreleased] entry without a fragment passes and names that entry', () => {
    const r = fixture();
    r.git('checkout', '-q', '-b', 'legacy');
    write(r, 'legacy.txt', 'l\n');
    write(r, 'CHANGELOG.md', fs.readFileSync(path.join(r.work, 'CHANGELOG.md'), 'utf8').replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n- legacy entry\n'));
    const res = run(r, commit(r, 'legacy'));
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain('the CHANGELOG change is confined to [Unreleased]');
  });
});
