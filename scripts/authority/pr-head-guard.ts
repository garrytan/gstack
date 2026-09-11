import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendJsonl } from '../../lib/jsonl-store';
import { assertProviderHeadSnapshot, directMergeProviderHead, snapshotProviderHead } from '../../lib/provider-access';
import { resolveProfileValidatorBinding } from '../../lib/profile-validator-binding';
import { withRemoteHead } from '../../lib/remote-head-validation';
import { resolveTrustedWorkProfile } from '../../lib/trusted-base';
import { ensureValidator, evaluateValidatorBinding } from '../../lib/validator-runner';
import type { EvidenceRecordV2 } from '../../lib/evidence-envelope';
import type { Lane } from '../../lib/work-profile';
import { assertEcpeAuthorityPlatform } from '../../lib/ecpe-platform';

function fail(error: unknown, status = 1): never { console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'provider_guard_failed' })); process.exit(status); }
try { assertEcpeAuthorityPlatform(); } catch (error) { fail(error); }
function parse(args: string[]) {
  const command = args.shift() ?? ''; const values = new Map<string, string>(); let requireLocalHead = false; let json = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === '--require-local-head') { if (requireLocalHead) throw new Error('provider_guard_arguments_invalid'); requireLocalHead = true; continue; }
    if (flag === '--json') { if (json) throw new Error('provider_guard_arguments_invalid'); json = true; continue; }
    const value = args.shift(); if (!flag.startsWith('--') || !value || value.startsWith('--') || values.has(flag)) throw new Error('provider_guard_arguments_invalid'); values.set(flag, value);
  }
  return { command, values, requireLocalHead, json };
}
function positive(value?: string): number { if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error('provider_guard_arguments_invalid'); return Number(value); }
function executable(logical: string): string {
  const candidate = logical === 'bun' ? process.execPath : logical;
  if (!path.isAbsolute(candidate)) throw new Error('validator_executable_untrusted');
  const info = fs.lstatSync(candidate); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) throw new Error('validator_executable_untrusted');
  return fs.realpathSync(candidate);
}

