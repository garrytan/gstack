import path from 'node:path';
import type { CommandSafetyProfile } from './factory-core';

export type FactoryFileWriteIntent = 'create' | 'overwrite' | 'edit-existing';

export interface FactoryFileWriteRequest {
  /** Host-resolved canonical absolute path. Raw user paths are out of scope. */
  readonly absolutePath: string;
  /** Host-resolved canonical absolute workspace root. */
  readonly workspaceRoot: string;
  readonly profile: CommandSafetyProfile;
  readonly intent: FactoryFileWriteIntent;
  readonly context?: {
    readonly runId?: string;
    readonly phaseId?: string;
    readonly workflowId?: string;
  };
  /** Host-observed existence, required so create/overwrite/edit intent cannot drift. */
  readonly targetExists?: boolean;
  /** Host verification result for Edit-style exact oldText matching. */
  readonly oldContentMatched?: boolean;
  /** Required for writes outside the source/test/docs allowlist. */
  readonly explicitReason?: string;
}

export interface FactoryFileWriteDecision {
  readonly allowed: boolean;
  readonly severity: 'allow' | 'warn' | 'block';
  readonly reason: string;
  readonly matchedRuleId?: string;
  readonly normalizedPath: string;
  readonly relativePath?: string;
}

interface RuleDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly ruleId: string;
}

