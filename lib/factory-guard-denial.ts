import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FactoryCommandGuardDecision, FactoryCommandGuardRequest } from './factory-command-guard';
import type { CommandSafetyProfile } from './factory-core';
import type { FactoryFileWriteDecision, FactoryFileWriteRequest } from './factory-file-write-guard';

export type FactoryGuardDenialCategory =
  | 'command-policy'
  | 'path-policy'
  | 'workspace-boundary'
  | 'secret-protection'
  | 'unsafe-shell'
  | 'release-mutation'
  | 'opaque';

export interface FactoryGuardDenialBaseDto {
  readonly kind: 'command' | 'path';
  readonly allowed: boolean;
  readonly severity: 'allow' | 'warn' | 'block';
  readonly reason: string;
  readonly matchedRuleId?: string;
  readonly category: FactoryGuardDenialCategory;
  readonly profile?: CommandSafetyProfile;
  readonly correlationDigest: string;
}

export interface SanitizedFactoryCommandDenial extends FactoryGuardDenialBaseDto {
  readonly kind: 'command';
  readonly commandHead: string;
  readonly commandDigest: string;
}

export interface SanitizedFactoryPathDenial extends FactoryGuardDenialBaseDto {
  readonly kind: 'path';
  readonly intent?: FactoryFileWriteRequest['intent'];
  readonly pathBasename: string;
  readonly pathDigest: string;
}

export type FactoryGuardDenialPublicDto = SanitizedFactoryCommandDenial | SanitizedFactoryPathDenial;

export interface FactoryGuardDenialEventDto {
  readonly schemaVersion: 'factory.guard-denial.v1';
  readonly type: 'factory.guard.denial';
  readonly occurredAt: string;
  readonly runId: string;
  readonly phaseId?: string;
  readonly workflowId?: string;
  readonly denial: FactoryGuardDenialPublicDto;
}

export interface FactoryGuardDenialArtifactDto {
  readonly schemaVersion: 'factory.guard-denial.v1';
  readonly runId: string;
  readonly phaseId?: string;
  readonly workflowId?: string;
  readonly createdAt: string;
  readonly summary: {
    readonly total: number;
    readonly blocked: number;
    readonly categories: ReadonlyArray<{
      readonly category: FactoryGuardDenialCategory;
      readonly count: number;
    }>;
  };
  readonly denials: readonly FactoryGuardDenialPublicDto[];
}

