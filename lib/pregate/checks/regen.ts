/**
 * pregate check `regen` (tier 1, preflight): every `.gstack/generated.json`
 * entry whose inputs or outputs the branch touched is regenerated in a
 * scratch git worktree (lib/regen.ts) and compared with the working tree.
 * Incident p0-4-stale-goldens: a template changed, the committed render and
 * the golden did not, and the remote gate failed an hour later.
 */
import { renderEntry, runRegen, selectEntries } from '../../regen';
import { baseInputs } from '../context';
import type { CheckDef, CheckResult, PregateContext } from '../types';

function run(ctx: PregateContext): CheckResult {
  const inputs = baseInputs(ctx, { registry: ctx.registryLabel });
  const touched = ctx.touched.map(t => t.path).concat(ctx.touched.flatMap(t => (t.renamedFrom ? [t.renamedFrom] : [])));
  const selected = selectEntries(ctx.registry, touched);
  if (ctx.registry.entries.length === 0) return { id: 'regen', stage: 'preflight', status: 'pass', detail: `no ${ctx.registryLabel.includes('(no ') ? 'registry' : 'entries'} (${ctx.registryLabel})`, inputs };
  if (selected.length === 0) return { id: 'regen', stage: 'preflight', status: 'pass', detail: `no registered input or output touched (${ctx.registry.entries.length} entries)`, inputs };
  const commands = selected.filter(e => e.command);
  if (commands.length && !ctx.allowRepoCommands) {
    return {
      id: 'regen', stage: 'preflight', status: 'incomplete', inputs, code: 'REPO_COMMANDS_NOT_ALLOWED',
      detail: `repo commands not executed (pass --allow-repo-commands): ${commands.map(c => `${c.id}: ${c.command}`).join('; ')}`,
      fix: 'rerun with --allow-repo-commands (what /ship passes)', lines: commands.map(c => `COMMAND: ${c.id}=${JSON.stringify(c.command)} outputs=${c.outputs.join(',')}`),
    };
  }
  const { results } = runRegen({ repoRoot: ctx.repoRoot, registry: ctx.registry, mode: 'check', only: selected.map(e => e.id), env: ctx.env, timeoutMs: ctx.timeoutMs });
  const lines = results.map(renderEntry);
  const stale = results.filter(r => r.status === 'stale');
  const failed = results.filter(r => r.status === 'failed');
  ctx.explain.push(...results.map(r => `regen ${r.id}: selected because touched ∩ (${selected.find(e => e.id === r.id)?.inputs.join(',') || 'always'} ∪ outputs) ≠ ∅`));
  if (failed.length) return { id: 'regen', stage: 'preflight', status: 'incomplete', inputs, lines, code: 'REGEN_COMMAND_FAILED', detail: `${failed.length} regen command(s) failed: ${failed.map(f => f.id).join(', ')}`, fix: failed.map(f => f.fix).join('; ') };
  if (stale.length) return { id: 'regen', stage: 'preflight', status: 'fail', inputs, lines, code: 'REGEN_STALE', detail: `${stale.length} stale: ${stale.flatMap(s => s.changed.concat(s.outside)).join(' ')}`, fix: stale.map(s => s.fix).join('; ') };
  return { id: 'regen', stage: 'preflight', status: 'pass', inputs, lines, detail: `${results.length} entr${results.length === 1 ? 'y' : 'ies'} fresh${results.some(r => r.status === 'listed') ? ' (hand-regenerated outputs listed)' : ''}` };
}

export const regenCheck: CheckDef = { id: 'regen', stage: 'preflight', tier: 1, downgradable: true, needsRepoCommands: true, run };
