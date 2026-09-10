// lib/frontend-scope.ts — which repo paths count as frontend.
//
// Pure module: no I/O, no imports from scripts/. The patterns mirror the
// `m_frontend` arm of bin/gstack-diff-scope (the bash source of truth for
// SCOPE_FRONTEND); test/frontend-scope.test.ts pins the two against the same
// sample paths so they cannot drift. bin/gstack-design-detect.ts uses this to
// derive `scan --changed <base>` targets without consuming a shell-split list.

const EXTENSIONS = new Set([
  '.css', '.scss', '.less', '.sass', '.pcss',
  '.tsx', '.jsx', '.vue', '.svelte', '.astro',
  '.erb', '.haml', '.slim', '.hbs', '.ejs',
  '.html',
]);

// Root-level only: the bash arm's glob (`tailwind.config.*`) is matched against the
// whole repo-relative path, so a nested `apps/web/tailwind.config.js` is not frontend there.
const ROOT_CONFIG_PREFIXES = ['tailwind.config.', 'postcss.config.'];

/** Repo-relative path (forward slashes) → is it a frontend file per gstack-diff-scope? */
export function isFrontendPath(relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot) : ''; // case-sensitive, exactly like gstack-diff-scope's globs
  if (EXTENSIONS.has(ext)) return true;
  if (!rel.includes('/') && ROOT_CONFIG_PREFIXES.some(p => base.startsWith(p))) return true;
  if (rel.startsWith('app/views/')) return true;
  if (rel.includes('/components/')) return true;
  if (rel.startsWith('styles/') || rel.startsWith('css/')) return true;
  if (rel.startsWith('app/assets/stylesheets/')) return true;
  return false;
}
