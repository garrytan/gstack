/**
 * lib/frontend-scope.ts mirrors the m_frontend arm of bin/gstack-diff-scope.
 * Pure cases run everywhere; the parity case runs the bash script in a temp
 * repo (POSIX only) so the two implementations cannot drift silently.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { TEMPLATE_TAG, TEMPLATE_TAG_ERE, TEST_PATH_ERE, isFrontendPath, isTemplateCandidate } from '../lib/frontend-scope';

const ROOT = path.join(import.meta.dir, '..');
const POSIX = process.platform !== 'win32';

const SAMPLES: Array<[string, boolean]> = [
  ['src/components/Button.tsx', true],
  ['src/Button.jsx', true],
  ['pages/index.vue', true],
  ['app/Widget.svelte', true],
  ['site/page.astro', true],
  ['styles/main.css', true],
  ['css/a.scss', true],
  ['x/y/theme.less', true],
  ['x/a.sass', true],
  ['x/a.pcss', true],
  ['app/views/users/show.html.erb', true],
  ['templates/a.haml', true],
  ['templates/a.slim', true],
  ['templates/a.hbs', true],
  ['views/a.ejs', true],
  ['public/index.html', true],
  ['tailwind.config.js', true],
  ['postcss.config.cjs', true],
  ['src/tailwind.config.js', false], // the bash glob is matched against the whole repo-relative path: root-level configs only
  ['packages/ui/postcss.config.cjs', false],
  ['app/assets/stylesheets/app.css', true],
  ['lib/util/components/helper.rb', true],
  ['lib/server.ts', false],
  ['src/api/route.js', false],
  ['README.md', false],
  ['package.json', false],
  ['test/foo.test.ts', false],
  ['components.md', false],
  ['public/Index.HTML', false], // bash globs are case-sensitive; the mirror must agree
  ['src/App.TSX', false],
  ['lib/widgets/bbtm_drawer/view/bbtm_drawer.dart', true],
  ['packages/cache/lib/cache.dart', true],
  ['test/ui/drawer_widget_test.dart', true],
];

describe('isFrontendPath', () => {
  test.each(SAMPLES)('%s → %p', (p, expected) => {
    expect(isFrontendPath(p)).toBe(expected);
  });

  test('normalizes leading ./ and backslashes', () => {
    expect(isFrontendPath('./styles/a.css')).toBe(true);
    expect(isFrontendPath('src\\components\\A.tsx')).toBe(true);
  });
});

describe('template content arm (GST-1718 regex, reused by /autoplan in GST-1750)', () => {
  test('TEMPLATE_TAG_ERE and TEST_PATH_ERE are byte-identical to the script', () => {
    const script = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-diff-scope'), 'utf-8');
    expect(script.match(/^TEMPLATE_TAG_RE='([^']+)'$/m)?.[1]).toBe(TEMPLATE_TAG_ERE);
    expect(script.match(/^TEST_PATH_RE='([^']+)'$/m)?.[1]).toBe(TEST_PATH_ERE);
  });

  test('TEMPLATE_TAG matches a tag before a backtick on one line, as grep -E does', () => {
    for (const s of ['return html`<p>`', 'x = svg `<g/>`', '  css`a{}`', 'foo(html`x`)']) expect(TEMPLATE_TAG.test(s), s).toBe(true);
    for (const s of ['xhtml`x`', 'a.html`x`', 'my_css`x`', 'html\n`x`', 'html("x")']) expect(TEMPLATE_TAG.test(s), s).toBe(false);
  });

  test.each([
    ['plugins/web-ui/src/personas.ts', true], ['src/a.mjs', true], ['a.cts', true],
    ['src/a.test.ts', false], ['src/a.spec.js', false], ['test/a.ts', false], ['e2e/a.ts', false], ['cypress/a.js', false],
    ['src/__tests__/a.ts', false], ['pkg/tests/a.ts', false], ['src/a_test.ts', false], ['src/A.tsx', false], ['src/a.TS', false],
  ] as Array<[string, boolean]>)('isTemplateCandidate(%s) → %p', (p, expected) => {
    expect(isTemplateCandidate(p)).toBe(expected);
  });
});

describe.skipIf(!POSIX)('parity with bin/gstack-diff-scope', () => {
  test('SCOPE_FRONTEND agrees with isFrontendPath for every sample, one file per diff', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-scope-parity-'));
    const git = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'base.txt'), 'x\n');
      git('add', '-A'); git('commit', '-q', '-m', 'base');
      const mismatches: string[] = [];
      for (const [rel, expected] of SAMPLES) {
        git('checkout', '-q', '-b', 'probe');
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '/* x */\n');
        git('add', '-A'); git('commit', '-q', '-m', rel);
        const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-diff-scope'), 'main'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
        const bashSays = /SCOPE_FRONTEND=true/.test(r.stdout);
        if (bashSays !== expected) mismatches.push(`${rel}: bash=${bashSays} ts=${expected}`);
        git('checkout', '-q', 'main'); git('branch', '-q', '-D', 'probe');
      }
      expect(mismatches).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000); // one git commit + one bash run per sample: past bun's 5 s default
});
