import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_MAX_BUNDLE_BYTES = 200 * 1024;
const SAFE_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export interface BundleManifestEntry {
  name: string;
  source: 'diff' | 'repository' | 'context' | 'artifact' | 'missing';
  path?: string;
  truncated?: boolean;
  note?: string;
}

export interface LensEvidenceBundle {
  schema_version: 1;
  run_id: string;
  lens: string;
  created_at: string;
  manifest: BundleManifestEntry[];
  context: Record<string, unknown>;
  required_missing: string[];
  evidence: Array<{
    name: string;
    source: BundleManifestEntry['source'];
    content: string;
    path?: string;
  }>;
  omissions?: string[];
}

export interface BundleOptions {
  gstackHome?: string;
  maxBytes?: number;
  now?: Date;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_RE.test(value)) throw new Error(`${label} must match ${SAFE_ID_RE}`);
}

export function lensBundleRoot(options: BundleOptions = {}): string {
  const home = options.gstackHome ?? process.env.GSTACK_HOME ?? path.join(os.homedir(), '.gstack');
  return path.join(home, 'lens-bundles');
}

export function lensBundlePath(runId: string, lens: string, options: BundleOptions = {}): string {
  assertSafeId(runId, 'run_id');
  assertSafeId(lens, 'lens');
  return path.join(lensBundleRoot(options), runId, lens, 'bundle.json');
}

function ensureSecureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function validateBundle(bundle: LensEvidenceBundle): void {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('Bundle must be a JSON object');
  if (bundle.schema_version !== 1) throw new Error('Bundle schema_version must be 1');
  assertSafeId(bundle.run_id, 'run_id');
  assertSafeId(bundle.lens, 'lens');
  if (!Array.isArray(bundle.manifest)) throw new Error('Bundle manifest must be an array');
  if (!bundle.context || typeof bundle.context !== 'object' || Array.isArray(bundle.context)) throw new Error('Bundle context must be an object');
  if (!Array.isArray(bundle.required_missing) || bundle.required_missing.some((item) => typeof item !== 'string')) {
    throw new Error('Bundle required_missing must be an array of strings');
  }
  if (!Array.isArray(bundle.evidence)) throw new Error('Bundle evidence must be an array');
  for (const item of bundle.evidence) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.content !== 'string') {
      throw new Error('Each bundle evidence entry requires name and content strings');
    }
  }
}

export function createBundle(input: Omit<LensEvidenceBundle, 'schema_version' | 'created_at'> & Partial<Pick<LensEvidenceBundle, 'schema_version' | 'created_at'>>, options: BundleOptions = {}): LensEvidenceBundle {
  const bundle: LensEvidenceBundle = {
    ...input,
    schema_version: 1,
    created_at: input.created_at ?? (options.now ?? new Date()).toISOString(),
  } as LensEvidenceBundle;
  validateBundle(bundle);
  return bundle;
}

export function writeLensBundle(bundle: LensEvidenceBundle, options: BundleOptions = {}): { path: string; bytes: number } {
  validateBundle(bundle);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  if (bytes > maxBytes) throw new Error(`Evidence bundle is ${bytes} bytes, exceeding the ${maxBytes}-byte limit`);
  const filePath = lensBundlePath(bundle.run_id, bundle.lens, options);
  ensureSecureDirectory(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, filePath);
  fs.chmodSync(filePath, 0o600);
  return { path: filePath, bytes };
}

export function readLensBundle(runId: string, lens: string, options: BundleOptions = {}): LensEvidenceBundle {
  const filePath = lensBundlePath(runId, lens, options);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LensEvidenceBundle;
  validateBundle(parsed);
  if (parsed.run_id !== runId || parsed.lens !== lens) throw new Error('Bundle identity does not match requested run and lens');
  return parsed;
}

export function purgeLensBundleRun(runId: string, options: BundleOptions = {}): string {
  assertSafeId(runId, 'run_id');
  const root = lensBundleRoot(options);
  const target = path.join(root, runId);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing unsafe bundle purge path');
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}
