export type AccountTool = 'git' | 'github' | 'gitlab';

// These are the caller's selected account/config roots, not repository or
// executable overrides. Their contents remain trusted user configuration.
const ACCOUNT_CONTEXT = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'AppData', 'LOCALAPPDATA',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
] as const;
const TOOL_CONTEXT: Record<AccountTool, readonly string[]> = {
  git: [
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
    'EMAIL', 'SSH_AUTH_SOCK', 'GNUPGHOME', 'GPG_TTY',
  ],
  github: ['GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'],
  gitlab: ['GLAB_CONFIG_DIR', 'GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'CI_JOB_TOKEN'],
};

/** Project account context explicitly; never inherit ambient process controls,
 * Git config injection, repo/host selectors, debug traces, or unrelated secrets.
 * Tool paths and provider hosts/repositories are supplied by the closed adapter.
 */
export function projectAccountEnvironment(
  tool: AccountTool,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' };
  for (const key of [...ACCOUNT_CONTEXT, ...TOOL_CONTEXT[tool]]) {
    if (source[key] !== undefined) environment[key] = source[key]!;
  }
  return environment;
}
