import * as fs from 'node:fs';
import * as path from 'node:path';
import { beginPrivatePilotWorkspaceMutation, inspectPrivatePilotWorkspace } from './private-pilot-workspace';
import { inspectSafetyLatch } from './milestone-block';
import { inspectSafetyDowngradeSource } from './safety-downgrade';
import { parseWorkProfile, type Lane } from './work-profile';
import { durableAtomicWrite } from './durable-atomic-write';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';

type Target = 'shadow' | 'legacy';
type Intent = {
  schema: 'ecpe.profile-downgrade-intent.v1'; phase: 'prepared' | 'written';
  latch_id: string; source_seal_id: string; participant: 'portfolioops'; lane: Lane;
  workspace_handle: string; selector: string; target: Target; subject_head: string; subject_tree: string;
  before_sha256: string; after_sha256: string; before_profile_hash: string; after_profile_hash: string;
  record_id: string | null;
};

const digest = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
const key = (lane: Lane, latchId: string) => `portfolioops\0${lane}\0${latchId}`;
function intentPath(stateRoot: string, latchId: string) { if (!/^latch-[0-9a-f]{32}$/.test(latchId)) throw new Error('downgrade_latch_invalid'); return path.join(path.resolve(stateRoot), 'ecpe', 'profile-downgrade-intents', `${latchId}.json`); }
function write(target: string, value: Intent) { durableAtomicWrite(target, JSON.stringify(value) + '\n'); }
function read(stateRoot: string, latchId: string): Intent | null { const target = intentPath(stateRoot, latchId); if (!fs.existsSync(target)) return null; const info = fs.lstatSync(target); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('downgrade_intent_invalid'); let value: Intent; try { value = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { throw new Error('downgrade_intent_invalid'); } if (value.schema !== 'ecpe.profile-downgrade-intent.v1' || value.latch_id !== latchId) throw new Error('downgrade_intent_invalid'); return value; }
function withIntentLock<T>(stateRoot:string,latchId:string,callback:()=>T):T{const owned=acquireDurableOwnerLock(intentPath(stateRoot,latchId),'downgrade_owner_busy');try{return callback()}finally{releaseDurableOwnerLock(owned)}}

function downgradedBytes(source: string, lane: Lane, target: Target): string {
  const lines = source.split(/(?<=\n)/); let inLanes = false; let inLane = false; let seen = 0;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].replace(/\r?\n$/, '');
    if (/^lanes:\s*$/.test(text)) { inLanes = true; inLane = false; continue; }
    if (inLanes && /^\S/.test(text) && text.trim()) { inLanes = false; inLane = false; }
    if (inLanes && new RegExp(`^  ${lane}:\\s*\\{.*\\bactivation:\\s*enforce\\b`).test(text)) { lines[index] = lines[index].replace(/\bactivation:\s*enforce\b/, `activation: ${target}`); seen++; continue; }
    if (inLanes && new RegExp(`^  ${lane}:\\s*$`).test(text)) { inLane = true; continue; }
    if (inLane && /^  \S/.test(text) && !new RegExp(`^  ${lane}:`).test(text)) inLane = false;
    if (inLane && /^    activation:\s*enforce\s*$/.test(text)) { const ending = lines[index].endsWith('\r\n') ? '\r\n' : lines[index].endsWith('\n') ? '\n' : ''; lines[index] = `    activation: ${target}${ending}`; seen++; }
  }
  if (seen !== 1) throw new Error('downgrade_selector_mismatch');
  return lines.join('');
}

function validateIntent(intent: Intent, input: { latchId: string; lane: Lane; workspaceHandle: string; assertSelector: string; target: Target }) {
  if (intent.latch_id !== input.latchId || intent.lane !== input.lane || intent.workspace_handle !== input.workspaceHandle || intent.selector !== input.assertSelector || intent.target !== input.target) throw new Error('downgrade_intent_conflict');
}

