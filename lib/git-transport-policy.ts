import { canonicalProviderRemote, type ProviderRemote } from './provider-access';

export type GitTransportMode = 'github_https.v1' | 'github_ssh.v1';

export interface GitTransport {
  mode: GitTransportMode;
  remote: ProviderRemote;
  normalizedUrl: string;
  environment: Record<string, string>;
}

export interface GitInsteadOfRule {
  prefix: string;
  replacement: string;
}

const FORBIDDEN_SSH = /^(include|match|proxycommand|localcommand|knownhostscommand|pkcs11provider|securitykeyprovider|identityagent)\b/i;
const ALLOWED_SSH = /^(host|hostname|user|port|identityfile|identitiesonly|addkeystoagent|usekeychain)\b/i;

export function validateStaticSshConfig(source: string): string {
  const projected: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (FORBIDDEN_SSH.test(line) || !ALLOWED_SSH.test(line)) throw new Error('git_ssh_config_unsupported');
    if (/^(addkeystoagent|usekeychain)\b/i.test(line)) {
      projected.push(`${line.split(/\s+/, 1)[0]} no`);
    } else projected.push(line);
  }
  return projected.join('\n');
}

export function applyGitInsteadOf(raw: string, rules: GitInsteadOfRule[] = []): string {
  const matches = rules.filter((rule) => raw.startsWith(rule.prefix));
  matches.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
  return matches.length ? matches[0].replacement + raw.slice(matches[0].prefix.length) : raw;
}

export function resolveStaticSshHostname(alias: string, source: string): string | undefined {
  const projected = validateStaticSshConfig(source);
  let hosts: string[] = [];
  for (const line of projected.split('\n')) {
    const [key, ...rest] = line.trim().split(/\s+/);
    if (key.toLowerCase() === 'host') hosts = rest.filter((host) => !host.includes('*') && !host.includes('?'));
    if (key.toLowerCase() === 'hostname' && rest.length === 1 && hosts.includes(alias)) return rest[0];
  }
  return undefined;
}

export function scrubGitEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const forbidden = new Set([
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_EXTERNAL_DIFF',
  ]);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !forbidden.has(key))) as Record<string, string>;
}

export function resolveGitTransport(rawUrl: string, expectedComparisonKey: string): GitTransport {
  if (/^(file|git|ext)::?/i.test(rawUrl) || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(rawUrl)) throw new Error('git_transport_unsupported');
  const remote = canonicalProviderRemote(rawUrl);
  if (remote.host !== 'github.com' || remote.comparisonKey !== expectedComparisonKey.toLowerCase()) throw new Error('git_transport_identity_mismatch');
  const ssh = rawUrl.startsWith('git@') || rawUrl.startsWith('ssh://');
  return {
    mode: ssh ? 'github_ssh.v1' : 'github_https.v1', remote,
    normalizedUrl: ssh ? `ssh://git@github.com/${remote.owner}/${remote.repository}.git` : `https://github.com/${remote.owner}/${remote.repository}.git`,
    environment: scrubGitEnvironment(process.env),
  };
}
