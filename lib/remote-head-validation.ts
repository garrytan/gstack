import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { materializePrivateValidatorEnv, releasePrivateValidatorEnv, type PrivateValidatorEnv } from './private-validator-env';

export interface ExactPrSnapshot { sourceRepository: string; repoId: string; prNumber: number; baseRef: string; baseSha: string; headSha: string }
export interface ExactRemoteSubject extends PrivateValidatorEnv { repo_id: string; pr_number: number; base_ref: string; base_sha: string; remote_pr_head_sha: string }
function git(cwd: string, args: string[]): { status: number | null; stdout: string } { const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' } }); return { status: result.status, stdout: result.stdout.trim() }; }
export function withRemoteHead<T>(snapshot: ExactPrSnapshot, callback: (subject: ExactRemoteSubject) => T): T {
  if (!Number.isSafeInteger(snapshot.prNumber) || snapshot.prNumber <= 0 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(snapshot.baseRef) || snapshot.baseRef.includes('..') || !/^[0-9a-f]{40}$/i.test(snapshot.baseSha) || !/^[0-9a-f]{40}$/i.test(snapshot.headSha)) throw new Error('remote_head_snapshot_invalid');
  const candidates = [snapshot.baseRef, `refs/heads/${snapshot.baseRef}`, `refs/remotes/origin/${snapshot.baseRef.replace(/^origin\//, '')}`];
  const base = candidates.map((candidate) => git(snapshot.sourceRepository, ['rev-parse', '--verify', `${candidate}^{commit}`])).find((result) => result.status === 0);
  if (!base || base.stdout.toLowerCase() !== snapshot.baseSha.toLowerCase()) throw new Error('remote_head_base_invalid');
  const head = git(snapshot.sourceRepository, ['rev-parse', '--verify', `${snapshot.headSha}^{commit}`]);
  if (head.status !== 0 || head.stdout.toLowerCase() !== snapshot.headSha.toLowerCase()) throw new Error('remote_head_subject_invalid');
  if (git(snapshot.sourceRepository, ['merge-base', '--is-ancestor', snapshot.baseSha, snapshot.headSha]).status !== 0) throw new Error('remote_head_ancestry_invalid');
  const lease = materializePrivateValidatorEnv({ sourceRepository: snapshot.sourceRepository, subjectSha: snapshot.headSha });
  try { return callback({ ...lease, repo_id: snapshot.repoId, pr_number: snapshot.prNumber, base_ref: snapshot.baseRef, base_sha: snapshot.baseSha.toLowerCase(), remote_pr_head_sha: snapshot.headSha.toLowerCase() }); }
  finally { releasePrivateValidatorEnv(lease); }
}
