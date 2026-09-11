import { describe, expect, test } from 'bun:test';
import { resolveReleasePolicy } from '../lib/release-policy';

describe('legacy release-policy seam', () => {
  test('is adapter-owned and caller-independent', () => {
    expect(resolveReleasePolicy()).toEqual({ schema: 'ecpe.release-policy.v1', source: 'legacy_seam', bumpMode: 'per_pr', titlePolicy: 'version_prefix' });
    expect(resolveReleasePolicy()).toEqual(resolveReleasePolicy());
  });
});
