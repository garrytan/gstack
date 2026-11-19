/**
 * Load-time injection (GST-3157).
 *
 * Claude Code runs a skill's `!\`<command>\`` lines while the skill loads and
 * puts their output into the skill text, so the model starts with the result
 * instead of an instruction it may skip (GEVA-2: the start command never ran
 * in 5 of 10 /autoplan sessions). Only the Claude render injects; every other
 * host keeps the instruction text.
 *
 * Two Claude Code rules shape this (checked on the pinned 2.1.292 and on
 * 2.1.328 against a stub API): an injected command that exits non-zero, or
 * whose permission check does not allow it, aborts the whole skill load; and
 * a bare `Bash` grant does not allow it in plan mode, where the classifier or
 * a prompt decides. So every injected line runs bin/gstack-skill-load, which
 * always exits 0 and turns a failure into one line, and the skill's
 * allowed-tools names that helper, which Claude Code allows in every mode.
 */
import type { TemplateContext } from './types';

export function injectsAtLoad(ctx: TemplateContext): boolean {
  return ctx.host === 'claude';
}

/** The injected line: one plain command, as worktree-isolated sessions require (#2763). */
export function loadLine(ctx: TemplateContext, args: string): string {
  return `!\`${ctx.paths.binDir}/gstack-skill-load ${args}\``;
}

/** Adds the helper's allowed-tools grant to a Claude render that injects it. */
export function addLoadGrant(content: string, ctx: TemplateContext): string {
  const helper = `${ctx.paths.binDir}/gstack-skill-load`;
  if (!injectsAtLoad(ctx) || !content.startsWith('---\n')) return content;
  const fmEnd = content.indexOf('\n---', 3);
  if (fmEnd === -1 || !content.slice(fmEnd).includes(`!\`${helper} `)) return content;
  const grant = `  - Bash(${helper}:*)`;
  const lines = content.slice(4, fmEnd).split('\n');
  const at = lines.findIndex(line => /^allowed-tools:\s*$/.test(line));
  if (at === -1) {
    if (lines.some(line => line.startsWith('allowed-tools:'))) throw new Error(`${ctx.tmplPath}: allowed-tools must be a YAML list to take the load-time grant`);
    lines.push('allowed-tools:', grant);
  } else {
    let end = at + 1;
    while (end < lines.length && /^\s+- /.test(lines[end]!)) end += 1;
    lines.splice(end, 0, grant);
  }
  return `---\n${lines.join('\n')}${content.slice(fmEnd)}`;
}
