import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractReleaseProjection, resolveReleasePolicy } from '../lib/release-policy';

const projection = { path: 'VERSION', format: 'plain_text', selector: 'whole_file' } as const;

function resolved(mode: 'per_pr' | 'required_on_release' | 'none') {
  return {
    mode: 'profile',
    profile_hash: 'a'.repeat(64),
    trusted_merge_base_sha: '1'.repeat(40),
    trusted_base: {
      target_ref: 'origin/main',
      target_sha: '2'.repeat(40),
      candidate_sha: '3'.repeat(40),
      merge_base_sha: '1'.repeat(40),
    },
    effective: {
      release: mode === 'none'
        ? { mode, title_policy: 'free' }
        : {
            mode,
            title_policy: 'version_prefix',
            version_source: projection,
            version_targets: [projection],
            changelog_path: 'CHANGELOG.md',
          },
    },
  } as any;
}

describe('trusted release policy seam', () => {
  test('short-circuits disabled and non-release decisions before version reads', () => {
    let reads = 0;
    const readVersion = () => { reads += 1; return '1.2.3'; };

    const disabled = resolveReleasePolicy({ resolvedProfile: resolved('none'), readVersion });
    const notRelease = resolveReleasePolicy({ resolvedProfile: resolved('required_on_release'), readVersion });

    expect(disabled).toMatchObject({ source: 'trusted_profile', release_mode: 'none', applicable: false, reason: 'disabled' });
    expect(notRelease).toMatchObject({ source: 'trusted_profile', release_mode: 'required_on_release', applicable: false, reason: 'not_release' });
    expect(reads).toBe(0);
  });

  test('reads trusted and live target versions separately when applicable', () => {
    const reads: string[] = [];
    const decision = resolveReleasePolicy({
      resolvedProfile: resolved('per_pr'),
      readVersion: (sha) => {
        reads.push(sha);
        return sha === '1'.repeat(40) ? '1.2.2' : '1.2.3';
      },
      readCurrentVersion: () => { reads.push('worktree'); return '1.2.3'; },
      currentVersion: '1.2.3',
      assertReleaseMode: 'per_pr',
    });

    expect(reads).toEqual(['1'.repeat(40), '2'.repeat(40), 'worktree']);
    expect(decision).toMatchObject({ applicable: true, reason: 'applicable', trusted_version: '1.2.2', target_version: '1.2.3', current_version: '1.2.3' });
  });

  test('treats current-version and release-mode as equality assertions', () => {
    expect(() => resolveReleasePolicy({
      resolvedProfile: resolved('per_pr'),
      currentVersion: '9.9.9',
      readVersion: (sha) => sha === '1'.repeat(40) ? '1.2.2' : '1.2.3',
      readCurrentVersion: () => '1.2.3',
    })).toThrow('release_current_version_mismatch');

    let reads = 0;
    expect(() => resolveReleasePolicy({
      resolvedProfile: resolved('per_pr'),
      assertReleaseMode: 'none',
      readVersion: () => { reads += 1; return '1.2.3'; },
    })).toThrow('release_mode_assertion_mismatch');
    expect(reads).toBe(0);
  });

  test('checks title-policy equality before reading any version projection', () => {
    let reads = 0;
    expect(() => resolveReleasePolicy({
      resolvedProfile: resolved('per_pr'),
      assertTitlePolicy: 'free',
      readVersion: () => { reads += 1; return '1.2.3'; },
      readCurrentVersion: () => { reads += 1; return '1.2.3'; },
    })).toThrow('release_title_policy_assertion_mismatch');
    expect(reads).toBe(0);
  });

  test('checks legacy title-policy equality without creating a second policy seam', () => {
    expect(resolveReleasePolicy({ resolvedProfile: { mode: 'legacy' } as any, assertTitlePolicy: 'version_prefix' })).toMatchObject({
      source: 'legacy_seam',
      titlePolicy: 'version_prefix',
    });
    expect(() => resolveReleasePolicy({
      resolvedProfile: { mode: 'legacy' } as any,
      assertTitlePolicy: 'conventional',
    })).toThrow('release_title_policy_assertion_mismatch');
  });

  test('activates required_on_release only with explicit release intent', () => {
    const decision = resolveReleasePolicy({
      resolvedProfile: resolved('required_on_release'),
      releaseRequested: true,
      readVersion: () => '1.2.3',
      readCurrentVersion: () => '1.2.3',
    });
    expect(decision).toMatchObject({ applicable: true, release_mode: 'required_on_release' });
  });

  test('accepts an npm_semver mirror of a four-component source', () => {
    const profile = resolved('per_pr');
    profile.effective.release.version_targets.push({ path: 'package.json', format: 'json', selector: '/version', value_encoding: 'npm_semver' });
    const decision = resolveReleasePolicy({
      resolvedProfile: profile,
      readVersion: (_sha, item) => item.path === 'package.json' ? '1.2.3' : '1.2.3.4',
      readCurrentVersion: (item) => item.path === 'package.json' ? '1.2.3' : '1.2.3.4',
    });
    expect(decision).toMatchObject({ current_version: '1.2.3.4', applicable: true });
  });

  test('reads only the root package entry for /packages//version', () => {
    const text = JSON.stringify({
      packages: {
        '': { version: '1.2.3' },
        'packages/a': { version: '9.9.9' },
      },
    });
    expect(extractReleaseProjection(text, {
      path: 'package-lock.json',
      format: 'json',
      selector: '/packages//version',
    })).toBe('1.2.3');
  });

  test('reads current subject from the exact worktree even with an injected git reader', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'release-current-'));
    writeFileSync(join(cwd, 'VERSION'), '1.2.4\n');
    try {
      const decision = resolveReleasePolicy({
        resolvedProfile: resolved('per_pr'),
        cwd,
        readVersion: (sha) => sha === '1'.repeat(40) ? '1.2.2' : '1.2.3',
        currentVersion: '1.2.4',
      });
      expect(decision).toMatchObject({ trusted_version: '1.2.2', target_version: '1.2.3', current_version: '1.2.4' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('rejects a worktree projection that escapes through a symlinked ancestor', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'release-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'release-outside-'));
    writeFileSync(join(outside, 'VERSION'), '1.2.3\n');
    symlinkSync(outside, join(cwd, 'linked'));
    const profile = resolved('per_pr');
    profile.effective.release.version_source = { path: 'linked/VERSION', format: 'plain_text', selector: 'whole_file' };
    profile.effective.release.version_targets = [profile.effective.release.version_source];
    try {
      expect(() => resolveReleasePolicy({ resolvedProfile: profile, cwd, readVersion: () => '1.2.3' })).toThrow('release_version_source_unreadable');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('parses the declared TOML project version and rejects malformed TOML', () => {
    const toml = { path: 'pyproject.toml', format: 'toml', selector: '/project/version' } as const;
    expect(extractReleaseProjection('[project]\nversion = "1.2.3"\n', toml)).toBe('1.2.3');
    expect(() => extractReleaseProjection('[project\nversion = "1.2.3"\n', toml)).toThrow('release_version_source_invalid');
  });

  test('binds release policy to the trusted profile hash rather than candidate-effective policy', () => {
    const profile = resolved('per_pr');
    (profile as any).trusted_release = { mode: 'none', title_policy: 'free' };
    let reads = 0;
    const decision = resolveReleasePolicy({
      resolvedProfile: profile,
      readVersion: () => { reads += 1; return '1.2.3'; },
      readCurrentVersion: () => { reads += 1; return '1.2.3'; },
    });
    expect(decision).toMatchObject({ release_mode: 'none', applicable: false, profile_hash: 'a'.repeat(64) });
    expect(reads).toBe(0);
  });
});
