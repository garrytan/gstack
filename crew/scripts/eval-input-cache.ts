/**
 * Conservative reuse of verified paid results. No provider calls or import-time I/O.
 *
 * The caller must audit the complete consumed input/dependency closure; touchfiles
 * alone are selection hints, not that proof. Hash the actual expanded prompts and
 * generated documents, fixtures, runner/rubric code, dependencies, resolved models,
 * runtime versions, parameters and relevant environment. Unknown inputs disable reuse.
 *
 * Receipts contain only hashes and public provenance, never prompts or credentials.
 * They are NOT signed evidence: the caller must restore through trusted same-repo,
 * same-PR cache transport (including its GitHub PR ref), never arbitrary artifacts
 * or cross-PR/base fallback keys. Scope checks below supplement that trust boundary.
 *
 * complete inputs -> key -> fresh successful execution -> same inputs -> receipt
 * receipt + identical key + trusted scope + age -> explicitly reported reused result
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBuiltin } from 'node:module';
import { createHash } from 'node:crypto';
import { atomicWriteSync } from '../../lib/fs-atomic';

/**
 * Follow literal module imports from `entries` (repo-relative) without
 * executing them, including installed package bytes and the package.json that
 * governs each resolved module; root bunfig/tsconfig/jsconfig are included
 * when present. The root package.json is left to the caller, which hashes its
 * semantic fields without the release version label.
 */
