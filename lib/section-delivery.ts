import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendTimelineBatch, validateEcpeObservation } from './ecpe-metrics';

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * Authority-compiled skill/stage table. Callers select a stage, never a file,
 * section ID, hash, or body. Values are sorted/deduplicated before use so a
 * future multi-section stage keeps deterministic output.
 */
export const SECTION_BATCHES = Object.freeze({
  autoplan: { 'ceo-phase': ['ceo-phase'], 'design-phase': ['design-phase'], 'eng-phase': ['eng-phase'], 'dx-phase': ['dx-phase'], 'tasks-aggregator': ['tasks-aggregator'] },
  browse: { 'command-list': ['command-list'] },
  codex: { 'review-mode': ['review-mode'], 'challenge-mode': ['challenge-mode'], 'consult-mode': ['consult-mode'] },
  cso: { 'audit-phases': ['audit-phases'] },
  'design-consultation': { 'proposal-and-preview': ['proposal-and-preview'] },
  'design-html': { 'detector-install-offer': ['detector-install-offer'], doctrine: ['doctrine'], 'pretext-patterns': ['pretext-patterns'] },
  'design-shotgun': { doctrine: ['doctrine'] },
  'document-release': { 'release-body': ['release-body'] },
  'land-and-deploy': { 'first-run-validation': ['first-run-validation'], 'readiness-gate': ['readiness-gate'], 'merge-and-deploy': ['merge-and-deploy'] },
  'office-hours': { 'phase-2a-startup-diagnostic': ['phase-2a-startup-diagnostic'], 'phase-2b-builder-brainstorm': ['phase-2b-builder-brainstorm'], 'design-and-handoff': ['design-and-handoff'] },
  'plan-ceo-review': { 'review-sections': ['review-sections'] },
  'plan-design-review': { 'review-sections': ['review-sections'] },
  'plan-devex-review': { 'review-sections': ['review-sections'] },
  'plan-eng-review': { 'review-sections': ['review-sections'] },
  qa: { 'test-bootstrap': ['test-bootstrap'], 'qa-patterns': ['qa-patterns'] },
  retro: { 'report-format': ['report-format'] },
  review: { 'plan-completion': ['plan-completion'], 'review-army': ['review-army'], adversarial: ['adversarial'] },
  'setup-gbrain': { 'engine-remediation': ['engine-remediation'], 'brain-init': ['brain-init'], 'transcript-gate': ['transcript-gate'], 'claude-md-persist': ['claude-md-persist'] },
  ship: { 'apple-release': ['apple-release'], tests: ['tests'], 'test-coverage': ['test-coverage'], 'plan-completion': ['plan-completion'], 'review-army': ['review-army'], greptile: ['greptile'], adversarial: ['adversarial'], changelog: ['changelog'], 'pr-body': ['pr-body'] },
  spec: { 'gate-and-file': ['gate-and-file'] },
} as const);

export type SectionDeliveryArgs = { skill: string; stage: string; json: true };

export function parseSectionDeliveryArgs(args: string[]): SectionDeliveryArgs {
  if (args.shift() !== 'resolve') throw new Error('section_argument_invalid');
  let skill: string | null = null;
  let stage: string | null = null;
  let json = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--json' && !json) { json = true; continue; }
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error('section_argument_invalid');
    if (flag === '--skill' && skill === null) skill = value;
    else if (flag === '--stage' && stage === null) stage = value;
    else throw new Error('section_argument_invalid');
  }
  if (!skill || !stage || !json || !ID.test(skill) || !ID.test(stage)) throw new Error('section_argument_invalid');
  selectSectionBatch(skill, stage);
  return { skill, stage, json: true };
}

export function selectSectionBatch(skill: string, stage: string): string[] {
  if (!ID.test(skill) || !ID.test(stage)) throw new Error('section_stage_unknown');
  const stages = (SECTION_BATCHES as Record<string, Record<string, readonly string[]>>)[skill];
  const selected = stages?.[stage];
  if (!selected) throw new Error('section_stage_unknown');
  return [...new Set(selected)].sort();
}

type InstalledArtifact = { sha256?: unknown; size?: unknown; mode?: unknown };
type SectionLayout = 'runtime' | 'claude-source' | 'codex-source';
type Inflight = {
  run_id: string;
  slug: string;
  skill: string;
  repository_root: string;
  contract: { work_kind: string; finish_line: string };
  section_delivery_stages?: string[];
};