async function exactRemoteValidator(command: 'with-worktree' | 'inspect', values: Map<string, string>) {
  const allowed = new Set(['--pr', '--expected', '--assert-target-ref', '--expected-base', '--validator', '--lane']);
  if ([...values.keys()].some((key) => !allowed.has(key))) throw new Error('provider_guard_arguments_invalid');
  const pr = positive(values.get('--pr')); const expectedHead = values.get('--expected'); const target = values.get('--assert-target-ref'); const expectedBase = values.get('--expected-base'); const validatorId = values.get('--validator');
  const lane = (values.get('--lane') ?? 'single_repo_code') as Lane;
  if (!expectedHead || !target || !expectedBase || !validatorId || !['docs_ux', 'single_repo_code', 'cross_repo_contract'].includes(lane)) throw new Error('provider_guard_arguments_invalid');
  const before = assertProviderHeadSnapshot(await snapshotProviderHead(process.cwd(), pr), { prNumber: pr, expectedHeadOid: expectedHead, expectedBaseOid: expectedBase, expectedTargetRef: target, requireAutomationNull: true });
  const resolved = resolveTrustedWorkProfile({ cwd: process.cwd(), lane, assertTargetRef: target });
  if (!resolved.effective || resolved.execution !== 'profile' || resolved.trusted_base.target_sha !== before.baseRefOid) throw new Error('remote_validator_profile_mismatch');
  const stateHome = process.env.GSTACK_HOME || (process.env.HOME ? path.join(process.env.HOME, '.gstack') : ''); if (!stateHome) throw new Error('evidence_state_home_missing');
  const buffered: EvidenceRecordV2[] = [];
  const result = withRemoteHead({ sourceRepository: process.cwd(), repoId: '', prNumber: pr, baseRef: before.targetRef, baseSha: before.baseRefOid, headSha: before.headRefOid }, (subject) => {
    const resolvedBinding = resolveProfileValidatorBinding({ cwd: process.cwd(), lane, validatorId, assertTargetRef: target, stateHome, resolvedProfile: resolved, subject: { cwd: subject.checkout_root, localHeadSha: subject.subject_sha, remotePrHeadSha: subject.remote_pr_head_sha, baseSha: subject.base_sha, mergeBaseSha: subject.base_sha } });
    if (resolvedBinding.binding.effect !== 'read') return { disposition: 'grant_required' as const, validator_id: validatorId, spawned: false, required_effect: 'paid_model' as const };
    if (command === 'inspect') return evaluateValidatorBinding(resolvedBinding.binding);
    return ensureValidator(resolvedBinding.binding, {
      spawn: (argv) => { const child = spawnSync(executable(argv[0]), argv.slice(1), { cwd: resolvedBinding.binding.cwd, stdio: 'inherit', shell: false, env: subject.environment }); return { exitCode: child.status ?? 1 }; },
      append: (record) => buffered.push(record),
    });
  });
  assertProviderHeadSnapshot(await snapshotProviderHead(process.cwd(), pr), { prNumber: pr, expectedHeadOid: before.headRefOid, expectedBaseOid: before.baseRefOid, expectedTargetRef: before.targetRef, requireAutomationNull: true });
  if (buffered.length) {
    const local = resolveProfileValidatorBinding({ cwd: process.cwd(), lane, validatorId, assertTargetRef: target, stateHome, resolvedProfile: resolved });
    fs.mkdirSync(local.ledgerDirectory, { recursive: true, mode: 0o700 }); for (const record of buffered) appendJsonl(local.ledgerFile, record, { mode: 0o600 });
  }
  return { schema: 'ecpe.remote-head-validation.v1', pr, base_ref: before.targetRef, base_sha: before.baseRefOid, remote_pr_head_sha: before.headRefOid, result };
}

try {
  const { command, values, requireLocalHead, json } = parse(process.argv.slice(2));
  if (command === 'snapshot') {
    if ([...values.keys()].some((key) => key !== '--pr')) throw new Error('provider_guard_arguments_invalid');
    console.log(JSON.stringify(await snapshotProviderHead(process.cwd(), positive(values.get('--pr')), { requireLocalHead })));
  } else if (command === 'assert' || command === 'direct-merge') {
    const allowed = new Set(['--pr', '--expected', '--expected-base', '--assert-target-ref', '--expected-repository-node']); if ([...values.keys()].some((key) => !allowed.has(key))) throw new Error('provider_guard_arguments_invalid');
    const pr = positive(values.get('--pr')); const expected = { prNumber: pr, expectedHeadOid: values.get('--expected') ?? '', expectedBaseOid: values.get('--expected-base') ?? '', expectedTargetRef: values.get('--assert-target-ref') ?? '', expectedRepositoryNodeId: values.get('--expected-repository-node') };
    console.log(JSON.stringify(command === 'direct-merge' ? await directMergeProviderHead(process.cwd(), { ...expected, requireLocalHead }) : assertProviderHeadSnapshot(await snapshotProviderHead(process.cwd(), pr, { requireLocalHead }), { ...expected, requireAutomationNull: true })));
  } else if (command === 'with-worktree' || command === 'inspect') {
    if (requireLocalHead || (command === 'inspect' && !json)) throw new Error('provider_guard_arguments_invalid');
    const output = await exactRemoteValidator(command, values); console.log(JSON.stringify(output));
    if (command === 'with-worktree' && 'disposition' in output.result && output.result.disposition === 'live_fail') process.exit(output.result.child_exit ?? 1);
    if (command === 'inspect' && 'current' in output.result && !output.result.current) process.exit(1);
  } else throw new Error('provider_guard_command_invalid');
} catch (error) { fail(error, error instanceof Error && error.message.includes('arguments') ? 2 : 1); }
