/**
 * autoplan-scope — the scope evidence both /autoplan paths share (field wave
 * item 11). The runner (lib/autoplan-prompts.ts `detectScope`) and the
 * interactive path (`gstack-autoplan-snapshot.ts scope`, read by
 * autoplan/SKILL.md) take UI scope from `detectUiScope` over the
 * Implementation plan only. UI needs a rendered surface: a path to a rendered
 * file, or a UI term next to a visual noun. Bare UI words are weak evidence:
 * they keep the runner's conservative section fallback but do not add the
 * Design phase. The scope marker is the author's way to pin flags in the plan
 * itself; it is read, never written. `detectDocsOnly` classifies the paths
 * the Implementation plan names: a plan that touches only markdown no agent
 * or gate consumes is docs-only (CEO + Eng, outside voice on Eng only).
 */
import { classifyPath } from './review-depth';

export const UI_TERMS = ['component', 'screen', 'form', 'button', 'modal', 'layout', 'dashboard', 'sidebar', 'nav', 'dialog'] as const;
export const VISUAL_NOUNS = ['page', 'layout', 'style', 'pixel', 'view', 'browser', 'css'] as const;
const VISUAL_WINDOW = 4;
const RENDERED_EXT = /(?:^|\/)[^/.][^/]*\.(?:tsx|jsx|vue|svelte|css|scss|html|erb|hbs)$/i;
const RENDERED_DIR = /(?:^|\/)(?:components|pages|views|styles)\//i;

export interface UiEvidence { terms: Array<{ term: string; count: number }>; visual: string[]; files: string[] }
export interface UiScope { uiRequired: boolean; uiMatches: number; uiEvidence: UiEvidence }

const wordOf = (w: string, list: readonly string[]) => list.find(t => w === t || w === `${t}s` || (t === 'style' && w === 'stylesheet'));

/** UI scope from rendered surfaces: a rendered file path, or a UI term within a few words of a visual noun in the same sentence (paths are not prose). */
export function detectUiScope(implementationPlan: string): UiScope {
  const files = [...new Set([...implementationPlan.matchAll(/[\w@~$.\/-]+/g)]
    .map(m => m[0].replace(/[.\-]+$/, ''))
    .filter(t => t.length > 1 && (RENDERED_EXT.test(t) || RENDERED_DIR.test(t))))];
  const counts = new Map<string, number>();
  const visual: string[] = [];
  for (const sentence of implementationPlan.split(/[.!?;:](?:\s|$)|\n\s*\n/)) {
    const words = sentence.replace(/\S*\/\S*|\b[\w-]+\.[a-z]{1,6}\b/gi, ' ').toLowerCase().match(/[a-z]+/g) ?? [];
    words.forEach((w, i) => {
      const term = wordOf(w, UI_TERMS);
      if (!term) return;
      counts.set(term, (counts.get(term) ?? 0) + 1);
      for (let j = Math.max(0, i - VISUAL_WINDOW); j <= Math.min(words.length - 1, i + VISUAL_WINDOW); j++) {
        const noun = j !== i ? wordOf(words[j]!, VISUAL_NOUNS) : undefined;
        if (noun && noun !== term) { visual.push(`${term}~${noun}`); return; }
      }
    });
  }
  const terms = UI_TERMS.flatMap(term => (counts.has(term) ? [{ term, count: counts.get(term)! }] : []));
  return { uiRequired: files.length > 0 || visual.length > 0, uiMatches: terms.reduce((s, t) => s + t.count, 0), uiEvidence: { terms, visual: [...new Set(visual)], files } };
}

/** Docs-class: what /ship's review classifies as docs (lib/review-depth.ts classifyPath: README, CHANGELOG, TODOS and prose markdown outside agent-read and skill-directory paths), plus a docs directory named without a file. */
export function docsClassPath(file: string, root: string): boolean {
  const p = file.replace(/^\.\//, '');
  if (p.startsWith('docs/') && !/\.mdx?$/i.test(p)) return true;
  return classifyPath(p, root) === 'docs';
}

export interface DocsOnlyScope { docsOnly: boolean; paths: string[]; code: string[] }
/** Docs-only when the Implementation plan names at least one path and every one is docs-class; unsure means not docs-only. */
export function detectDocsOnly(implementationPlan: string, root: string): DocsOnlyScope {
  const paths = [...new Set([...implementationPlan.matchAll(/[\w@~$.\/*-]+/g)].map(m => m[0].replace(/[.\-]+$/, ''))
    .filter(t => !/^[a-z]+:\/\//i.test(t) && t.length > 1 && (t.includes('/') || /\.[a-z][a-z0-9]*$/i.test(t))))];
  const code = paths.filter(p => !docsClassPath(p, root));
  return { docsOnly: paths.length > 0 && code.length === 0, paths, code };
}

export interface ScopeFlags { ui?: boolean; developerTool?: boolean; agentPrimary?: boolean; dx?: boolean; docsOnly?: boolean }
export const SCOPE_FLAG_TOKENS = ['--ui', '--no-ui', '--no-dx', '--developer-tool', '--agent-primary', '--docs-only'] as const;
export const MARKER_RE = /^<!--\s*gstack-autoplan-scope:(.*?)-->\s*$/;

export function scopeTokens(f: ScopeFlags): string[] {
  return [...(f.ui === true ? ['--ui'] : f.ui === false ? ['--no-ui'] : []), ...(f.dx === false ? ['--no-dx'] : []),
    ...(f.developerTool ? ['--developer-tool'] : []), ...(f.agentPrimary ? ['--agent-primary'] : []), ...(f.docsOnly ? ['--docs-only'] : [])];
}

export function parseScopeTokens(tokens: readonly string[], where: string): ScopeFlags {
  const unknown = tokens.filter(t => !(SCOPE_FLAG_TOKENS as readonly string[]).includes(t));
  if (unknown.length) throw new Error(`${where}: unknown scope flag ${unknown.join(', ')} (known: ${SCOPE_FLAG_TOKENS.join(' ')})`);
  if (tokens.includes('--ui') && tokens.includes('--no-ui')) throw new Error(`${where}: --ui and --no-ui conflict`);
  return {
    ...(tokens.includes('--ui') ? { ui: true } : tokens.includes('--no-ui') ? { ui: false } : {}),
    ...(tokens.includes('--no-dx') ? { dx: false } : {}),
    ...(tokens.includes('--developer-tool') ? { developerTool: true } : {}),
    ...(tokens.includes('--agent-primary') ? { agentPrimary: true } : {}),
    ...(tokens.includes('--docs-only') ? { docsOnly: true } : {}),
  };
}

export const scopeMarker = (tokens: readonly string[]) => `<!-- gstack-autoplan-scope: ${tokens.join(' ')} -->`;

/** The marker on the plan's first line (before any heading), or null. */
export function readScopeMarker(planText: string, file: string): { tokens: string[]; flags: ScopeFlags } | null {
  const m = MARKER_RE.exec(planText.split('\n', 1)[0]!.replace(/^\uFEFF/, '').trimEnd());
  if (!m) return null;
  const tokens = m[1]!.trim().split(/\s+/).filter(Boolean);
  return { tokens, flags: parseScopeTokens(tokens, `scope marker in ${file}`) };
}