export function sourceDependencyClosure(root: string, entries: string[]): string[] {
  const seen = new Set<string>();
  const scan = new Bun.Transpiler({ loader: 'tsx' });
  const visit = (file: string) => {
    file = path.resolve(file);
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Dependency outside checkout');
    if (relative === 'package.json') return;
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = fs.readFileSync(file, 'utf8');
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    // Entrypoint scripts carry hashbangs, which scanImports does not accept.
    // Strip only for parsing; buildEvalInputIdentity still hashes the full file.
    for (const entry of scan.scanImports(source.replace(/^#![^\n]*(?:\n|$)/, '\n'))) {
      if (isBuiltin(entry.path) || entry.path.startsWith('bun:')) continue;
      const resolved = Bun.resolveSync(entry.path, path.dirname(file));
      visit(resolved);
      // Package export maps/defaults affect resolution independently of code.
      let directory = path.dirname(resolved);
      while (directory !== root && directory.startsWith(root + path.sep)) {
        const manifest = path.join(directory, 'package.json');
        if (fs.existsSync(manifest)) { visit(manifest); break; }
        directory = path.dirname(directory);
      }
    }
  };
  for (const file of entries) visit(path.join(root, file));
  for (const file of ['bunfig.toml', 'tsconfig.json', 'jsconfig.json'])
    if (fs.existsSync(path.join(root, file))) visit(path.join(root, file));
  return [...seen].sort();
}

export const EVAL_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EVAL_CACHE_RESULT_MAX_BYTES = 16 * 1024;
const SCHEMA = 1;
export type EvalCacheValue = null | boolean | number | string | EvalCacheValue[] | { [key: string]: EvalCacheValue };
type Json = EvalCacheValue;
export interface EvalCacheScope { repository: string; pullRequest: number }
export interface EvalInputIdentity {
  key: string;
  scope: EvalCacheScope;
  caseIds: string[];
}
export interface EvalInputManifest {
  root: string;
  scope: EvalCacheScope;
  /** These claims require an audited adapter, not automatic touchfile inference. */
  coverage: { dependencies: 'complete'; prompts: 'complete'; environment: 'complete' };
  unknownDependencies: string[];
  /** Complete declared and imported source/fixture/rubric/generated-file closure. */
  files: string[];
  /** Complete actual prompt bytes keyed by expected case identity. */
  prompts: Record<string, string>;
  /** Rubric, model/request parameters, selection, retry policy and work budgets. */
  parameters: Record<string, Json>;
  /** Resolved models, provider endpoint, OS/arch, Bun/Node/CLI and relevant env. */
  runtime: Record<string, Json>;
}
export type EvalInputIdentityResult =
  | { status: 'eligible'; identity: EvalInputIdentity }
  | { status: 'ineligible'; reason: string };
export interface EvalCachePolicy {
  purpose: 'gate' | 'periodic' | 'release' | 'marathon';
  fresh?: boolean;
  now?: number;
  maxAgeMs?: number;
}
export interface EvalPassingProof {
  execution: 'new';
  finalized: true;
  completeAttemptHistory: true;
  exitCode: 0;
  timedOut: false;
  cancelled: false;
  skipped: 0;
  failed: 0;
  passed: number;
  /** Include EVERY attempt. Retry passes cannot hide their previous failures. */
  cases: Array<{ id: string; outcome: 'passed'; attempt: 1 }>;
  source: { runId: string; revision: string; completedAt: number };
  /** Small public assertion input (e.g. JudgeScore); never prompts or API state. */
  result: EvalCacheValue;
}
interface Receipt {
  schema: 1;
  identity: EvalInputIdentity;
  proof: EvalPassingProof;
  resultSha256: string;
}
export type EvalCacheLookup =
  | { status: 'reused'; key: string; caseIds: string[]; source: EvalPassingProof['source']; result: EvalCacheValue }
  | { status: 'miss'; reason: string };

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sorted = (values: string[]) => [...values].sort();
const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0
  && value.every(id => typeof id === 'string' && id.trim().length > 0)
  && new Set(value).size === value.length;
const validScope = (value: unknown): value is EvalCacheScope => object(value)
  && typeof value.repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value.repository)
  && positive(value.pullRequest);

/** Reject non-JSON inputs instead of silently dropping undefined/functions/NaN. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('Input contains an unknown or non-JSON value');
}

export function buildEvalInputIdentity(input: EvalInputManifest): EvalInputIdentityResult {
  try {
    if (!validScope(input.scope)) throw new Error('A repository and positive PR number are required');
    if (!object(input.coverage) || (['dependencies', 'prompts', 'environment'] as const).some(key => input.coverage[key] !== 'complete')
      || !Array.isArray(input.unknownDependencies) || input.unknownDependencies.length !== 0) {
      throw new Error('Consumed input coverage is incomplete or unknown');
    }
    if (!object(input.prompts) || !validIds(Object.keys(input.prompts))
      || Object.values(input.prompts).some(prompt => typeof prompt !== 'string' || !prompt.trim())) {
      throw new Error('Every expected case needs its complete nonempty prompt');
    }
    if (!object(input.runtime) || !Object.keys(input.runtime).length
      || !object(input.parameters) || !Object.keys(input.parameters).length) {
      throw new Error('Explicit runtime and request parameters are required');
    }
    if (!validIds(input.files)) throw new Error('A unique nonempty file closure is required');
    const root = fs.realpathSync(input.root);
    const files = sorted(input.files).map(relative => {
      if (relative.includes('\\') || path.isAbsolute(relative) || relative !== path.posix.normalize(relative)
        || relative === '..' || relative.startsWith('../')) throw new Error('Input paths must be canonical repository-relative paths');
      const target = fs.realpathSync(path.join(root, relative));
      const inside = path.relative(root, target);
      if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('Input escapes repository');
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error('Input is not a regular file');
      return { path: relative, target: inside.split(path.sep).join('/'), sha256: hash(fs.readFileSync(target)), mode: stat.mode & 0o777 };
    });
    const caseIds = sorted(Object.keys(input.prompts));
    const key = hash(canonical({ schema: SCHEMA, scope: input.scope, files,
      prompts: caseIds.map(id => ({ id, sha256: hash(input.prompts[id]!) })),
      parameters: input.parameters, runtime: input.runtime }));
    return { status: 'eligible', identity: { key,
      scope: { repository: input.scope.repository, pullRequest: input.scope.pullRequest }, caseIds } };
  } catch (error) {
    return { status: 'ineligible', reason: error instanceof Error ? error.message : 'Cannot identify consumed inputs' };
  }
}

function validIdentity(value: unknown): value is EvalInputIdentity {
  return object(value) && typeof value.key === 'string' && /^[a-f0-9]{64}$/.test(value.key)
    && validScope(value.scope) && validIds(value.caseIds)
    && canonical(value.caseIds) === canonical(sorted(value.caseIds));
}
function bypass(policy: EvalCachePolicy): string | null {
  if (policy.purpose !== 'gate') return 'Periodic, marathon and release validation must execute fresh';
  if (policy.fresh) return 'Fresh validation requested';
  if (!positive(policy.now ?? Date.now()) || !positive(policy.maxAgeMs ?? EVAL_CACHE_MAX_AGE_MS)) return 'Invalid cache age policy';
  return null;
}
function validProof(proof: unknown, identity: EvalInputIdentity, now: number): proof is EvalPassingProof {
  if (!object(proof) || proof.execution !== 'new' || proof.finalized !== true || proof.completeAttemptHistory !== true
    || proof.exitCode !== 0 || proof.timedOut !== false || proof.cancelled !== false || proof.skipped !== 0 || proof.failed !== 0
    || proof.passed !== identity.caseIds.length || !Array.isArray(proof.cases) || proof.cases.length !== identity.caseIds.length) return false;
  const ids: string[] = [];
  for (const entry of proof.cases) {
    if (!object(entry) || typeof entry.id !== 'string' || entry.outcome !== 'passed' || entry.attempt !== 1) return false;
    ids.push(entry.id);
  }
  if (canonical(sorted(ids)) !== canonical(identity.caseIds)) return false;
  if (Buffer.byteLength(canonical(proof.result)) > EVAL_CACHE_RESULT_MAX_BYTES) return false;
  return object(proof.source) && typeof proof.source.runId === 'string' && /^[\w./-]{1,160}$/.test(proof.source.runId)
    && typeof proof.source.revision === 'string' && /^[a-f0-9]{40}$/.test(proof.source.revision)
    && positive(proof.source.completedAt) && proof.source.completedAt <= now;
}

export function lookupEvalInputCache(options: EvalCachePolicy & {
  cacheDir: string; identity: EvalInputIdentity;
  /** Validate result shape AND current assertions before granting cache credit. */
  validateResult: (value: EvalCacheValue) => boolean;
}): EvalCacheLookup {
  const disabled = bypass(options);
  if (disabled) return { status: 'miss', reason: disabled };
  try {
    if (!validIdentity(options.identity)) throw new Error('Invalid current input identity');
    const filename = path.join(options.cacheDir, `${options.identity.key}.json`);
    if (!fs.lstatSync(filename).isFile()) throw new Error('Receipt is not a regular file');
    // Read the same inode we inspect; do not follow a link swapped in after lstat.
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let receipt: unknown;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > EVAL_CACHE_RESULT_MAX_BYTES + 32 * 1024) throw new Error('Invalid receipt file');
      receipt = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
    const now = options.now ?? Date.now();
    if (!object(receipt) || receipt.schema !== SCHEMA || !validIdentity(receipt.identity)
      || canonical(receipt.identity) !== canonical(options.identity)
      || !validProof(receipt.proof, options.identity, now)) throw new Error('Invalid or incomplete passing receipt');
    if (receipt.resultSha256 !== hash(canonical(receipt.proof.result)) || options.validateResult(receipt.proof.result) !== true) {
      throw new Error('Cached result failed current validation');
    }
    if (now - receipt.proof.source.completedAt >= (options.maxAgeMs ?? EVAL_CACHE_MAX_AGE_MS)) throw new Error('Passing receipt expired');
    return { status: 'reused', key: options.identity.key, caseIds: [...options.identity.caseIds],
      source: { ...receipt.proof.source }, result: receipt.proof.result };
  } catch {
    return { status: 'miss', reason: 'No valid unexpired passing receipt for these inputs' };
  }
}