const SECRET_PATH_RE = /(^|\/)(\.env(?:\.[^/]*|[*?\[]|$)|\.en[*?\[]|env-master|\.ssh|id_rsa|id_ed25519|known_hosts|credentials[^/]*|secrets?[^/]*)(\/|$|[*?\[])/i;
const SECRET_TOKEN_RE = /(api[_-]?key|access[_-]?token|auth[_-]?token|database[_-]?url|secret|password|private[_-]?key|credentials?|gh[_-]?token|anthropic[_-]?api[_-]?key)/i;
const INLINE_SECRET_VALUE_RE = /(?:^|\s)[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*=[^\s]+/i;
const INLINE_SECRET_PATH_RE = /(?:^|\s)(?:~\/|\/)[^\s]*(?:\.env|\.ssh|env-master|id_rsa|id_ed25519|credentials|secrets?)[^\s]*/i;
const SECRET_REASON_TOKEN_RE = /(^|\s)(\.env(?:\.[^\s/]+)?|\.ssh|env-master|id_rsa|id_ed25519|credentials[^\s/]*|secrets?[^\s/]*)(\s|$|\/)/i;

export function sanitizeFactoryCommandDenial(input: {
  readonly decision: FactoryCommandGuardDecision;
  readonly request?: FactoryCommandGuardRequest;
}): SanitizedFactoryCommandDenial {
  const normalizedCommand = normalizeCommand(input.decision.normalizedCommand ?? input.request?.command ?? '');
  const commandDigest = correlationDigest({
    kind: 'command',
    normalizedTarget: normalizedCommand,
    profile: input.request?.profile,
    workspaceRoot: input.request?.workspaceRoot,
    context: input.request?.context,
  });

  return {
    kind: 'command',
    allowed: input.decision.allowed,
    severity: input.decision.severity,
    reason: input.decision.allowed ? sanitizeReason(input.decision.reason) : 'Guard denied by policy.',
    matchedRuleId: input.decision.matchedRuleId,
    category: categoryFromCommandRule(input.decision.matchedRuleId),
    profile: input.request?.profile,
    commandHead: commandHeadFor(normalizedCommand),
    commandDigest,
    correlationDigest: commandDigest,
  };
}

export function sanitizeFactoryFileWriteDenial(input: {
  readonly decision: FactoryFileWriteDecision;
  readonly request?: FactoryFileWriteRequest;
}): SanitizedFactoryPathDenial {
  const normalizedPath = normalizePath(input.decision.normalizedPath ?? input.request?.absolutePath ?? '');
  const pathDigest = correlationDigest({
    kind: 'path',
    normalizedTarget: normalizedPath,
    profile: input.request?.profile,
    workspaceRoot: input.request?.workspaceRoot,
    context: input.request?.context,
  });

  return {
    kind: 'path',
    allowed: input.decision.allowed,
    severity: input.decision.severity,
    reason: sanitizeReason(input.decision.reason),
    matchedRuleId: input.decision.matchedRuleId,
    category: categoryFromPathRule(input.decision.matchedRuleId),
    profile: input.request?.profile,
    intent: input.request?.intent,
    pathBasename: pathBasenameFor(normalizedPath),
    pathDigest,
    correlationDigest: pathDigest,
  };
}

export function createFactoryGuardDenialEventDto(input: {
  readonly runId: string;
  readonly phaseId?: string;
  readonly workflowId?: string;
  readonly denial: FactoryGuardDenialPublicDto;
  readonly occurredAt?: string;
}): FactoryGuardDenialEventDto {
  assertNonEmptyString(input.runId, 'runId');
  return {
    schemaVersion: 'factory.guard-denial.v1',
    type: 'factory.guard.denial',
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    runId: input.runId,
    phaseId: input.phaseId,
    workflowId: input.workflowId,
    denial: input.denial,
  };
}

export function createFactoryGuardDenialArtifactDto(input: {
  readonly runId: string;
  readonly phaseId?: string;
  readonly workflowId?: string;
  readonly denials: readonly FactoryGuardDenialPublicDto[];
  readonly createdAt?: string;
}): FactoryGuardDenialArtifactDto {
  assertNonEmptyString(input.runId, 'runId');
  if (input.denials.length === 0) {
    throw new Error('Factory guard denial artifact requires at least one denial entry');
  }

  const categoryCounts = new Map<FactoryGuardDenialCategory, number>();
  for (const denial of input.denials) {
    categoryCounts.set(denial.category, (categoryCounts.get(denial.category) ?? 0) + 1);
  }

  return {
    schemaVersion: 'factory.guard-denial.v1',
    runId: input.runId,
    phaseId: input.phaseId,
    workflowId: input.workflowId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    summary: {
      total: input.denials.length,
      blocked: input.denials.filter(denial => denial.severity === 'block').length,
      categories: Array.from(categoryCounts.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    },
    denials: [...input.denials],
  };
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function normalizePath(target: string): string {
  if (!target) return '';
  return path.resolve(target).replace(/\\/g, '/');
}

function commandHeadFor(command: string): string {
  const token = command.split(/\s+/, 1)[0] ?? '';
  if (!token) return '';
  const basename = token.replace(/\\/g, '/').split('/').at(-1) ?? token;
  const stripped = basename.replace(/^['"]+|['"]+$/g, '');
  if (!stripped || stripped.includes('=') || SECRET_TOKEN_RE.test(stripped) || SECRET_PATH_RE.test(stripped)) {
    return '[redacted]';
  }
  return stripped.slice(0, 32);
}

function pathBasenameFor(target: string): string {
  if (!target) return '';
  const normalized = target.replace(/\\/g, '/');
  if (SECRET_PATH_RE.test(normalized) || SECRET_TOKEN_RE.test(normalized)) return '[redacted]';
  const basename = path.posix.basename(normalized);
  if (!basename || basename === '.' || basename === '..') return '[redacted]';
  if (SECRET_PATH_RE.test(basename) || SECRET_TOKEN_RE.test(basename)) return '[redacted]';
  return basename.slice(0, 64);
}

function categoryFromCommandRule(ruleId: string | undefined): FactoryGuardDenialCategory {
  if (!ruleId) return 'opaque';
  if (ruleId === 'secret-dump' || ruleId === 'secret-path' || ruleId === 'git-secret-path') return 'secret-protection';
  if (ruleId === 'outside-workspace-path' || ruleId === 'path-traversal' || ruleId === 'home-path' || ruleId === 'untrusted-executable-path') {
    return 'workspace-boundary';
  }
  if (ruleId.startsWith('shell-') || ruleId === 'parse-error' || ruleId === 'attached-short-option' || ruleId === 'rg-preprocessor') {
    return 'unsafe-shell';
  }
  if (ruleId.includes('publish') || ruleId.includes('deploy') || ruleId.includes('release') || ruleId.startsWith('git-push') || ruleId === 'git-tag-blocked' || ruleId === 'docker-push') {
    return 'release-mutation';
  }
  if (ruleId.endsWith('default-deny') || ruleId.startsWith('git-') || ruleId.startsWith('find-') || ruleId.startsWith('rm-') || ruleId.startsWith('bun-') || ruleId.startsWith('tsc-')) {
    return 'command-policy';
  }
  return 'opaque';
}

function categoryFromPathRule(ruleId: string | undefined): FactoryGuardDenialCategory {
  if (!ruleId) return 'opaque';
  if (ruleId === 'secret-path') return 'secret-protection';
  if (ruleId === 'outside-workspace-path' || ruleId === 'path-traversal' || ruleId === 'non-absolute-path' || ruleId === 'non-absolute-workspace-root' || ruleId === 'windows-or-backslash-path' || ruleId === 'workspace-root-write') {
    return 'workspace-boundary';
  }
  if (ruleId.startsWith('factory-run-output') || ruleId.startsWith('write-') || ruleId.startsWith('edit-') || ruleId.startsWith('overwrite-') || ruleId.startsWith('create-') || ruleId.startsWith('protected-') || ruleId === 'generated-output-directory' || ruleId === 'hidden-bootstrap-file' || ruleId === 'wrong-factory-run-output-path') {
    return 'path-policy';
  }
  return 'opaque';
}

function sanitizeReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Guard denied by policy.';
  if (SECRET_TOKEN_RE.test(normalized) || INLINE_SECRET_VALUE_RE.test(normalized) || INLINE_SECRET_PATH_RE.test(normalized) || SECRET_REASON_TOKEN_RE.test(normalized)) {
    return 'Guard denied by policy.';
  }
  return normalized.slice(0, 240);
}

function correlationDigest(input: {
  readonly kind: 'command' | 'path';
  readonly normalizedTarget: string;
  readonly profile?: CommandSafetyProfile;
  readonly workspaceRoot?: string;
  readonly context?: {
    readonly workflowId?: string;
    readonly phaseId?: string;
    readonly runId?: string;
  };
}): string {
  const hasScope = input.profile !== undefined
    || (input.workspaceRoot !== undefined && input.workspaceRoot.length > 0)
    || input.context?.workflowId !== undefined
    || input.context?.phaseId !== undefined
    || input.context?.runId !== undefined;
  const payload = hasScope
    ? stableJson({
      kind: input.kind,
      profile: input.profile,
      normalizedTarget: input.normalizedTarget,
      workspaceRoot: input.workspaceRoot ? normalizePath(input.workspaceRoot) : undefined,
      workflowId: input.context?.workflowId,
      phaseId: input.context?.phaseId,
      runId: input.context?.runId,
    })
    : input.normalizedTarget;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Factory guard denial ${field} must be a non-empty string`);
  }
}