export type SectionDeliveryOutput = {
  schema: 'ecpe.section-delivery.v1';
  skill: string;
  stage: string;
  batch_id: string;
  sections: Array<{ id: string; sha256: string; bytes: number; content: string }>;
};

export type PreparedSectionBatch = {
  output: SectionDeliveryOutput;
  batchId: string;
  stateRoot: string;
  slug: string;
  runId: string;
  contract: { work_kind: string; finish_line: string };
  bundleHash: string;
  preparedAt: number;
};

function sha256(bytes: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function readInstalledArtifacts(runtimeRoot: string): { artifacts: Record<string, InstalledArtifact>; layout?: SectionLayout } {
  const manifestPath = path.join(runtimeRoot, '.ecpe-installed-runtime.json');
  const info = fs.lstatSync(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('installed_manifest_invalid');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { schema?: unknown; artifacts?: unknown; section_layout?: unknown };
  if (manifest.schema !== 'ecpe.gstack-runtime.v1' || !manifest.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts)) {
    throw new Error('installed_manifest_invalid');
  }
  if (manifest.section_layout !== undefined && !['runtime', 'claude-source', 'codex-source'].includes(manifest.section_layout as string)) {
    throw new Error('installed_manifest_invalid');
  }
  return { artifacts: manifest.artifacts as Record<string, InstalledArtifact>, layout: manifest.section_layout as SectionLayout | undefined };
}

function installedArtifact(artifacts: Record<string, InstalledArtifact>, skill: string, sectionId: string, observed: { sha256: string; size: number; mode: number }, boundPath?: string): InstalledArtifact {
  const generatedPath = `.agents/skills/gstack-${skill}/sections/${sectionId}.md`;
  const runtimePath = `sections/${skill}/${sectionId}.md`;
  const sourcePath = `${skill}/sections/${sectionId}.md`;
  const candidates = Object.entries(artifacts).filter(([candidate]) => (boundPath ? [boundPath] : [generatedPath, runtimePath, sourcePath]).includes(candidate));
  if (candidates.length === 0) throw new Error('installed_section_missing');
  const matches = candidates.filter(([, expected]) => expected.sha256 === observed.sha256
    && expected.size === observed.size && expected.mode === observed.mode);
  if (matches.length === 0) throw new Error('installed_section_mismatch');
  return matches[0][1];
}

function matchingInflight(stateRoot: string, repositoryRoot: string, skill: string, runId?: string): { path: string; value: Inflight } {
  const directory = path.join(stateRoot, 'ecpe', 'inflight');
  const realRepository = fs.realpathSync(repositoryRoot);
  const matches: Array<{ path: string; value: Inflight }> = [];
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    const candidate = path.join(directory, file);
    const info = fs.lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const value = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Inflight;
    if (value.skill === skill && value.repository_root === realRepository && (!runId || value.run_id === runId)) matches.push({ path: candidate, value });
  }
  if (matches.length !== 1) throw new Error('section_inflight_unavailable');
  return matches[0];
}

