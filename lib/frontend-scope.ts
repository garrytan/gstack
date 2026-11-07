// lib/frontend-scope.ts — which repo paths count as frontend.
//
// Pure module: no I/O, no imports from scripts/. The patterns mirror the
// `m_frontend` arm of bin/gstack-diff-scope (the bash source of truth for
// SCOPE_FRONTEND); test/frontend-scope.test.ts pins the two against the same
// sample paths so they cannot drift. bin/gstack-design-detect.ts uses this to
// derive `scan --changed <base>` targets without consuming a shell-split list.
// The bash script's template-UI content arm (GST-1718: Lit or htm templates in
// .ts/.js) reads file contents, so isFrontendPath stays path-only and the
// detector's targets with it. TEMPLATE_TAG and isTemplateCandidate are that
// arm's regex and candidate rule, for callers that read the file themselves
// (lib/autoplan-scope.ts); test/frontend-scope.test.ts pins them to the script.

const EXTENSIONS = new Set([
  '.css', '.scss', '.less', '.sass', '.pcss',
  '.tsx', '.jsx', '.vue', '.svelte', '.astro',
  '.erb', '.haml', '.slim', '.hbs', '.ejs',
  '.html',
  // Dart: a Flutter widget and a repository share the extension, so the bash
  // script counts .dart as frontend AND backend; only the frontend half lives here.
  '.dart',
]);

// Root-level only: the bash arm's glob (`tailwind.config.*`) is matched against the
// whole repo-relative path, so a nested `apps/web/tailwind.config.js` is not frontend there.
const ROOT_CONFIG_PREFIXES = ['tailwind.config.', 'postcss.config.'];

/** gstack-diff-scope's TEMPLATE_TAG_RE, verbatim (POSIX ERE, matched per line). */
export const TEMPLATE_TAG_ERE = '(^|[^A-Za-z0-9_$.])(html|css|svg)[[:space:]]*`';
/** TEMPLATE_TAG_ERE over a whole file: per line, as grep reads it. */
export const TEMPLATE_TAG = new RegExp(TEMPLATE_TAG_ERE.replace('[[:space:]]', '[^\\S\\n]'), 'm');
/** gstack-diff-scope's TEST_PATH_RE, verbatim. */
export const TEST_PATH_ERE = '(^|/)(tests?|spec|__tests__)/|(^|/)tests?\\.py$|(^|/)test_[^/]+\\.py$|_test\\.(go|py|rb|ts|js|exs|dart)$|\\.(test|spec)\\.[jt]sx?$|_spec\\.rb$|Test\\.(java|kt)$';
const TEST_PATH = new RegExp(TEST_PATH_ERE);
const TEMPLATE_EXT = /\.(ts|js|mjs|cjs|mts|cts)$/;
const TEMPLATE_SKIP = /\.(test|spec)\.|^(test|tests|spec|__tests__|cypress|e2e)\//;

/** Could the content arm count this path: a non-test .ts/.js source file (gstack-diff-scope's TPL_CANDIDATES rule)? */
export function isTemplateCandidate(relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return TEMPLATE_EXT.test(rel) && !TEMPLATE_SKIP.test(rel) && !TEST_PATH.test(rel);
}

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
