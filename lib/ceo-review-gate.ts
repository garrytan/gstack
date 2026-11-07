/**
 * ceo-review-gate — the output check behind the /plan-ceo-review enforcement
 * hook (GST-1461). Docs: docs/skill-gates.md.
 *
 * A review is met when one candidate output file, modified after the skill
 * loaded, has a heading whose text contains "Findings" or "Top risks" (any
 * level) and, inside that section, a numbered list that starts at 1 with at
 * least one item that is not a placeholder: the ranked top risks. Candidates,
 * in order: GSTACK_CEO_REVIEW_OUTPUT; files the run wrote with Write, Edit or
 * MultiEdit; changed or untracked (not ignored) .md files in the git repo at
 * cwd; $GSTACK_STATE_ROOT/projects/<slug>/ceo-plans/*.md. Bash commands are
 * never parsed: a file written through the shell is found by the repo and
 * ceo-plans scans. A file in a skills/ directory (judged from the repo root,
 * else cwd) is never a candidate or the place the block names: the review's
 * own methodology sections are not its output.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isPlaceholder, sameSkill, skillLoads, type SkillLoad, type Transcript } from './skill-contract';
import { remainingMs } from './skill-gates';
import { resolveStateRoot } from './state-root';

const GIT_TIMEOUT_MS = 3000;

function git(root: string, args: string[]): { ok: boolean; out: Buffer } {
  const r = spawnSync('git', args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: Math.min(GIT_TIMEOUT_MS, remainingMs()), maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout as Buffer) ?? Buffer.alloc(0) };
}

function repoRoot(cwd: string): string | null {
  if (!fs.existsSync(cwd)) return null;
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? fs.realpathSync(r.out.toString('utf8').trim()) : null;
}

export const SKILL = 'plan-ceo-review';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SCANNED = 200;
const WRITE_TOOLS = /^(?:Write|Edit|MultiEdit)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const RISK_HEADING = /findings|top risks/i;
const ITEM = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SKILL_TREE = /(?:^|[\\/])skills[\\/]/;

/** Why markdown does not rank the top risks, or null when it does. */
export function rankedRisksGap(md: string): string | null {
  let level = 0;
  let started = false;
  let heading = false;
  let list = false;
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (f) { fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence; continue; }
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h) {
      if (level && h[1].length > level) continue;
      level = RISK_HEADING.test(h[2]) ? h[1].length : 0;
      heading ||= level > 0;
      started = false;
      continue;
    }
    if (!level) continue;
    const item = ITEM.exec(line);
    if (!item) continue;
    if (!started && Number(item[1]) !== 1) { level = 0; continue; }
    started = true;
    list = true;
    if (!isPlaceholder(item[2].replace(/^[\s*_`]+|[\s*_`]+$/g, ''))) return null;
  }
  if (!heading) return 'no Findings or Top risks heading';
  if (!list) return 'no numbered list starting at 1 under its Findings or Top risks heading';
  return 'its numbered list holds only placeholders';
}

export interface OutputCheck {
  /** the first candidate that ranks the top risks */
  met: string | null;
  /** every existing candidate looked at, with why it fell short */
  checked: Array<{ file: string; why: string }>;
  /** the candidates that do not exist (GSTACK_CEO_REVIEW_OUTPUT, a written file since removed) */
  missing: string[];
  /** where the block tells the model to write */
  dest: string;
}

export interface OutputContext { cwd: string; since: number; envOutput: string | undefined; slug: () => string }

function changedMarkdown(root: string | null, since: number): string[] {
  if (!root) return [];
  const list = (args: string[]) => git(root, args).out.toString('utf8').split('\0').filter(Boolean);
  const rels = [...new Set([...list(['diff', 'HEAD', '--name-only', '-z', '--no-renames', '--', '*.md']), ...list(['ls-files', '-o', '--exclude-standard', '-z', '--', '*.md'])])];
  return newest(rels.map(r => path.join(root, r)), since);
}

function newest(files: string[], since: number): string[] {
  const dated: Array<[string, number]> = [];
  for (const f of files) {
    try { const st = fs.statSync(f); if (st.isFile() && st.mtimeMs > since) dated.push([f, st.mtimeMs]); } catch { /* removed since */ }
  }
  return dated.sort((a, b) => b[1] - a[1]).slice(0, MAX_SCANNED).map(([f]) => f);
}

function ceoPlans(slug: string, since: number): string[] {
  const dir = path.join(resolveStateRoot(), 'projects', slug, 'ceo-plans');
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md')); } catch { return []; }
  return newest(names.map(n => path.join(dir, n)), since);
}

/** Check the candidates of one /plan-ceo-review run, source by source, stopping at the first met file. */
export function checkOutput(t: Transcript, load: SkillLoad, ctx: OutputContext): OutputCheck {
  const next = skillLoads(t).find(l => l.at > load.at && sameSkill(l.skill, SKILL));
  const run = t.events.slice(load.at + 1, next?.at);
  const paths = (re: RegExp) => run.flatMap(e => (e.kind === 'tool_use' && re.test(e.name) && typeof e.input.file_path === 'string' ? [path.resolve(ctx.cwd, e.input.file_path)] : []));
  const env = ctx.envOutput?.trim() ? path.resolve(ctx.cwd, ctx.envOutput.trim()) : undefined;
  const repo = repoRoot(ctx.cwd);
  const inSkillTree = (f: string) => SKILL_TREE.test(path.relative(repo ?? ctx.cwd, f));
  const written = paths(WRITE_TOOLS).filter(f => !inSkillTree(f));
  const reviewed = paths(/^Read$/).filter(f => f.endsWith('.md') && !inSkillTree(f)).pop();
  const dest = env ?? written.filter(f => f.endsWith('.md')).pop() ?? reviewed ?? 'the plan file you reviewed';
  const sources: Array<() => string[]> = [() => (env ? [env] : []), () => written, () => changedMarkdown(repo, ctx.since).filter(f => !inSkillTree(f)), () => ceoPlans(ctx.slug(), ctx.since)];
  const result: OutputCheck = { met: null, checked: [], missing: [], dest };
  const seen = new Set<string>();
  for (const source of sources) {
    for (const file of source()) {
      if (seen.has(file)) continue;
      seen.add(file);
      remainingMs();
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { result.missing.push(file); continue; }
      if (!st.isFile()) { result.checked.push({ file, why: 'not a file' }); continue; }
      if (st.mtimeMs <= ctx.since) { result.checked.push({ file, why: 'not changed since /plan-ceo-review loaded' }); continue; }
      if (st.size > MAX_FILE_BYTES) { result.checked.push({ file, why: `over ${MAX_FILE_BYTES} bytes` }); continue; }
      const why = rankedRisksGap(fs.readFileSync(file, 'utf8'));
      if (why === null) { result.met = file; return result; }
      result.checked.push({ file, why });
    }
  }
  return result;
}
