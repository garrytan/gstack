import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { materializePrivateValidatorEnv, releasePrivateValidatorEnv } from './private-validator-env';
import { durableAtomicWrite } from './durable-atomic-write';

type Purpose = 'ecpe-v3-pilot' | 'safety-downgrade';
type Phase = 'seed' | 'promotion' | 'canary' | 'terminal';
interface RecordV2 { schema: 'ecpe.private-pilot-workspace.v2'; purpose: Purpose; key: string; handle: string; source_repository: string; lease_root: string; checkout_root: string; head: string; tree: string; phase: Phase; cleaned: boolean; allowed_dirty_path?:'.gstack/work-profile.yaml'|null }
const digest = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
function file(stateRoot: string, purpose: Purpose, key: string) { return path.join(path.resolve(stateRoot), 'ecpe', 'private-workspaces', `${purpose}-${digest(key).slice(0, 24)}.json`); }
function git(cwd: string, args: string[], code: string): string { const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' } }); if (result.status !== 0) throw new Error(code); return result.stdout.trim(); }
function gitStatus(cwd:string):string{const result=spawnSync('/usr/bin/git',['status','--porcelain=v1','--untracked-files=all'],{cwd,encoding:'utf8',timeout:20_000,env:{PATH:'/usr/bin:/bin',HOME:os.homedir(),LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1'}});if(result.status!==0)throw new Error('pilot_workspace_subject_invalid');return result.stdout.trimEnd()}
function write(target: string, value: RecordV2) {
  durableAtomicWrite(target, JSON.stringify(value) + '\n');
}
function validateLease(value: RecordV2): void {
  if (value.cleaned) return;
  const lease = path.resolve(value.lease_root);
  if (path.dirname(lease) !== path.resolve(os.tmpdir()) || !path.basename(lease).startsWith('gstack-private-validator-')) throw new Error('pilot_workspace_lease_invalid');
  if (fs.realpathSync(value.checkout_root) !== fs.realpathSync(path.join(lease, 'checkout'))) throw new Error('pilot_workspace_lease_invalid');
  const head = git(value.checkout_root, ['rev-parse', 'HEAD^{commit}'], 'pilot_workspace_subject_invalid');
  const tree = git(value.checkout_root, ['rev-parse', 'HEAD^{tree}'], 'pilot_workspace_subject_invalid');
  const status=gitStatus(value.checkout_root);
  const sanctionedDirty=value.phase==='promotion'&&value.allowed_dirty_path==='.gstack/work-profile.yaml'&&status.split('\n').filter(Boolean).every(line=>line.length>3&&line.slice(3)===value.allowed_dirty_path);
  if (head !== value.head || tree !== value.tree || (status!==''&&!sanctionedDirty)) throw new Error('pilot_workspace_subject_moved');
}
function read(input: { stateRoot: string; purpose: Purpose; key: string }): RecordV2 {
  let value: RecordV2; try { value = JSON.parse(fs.readFileSync(file(input.stateRoot, input.purpose, input.key), 'utf8')); } catch { throw new Error('pilot_workspace_missing'); }
  if (value.schema !== 'ecpe.private-pilot-workspace.v2' || value.purpose !== input.purpose || value.key !== input.key || !/^workspace-[0-9a-f]{32}$/.test(value.handle)) throw new Error('pilot_workspace_invalid');
  validateLease(value); return value;
}
export function initPrivatePilotWorkspace(input: { stateRoot: string; sourceRepository: string; purpose: Purpose; key: string; subjectSha: string }) {
  const target = file(input.stateRoot, input.purpose, input.key);
  if (fs.existsSync(target)) { const existing = read(input); if (existing.head !== input.subjectSha && existing.phase === 'seed') throw new Error('pilot_workspace_subject_moved'); return existing; }
  const source = fs.realpathSync(input.sourceRepository); const lease = materializePrivateValidatorEnv({ sourceRepository: source, subjectSha: input.subjectSha });
  const record: RecordV2 = { schema: 'ecpe.private-pilot-workspace.v2', purpose: input.purpose, key: input.key, handle: `workspace-${digest(`${input.purpose}\0${input.key}\0${input.subjectSha}`).slice(0, 32)}`, source_repository: source, lease_root: lease.lease_root, checkout_root: lease.checkout_root, head: lease.subject_sha, tree: lease.subject_tree, phase: 'seed', cleaned: false,allowed_dirty_path:null };
  try { write(target, record); return record; } catch (error) { releasePrivateValidatorEnv(lease); throw error; }
}
export function inspectPrivatePilotWorkspace(input: { stateRoot: string; purpose: Purpose; key: string }) { const value = read(input); return { ...value, cleanup_eligible: value.phase === 'terminal' && !value.cleaned, cleanup_reason: value.cleaned ? 'already_cleaned' : value.phase === 'terminal' ? null : 'terminal_receipt_required' }; }
export function advancePrivatePilotWorkspace(input: { stateRoot: string; purpose: Purpose; key: string; assertPhase: Phase; assertHead: string; nextPhase: Phase; nextHead: string }) {
  const current = read(input); if (current.cleaned || current.phase !== input.assertPhase || current.head !== input.assertHead || !['seed:promotion', 'promotion:canary', 'canary:terminal', 'seed:terminal'].includes(`${current.phase}:${input.nextPhase}`)) throw new Error('pilot_workspace_assertion_mismatch');
  const observedHead = git(current.checkout_root, ['rev-parse', 'HEAD^{commit}'], 'pilot_workspace_subject_invalid'); if (observedHead !== input.nextHead) throw new Error('pilot_workspace_next_head_mismatch');
  if(gitStatus(current.checkout_root)!=='')throw new Error('pilot_workspace_subject_moved');
  current.phase = input.nextPhase; current.head = observedHead; current.tree = git(current.checkout_root, ['rev-parse', 'HEAD^{tree}'], 'pilot_workspace_subject_invalid');current.allowed_dirty_path=null; write(file(input.stateRoot, input.purpose, input.key), current); return current;
}
export function beginPrivatePilotWorkspaceMutation(input:{stateRoot:string;purpose:'safety-downgrade';key:string;workspaceHandle:string}){const current=read(input);if(current.cleaned||current.handle!==input.workspaceHandle)throw new Error('pilot_workspace_assertion_mismatch');if(current.phase==='promotion'&&current.allowed_dirty_path==='.gstack/work-profile.yaml')return current;if(current.phase!=='seed')throw new Error('pilot_workspace_assertion_mismatch');current.phase='promotion';current.allowed_dirty_path='.gstack/work-profile.yaml';write(file(input.stateRoot,input.purpose,input.key),current);return current}
export function cleanupPrivatePilotWorkspace(input: { stateRoot: string; purpose: Purpose; key: string }) {
  const current = read(input); if (current.phase !== 'terminal') throw new Error('pilot_workspace_not_terminal');
  if (!current.cleaned) { releasePrivateValidatorEnv({ lease_root: current.lease_root }); current.cleaned = true; write(file(input.stateRoot, input.purpose, input.key), current); }
  return { handle: current.handle, cleaned: true };
}
