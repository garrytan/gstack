/**
 * docs_only — the repository's own human-docs paths in .gstack/ship-policy.json (GST-1974; docs/pregate.md#repo-docs-paths),
 * and the built-in deny list lib/docs-only.ts applies to every path, built-in or repo-allowed. Its own module so the
 * policy reader (lib/ship-policy.ts) and the classifier share one deny list without the reader importing the classifier.
 *
 * The block is `{ allow: [globs], deny?: [globs], tests?: [test files] }`. Allow entries widen the docs allowlist, so they are narrow by
 * construction: each ends in `.md`, starts with a literal path segment, names no hidden, code or agent directory and no
 * built-in deny entry. Deny entries only remove paths, so any contained glob is accepted. Tests are the repository's own
 * checks for its docs directories: the docs lane runs them, and a non-docs file that reads an allowed directory must be
 * tied to one of them (lib/docs-only.ts directory readers). Unknown keys are warnings to the
 * reader; the classifier then ignores the allow list, so a gstack that does not understand a key never widens on it.
 */
import type { PolicyError } from './ship-policy';
import { globError } from './ship-policy-bookkeeping';

export interface DocsOnlyPolicy { allow: string[]; deny?: string[]; tests?: string[] }

export const DOCS_ONLY_KEYS: readonly string[] = ['allow', 'deny', 'tests'];
const MAX_ALLOW = 16, MAX_DENY = 64, MAX_TESTS = 16;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Agent-loaded Markdown, tool configuration, pinned results, preregistrations and fragment instructions: never docs, whatever a repo allows. */
export const DOCS_ONLY_DENY: readonly [RegExp, string][] = [
  [/(?:^|\/)(?:skill|agents|claude|gemini|ethos|crew|captain|factory|driver|checklist|unattended|pregate|lane-card|notes|digest|soul)\.md$/i, 'agent instructions'],
  [/-policy\.md$/i, 'policy doc'],
  [/(?:^|\/)preferences[^/]*$/i, 'preferences'],
  [/(?:^|\/)(?:sections|templates|specialists|skills|prompts?)\//i, 'agent instructions'],
  [/(?:^|\/|[-_.])prompts?\.md$/i, 'prompt file'],
  [/\.tmpl$/i, 'template'],
  [/(?:^|\/)\.[^/]+\//, 'tool configuration directory'],
  [/(?:^|\/)(?:evals|inventory)\//, 'pinned results'],
  [/prereg/i, 'preregistration'],
  [/^changelog\.d\/README\.md$/i, 'fragment instructions'],
];

/** Directory names that hold code, tests or agent instructions; neither an allow pattern nor a path it admits may pass through one. */
export const CODE_DIRS = new Set(['skills', 'templates', 'sections', 'specialists', 'prompts', 'prompt', 'test', 'tests', 'spec', '__tests__', 'fixtures', 'lib', 'bin', 'scripts', 'src', 'node_modules', 'vendor', 'dist', 'build']);
const NARROW = 'allow takes narrow Markdown globs under one literal directory, such as "wiki/board/**.md"';

function allowError(p: string): string | null {
  const contained = globError(p);
  if (contained) return contained;
  if (!p.endsWith('.md') || p.endsWith('/.md')) return 'must end in .md: only Markdown prose can skip the test suites';
  const segs = p.split('/');
  if (/[?[\]{}]/.test(p)) return 'must use only * and ** as wildcards';
  if (segs[0]!.includes('*')) return 'must start with a literal directory or file name, never a wildcard';
  if (segs[0]!.startsWith('.')) return 'must not name a hidden directory (.github, .gstack and the like hold configuration)';
  const dir = segs.find(s => CODE_DIRS.has(s.toLowerCase()));
  if (dir) return `must not pass through ${dir}/, which holds code, tests or agent instructions`;
  const deny = DOCS_ONLY_DENY.find(([r]) => r.test(p));
  if (deny) return `names ${deny[1]}, which the built-in deny list always refuses`;
  return null;
}

/** Shape and pattern errors in a `docs_only` value (not null). Unknown keys are not errors (unknownKeyWarnings). */
export function docsOnlyPolicyErrors(raw: unknown): PolicyError[] {
  const d = raw as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [{ code: 'POLICY_INVALID', path: 'docs_only', message: 'must be { allow, deny?, tests? } or null' }];
  const out: PolicyError[] = [];
  const list = (key: 'allow' | 'deny' | 'tests', min: number, max: number, check: (p: string) => string | null, hint: string) => {
    const v = d[key];
    if (key !== 'allow' && v === undefined) return;
    if (!Array.isArray(v) || v.length < min || v.length > max) { out.push({ code: 'POLICY_INVALID', path: `docs_only.${key}`, message: `must list ${min} to ${max} entries${hint}` }); return; }
    v.forEach((p, i) => {
      const why = typeof p === 'string' ? check(p) : 'must be a string';
      if (why) out.push({ code: 'POLICY_INVALID', path: `docs_only.${key}[${i}]`, message: `${JSON.stringify(p)} ${why}${hint}` });
    });
  };
  list('allow', 1, MAX_ALLOW, allowError, `; ${NARROW}`);
  list('deny', 0, MAX_DENY, globError, '');
  list('tests', 0, MAX_TESTS, t => globError(t) ?? (/[*?[\]{}]/.test(t) || !TEST_FILE.test(t) || /^\.(?:gstack|github)\//.test(t) ? 'must be one test file path (*.test.ts and the like), not a glob or a path under .gstack/ or .github/' : null), '');
  return out;
}

export interface PolicyWarning { path: string; message: string }

/** Keys a newer gstack may add under `at`: ignored here with a warning instead of refusing the whole policy. */
export function unknownKeyWarnings(at: string, raw: unknown, known: readonly string[]): PolicyWarning[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw).filter(k => !known.includes(k)).map(k => ({ path: `${at}.${k}`, message: `unknown key, ignored (a newer gstack may read it; check the spelling)${at === 'docs_only' ? '; the docs-only classifier ignores this block\'s allow list while it is present' : ''}` }));
}

