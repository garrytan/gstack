import { describe, expect, test } from 'bun:test';
import { applyGitInsteadOf, resolveGitTransport, resolveStaticSshHostname, scrubGitEnvironment, validateStaticSshConfig } from '../lib/git-transport-policy';

describe('closed Git transport policy', () => {
  test('normalizes only identity-matched GitHub transports', () => {
    expect(resolveGitTransport('git@github.com:Org/Repo.git', 'github.com/org/repo').normalizedUrl).toBe('ssh://git@github.com/Org/Repo.git');
    expect(() => resolveGitTransport('file:///tmp/repo', 'github.com/org/repo')).toThrow('git_transport_unsupported');
    expect(() => resolveGitTransport('https://github.com/Other/Repo', 'github.com/org/repo')).toThrow('git_transport_identity_mismatch');
  });
  test('rejects executable SSH directives and scrubs process overrides', () => {
    expect(() => validateStaticSshConfig('Host github.com\n  ProxyCommand evil')).toThrow('git_ssh_config_unsupported');
    expect(scrubGitEnvironment({ PATH: '/safe', GIT_SSH_COMMAND: 'evil', GIT_EXTERNAL_DIFF: 'evil' })).toEqual({ PATH: '/safe' });
  });
  test('projects longest insteadOf and static SSH aliases without executing SSH', () => {
    expect(applyGitInsteadOf('work:Org/Repo.git', [
      { prefix: 'work:', replacement: 'https://example.invalid/' },
      { prefix: 'work:Org/', replacement: 'https://github.com/Org/' },
    ])).toBe('https://github.com/Org/Repo.git');
    expect(resolveStaticSshHostname('github-work', 'Host github-work\n HostName github.com\n User git')).toBe('github.com');
    expect(() => resolveStaticSshHostname('github-work', 'Host github-work\n ProxyCommand evil')).toThrow('git_ssh_config_unsupported');
  });
});
