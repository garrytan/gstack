/**
 * pregate check `strays` (tier 1, preflight): files the branch added at the
 * repository root, in a top-level directory the base branch does not have,
 * or anywhere under a scratch name (`zz-*`, `tmp*`, `scratch*`, editor
 * leftovers). Incident p0-4-scratch-script: a `zz-probe.sh` shipped in a
 * release PR because nothing looked at the file list.
 */
import { spawnSync } from 'node:child_process';
import { matchesAny } from '../../ship-policy';
import { baseInputs } from '../context';
import type { CheckDef, CheckResult, PregateContext } from '../types';

/** Conventional root files a repo adds without a declaration. */
const ROOT_OK = /^(?:README|LICENSE|LICENCE|NOTICE|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|AUTHORS|VERSION|Makefile|Dockerfile|Procfile|Gemfile|Rakefile|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|package(?:-lock)?\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|tsconfig[\w.-]*\.json|bunfig\.toml|pyproject\.toml|requirements[\w.-]*\.txt|setup\.(?:py|cfg)|\.[\w.-]+|[\w.-]+\.config\.[cm]?[jt]s|[\w.-]+\.md)$/i;
export const STRAY_NAME = /^(?:zz-|tmp|temp|scratch|debug-|probe)|\.(?:orig|rej|swp|swo|bak|tmp)$|~$|^\.DS_Store$|^Thumbs\.db$/i;

function run(ctx: PregateContext): CheckResult {
  const inputs = baseInputs(ctx);
  const baseDirs = new Set(spawnSync('git', ['ls-tree', '--name-only', '-d', ctx.mergeBase], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 30_000, env: ctx.env }).stdout.split('\n').filter(Boolean));
  const allow = ctx.config.strays.allow;
  const lines: string[] = [];
  const warnings: string[] = [];
  for (const t of ctx.touched) {
    if (t.status !== 'A' && t.status !== 'R') continue;
    const file = t.path;
    const name = file.split('/').pop()!;
    if (matchesAny(allow, file) || matchesAny(allow, file.split('/')[0]!)) continue;
    if (STRAY_NAME.test(name)) { lines.push(`${file}: scratch name (${name})`); continue; }
    if (!file.includes('/')) { if (!ROOT_OK.test(name)) lines.push(`${file}: new file at the repository root`); continue; }
    const top = file.split('/')[0]!;
    if (!baseDirs.has(top)) warnings.push(`${file}: new top-level directory ${top}/ (not on ${ctx.baseRef})`);
  }
  ctx.explain.push(`strays: base directories ${[...baseDirs].join(',')}; allow ${allow.join(',') || '(none)'}`);
  if (lines.length) return { id: 'strays', stage: 'preflight', status: 'fail', inputs, lines: [...lines, ...warnings], code: 'PREGATE_STRAYS', detail: `${lines.length} stray file(s): ${lines.map(l => l.split(':')[0]).join(' ')}`, fix: 'delete or move the file; an intentional root file goes in .gstack/pregate.json strays.allow' };
  if (warnings.length) return { id: 'strays', stage: 'preflight', status: 'warn', inputs, lines: warnings, code: 'PREGATE_STRAYS', detail: `${warnings.length} file(s) in a new top-level directory`, fix: 'confirm the directory is intended, or allow it in .gstack/pregate.json strays.allow' };
  return { id: 'strays', stage: 'preflight', status: 'pass', inputs, detail: `${ctx.touched.filter(t => t.status === 'A').length} added file(s), none stray` };
}

export const straysCheck: CheckDef = { id: 'strays', stage: 'preflight', tier: 1, downgradable: true, needsRepoCommands: false, run };