function applyProfileDowngradeUnlocked(input: { stateRoot: string; latchId: string; lane: Lane; workspaceHandle: string; assertSelector: string; target: Target }) {
  const selector = `/lanes/${input.lane}/activation`;
  if (input.assertSelector !== selector || !['shadow', 'legacy'].includes(input.target)) throw new Error('downgrade_selector_mismatch');
  const latch = inspectSafetyLatch({ stateRoot: input.stateRoot, participant: 'portfolioops', lane: input.lane });
  if (latch.result !== 'latched' || latch.latch_id !== input.latchId) throw new Error('downgrade_latch_mismatch');
  const seal = inspectSafetyDowngradeSource({ stateRoot: input.stateRoot, participant: 'portfolioops', lane: input.lane, latchId: input.latchId });
  const workspaceKey = key(input.lane, input.latchId);
  let workspace = inspectPrivatePilotWorkspace({ stateRoot: input.stateRoot, purpose: 'safety-downgrade', key: workspaceKey });
  if (workspace.handle !== input.workspaceHandle || !['seed', 'promotion'].includes(workspace.phase) || workspace.cleaned) throw new Error('downgrade_workspace_mismatch');
  const file = path.join(workspace.checkout_root, '.gstack', 'work-profile.yaml');
  const current = fs.readFileSync(file); const currentHash = digest(current);
  const existing = read(input.stateRoot, input.latchId);
  if (existing) {
    validateIntent(existing, input);
    if (existing.source_seal_id !== seal.seal_id || existing.subject_head !== workspace.head || existing.subject_tree !== workspace.tree) throw new Error('downgrade_lineage_moved');
    if (existing.phase === 'written') { if (currentHash !== existing.after_sha256) throw new Error('downgrade_profile_moved'); return { result: 'reused', phase: existing.phase, latch_id: existing.latch_id, lane: existing.lane, target: existing.target, record_id: existing.record_id, workspace_handle: existing.workspace_handle }; }
    if (currentHash === existing.after_sha256) { existing.phase = 'written'; existing.record_id = `downgrade-write-${digest(JSON.stringify(existing)).slice(0, 32)}`; write(intentPath(input.stateRoot, input.latchId), existing); return { result: 'reconciled', phase: existing.phase, latch_id: existing.latch_id, lane: existing.lane, target: existing.target, record_id: existing.record_id, workspace_handle: existing.workspace_handle }; }
    if (currentHash !== existing.before_sha256) throw new Error('downgrade_profile_moved');
  }
  const beforeText = current.toString('utf8'); const before = parseWorkProfile(beforeText);
  if (before.lanes[input.lane].activation !== 'enforce' || before.semantic_policy_hash !== latch.profile_lineage_hash) throw new Error('downgrade_lineage_moved');
  const afterText = downgradedBytes(beforeText, input.lane, input.target); const after = Buffer.from(afterText); const afterProfile = parseWorkProfile(afterText);
  const intent: Intent = existing ?? { schema: 'ecpe.profile-downgrade-intent.v1', phase: 'prepared', latch_id: input.latchId, source_seal_id: seal.seal_id, participant: 'portfolioops', lane: input.lane, workspace_handle: input.workspaceHandle, selector, target: input.target, subject_head: workspace.head, subject_tree: workspace.tree, before_sha256: currentHash, after_sha256: digest(after), before_profile_hash: before.semantic_policy_hash, after_profile_hash: afterProfile.semantic_policy_hash, record_id: null };
  if (!existing) write(intentPath(input.stateRoot, input.latchId), intent);
  workspace = beginPrivatePilotWorkspaceMutation({ stateRoot: input.stateRoot, purpose: 'safety-downgrade', key: workspaceKey, workspaceHandle: input.workspaceHandle });
  if (workspace.head !== intent.subject_head || workspace.tree !== intent.subject_tree) throw new Error('downgrade_lineage_moved');
  durableAtomicWrite(file, after, {
    mode: fs.statSync(file).mode & 0o777,
    lockTarget: `${intentPath(input.stateRoot, input.latchId)}.profile-write`,
  });
  intent.phase = 'written'; intent.record_id = `downgrade-write-${digest(JSON.stringify(intent)).slice(0, 32)}`; write(intentPath(input.stateRoot, input.latchId), intent);
  return { result: 'written', phase: intent.phase, latch_id: intent.latch_id, lane: intent.lane, target: intent.target, record_id: intent.record_id, workspace_handle: intent.workspace_handle, before_profile_hash: intent.before_profile_hash, after_profile_hash: intent.after_profile_hash };
}

export function applyProfileDowngrade(input: { stateRoot: string; latchId: string; lane: Lane; workspaceHandle: string; assertSelector: string; target: Target }) { return withIntentLock(input.stateRoot,input.latchId,()=>applyProfileDowngradeUnlocked(input)); }

export function inspectProfileDowngrade(input: { stateRoot: string; latchId: string; lane: Lane }) {
  const intent = read(input.stateRoot, input.latchId); if (!intent || intent.lane !== input.lane) throw new Error('downgrade_intent_missing');
  const workspace = inspectPrivatePilotWorkspace({ stateRoot: input.stateRoot, purpose: 'safety-downgrade', key: key(input.lane, input.latchId) });
  const currentHash = digest(fs.readFileSync(path.join(workspace.checkout_root, '.gstack', 'work-profile.yaml')));
  if (workspace.handle !== intent.workspace_handle || workspace.head !== intent.subject_head || workspace.tree !== intent.subject_tree || currentHash !== (intent.phase === 'written' ? intent.after_sha256 : intent.before_sha256)) throw new Error('downgrade_profile_moved');
  return { result: intent.phase === 'written' ? 'written' : 'intent_recovery_required', phase: intent.phase, latch_id: intent.latch_id, source_seal_id: intent.source_seal_id, lane: intent.lane, target: intent.target, record_id: intent.record_id, workspace_handle: intent.workspace_handle, next_operation: intent.phase === 'written' ? 'ship' : 'apply_profile_downgrade' };
}
