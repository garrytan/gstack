import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface PrivateValidatorEnv { lease_root: string; checkout_root: string; subject_sha: string; subject_tree: string; environment: Record<string, string> }
function git(cwd: string, args: string[], code: string): string {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(code);
  return result.stdout.trim();
}
export function materializePrivateValidatorEnv(input: { sourceRepository: string; subjectSha: string }): PrivateValidatorEnv {
  if (!/^[0-9a-f]{40}$/i.test(input.subjectSha)) throw new Error('private_validator_subject_invalid');
  const source = fs.realpathSync(path.resolve(input.sourceRepository));
  const verified = git(source, ['rev-parse', '--verify', `${input.subjectSha}^{commit}`], 'private_validator_subject_invalid').toLowerCase();
  if (verified !== input.subjectSha.toLowerCase()) throw new Error('private_validator_subject_invalid');
  const tree = git(source, ['rev-parse', `${verified}^{tree}`], 'private_validator_subject_invalid');
  const lease = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-private-validator-')); fs.chmodSync(lease, 0o700);
  const checkout = path.join(lease, 'checkout');
  try {
    git(lease, ['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', '--', source, checkout], 'private_validator_materialization_failed');
    git(checkout, ['checkout', '--quiet', '--detach', verified], 'private_validator_materialization_failed');
    if (git(checkout, ['rev-parse', 'HEAD^{tree}'], 'private_validator_materialization_failed') !== tree || git(checkout, ['status', '--porcelain=v1', '--untracked-files=all'], 'private_validator_materialization_failed') !== '') throw new Error('private_validator_materialization_mismatch');
    const home = path.join(lease, 'home'); const cache = path.join(lease, 'cache'); const temporary = path.join(lease, 'tmp');
    for (const directory of [home, cache, temporary]) fs.mkdirSync(directory, { mode: 0o700 });
    const gitConfig = path.join(lease, 'gitconfig'); fs.writeFileSync(gitConfig, '', { mode: 0o600 });
    const environment: Record<string, string> = {
      HOME: home, XDG_CACHE_HOME: cache, TMPDIR: temporary, PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C',
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    };
    return { lease_root: lease, checkout_root: checkout, subject_sha: verified, subject_tree: tree, environment };
  } catch (error) { fs.rmSync(lease, { recursive: true, force: true }); throw error; }
}
export function releasePrivateValidatorEnv(binding: Pick<PrivateValidatorEnv, 'lease_root'>): void {
  const root = path.resolve(binding.lease_root);
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('gstack-private-validator-')) throw new Error('private_validator_lease_invalid');
  fs.rmSync(root, { recursive: true, force: true });
}