const SECRET_PATH_RE = /(^|\/)(\.env(?:\.[^/]*|[*?\[]|$)|\.en[*?\[]|env-master|\.ssh|id_rsa|id_ed25519|known_hosts|credentials[^/]*|secrets?[^/]*)(\/|$|[*?\[])/i;
const PROTECTED_BASENAMES = new Set([
  'CLAUDE.md',
  'package-lock.json',
  'package.json',
  'bun.lock',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  '.npmrc',
]);
const PROTECTED_DIRS = new Set(['.git', '.pi', '.agents', '.claude']);
const GENERATED_DIRS = new Set(['dist', 'build', 'node_modules', '.next', '.turbo']);
const ALLOWED_TOP_LEVELS = new Set([
  'src',
  'lib',
  'test',
  'tests',
  'docs',
  'browse',
  'design',
  'make-pdf',
]);

export function evaluateFactoryFileWriteSafety(request: FactoryFileWriteRequest): FactoryFileWriteDecision {
  const normalizedPath = normalizeHostPath(request.absolutePath);
  const normalizedRoot = normalizeHostPath(request.workspaceRoot);

  if (request.profile !== 'non-destructive-write') {
    return block('write-profile-unsupported', 'File writes require the non-destructive-write profile.', normalizedPath);
  }

  if (!request.absolutePath || !path.isAbsolute(request.absolutePath)) {
    return block('non-absolute-path', 'File-write guard requires a canonical absolute path.', normalizedPath);
  }
  if (!request.workspaceRoot || !path.isAbsolute(request.workspaceRoot)) {
    return block('non-absolute-workspace-root', 'File-write guard requires a canonical absolute workspace root.', normalizedPath);
  }
  if (request.absolutePath.includes('\\') || request.workspaceRoot.includes('\\')) {
    return block('windows-or-backslash-path', 'Backslash and Windows-style paths are not allowed in guarded file writes.', normalizedPath);
  }
  if (hasParentTraversalSegment(request.absolutePath) || hasParentTraversalSegment(request.workspaceRoot)) {
    return block('path-traversal', 'Parent traversal is not allowed in guarded file-write paths.', normalizedPath);
  }

  const relativePath = path.relative(normalizedRoot, normalizedPath).replace(/\\/g, '/');
  if (relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    return block('outside-workspace-path', 'File write targets must stay inside the workspace root.', normalizedPath, relativePath);
  }
  if (!relativePath || relativePath === '.') {
    return block('workspace-root-write', 'Writing the workspace root itself is not allowed.', normalizedPath, relativePath);
  }

  const intentDecision = evaluateIntent(request);
  if (intentDecision) return toDecision(intentDecision, normalizedPath, relativePath);

  const segments = relativePath.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? '';

  if (SECRET_PATH_RE.test(relativePath) || SECRET_PATH_RE.test(basename)) {
    return block('secret-path', 'File write targets a protected secret or credential path.', normalizedPath, relativePath);
  }
  if (PROTECTED_BASENAMES.has(basename)) {
    return block('protected-file', `File write targets protected file ${basename}.`, normalizedPath, relativePath);
  }
  const protectedDir = segments.find(segment => PROTECTED_DIRS.has(segment));
  if (protectedDir) {
    return block('protected-directory', `File write targets protected directory ${protectedDir}/.`, normalizedPath, relativePath);
  }
  if (segments[0] === '.gstack') {
    const factoryDecision = evaluateGstackFactoryPath(segments, request.context?.runId);
    if (factoryDecision) return toDecision(factoryDecision, normalizedPath, relativePath);
  }
  if (isHiddenRootBootstrap(segments)) {
    return block('hidden-bootstrap-file', 'Root dotfiles are protected bootstrap files for guarded factory writes.', normalizedPath, relativePath);
  }
  const generatedDir = segments.find(segment => GENERATED_DIRS.has(segment));
  if (generatedDir) {
    return block('generated-output-directory', `File write targets generated output directory ${generatedDir}/.`, normalizedPath, relativePath);
  }

  if (isSourceTestDocsPath(segments)) {
    return allow('source-test-docs-allowlist', 'File write target is inside the guarded source/test/docs allowlist.', normalizedPath, relativePath);
  }

  if (!request.explicitReason || request.explicitReason.trim().length === 0) {
    return block('write-default-deny', 'File write target is outside the default allowlist and needs an explicit reason.', normalizedPath, relativePath);
  }

  return allow('explicit-reason-allowlist', 'File write target is outside the default allowlist but supplied an explicit reason.', normalizedPath, relativePath);
}

function evaluateIntent(request: FactoryFileWriteRequest): RuleDecision | null {
  switch (request.intent) {
    case 'create':
      if (request.targetExists === true) {
        return deny('create-target-exists', 'Create intent cannot overwrite an existing file.');
      }
      if (request.targetExists !== false) {
        return deny('create-target-existence-unknown', 'Create intent requires host-confirmed target absence.');
      }
      return null;
    case 'overwrite':
      if (request.targetExists !== true) {
        return deny('overwrite-target-missing', 'Overwrite intent requires an existing target file.');
      }
      return null;
    case 'edit-existing':
      if (request.targetExists !== true) {
        return deny('edit-target-missing', 'Edit intent requires an existing target file.');
      }
      if (request.oldContentMatched !== true) {
        return deny('edit-old-content-mismatch', 'Edit intent requires an exact old-content match verified by the host.');
      }
      return null;
    default:
      return deny('unknown-write-intent', 'Unknown file write intent; failing closed.');
  }
}

function evaluateGstackFactoryPath(segments: readonly string[], runId: string | undefined): RuleDecision | null {
  if (segments[1] !== 'factory') {
    return deny('protected-gstack-path', '.gstack writes are allowed only under .gstack/factory/<runId>/.');
  }
  if (!runId || segments[2] !== runId) {
    return deny('wrong-factory-run-output-path', '.gstack/factory writes must be scoped to the current run id.');
  }
  if (segments.length < 4) {
    return deny('factory-run-output-root', 'Writing the factory run output root itself is not allowed.');
  }
  return allowRule('factory-run-output', 'File write target is scoped to the current factory run output directory.');
}

function isHiddenRootBootstrap(segments: readonly string[]): boolean {
  return segments.length === 1 && (segments[0]?.startsWith('.') ?? false);
}

function isSourceTestDocsPath(segments: readonly string[]): boolean {
  const first = segments[0] ?? '';
  if (!ALLOWED_TOP_LEVELS.has(first)) return false;
  if (first === 'browse' || first === 'design' || first === 'make-pdf') {
    const second = segments[1] ?? '';
    return second === 'src' || second === 'test' || second === 'scripts';
  }
  return true;
}

function normalizeHostPath(input: string): string {
  if (!input) return '';
  return path.resolve(input);
}

function hasParentTraversalSegment(input: string): boolean {
  return input.split(/[\\/]+/).includes('..');
}

function toDecision(rule: RuleDecision, normalizedPath: string, relativePath?: string): FactoryFileWriteDecision {
  return {
    allowed: rule.allowed,
    severity: rule.allowed ? 'allow' : 'block',
    reason: rule.reason,
    matchedRuleId: rule.ruleId,
    normalizedPath,
    relativePath,
  };
}

function allow(ruleId: string, reason: string, normalizedPath: string, relativePath?: string): FactoryFileWriteDecision {
  return { allowed: true, severity: 'allow', reason, matchedRuleId: ruleId, normalizedPath, relativePath };
}

function block(ruleId: string, reason: string, normalizedPath: string, relativePath?: string): FactoryFileWriteDecision {
  return { allowed: false, severity: 'block', reason, matchedRuleId: ruleId, normalizedPath, relativePath };
}

function allowRule(ruleId: string, reason: string): RuleDecision {
  return { allowed: true, reason, ruleId };
}

function deny(ruleId: string, reason: string): RuleDecision {
  return { allowed: false, reason, ruleId };
}