export function storeEvalInputCache(options: EvalCachePolicy & {
  cacheDir: string; before: EvalInputIdentity; after: EvalInputIdentity; proof: EvalPassingProof;
}): { status: 'stored'; key: string } | { status: 'not-stored'; reason: string } {
  const disabled = bypass(options);
  if (disabled) return { status: 'not-stored', reason: disabled };
  try {
    if (!validIdentity(options.before) || !validIdentity(options.after)
      || canonical(options.before) !== canonical(options.after)) throw new Error('Inputs changed during execution');
    const now = options.now ?? Date.now();
    if (!validProof(options.proof, options.before, now)) throw new Error('Execution did not produce complete fresh passing evidence');
    if (now - options.proof.source.completedAt >= (options.maxAgeMs ?? EVAL_CACHE_MAX_AGE_MS)) throw new Error('Execution evidence expired');
    fs.mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(options.cacheDir).isDirectory()) throw new Error('Cache directory is not a regular directory');
    // Whitelist proof fields: callers may pass richer collector objects containing
    // transcripts, prompts or operational paths which must not enter cache storage.
    const p = options.proof;
    const proof: EvalPassingProof = { execution: p.execution, finalized: p.finalized,
      completeAttemptHistory: p.completeAttemptHistory, exitCode: p.exitCode,
      timedOut: p.timedOut, cancelled: p.cancelled, skipped: p.skipped, failed: p.failed,
      passed: p.passed, cases: p.cases.map(c => ({ id: c.id, outcome: c.outcome, attempt: c.attempt })),
      source: { runId: p.source.runId, revision: p.source.revision, completedAt: p.source.completedAt }, result: p.result };
    const receipt: Receipt = { schema: SCHEMA, identity: options.before, proof, resultSha256: hash(canonical(proof.result)) };
    atomicWriteSync(path.join(options.cacheDir, `${options.before.key}.json`), JSON.stringify(receipt) + '\n', { mode: 0o600 });
    return { status: 'stored', key: options.before.key };
  } catch (error) {
    return { status: 'not-stored', reason: error instanceof Error ? error.message : 'Could not save passing evidence' };
  }
}
