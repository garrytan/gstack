/**
 * Lane mapping for paths a framework puts punctuation in, and for imports
 * written through a tsconfig `paths` alias. Both were `no lane` false
 * negatives in a Next.js App Router repo whose tests did name the files:
 *   - `app/(app)/recipes/page.tsx` named in a string (readFileSync) — the
 *     QUOTED literal pattern stopped at `(`, so the literal never matched;
 *   - `app/(app)/recipes/[id]/page.tsx` imported as `@/app/(app)/recipes/[id]/page`
 *     — `@/…` was resolved as a repo path, so it never matched a file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_TSCONFIG_EXTENDS, buildGraph, testsFor } from '../lib/pregate/import-graph';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo(); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('import graph: route-group / dynamic-segment paths and tsconfig path aliases', () => {
  test('a repo-path literal containing ( ) [ ] maps to the file it names', () => {
    const repo = fixture();
    commit(repo, {
      'app/(app)/recipes/page.tsx': 'export default function P() { return null }\n',
      'app/(app)/recipes/[id]/page.tsx': 'export default function D() { return null }\n',
      'app/[[...slug]]/page.tsx': 'export default function C() { return null }\n',
      'test/pages.test.ts': "import { readFileSync } from 'node:fs';\nfor (const f of ['app/(app)/recipes/page.tsx', 'app/(app)/recipes/[id]/page.tsx', 'app/[[...slug]]/page.tsx']) readFileSync(f, 'utf8');\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'app/(app)/recipes/page.tsx').tests).toEqual(['test/pages.test.ts']);
    expect(testsFor(g, 'app/(app)/recipes/[id]/page.tsx').tests).toEqual(['test/pages.test.ts']);
    expect(testsFor(g, 'app/[[...slug]]/page.tsx').tests).toEqual(['test/pages.test.ts']);
  });

  test('a relative literal a test reads through new URL or readFileSync maps from the file that names it', () => {
    const repo = fixture();
    commit(repo, {
      'ship/sections/pr-body.md.tmpl': '## Summary\n',
      'ship/sections/other.md.tmpl': '## Other\n',
      'docs/guide.md': '# guide\n',
      'test/publication.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('../ship/sections/pr-body.md.tmpl', import.meta.url), 'utf8');\nreadFileSync('./../docs/guide.md', 'utf8');\n",
      'test/nested/deep.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('../../ship/sections/other.md.tmpl', 'utf8');\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'ship/sections/pr-body.md.tmpl').tests).toEqual(['test/publication.test.ts']);
    expect(testsFor(g, 'docs/guide.md').tests).toEqual(['test/publication.test.ts']);
    expect(testsFor(g, 'ship/sections/other.md.tmpl').tests).toEqual(['test/nested/deep.test.ts']);
    // A relative literal that climbs out of the repository names nothing.
    commit(repo, { 'test/escape.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('../../../ship/sections/pr-body.md.tmpl', 'utf8');\n" });
    expect(testsFor(buildGraph(repo.work), 'ship/sections/pr-body.md.tmpl').tests).toEqual(['test/publication.test.ts']);
  });

  test('a dotfile named by a quoted literal or a join() maps, relative or from the repo root', () => {
    const repo = fixture();
    commit(repo, {
      '.gitleaks.toml': 'title = "x"\n',
      '.github/workflows/ci.yml': 'on: push\n',
      'test/relative.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8');\n",
      'test/rooted.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('.gitleaks.toml', 'utf8');\n",
      'test/joined.test.ts': "import { join } from 'node:path';\nimport { readFileSync } from 'node:fs';\nreadFileSync(join('.github', 'workflows', 'ci.yml'), 'utf8');\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, '.gitleaks.toml').tests).toEqual(['test/relative.test.ts', 'test/rooted.test.ts']);
    expect(testsFor(g, '.github/workflows/ci.yml').tests).toEqual(['test/joined.test.ts']);
  });

  test('a dot-led literal keeps the edges the base found: no swallowed quote, fixture dotfiles still map', () => {
    const repo = fixture();
    commit(repo, {
      'test/fixtures/x.md': 'x\n',
      '.github/workflows/ci.yml': 'on: push\n',
      'test/.github/workflows/ci.yml': 'on: push\n',
      'test/method.test.ts': "const d = 'a';\nexport const hit = `${d}`.includes('test/fixtures/x.md');\n",
      'test/config.test.ts': "import { join } from 'node:path';\nimport { readFileSync } from 'node:fs';\nreadFileSync(join(__dirname, '.github', 'workflows', 'ci.yml'), 'utf8');\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'test/fixtures/x.md').tests).toEqual(['test/method.test.ts']);
    expect(testsFor(g, 'test/.github/workflows/ci.yml').tests).toEqual(['test/config.test.ts']);
    expect(testsFor(g, '.github/workflows/ci.yml').tests).toEqual(['test/config.test.ts']);
  });

  test('a dot-led literal that names no repo file adds no edge (extensions, missing dotfiles)', () => {
    const repo = fixture();
    commit(repo, {
      'lib/plan.ts': 'export const plan = 1;\n',
      'test/ext.test.ts': "const exts = ['.ts', '.md', '.env', '../.missing.toml', '.github'];\nexport { exts };\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'lib/plan.ts').tests).toEqual([]);
    expect([...g.reverse.values()].flat().filter(e => e.from === 'test/ext.test.ts')).toEqual([]);
  });

  test('a relative import of a bracketed path already maps (control: the import scanner is not the bug)', () => {
    const repo = fixture();
    commit(repo, {
      'app/(app)/recipes/[id]/page.tsx': 'export default function D() { return null }\n',
      'test/detail.test.tsx': "import D from '../app/(app)/recipes/[id]/page';\nD();\n",
    });
    expect(testsFor(buildGraph(repo.work), 'app/(app)/recipes/[id]/page.tsx').tests).toEqual(['test/detail.test.tsx']);
  });

  test('an import through a tsconfig paths alias (JSONC, with comments and a trailing comma) maps; so does a vi.mock of it', () => {
    const repo = fixture();
    commit(repo, {
      'tsconfig.json': '{\n  // Next.js default\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["./*"], "~lib/*": ["lib/*"], },\n  },\n}\n',
      'app/(app)/recipes/[id]/page.tsx': 'export default function D() { return null }\n',
      'lib/plan.ts': 'export const plan = 1;\n',
      'lib/mocked.ts': 'export const m = 1;\n',
      'test/detail.test.tsx': "import D from '@/app/(app)/recipes/[id]/page';\nimport { plan } from '~lib/plan';\nvi.mock('@/lib/mocked', () => ({}));\nD(); plan;\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'app/(app)/recipes/[id]/page.tsx').tests).toEqual(['test/detail.test.tsx']);
    expect(testsFor(g, 'lib/plan.ts').tests).toEqual(['test/detail.test.tsx']);
    expect(testsFor(g, 'lib/mocked.ts').tests).toEqual(['test/detail.test.tsx']);
  });

  test('without a tsconfig an @scope/pkg import still resolves to nothing (no new false edges)', () => {
    const repo = fixture();
    commit(repo, {
      'lib/plan.ts': 'export const plan = 1;\n',
      'test/scoped.test.ts': "import { x } from '@scope/plan';\nx;\n",
    });
    expect(testsFor(buildGraph(repo.work), 'lib/plan.ts').tests).toEqual([]);
  });
});

describe('import graph: alias precedence, extends and the no-lane explanation', () => {
  const twoAliases = (specificFirst: boolean) => {
    const specific = '"@/lib/*": ["src/lib/*"]';
    const broad = '"@/*": ["./*"]';
    return `{ "compilerOptions": { "paths": { ${specificFirst ? `${specific}, ${broad}` : `${broad}, ${specific}`} } } }\n`;
  };

  for (const specificFirst of [true, false]) {
    test(`overlapping aliases pick the most specific pattern when both targets exist (${specificFirst ? 'specific' : 'broad'} key first)`, () => {
      const repo = fixture();
      commit(repo, {
        'tsconfig.json': twoAliases(specificFirst),
        'lib/x.ts': 'export const x = "root";\n',
        'src/lib/x.ts': 'export const x = "src";\n',
        'test/x.test.ts': "import { x } from '@/lib/x';\nx;\n",
      });
      const g = buildGraph(repo.work);
      expect(testsFor(g, 'src/lib/x.ts').tests).toEqual(['test/x.test.ts']);
      expect(testsFor(g, 'lib/x.ts').tests).toEqual([]);
    });
  }

  test('an exact alias wins over a wildcard that also matches', () => {
    const repo = fixture();
    commit(repo, {
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./*"], "@/env": ["src/env.ts"] } } }\n',
      'env.ts': 'export const env = 1;\n',
      'src/env.ts': 'export const env = 2;\n',
      'test/env.test.ts': "import { env } from '@/env';\nenv;\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'src/env.ts').tests).toEqual(['test/env.test.ts']);
    expect(testsFor(g, 'env.ts').tests).toEqual([]);
  });

  test('a later target is the fallback when the first target does not exist', () => {
    const repo = fixture();
    commit(repo, {
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["src/*", "generated/*"] } } }\n',
      'generated/api.ts': 'export const api = 1;\n',
      'test/api.test.ts': "import { api } from '@/api';\napi;\n",
    });
    expect(testsFor(buildGraph(repo.work), 'generated/api.ts').tests).toEqual(['test/api.test.ts']);
  });

  test('when the chosen alias resolves nothing, every plausible reading gains the edge (uncertainty selects more)', () => {
    const repo = fixture();
    commit(repo, {
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@/ui/*": ["packages/ui/*"], "@/*": ["src/*"] } } }\n',
      'src/ui/button.ts': 'export const b = 1;\n',
      'test/button.test.ts': "import { b } from '@/ui/button';\nb;\n",
    });
    expect(testsFor(buildGraph(repo.work), 'src/ui/button.ts').tests).toEqual(['test/button.test.ts']);
  });

  test('a relative extends chain supplies paths and baseUrl relative to the config that declares them', () => {
    const repo = fixture();
    commit(repo, {
      'tsconfig.json': '{ "extends": "./config/tsconfig.base", "compilerOptions": { "strict": true } }\n',
      'config/tsconfig.base.json': '{ "extends": "./tsconfig.paths.json" }\n',
      'config/tsconfig.paths.json': '{ "compilerOptions": { "baseUrl": "..", "paths": { "#lib/*": ["lib/*"] } } }\n',
      'lib/plan.ts': 'export const plan = 1;\n',
      'test/plan.test.ts': "import { plan } from '#lib/plan';\nplan;\n",
    });
    expect(testsFor(buildGraph(repo.work), 'lib/plan.ts').tests).toEqual(['test/plan.test.ts']);
  });

  test('trailing commas are dropped by the tokenizer, never inside a string', () => {
    const repo = fixture();
    commit(repo, {
      'tsconfig.json': '{ "compilerOptions": { "paths": { "~a,]/*": ["lib/*",], }, }, }\n',
      'lib/plan.ts': 'export const plan = 1;\n',
      'test/plan.test.ts': "import { plan } from '~a,]/plan';\nplan;\n",
    });
    expect(testsFor(buildGraph(repo.work), 'lib/plan.ts').tests).toEqual(['test/plan.test.ts']);
  });

  test('an extends chain past the depth limit is named in the no-lane explanation, with the unresolved specifiers', () => {
    const repo = fixture();
    const files: Record<string, string> = {
      'tsconfig.json': '{ "extends": "./c1.json" }\n',
      'lib/plan.ts': 'export const plan = 1;\n',
      'test/plan.test.ts': "import { plan } from '#lib/plan';\nimport { gone } from '../lib/gone';\nimport { expect } from 'bun:test';\nimport React from 'react';\nplan; gone; expect; React;\n",
    };
    for (let i = 1; i <= MAX_TSCONFIG_EXTENDS; i++) files[`c${i}.json`] = `{ "extends": "./c${i + 1}.json" }\n`;
    files[`c${MAX_TSCONFIG_EXTENDS + 1}.json`] = '{ "compilerOptions": { "paths": { "#lib/*": ["lib/*"] } } }\n';
    commit(repo, files);
    const m = testsFor(buildGraph(repo.work), 'lib/plan.ts');
    expect(m.tests).toEqual([]);
    const text = m.provenance.join('\n');
    expect(text).toContain(`tsconfig extends depth limit ${MAX_TSCONFIG_EXTENDS}`);
    expect(text).toContain("test/plan.test.ts: '#lib/plan' '../lib/gone'");
    expect(text).not.toContain("'react'");
    expect(text).not.toContain("'bun:test'");
    expect(text).toContain('declare the file under dependencies in .gstack/pregate.json, or report the resolver gap');
  });
});
