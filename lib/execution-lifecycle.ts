import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildBill } from './context-bill';
import { resolveRuntimeStateRoot, stampStateRoot } from './canonical-state-root';
import { appendTimelineBatch, RecordInventory, validateEcpeObservation } from './ecpe-metrics';
import { resolveProjectIdentity } from './project-identity';
import { durableAtomicWrite } from './durable-atomic-write';

function sha256(bytes: Uint8Array | string): string { return new Bun.CryptoHasher('sha256').update(bytes).digest('hex'); }
function writeOwnedJson(target: string, value: unknown): void {
  durableAtomicWrite(target, JSON.stringify(value) + '\n');
}
function runtimeIdentity(runtimeRoot: string): string {
  const manifest = path.join(runtimeRoot, '.ecpe-installed-runtime.json');
  if (fs.existsSync(manifest)) return `sha256:${sha256(fs.readFileSync(manifest))}`;
  const parts = ['VERSION', 'package.json', 'bun.lock'].filter((name) => fs.existsSync(path.join(runtimeRoot, name))).map((name) => fs.readFileSync(path.join(runtimeRoot, name)));
  return `sha256:${sha256(Buffer.concat(parts))}`;
}

export function startFusedExecutionLifecycle(input: { runtimeRoot: string; repositoryRoot: string; skill: string; workKind: string; finishLine: string; identityMode?: 'legacy' | 'profile'; runId?: string }) {
  const state = resolveRuntimeStateRoot();
  const identity = resolveProjectIdentity(input.repositoryRoot, { mode: input.identityMode ?? 'profile' });
  const slug = /^[a-z0-9][a-z0-9._-]{0,127}$/.test(identity.write_slug) ? identity.write_slug : `project-${sha256(identity.repo_id).slice(0, 32)}`;
  const telStart = Math.floor(Date.now() / 1000);
  const runId = input.runId ?? `${process.pid}-${telStart}-${randomBytes(4).toString('hex')}`;
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(runId)) throw new Error('execution_run_id_invalid');
  const contract = { work_kind: input.workKind, finish_line: input.finishLine };
  const repositoryRoot = fs.realpathSync(input.repositoryRoot);
  const inventory = new RecordInventory({ repositoryRoot, stateRoot: state.root, projectId: slug });
  const inventoryStart = inventory.start(runId);
  const now = new Date().toISOString();
  const context = validateEcpeObservation({
    schema_version: 1, run_id: runId, timestamp: now, wtree: slug, kind: 'context',
    ...contract, context: { skill: input.skill, eager_bytes: (() => { try { return buildBill(input.runtimeRoot).totals.eagerBytesBySkill[input.skill] ?? 0; } catch { return 0; } })(), skillpack_identity: runtimeIdentity(input.runtimeRoot) },
  });
  const inflight = path.join(state.root, 'ecpe', 'inflight', `${runId}.json`);
  if (fs.existsSync(inflight)) throw new Error('execution_run_id_reused');
  writeOwnedJson(inflight, stampStateRoot({ schema: 'ecpe.lifecycle-inflight.v1', run_id: runId, slug, skill: input.skill, branch: identity.raw_branch, repository_root: repositoryRoot, contract, inventory_start: inventoryStart }, state));
  const markerDirectory = path.join(state.root, 'governed-runs');
  fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(path.join(markerDirectory, `${runId}.${input.skill}.active`), 'w', 0o600));
  appendTimelineBatch(state.root, slug, [{ skill: input.skill, event: 'started', branch: identity.raw_branch, session: runId, run_id: runId, ts: now, ecpe: context }]);
  return { run_id: runId, tel_start: telStart, branch: identity.raw_branch, slug, state_root: state.root };
}

export function recordFusedAuthorityCall(input: { lifecycle: ReturnType<typeof startFusedExecutionLifecycle>; skill: string; workKind: string; finishLine: string; startedAt: number; bundleHashBytes: number }): void {
  const now = new Date().toISOString();
  const observation = validateEcpeObservation({ schema_version: 1, run_id: input.lifecycle.run_id, timestamp: now, wtree: input.lifecycle.slug, kind: 'authority_call', work_kind: input.workKind, finish_line: input.finishLine, authority_call: { command_id: 'execution-plan', duration_ms: performance.now() - input.startedAt, anchor_duration_ms: performance.now() - input.startedAt, adapter_duration_ms: 0, authority_processes: 1, bundle_hash_bytes: input.bundleHashBytes, full_tool_hash_bytes: 0, lease: 'created', fused_read_decision: true } });
  appendTimelineBatch(input.lifecycle.state_root, input.lifecycle.slug, [{ skill: input.skill, event: 'observation', run_id: input.lifecycle.run_id, ts: now, ecpe: observation }]);
}
