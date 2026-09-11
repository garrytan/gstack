import { describe, expect, test } from 'bun:test';
import { buildGitPushPlan } from '../lib/git-push-boundary';

const OID = 'a'.repeat(40);
describe('exact Git push boundary', () => {
  test('binds source OID, destination, identity, and lease', () => {
    expect(buildGitPushPlan({ remoteUrl: 'https://github.com/Org/Repo.git', expectedRepositoryKey: 'github.com/org/repo', sourceOid: OID, destinationRef: 'refs/heads/feature/x', expectedRemoteOid: null }).argv).toEqual([
      'push', 'https://github.com/Org/Repo.git', `${OID}:refs/heads/feature/x`, '--force-with-lease=refs/heads/feature/x:',
    ]);
  });
  test('rejects symbolic sources and unsafe destinations', () => {
    expect(() => buildGitPushPlan({ remoteUrl: 'https://github.com/Org/Repo', expectedRepositoryKey: 'github.com/org/repo', sourceOid: 'HEAD', destinationRef: 'refs/heads/main', expectedRemoteOid: null })).toThrow('git_oid_invalid');
    expect(() => buildGitPushPlan({ remoteUrl: 'https://github.com/Org/Repo', expectedRepositoryKey: 'github.com/org/repo', sourceOid: OID, destinationRef: 'refs/heads/a..b', expectedRemoteOid: null })).toThrow('git_destination_ref_invalid');
  });
});
