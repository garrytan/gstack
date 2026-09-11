import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkCandidatePreview, cleanupCandidatePreview, initCandidatePreview, inspectCandidatePreview, inspectCandidatePreviewLease, inspectCandidateSource, runCandidatePreview, validateCandidatePreview, writeCandidatePreview } from '../lib/candidate-preview';
import { parseWorkProfile } from '../lib/work-profile';

const roots: string[] = [];
const git = (cwd: string, args: string[]) => { const result = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); };
const profile = (name: string) => parseWorkProfile(readFileSync(join(import.meta.dir, 'fixtures/work-profile', name), 'utf8'));
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'candidate-preview-')); roots.push(root); const repo = join(root, 'repo'); const state = join(root, 'state'); mkdirSync(repo); mkdirSync(state, { mode: 0o700 });
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'T']); git(repo, ['config', 'user.email', 't@example.test']);
  for (const [file, body] of [['AGENTS.md', 'agents\n'], ['SYSTEM_PROMPT.md', 'prompt\n'], ['docs/agent-runtime-contract.md', 'contract\n'], ['README.md', 'readme\n'], ['SESSION.md', 'session\n'], ['scripts/check.sh', '#!/bin/sh\nexit 0\n']] as const) { mkdirSync(join(repo, file, '..'), { recursive: true }); writeFileSync(join(repo, file), body); }
  git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']); const head = git(repo, ['rev-parse', 'HEAD']); const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  const runtimeRoot = join(root, 'runtime'); mkdirSync(runtimeRoot); const purelib = join(runtimeRoot, 'purelib'); const platlib = join(runtimeRoot, 'platlib'); mkdirSync(purelib); mkdirSync(platlib); const interpreter = join(runtimeRoot, 'python');
  writeFileSync(interpreter, '#!/bin/sh\nif [ "$2" = "-c" ]; then echo 3.11.0; fi\nexit 0\n'); chmodSync(interpreter, 0o700); const real = realpathSync(interpreter); const info = lstatSync(real); const sha256 = new Bun.CryptoHasher('sha256').update(readFileSync(real)).digest('hex'); const manifest = join(runtimeRoot, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schema: 'ecpe.gstack-runtime.v1', execution_environment: { runtimes: { cdo_preview_python: { runtime_id: 'cdo_preview_python', realpath: real, owner_uid: info.uid, mode: info.mode & 0o777, sha256, version: '3.11.0', purelib, platlib, packages: {} } } } }));
  return { repo, state, head, tree, manifest };
}