function writeJsonAtomic(target: string, value: unknown): void {
  const temporary = `${target}.section-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
}

function acquireStageLease(stateRoot: string, runId: string, skill: string, stage: string): void {
  const directory = path.join(stateRoot, 'ecpe', 'section-delivery', runId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lease = path.join(directory, `${skill}--${stage}.lock`);
  try { fs.mkdirSync(lease, { mode: 0o700 }); }
  catch { throw new Error('section_batch_already_delivered'); }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableFile(left: fs.Stats, right: fs.Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mode === right.mode
    && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sectionFile(runtimeRoot: string, skill: string, sectionId: string, layout?: SectionLayout): { bytes: Buffer; mode: number; relativePath: string } {
  const layouts: Record<SectionLayout, string> = {
    runtime: `sections/${skill}/${sectionId}.md`,
    'claude-source': `${skill}/sections/${sectionId}.md`,
    'codex-source': `.agents/skills/gstack-${skill}/sections/${sectionId}.md`,
  };
  // Explicit setup bindings never fall back to another host's valid bytes.
  const candidates = layout ? [layouts[layout]] : Object.values(layouts);
  for (const relativePath of candidates) {
    const candidate = path.join(runtimeRoot, relativePath);
    let leaf: fs.Stats;
    try { leaf = fs.lstatSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) throw new Error('installed_section_mismatch');

    let fd: number;
    try { fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
    catch { throw new Error('installed_section_mismatch'); }
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || !sameFile(leaf, before)) throw new Error('installed_section_mismatch');
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      let finalLeaf: fs.Stats;
      try { finalLeaf = fs.lstatSync(candidate); }
      catch { throw new Error('installed_section_mismatch'); }
      if (!after.isFile() || after.nlink !== 1 || bytes.length !== after.size
        || !stableFile(before, after) || finalLeaf.isSymbolicLink() || !stableFile(after, finalLeaf)) {
        throw new Error('installed_section_mismatch');
      }
      return { bytes, mode: after.mode & 0o777, relativePath };
    } finally { fs.closeSync(fd); }
  }
  throw new Error('installed_section_missing');
}

function decodeSection(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('installed_section_encoding_invalid'); }
}

export function prepareSectionBatch(options: {
  runtimeRoot: string;
  stateRoot: string;
  repositoryRoot: string;
  skill: string;
  stage: string;
  runId?: string;
}): PreparedSectionBatch {
  const sectionIds = selectSectionBatch(options.skill, options.stage);
  const { artifacts, layout } = readInstalledArtifacts(options.runtimeRoot);
  const sections = sectionIds.map((sectionId) => {
    const { bytes, mode, relativePath } = sectionFile(options.runtimeRoot, options.skill, sectionId, layout);
    const digest = sha256(bytes);
    installedArtifact(artifacts, options.skill, sectionId, { sha256: digest, size: bytes.length, mode }, layout ? relativePath : undefined);
    if (bytes.length === 0) throw new Error('installed_section_mismatch');
    const content = decodeSection(bytes);
    return { id: sectionId, sha256: digest, bytes: bytes.length, content };
  });
  const inflight = matchingInflight(options.stateRoot, options.repositoryRoot, options.skill, options.runId);
  const stageKey = `${options.skill}:${options.stage}`;
  const delivered = inflight.value.section_delivery_stages ?? [];
  if (delivered.includes(stageKey)) throw new Error('section_batch_already_delivered');
  acquireStageLease(options.stateRoot, inflight.value.run_id, options.skill, options.stage);
  inflight.value.section_delivery_stages = [...delivered, stageKey].sort();
  writeJsonAtomic(inflight.path, inflight.value);

  const bundleDigest = sha256(sections.map(section => `${section.id}\0${section.sha256}\0${section.bytes}`).join('\n'));
  const batchId = `batch-${sha256(`${inflight.value.run_id}\0${stageKey}\0${bundleDigest}`).slice(0, 24)}`;
  return {
    output: { schema: 'ecpe.section-delivery.v1', skill: options.skill, stage: options.stage, batch_id: batchId, sections },
    batchId,
    stateRoot: options.stateRoot,
    slug: inflight.value.slug,
    runId: inflight.value.run_id,
    contract: inflight.value.contract,
    bundleHash: `sha256:${bundleDigest}`,
    preparedAt: performance.now(),
  };
}

export function commitSectionBatch(prepared: PreparedSectionBatch, options: { fused?: boolean } = {}): void {
  const now = new Date().toISOString();
  const authority = options.fused ? null : validateEcpeObservation({
    schema_version: 1,
    run_id: prepared.runId,
    timestamp: now,
    wtree: prepared.slug,
    kind: 'authority_call',
    ...prepared.contract,
    authority_call: {
      command_id: 'section-delivery',
      duration_ms: performance.now() - prepared.preparedAt,
      anchor_duration_ms: 0,
      adapter_duration_ms: performance.now() - prepared.preparedAt,
      authority_processes: options.fused ? 0 : 1,
      bundle_hash_bytes: 0,
      full_tool_hash_bytes: 0,
      lease: 'created',
      fused_read_decision: true,
    },
  });
  const observations = [...(authority ? [authority] : []), ...prepared.output.sections.map((section, index) => validateEcpeObservation({
    schema_version: 1,
    run_id: prepared.runId,
    timestamp: now,
    wtree: prepared.slug,
    kind: 'section_load',
    ...prepared.contract,
    section_load: {
      section_id: section.id,
      bundle_hash: prepared.bundleHash,
      bytes: section.bytes,
      delivery_provenance: 'adapter_delivered',
      delivery_batch_id: index === prepared.output.sections.length - 1 ? prepared.batchId : null,
    },
  }))];
  appendTimelineBatch(prepared.stateRoot, prepared.slug, observations.map(observation => ({
    skill: prepared.output.skill,
    event: 'observation',
    run_id: prepared.runId,
    ts: now,
    ecpe: observation,
  })));
}
