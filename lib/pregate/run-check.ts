/**
 * The run-evidence inputs one consumer needs (GSTA-156): the base branch's run
 * profiles, this repository on GitHub, the verifier's gh- and git-backed
 * dependencies, and the remote gate's inventory and skipped commands (pin-file
 * commands, so they run only with --allow-repo-commands; skipped reads the
 * selected files from PREGATE_FILES_FILE). Shared by `gstack-pregate
 * clear` and `gstack-pregate --from-run`, so both read profiles from the
 * base and nowhere else.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ghRunDeps, runInventory, type RunProfile } from '../run-evidence';
import { wtreeFingerprint } from '../script-invocation';
import { resolveBaseBranch } from '../ship-policy';
import { normalizeRemoteUrl } from '../ship-queue-train-record';
import { REMOTE_GATE_LANE } from './checks/lanes';
import { PREGATE_CONFIG_PATH, isConfigUnavailable, loadConfigFromBase, loadConfigFromHead } from './config';
import type { RunCheck } from './index';

/**
 * Null when a skippable profile's workflow and every repo file its gate job runs are byte-identical at HEAD and
 * origin/<base> (GST-1190); else the first that differs. The files are the profile's declared `scripts` plus every path the
 * gate job's block in the base workflow names that exists on either side, so a branch cannot move the skip decision.
 */
export function gateInputsChanged(root: string, base: string, p: RunProfile): string | null {
  const ref = `origin/${base.replace(/^origin\//, '')}`;
  const wf = `.github/workflows/${p.workflow}`;
  const gate = p.skippable?.gate;
  if (!gate) return 'the profile names no gate job';
  const blob = (rev: string, f: string) => { const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}:${f}`], { cwd: root, encoding: 'utf8', timeout: 30_000 }); return r.status === 0 ? r.stdout.trim() : null; };
  const show = spawnSync('git', ['show', `${ref}:${wf}`], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (show.status !== 0) return `${wf} is not on ${ref}`;
  const lines = show.stdout.split('\n');
  const jobsAt = lines.findIndex(l => /^jobs:\s*$/.test(l));
  const blocks: string[][] = [];
  for (let i = jobsAt + 1; jobsAt >= 0 && i < lines.length && !/^\S/.test(lines[i]!); i++) {
    if (/^  [\w-]+:\s*$/.test(lines[i]!)) blocks.push([lines[i]!]);
    else blocks.at(-1)?.push(lines[i]!);
  }
  const block = blocks.find(b => b[0]!.trim() === `${gate}:` || b.some(l => l.trim() === `name: ${gate}`));
  if (!block) return `${wf} on ${ref} has no job ${gate}`;
  const named = [...new Set([...block.join('\n').matchAll(/[\w.\/-]+/g)].map(m => m[0].replace(/^\.\//, '')).filter(t => t.includes('/') || /\.(sh|ts|js|mjs|cjs|py|rb)$/.test(t)))];
  for (const f of [wf, ...(p.skippable!.scripts ?? []), ...named]) {
    const a = blob(ref, f);
    const b = blob('HEAD', f);
    if (a === null && b === null && f !== wf && !p.skippable!.scripts?.includes(f)) continue;
    if (a === null || a !== b) return `${f} differs from ${ref}`;
  }
  return null;
}

/**
 * `profiled` says whether `lane` may have a run profile: an unreadable base counts as profiled, so a lane is
 * recorded unverified only once the base shows it has none. `policy: 'head'` reads the branch's profiles instead, only
 * for gstack-ship-preflight --simulate, a dry run that records and clears nothing.
 */
export function buildRunCheck(root: string, lane: string | null, allowRepoCommands: boolean, base = resolveBaseBranch(root), policy: 'base' | 'head' = 'base'): RunCheck | { error: string; profiled?: boolean } {
  const loaded = policy === 'head' ? loadConfigFromHead(root) : loadConfigFromBase(root, base);
  if (isConfigUnavailable(loaded)) return { error: `the base branch's ${PREGATE_CONFIG_PATH} is unreadable (${loaded.detail}); run profiles come only from the base`, profiled: true };
  if (loaded.errors.length) return { error: `the base branch's ${PREGATE_CONFIG_PATH} is invalid: ${loaded.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`, profiled: true };
  const origin = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const repo = /^https:\/\/github\.com\/(.+)$/.exec(normalizeRemoteUrl(origin.status === 0 ? origin.stdout.trim() : ''))?.[1];
  if (!repo) return { error: 'origin is not a github.com repository; run evidence is read from GitHub Actions', profiled: lane === null ? false : lane === REMOTE_GATE_LANE ? !!loaded.config.remote_gate_runs : !!loaded.config.run_profiles[lane] };
  return {
    repo, deps: ghRunDeps(repo, root), profiles: loaded.config.run_profiles, gateRuns: loaded.config.remote_gate_runs, now: new Date(),
    unchanged: p => gateInputsChanged(root, base, p),
    inventory: (command, tree, selected) => {
      if (!allowRepoCommands) return { error: 'the inventory command is a pin-file command; pass --allow-repo-commands' };
      const at = () => { const fp = wtreeFingerprint({ cwd: root }); return 'tree' in fp ? fp.tree : null; };
      if (at() !== tree) return { error: `the working tree is not pregate.json's tree ${tree.slice(0, 12)}; the inventory must list that tree's gate files` };
      const dir = selected && fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-skipped-'));
      try {
        if (dir) fs.writeFileSync(path.join(dir, 'selected.txt'), selected!.map(f => `${f}\n`).join(''));
        const listed = runInventory(command, root, dir ? { PREGATE_FILES_FILE: path.join(dir, 'selected.txt') } : undefined);
        if (at() !== tree) return { error: `the working tree changed while ${command} ran` };
        return listed;
      } finally {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
