import { isAbsolute, relative, resolve } from 'node:path';
import type { CommandSafetyProfile } from './factory-core';

export interface FactoryCommandGuardRequest {
  readonly command: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly profile: CommandSafetyProfile;
  readonly context?: {
    readonly workflowId?: string;
    readonly phaseId?: string;
    readonly runId?: string;
  };
}

export interface FactoryCommandGuardDecision {
  readonly allowed: boolean;
  readonly severity: 'allow' | 'warn' | 'block';
  readonly reason: string;
  readonly matchedRuleId?: string;
  readonly normalizedCommand: string;
}

interface RuleDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly ruleId: string;
}

const SAFE_GIT_READ_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse']);
const SECRET_PATH_RE = /(^|\/)(\.env(?:\.[^/]*|[*?\[]|$)|\.en[*?\[]|env-master|\.ssh|id_rsa|id_ed25519|known_hosts|credentials|secrets?)(\/|$|[*?\[])/i;
const SECRET_TOKEN_RE = /(api[_-]?key|access[_-]?token|auth[_-]?token|database[_-]?url|secret|password|private[_-]?key)/i;

export function evaluateFactoryCommandSafety(request: FactoryCommandGuardRequest): FactoryCommandGuardDecision {
  const normalizedCommand = normalizeCommand(request.command);
  if (!normalizedCommand) {
    return block('empty-command', 'Command is empty.', normalizedCommand);
  }

  if (request.profile === 'release-action') {
    return block('release-profile-unsupported', 'release-action commands are not supported by the G1 safe command guard.', normalizedCommand);
  }

  const opaque = rejectOpaqueShellSyntax(normalizedCommand);
  if (opaque) return toDecision(opaque, normalizedCommand);

  const tokens = splitShellWords(normalizedCommand);
  if (!tokens) {
    return block('parse-error', 'Command could not be parsed safely; failing closed.', normalizedCommand);
  }
  if (tokens.length === 0) {
    return block('empty-command', 'Command is empty.', normalizedCommand);
  }
  if (isPathLikeExecutable(tokens[0] ?? '')) {
    return block('untrusted-executable-path', 'Commands must use trusted executable names, not explicit executable paths.', normalizedCommand);
  }
  const attachedShortDecision = rejectAttachedShortOptionValues(tokens);
  if (attachedShortDecision) return toDecision(attachedShortDecision, normalizedCommand);

  const pathDecision = rejectUnsafePaths(tokens, request.cwd, request.workspaceRoot);
  if (pathDecision) return toDecision(pathDecision, normalizedCommand);

  const deny = firstDenyRule(tokens, request.profile);
  if (deny) return toDecision(deny, normalizedCommand);

  const allow = firstAllowRule(tokens, request.profile);
  if (allow) return toDecision(allow, normalizedCommand);

  return block(
    request.profile === 'read-only' ? 'read-only-default-deny' : 'non-destructive-default-deny',
    `Command is not in the ${request.profile} allowlist.`,
    normalizedCommand,
  );
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function toDecision(rule: RuleDecision, normalizedCommand: string): FactoryCommandGuardDecision {
  return {
    allowed: rule.allowed,
    severity: rule.allowed ? 'allow' : 'block',
    reason: rule.reason,
    matchedRuleId: rule.ruleId,
    normalizedCommand,
  };
}

function block(ruleId: string, reason: string, normalizedCommand: string): FactoryCommandGuardDecision {
  return { allowed: false, severity: 'block', reason, matchedRuleId: ruleId, normalizedCommand };
}

function rejectOpaqueShellSyntax(command: string): RuleDecision | null {
  if (hasUnquoted(command, '$(') || hasUnquoted(command, '`') || hasUnquoted(command, '<(') || hasUnquoted(command, '>(')) {
    return deny('shell-substitution', 'Command substitution/process substitution is not allowed in guarded factory commands.');
  }
  if (hasUnquotedBackslash(command)) {
    return deny('shell-escape', 'Backslash escapes and Windows-style paths are not allowed in guarded factory commands.');
  }
  if (hasUnquoted(command, '&&') || hasUnquoted(command, '||') || hasUnquoted(command, ';')) {
    return deny('shell-chaining', 'Chained shell commands must be split and evaluated independently.');
  }
  if (hasUnquoted(command, '|')) {
    return deny('shell-pipe', 'Piped shell commands are not allowed in guarded factory commands.');
  }
  if (hasUnquoted(command, '<') || hasUnquoted(command, '>')) {
    return deny('shell-redirection', 'Shell redirection is not allowed in guarded factory commands.');
  }
  return null;
}

function hasUnquoted(command: string, needle: string): boolean {
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (ch === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (ch === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (!quote && command.startsWith(needle, i)) return true;
  }
  return false;
}

function hasUnquotedBackslash(command: string): boolean {
  return command.includes('\\');
}

function splitShellWords(command: string): string[] | null {
  const out: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (ch === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (ch === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (/\s/.test(ch) && !quote) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaped || quote) return null;
  if (current) out.push(current);
  return out;
}

function rejectUnsafePaths(tokens: readonly string[], cwd: string, workspaceRoot: string): RuleDecision | null {
  const normalizedRoot = stripTrailingSlash(resolve(workspaceRoot));
  const normalizedCwd = resolve(cwd);
  for (const token of tokens.slice(1)) {
    const normalizedToken = token.replace(/\\/g, '/');
    const flagValue = flagPathCandidate(normalizedToken);
    const candidates = flagValue ? [normalizedToken, flagValue] : [normalizedToken];
    for (const candidate of candidates) {
      const decision = rejectUnsafePathCandidate(candidate, normalizedCwd, normalizedRoot);
      if (decision) return decision;
    }
    if (normalizedToken.startsWith('-')) continue;
  }
  return null;
}

function flagPathCandidate(token: string): string | null {
  if (!token.startsWith('-')) return null;
  if (token.includes('=')) return token.slice(token.indexOf('=') + 1);
  return null;
}

function rejectAttachedShortOptionValues(tokens: readonly string[]): RuleDecision | null {
  const command = basename(tokens[0] ?? '');
  for (const token of tokens.slice(1)) {
    const match = /^-([A-Za-z])(.+)$/.exec(token);
    if (!match) continue;
    const flag = match[1] ?? '';
    const value = match[2] ?? '';
    if (isSafeAttachedPatternFlag(command, flag)) continue;
    if (isKnownAttachedPathFlag(command, flag) || isSuspiciousAttachedValue(value)) {
      return deny('attached-short-option', 'Attached short-option values are ambiguous; use separated, explicit arguments.');
    }
  }
  return null;
}

function isSafeAttachedPatternFlag(command: string, flag: string): boolean {
  if ((command === 'grep' || command === 'rg') && flag === 'e') return true;
  if (command === 'git' && (flag === 'S' || flag === 'G')) return true;
  return false;
}

function isKnownAttachedPathFlag(command: string, flag: string): boolean {
  if (command === 'eslint' && (flag === 'o' || flag === 'c')) return true;
  if (command === 'tsc' && flag === 'p') return true;
  if ((command === 'grep' || command === 'rg') && flag === 'f') return true;
  return false;
}

function isSuspiciousAttachedValue(value: string): boolean {
  return value.startsWith('.')
    || value.startsWith('/')
    || value.startsWith('~/')
    || /^[A-Za-z]:\//.test(value)
    || value.includes('/')
    || SECRET_PATH_RE.test(value);
}

function rejectUnsafePathCandidate(candidate: string, normalizedCwd: string, normalizedRoot: string): RuleDecision | null {
  if (candidate.startsWith('-')) return null;
  if (candidate === '~' || candidate.startsWith('~/')) {
    return deny('home-path', 'Home-directory paths are not allowed in guarded factory commands.');
  }
  if (SECRET_PATH_RE.test(candidate)) {
    return deny('secret-path', 'Command references a protected secret or credential path.');
  }
  if (candidate.includes('../') || candidate === '..') {
    return deny('path-traversal', 'Relative path traversal outside the workspace is not allowed.');
  }
  if (isWindowsAbsolutePath(candidate)) {
    return deny('outside-workspace-path', 'Windows-style absolute paths are not allowed in guarded factory commands.');
  }
  if (!looksLikePath(candidate)) return null;
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(normalizedCwd, candidate);
  const rel = relative(normalizedRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${separator()}`) || isAbsolute(rel)) {
    return deny('outside-workspace-path', 'Paths outside the workspace are not allowed.');
  }
  return null;
}

function looksLikePath(token: string): boolean {
  return token.startsWith('/') || token.startsWith('./') || token.includes('/');
}

function isWindowsAbsolutePath(token: string): boolean {
  return /^[A-Za-z]:\//.test(token);
}

function separator(): string {
  return '/';
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

function firstDenyRule(tokens: readonly string[], profile: CommandSafetyProfile): RuleDecision | null {
  const command = basename(tokens[0] ?? '');
  const args = tokens.slice(1);

  if (isSecretDump(command, args)) {
    return deny('secret-dump', 'Command may dump environment variables, credentials, or secret-like values.');
  }
  if (command === 'rg' && args.some(arg => arg === '--pre' || arg.startsWith('--pre='))) {
    return deny('rg-preprocessor', 'ripgrep preprocessors can execute arbitrary commands and are not allowed.');
  }
  if (command === 'bun' && args[0] === 'test' && args.some(isMutatingBunTestFlag)) {
    return deny('bun-test-mutation', 'bun test snapshot/update flags can write files and are not allowed.');
  }
  if (command === 'tsc' && args.some(isTscOutputFlag)) {
    return deny('tsc-output', 'tsc output/profile/trace flags can write files and are not allowed.');
  }

  if (command === 'rm' && isDestructiveRm(args)) {
    return deny('rm-recursive-force', 'Recursive/force deletion is not allowed.');
  }
  if (command === 'find' && isDestructiveFind(args)) {
    return deny('find-destructive', 'find mutating/output actions are not allowed.');
  }

  if (command === 'git') {
    const gitDeny = gitDenyRule(args, profile);
    if (gitDeny) return gitDeny;
  }

  const publishDeploy = publishDeployDenyRule(command, args);
  if (publishDeploy) return publishDeploy;

  return null;
}

function firstAllowRule(tokens: readonly string[], profile: CommandSafetyProfile): RuleDecision | null {
  const command = basename(tokens[0] ?? '');
  const args = tokens.slice(1);

  if (command === 'git' && isAllowedGitRead(args)) {
    return allow('git-read', 'Safe git inspection command.');
  }
  if (profile === 'non-destructive-write' && command === 'git' && isAllowedGitAdd(args)) {
    return allow('git-add-local', 'Explicit local git add path is allowed for non-destructive write runs.');
  }

  if (isSafeReadCommand(command, args)) {
    return allow('read-command', 'Safe read-only inspection command.');
  }

  if (profile === 'non-destructive-write' && isSafeProjectCheck(command, args)) {
    return allow('project-check', 'Safe project test/lint/typecheck/format command.');
  }

  return null;
}

function basename(command: string): string {
  return command.split('/').at(-1) ?? command;
}

function isPathLikeExecutable(command: string): boolean {
  return command.startsWith('/') || command.startsWith('./') || command.startsWith('../') || command.includes('/');
}

function isSecretDump(command: string, args: readonly string[]): boolean {
  if (command === 'env' || command === 'printenv') return true;
  if (command === 'set' && args.length === 0) return true;
  if (command === 'export' && args.includes('-p')) return true;
  if ((command === 'cat' || command === 'less' || command === 'more') && args.some(arg => SECRET_PATH_RE.test(arg))) return true;
  if ((command === 'rg' || command === 'grep') && args.some(arg => SECRET_PATH_RE.test(arg) || SECRET_TOKEN_RE.test(arg))) return true;
  return false;
}

function isDestructiveRm(args: readonly string[]): boolean {
  const flags = args.filter(arg => arg.startsWith('-')).join('');
  const recursive = /r|recursive/.test(flags);
  const force = /f|force/.test(flags);
  const riskyTarget = args.some(arg => arg === '/' || arg === '.' || arg === '..' || arg === '.git' || arg === '.gstack' || arg === '.pi' || arg === '.agents');
  return (recursive && force) || riskyTarget;
}

function isDestructiveFind(args: readonly string[]): boolean {
  if (args.includes('-delete')) return true;
  if (args.some(arg => arg === '-exec' || arg === '-execdir')) return true;
  return args.some(arg => arg === '-fprint' || arg === '-fprintf' || arg === '-fls');
}

function gitDenyRule(args: readonly string[], profile: CommandSafetyProfile): RuleDecision | null {
  const subcommand = args[0] ?? '';
  if (subcommand === 'reset' && args.includes('--hard')) return deny('git-reset-hard', 'git reset --hard is not allowed.');
  if (subcommand === 'clean') return deny('git-clean', 'git clean is not allowed.');
  if (subcommand === 'push') return deny(profile === 'non-destructive-write' ? 'git-push-blocked' : 'git-push', 'git push is not allowed in guarded QA-fix/read-only runs.');
  if (subcommand === 'tag') return deny('git-tag-blocked', 'git tag operations are release actions and are not allowed.');
  if ((subcommand === 'diff' || subcommand === 'show') && args.some(isGitSecretPathArg)) return deny('git-secret-path', 'git read command references a protected secret path.');
  if ((subcommand === 'diff' || subcommand === 'show' || subcommand === 'log') && args.some(isUnsafeGitReadFlag)) return deny('git-read-unsafe-flag', 'git read command uses an output/helper flag that can write files or execute helpers.');
  if (subcommand === 'branch' && args.slice(1).length > 0 && !isAllowedGitBranchRead(args.slice(1))) {
    return deny('git-branch-mutation', 'Mutating git branch operations are not allowed.');
  }
  if (subcommand === 'add' && args.slice(1).some(arg => ['.', ':/', '-A', '--all', '-u', '--update'].includes(arg) || isBulkGitPathspec(arg))) {
    return deny('git-add-bulk', 'Bulk git add is not allowed; use exact workspace paths.');
  }
  if ((subcommand === 'checkout' || subcommand === 'restore') && args.some(arg => arg === '.' || arg === ':/' || arg === '--source=HEAD')) {
    return deny('git-worktree-overwrite', 'Bulk checkout/restore can overwrite local work and is not allowed.');
  }
  return null;
}

function publishDeployDenyRule(command: string, args: readonly string[]): RuleDecision | null {
  if ((command === 'npm' || command === 'pnpm' || command === 'bun') && args[0] === 'publish') return deny('package-publish', 'Package publish commands are not allowed.');
  if (command === 'yarn' && args.includes('publish')) return deny('package-publish', 'Package publish commands are not allowed.');
  if (command === 'cargo' && args[0] === 'publish') return deny('package-publish', 'Package publish commands are not allowed.');
  if (command === 'twine' && args[0] === 'upload') return deny('package-publish', 'Package publish commands are not allowed.');
  if (command === 'docker' && args[0] === 'push') return deny('docker-push', 'Docker push is not allowed.');
  if (command === 'kubectl' && ['apply', 'delete', 'rollout'].includes(args[0] ?? '')) return deny('cluster-deploy', 'Kubernetes mutation commands are not allowed.');
  if (command === 'terraform' && ['apply', 'destroy'].includes(args[0] ?? '')) return deny('infra-mutation', 'Terraform apply/destroy is not allowed.');
  if (command === 'pulumi' && ['up', 'destroy'].includes(args[0] ?? '')) return deny('infra-mutation', 'Pulumi up/destroy is not allowed.');
  if (command === 'vercel' && args[0] === 'deploy') return deny('deploy-command', 'Deploy commands are not allowed.');
  if (command === 'netlify' && args[0] === 'deploy') return deny('deploy-command', 'Deploy commands are not allowed.');
  if (command === 'fly' && args[0] === 'deploy') return deny('deploy-command', 'Deploy commands are not allowed.');
  if (command === 'wrangler' && args[0] === 'deploy') return deny('deploy-command', 'Deploy commands are not allowed.');
  if (command === 'gh' && args[0] === 'release') return deny('release-command', 'Release commands are not allowed.');
  return null;
}

function isAllowedGitRead(args: readonly string[]): boolean {
  const subcommand = args[0] ?? '';
  if (subcommand === 'branch') return isAllowedGitBranchRead(args.slice(1));
  return SAFE_GIT_READ_COMMANDS.has(subcommand);
}

function isAllowedGitBranchRead(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  return args.every(arg => ['--list', '-a', '-r', '--show-current'].includes(arg));
}

function isAllowedGitAdd(args: readonly string[]): boolean {
  if (args[0] !== 'add' || args.length < 2) return false;
  const pathspecs = args.slice(1);
  return pathspecs.every(arg => !arg.startsWith('-') && arg !== '.' && arg !== ':/' && arg !== '..' && !isBulkGitPathspec(arg));
}

function isBulkGitPathspec(arg: string): boolean {
  return arg.startsWith(':(') || /[*?\[\]{}]/.test(arg);
}

function isGitSecretPathArg(arg: string): boolean {
  const colonIndex = arg.indexOf(':');
  const possiblePath = colonIndex >= 0 ? arg.slice(colonIndex + 1) : arg;
  return SECRET_PATH_RE.test(possiblePath.replace(/\\/g, '/'));
}

function isUnsafeGitReadFlag(arg: string): boolean {
  return arg === '--output'
    || arg.startsWith('--output=')
    || arg === '--ext-diff'
    || arg === '--textconv'
    || arg === '--external-diff';
}

function isSafeReadCommand(command: string, args: readonly string[]): boolean {
  if (['pwd', 'ls', 'rg'].includes(command)) return true;
  return false;
}

function isSafeProjectCheck(command: string, args: readonly string[]): boolean {
  if (command === 'bun' && args[0] === 'test' && !args.some(isMutatingBunTestFlag)) return true;
  if (command === 'tsc' && args.includes('--noEmit') && !args.some(isTscOutputFlag)) return true;
  return false;
}

function isMutatingBunTestFlag(arg: string): boolean {
  return arg === '-u' || arg === '--update-snapshots' || arg === '--updateSnapshot' || arg === '--update-snapshot';
}

function isTscOutputFlag(arg: string): boolean {
  return arg === '-b'
    || arg === '--build'
    || arg === '--incremental'
    || arg === '--composite'
    || arg === '--generateTrace'
    || arg.startsWith('--generateTrace=')
    || arg === '--generateCpuProfile'
    || arg.startsWith('--generateCpuProfile=')
    || arg === '--outFile'
    || arg.startsWith('--outFile=')
    || arg === '--outDir'
    || arg.startsWith('--outDir=')
    || arg === '--declarationDir'
    || arg.startsWith('--declarationDir=')
    || arg === '--tsBuildInfoFile'
    || arg.startsWith('--tsBuildInfoFile=');
}

function allow(ruleId: string, reason: string): RuleDecision {
  return { allowed: true, ruleId, reason };
}

function deny(ruleId: string, reason: string): RuleDecision {
  return { allowed: false, ruleId, reason };
}
