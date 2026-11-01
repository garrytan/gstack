/**
 * The run-evidence inputs one consumer needs (GSTA-156): the base branch's run
 * profiles, this repository on GitHub, the verifier's gh- and git-backed
 * dependencies, and the remote gate's inventory command (a pin-file command,
 * so it runs only with --allow-repo-commands). Shared by `gstack-pregate
 * clear` and `gstack-pregate --from-run`, so both read profiles from the
 * base and nowhere else.
 */
import { spawnSync } from 'node:child_process';
import { ghRunDeps, runInventory } from '../run-evidence';
import { wtreeFingerprint } from '../script-invocation';
import { resolveBaseBranch } from '../ship-policy';
import { normalizeRemoteUrl } from '../ship-queue-train-record';
import { REMOTE_GATE_LANE } from './checks/lanes';
import { PREGATE_CONFIG_PATH, isConfigUnavailable, loadConfigFromBase } from './config';
import type { RunCheck } from './index';

/**
 * `profiled` says whether `lane` may have a run profile: an unreadable base counts as profiled, so a lane is
 * recorded unverified only once the base shows it has none.
 */
export function buildRunCheck(root: string, lane: string | null, allowRepoCommands: boolean, base = resolveBaseBranch(root)): RunCheck | { error: string; profiled?: boolean } {
  const loaded = loadConfigFromBase(root, base);
  if (isConfigUnavailable(loaded)) return { error: `the base branch's ${PREGATE_CONFIG_PATH} is unreadable (${loaded.detail}); run profiles come only from the base`, profiled: true };
  if (loaded.errors.length) return { error: `the base branch's ${PREGATE_CONFIG_PATH} is invalid: ${loaded.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`, profiled: true };
  const origin = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const repo = /^https:\/\/github\.com\/(.+)$/.exec(normalizeRemoteUrl(origin.status === 0 ? origin.stdout.trim() : ''))?.[1];
  if (!repo) return { error: 'origin is not a github.com repository; run evidence is read from GitHub Actions', profiled: lane === null ? false : lane === REMOTE_GATE_LANE ? !!loaded.config.remote_gate_runs : !!loaded.config.run_profiles[lane] };
  return {
    repo, deps: ghRunDeps(repo, root), profiles: loaded.config.run_profiles, gateRuns: loaded.config.remote_gate_runs, now: new Date(),
    inventory: (command, tree) => {
      if (!allowRepoCommands) return { error: 'the inventory command is a pin-file command; pass --allow-repo-commands' };
      const at = () => { const fp = wtreeFingerprint({ cwd: root }); return 'tree' in fp ? fp.tree : null; };
      if (at() !== tree) return { error: `the working tree is not pregate.json's tree ${tree.slice(0, 12)}; the inventory must list that tree's gate files` };
      const listed = runInventory(command, root);
      if (at() !== tree) return { error: `the working tree changed while ${command} ran` };
      return listed;
    },
  };
}