describe('candidate preview', () => {
  test('never activates a relaxation and binds exact candidate bytes', () => {
    const result = validateCandidatePreview({ trusted: profile('shadow.yaml'), candidate: profile('candidate-relaxation.yaml'), candidateBytes: readFileSync(join(import.meta.dir, 'fixtures/work-profile/candidate-relaxation.yaml')), candidateBlobSha: 'a'.repeat(40) });
    expect(result.execution).toBe('legacy'); expect(result.candidate_state).toBe('ignored_untrusted'); expect(result.validation_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('owns init, stdin write, bounded validation, check-first recovery, and cleanup', () => {
    const value = fixture(); writeFileSync(join(value.repo, '.ignored-local'), 'secret\n'); const source = inspectCandidateSource({ sourceRepository: value.repo, repoId: 'cdo-os', blockId: 'block-1' });
    expect(source.files.map((item) => item.path)).toEqual(['AGENTS.md', 'SYSTEM_PROMPT.md', 'docs/agent-runtime-contract.md', 'README.md', 'SESSION.md']); expect(source.head_sha).toBe(value.head);
    const initialized = initCandidatePreview({ stateRoot: value.state, sourceRepository: value.repo, repoId: 'cdo-os', blockId: 'block-1', assertSubjectHead: source.head_sha, assertSubjectTree: source.tree });
    expect(initCandidatePreview({ stateRoot: value.state, sourceRepository: value.repo, repoId: 'cdo-os', blockId: 'block-1', assertSubjectHead: source.head_sha, assertSubjectTree: source.tree }).lease).toBe(initialized.lease);
    const bytes = readFileSync(join(import.meta.dir, 'fixtures/work-profile/shadow.yaml')); const written = writeCandidatePreview({ stateRoot: value.state, blockId: 'block-1', lease: initialized.lease, bytes }); expect(written.disposition).toBe('written');
    const terminal = runCandidatePreview({ stateRoot: value.state, sourceRepository: value.repo, blockId: 'block-1', lease: initialized.lease, comparisonRef: 'main', runtimeManifestPath: value.manifest, timelineSlug: 'cdo-os' });
    expect(terminal).toMatchObject({ disposition: 'live_pass', result: 'pass', spawned: true, child_exits: [0, 0], private_subject_cleanup_complete: true });
    expect(runCandidatePreview({ stateRoot: value.state, sourceRepository: value.repo, blockId: 'block-1', lease: initialized.lease, comparisonRef: 'main', runtimeManifestPath: value.manifest }).spawned).toBe(false);
    expect(checkCandidatePreview({ stateRoot: value.state, sourceRepository: value.repo, runId: terminal.run_id }).disposition).toBe('checked'); expect(inspectCandidatePreview({ stateRoot: value.state, blockId: 'block-1', sourceRepository: value.repo }).run_id).toBe(terminal.run_id); expect(inspectCandidatePreviewLease({ stateRoot: value.state, blockId: 'block-1' }).next_operation).toBe('candidate_preview_cleanup');
    expect(cleanupCandidatePreview({ stateRoot: value.state, blockId: 'block-1', lease: initialized.lease })).toMatchObject({ disposition: 'cleaned', cleaned: true }); expect(cleanupCandidatePreview({ stateRoot: value.state, blockId: 'block-1', lease: initialized.lease }).disposition).toBe('reused'); expect(readFileSync(join(value.repo, '.ignored-local'), 'utf8')).toBe('secret\n');
  });

  test('rejects source movement and conflicting candidate bytes', () => {
    const value = fixture(); expect(() => initCandidatePreview({ stateRoot: value.state, sourceRepository: value.repo, repoId: 'cdo-os', blockId: 'block-2', assertSubjectHead: '0'.repeat(40), assertSubjectTree: value.tree })).toThrow('subject_moved');
    const initialized = initCandidatePreview({ stateRoot: value.state, sourceRepository: value.repo, repoId: 'cdo-os', blockId: 'block-2', assertSubjectHead: value.head, assertSubjectTree: value.tree }); const bytes = readFileSync(join(import.meta.dir, 'fixtures/work-profile/shadow.yaml')); writeCandidatePreview({ stateRoot: value.state, blockId: 'block-2', lease: initialized.lease, bytes });
    expect(() => writeCandidatePreview({ stateRoot: value.state, blockId: 'block-2', lease: initialized.lease, bytes: readFileSync(join(import.meta.dir, 'fixtures/work-profile/candidate-relaxation.yaml')) })).toThrow('preview_slot_conflict'); writeFileSync(join(value.repo, 'later'), 'later\n'); git(value.repo, ['add', '.']); git(value.repo, ['commit', '-m', 'move']); expect(() => runCandidatePreview({ stateRoot: value.state, sourceRepository: value.repo, blockId: 'block-2', lease: initialized.lease, comparisonRef: 'main', runtimeManifestPath: value.manifest })).toThrow('subject_moved');
  });
  test('bounds a lost baseline result to one replay and never spawns a third attempt',()=>{const value=fixture();const initialized=initCandidatePreview({stateRoot:value.state,sourceRepository:value.repo,repoId:'cdo-os',blockId:'block-3',assertSubjectHead:value.head,assertSubjectTree:value.tree});writeCandidatePreview({stateRoot:value.state,blockId:'block-3',lease:initialized.lease,bytes:readFileSync(join(import.meta.dir,'fixtures/work-profile/shadow.yaml'))});expect(()=>runCandidatePreview({stateRoot:value.state,sourceRepository:value.repo,blockId:'block-3',lease:initialized.lease,comparisonRef:'main',runtimeManifestPath:value.manifest,eventObserver:()=>{throw new Error('simulated_parent_loss')}})).toThrow('simulated_parent_loss');expect(inspectCandidatePreviewLease({stateRoot:value.state,blockId:'block-3'})).toMatchObject({phase:'running',ambiguity_count:0,next_operation:'candidate_preview_run'});const replay=runCandidatePreview({stateRoot:value.state,sourceRepository:value.repo,blockId:'block-3',lease:initialized.lease,comparisonRef:'main',runtimeManifestPath:value.manifest});expect(replay).toMatchObject({result:'pass',spawned:true});expect(runCandidatePreview({stateRoot:value.state,sourceRepository:value.repo,blockId:'block-3',lease:initialized.lease,comparisonRef:'main',runtimeManifestPath:value.manifest})).toMatchObject({disposition:'receipt_current',spawned:false})});
  test('terminalizes a second ambiguous child boundary without a third spawn',()=>{const value=fixture();const initialized=initCandidatePreview({stateRoot:value.state,sourceRepository:value.repo,repoId:'cdo-os',blockId:'block-4',assertSubjectHead:value.head,assertSubjectTree:value.tree});writeCandidatePreview({stateRoot:value.state,blockId:'block-4',lease:initialized.lease,bytes:readFileSync(join(import.meta.dir,'fixtures/work-profile/shadow.yaml'))});const lose=()=>{throw new Error('lost')};expect(()=>runCandidatePreview({stateRoot:value.state,sourceRepository:value.repo,blockId:'block-4',lease:initialized.lease,comparisonRef:'main',runtimeManifestPath:value.manifest,eventObserver:lose})).toThrow('lost');expect(()=>runCandidatePreview({stateRoot:value.state,sourceRepository:value.repo,blockId:'block-4',lease:initialized.lease,comparisonRef:'main',runtimeManifestPath:value.manifest,eventObserver:lose})).toThrow('lost');expect(runCandidatePreview({stateRoot:value.state,sourceRepository:value.repo,blockId:'block-4',lease:initialized.lease,comparisonRef:'main',runtimeManifestPath:value.manifest})).toMatchObject({disposition:'terminalized',spawned:false,attempt_reason:'participant_unavailable',terminal_kind:null});expect(inspectCandidatePreviewLease({stateRoot:value.state,blockId:'block-4'}).next_operation).toBe('candidate_preview_cleanup')});
});
