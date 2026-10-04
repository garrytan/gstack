/**
 * Canonical remote + slug golden vectors (#3003).
 *
 * Every implementation of project identity must agree on these vectors:
 * lib/remote-identity.ts (bin-context, browse config, global-discover) and
 * bin/gstack-remote-identity.sh (gstack-slug, browse/bin/remote-slug). The
 * fixture pins literal digests, so a drift in either twin (or in the bash
 * sha256 tool selection) fails here rather than splitting a user's state.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalRemote, legacyRemoteSlug, remoteSlug } from '../lib/remote-identity';
import { normalizeRemoteUrl } from '../bin/gstack-global-discover';

const ROOT = path.resolve(import.meta.dir, '..');
const VECTORS: Array<{ url: string; canonical: string; slug: string; legacy_slug: string }> = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'remote-identity-vectors.json'), 'utf-8'),
);

function bashVectors(): Array<{ canonical: string; slug: string; legacy: string }> {
  const script = `set -euo pipefail
. "$1/bin/gstack-remote-identity.sh"
shift
for u in "$@"; do
  gstack_remote_slug "$u"
  printf '%s\\037%s\\037%s\\n' "$_gri_canon" "$_gri_slug" "$_gri_legacy_slug"
done`;
  const r = spawnSync('bash', ['-c', script, 'vectors', ROOT, ...VECTORS.map((v) => v.url)], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  expect(r.status).toBe(0);
  return r.stdout
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [canonical, slug, legacy] = l.split('\x1f');
      return { canonical, slug, legacy };
    });
}

describe('remote identity golden vectors', () => {
  test('fixture covers 2/3/4-segment, ssh/https/port/credential, Azure, Bitbucket, local forms', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(20);
    const nested = VECTORS.filter((v) => v.slug !== v.legacy_slug);
    expect(nested.length).toBeGreaterThan(5);
    for (const v of nested) expect(v.slug).toMatch(/-[0-9a-f]{16}$/);
  });

  test('TypeScript twin matches every vector', () => {
    for (const v of VECTORS) {
      expect({ url: v.url, canonical: canonicalRemote(v.url).canonical, slug: remoteSlug(v.url), legacy: legacyRemoteSlug(v.url) })
        .toEqual({ url: v.url, canonical: v.canonical, slug: v.slug, legacy: v.legacy_slug });
    }
  });

  // The bash twin runs on POSIX CI; windows-free-tests covers the TS twin.
  test.skipIf(process.platform === 'win32')('bash twin matches every vector byte-for-byte', () => {
    const got = bashVectors();
    expect(got.length).toBe(VECTORS.length);
    VECTORS.forEach((v, i) => {
      expect({ url: v.url, ...got[i] }).toEqual({ url: v.url, canonical: v.canonical, slug: v.slug, legacy: v.legacy_slug });
    });
  });

  test('ssh, https, ssh:// with port and credential-bearing https of one nested repo share one slug', () => {
    const forms = [
      'https://gitlab.com/customer-a/product/repo.git',
      'git@gitlab.com:customer-a/product/repo.git',
      'ssh://git@gitlab.com:2222/customer-a/product/repo.git',
      'https://oauth2:PASSWORD@GitLab.com:8443/customer-a/product/repo.git',
    ];
    const slugs = new Set(forms.map(remoteSlug));
    expect(slugs.size).toBe(1);
    expect(remoteSlug('https://gitlab.com/customer-b/product/repo.git')).not.toBe([...slugs][0]);
    for (const f of forms) expect(canonicalRemote(f).canonical).not.toContain('PASSWORD');
  });

  test('2-segment remotes keep the legacy slug, so no GitHub bucket moves', () => {
    for (const v of VECTORS.filter((x) => canonicalRemote(x.url).hosted && canonicalRemote(x.url).segments.length <= 2)) {
      expect(v.slug).toBe(v.legacy_slug);
    }
  });

  test('gstack-global-discover groups by the same canonical remote (ssh:// port no longer leaks into the path)', () => {
    for (const v of VECTORS.filter((x) => canonicalRemote(x.url).hosted)) {
      expect(normalizeRemoteUrl(v.url)).toBe(`https://${v.canonical}`);
    }
    expect(normalizeRemoteUrl('ssh://git@host.example:2222/team/repo.git')).toBe('https://host.example/team/repo');
  });
});

describe('every resolver files a nested-group repo under the same slug', () => {
  const NESTED = 'git@gitlab.com:customer-a/product/repo.git';
  const WANT = 'product-repo-5eca1fe041984543';
  let tmp: string;

  function nestedRepo(): string {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-parity-')));
    const repo = path.join(tmp, 'checkout');
    fs.mkdirSync(repo);
    for (const args of [['init', '-q', '-b', 'feat-x'], ['remote', 'add', 'origin', NESTED]]) {
      spawnSync('git', args, { cwd: repo, timeout: 30_000 });
    }
    return repo;
  }

  test('browse getRemoteSlug', () => {
    const repo = nestedRepo();
    try {
      const r = spawnSync(
        'bun',
        ['-e', `import { getRemoteSlug } from ${JSON.stringify(path.join(ROOT, 'browse', 'src', 'config.ts'))}; console.log(getRemoteSlug());`],
        { cwd: repo, encoding: 'utf-8', timeout: 30_000 },
      );
      expect(r.stdout.trim()).toBe(WANT);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('generated plan-file discovery (_PLAN_SLUG) searches the gstack-slug bucket', () => {
    const repo = nestedRepo();
    try {
      const md = fs.readFileSync(path.join(ROOT, 'review', 'sections', 'plan-completion.md'), 'utf-8');
      const block = md.slice(md.indexOf('### Plan File Discovery')).match(/```bash\n([\s\S]*?)```/)![1];
      const state = path.join(tmp, '.gstack');
      const planDir = path.join(state, 'projects', WANT);
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, 'plan.md'), '# plan for feat-x\n');
      const { GSTACK_PROJECT_SLUG: _drop, GSTACK_STATE_ROOT: _drop2, ...ambient } = process.env;
      const r = spawnSync('bash', ['-c', block.replaceAll('~/.claude/skills/gstack', ROOT)], {
        cwd: repo,
        env: { ...ambient, HOME: tmp, GSTACK_HOME: state },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      // F1 (#2768): search results are offered as candidates, never auto-bound.
      expect(r.stdout).toContain(`PLAN_CANDIDATE: ${path.join(planDir, 'plan.md')}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
