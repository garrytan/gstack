/**
 * Deprecated codex web-search flag tripwire (#2525).
 *
 * codex >=0.144 deprecates `--enable web_search_cached` (its `--enable
 * <FEATURE>` surface now means `-c features.<name>=true`); the replacement
 * is `-c 'web_search="cached"'`, owned by ONE constant:
 * CODEX_WEB_SEARCH_FLAG in scripts/resolvers/constants.ts. Resolvers
 * interpolate it; templates reference {{CODEX_WEB_SEARCH_FLAG}}.
 *
 * These tests fail CI if the deprecated spelling re-enters any source
 * (resolver, template, helper) or any rendered SKILL.md / section / golden.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'node:os';
import { CODEX_MODEL_CONFIG_FLAG, CODEX_REVIEW_MODEL_CONFIG_FLAG, CODEX_WEB_SEARCH_FLAG } from '../scripts/resolvers/constants';

const ROOT = path.join(import.meta.dir, '..');
const DEPRECATED = '--enable web_search_cached';

function grepRepo(pattern: string, includes: string[], root = ROOT): string[] {
  const matchers = includes.map(include => new Bun.Glob(include));
  // Prune before descending: these trees can contain gigabytes of installed
  // dependencies and historical workspace copies. Generated host output such
  // as .agents/ and checked-in goldens remain part of the regression scan.
  const excluded = new Set(['node_modules', '.claude', '.context', '.git']);
  const hits: string[] = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) pending.push(file);
      } else if (entry.isFile() && matchers.some(matcher => matcher.match(entry.name)) &&
          path.relative(root, file) !== path.join('test', 'codex-web-search-flag.test.ts') &&
          fs.readFileSync(file, 'utf8').includes(pattern)) {
        hits.push(file);
      }
    }
  }
  return hits;
}

describe('deprecated codex web-search flag is gone (#2525)', () => {
  test('the replacement flag has exactly the documented shape', () => {
    expect(CODEX_WEB_SEARCH_FLAG).toBe(`-c 'web_search="cached"'`);
  });

  test('no rendered SKILL.md or section carries the deprecated flag', () => {
    const hits = grepRepo(DEPRECATED, ['SKILL.md', '*.md']);
    expect(hits).toEqual([]);
  });

  test('no source file (resolver, template, helper) carries the deprecated flag', () => {
    const hits = grepRepo(DEPRECATED, ['*.ts', '*.tmpl']);
    expect(hits).toEqual([]);
  });

  test('rendered codex skill actually resolves the token to the live flag', () => {
    const rendered = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(rendered).toContain(CODEX_WEB_SEARCH_FLAG);
    expect(rendered).not.toContain('{{CODEX_WEB_SEARCH_FLAG}}');
  });

  test('rendered codex mode sections resolve the token at every invocation site', () => {
    // The mode bodies (and their codex invocations) are carved into
    // codex/sections/*-mode.md (T9) — each generated section must carry the
    // live flag, never the unresolved token.
    for (const file of ['review-mode.md', 'challenge-mode.md', 'consult-mode.md']) {
      const rendered = fs.readFileSync(path.join(ROOT, 'codex', 'sections', file), 'utf-8');
      expect(rendered, `${file} lost the web-search flag`).toContain(CODEX_WEB_SEARCH_FLAG);
      expect(rendered).not.toContain('{{CODEX_WEB_SEARCH_FLAG}}');
    }
  });

  test('rendered autoplan phase sections resolve the token at every inline site', () => {
    // The four phase bodies (and their codex invocations) are carved into
    // autoplan/sections/*-phase.md — each generated section must carry the
    // live flag, never the unresolved token.
    for (const file of ['ceo-phase.md', 'design-phase.md', 'eng-phase.md', 'dx-phase.md']) {
      const rendered = fs.readFileSync(path.join(ROOT, 'autoplan', 'sections', file), 'utf-8');
      expect(rendered, `${file} lost the web-search flag`).toContain(CODEX_WEB_SEARCH_FLAG);
      expect(rendered).not.toContain('{{CODEX_WEB_SEARCH_FLAG}}');
    }
    const skeleton = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md'), 'utf-8');
    expect(skeleton).not.toContain('{{CODEX_WEB_SEARCH_FLAG}}');
  });
});

describe('codex frontier model flag is present', () => {
  test('the model flag defaults to gpt-6-astra while allowing GSTACK_CODEX_MODEL', () => {
    expect(CODEX_MODEL_CONFIG_FLAG).toBe('-c "model=\\"${GSTACK_CODEX_MODEL:-gpt-6-astra}\\""');
  });

  test('native review overrides both model settings with the same selection', () => {
    for (const override of ['', 'custom-codex']) {
      const argv = execFileSync('bash', ['-c', `printf '%s\\n' ${CODEX_REVIEW_MODEL_CONFIG_FLAG}`], {
        env: { ...process.env, GSTACK_CODEX_MODEL: override }, encoding: 'utf8', timeout: 5000,
      }).trim().split('\n');
      const expected = override || 'gpt-6-astra';
      expect(argv).toEqual(['-c', `model="${expected}"`, '-c', `review_model="${expected}"`]);
    }
    for (const file of ['codex/sections/review-mode.md', 'review/sections/adversarial.md', 'ship/sections/adversarial.md']) {
      const rendered = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const calls = rendered.split('\n').filter(line => line.includes('codex review --base') && line.includes('2>'));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toContain(CODEX_REVIEW_MODEL_CONFIG_FLAG);
    }
  });

  test('rendered codex mode sections resolve the model token at every invocation site', () => {
    for (const file of ['review-mode.md', 'challenge-mode.md', 'consult-mode.md']) {
      const rendered = fs.readFileSync(path.join(ROOT, 'codex', 'sections', file), 'utf-8');
      const invocations = rendered.split('\n').filter(line => /codex (exec|review) /.test(line) && line.includes('2>'));
      expect(invocations.length).toBeGreaterThan(0);
      for (const line of invocations) expect(line, `${file} lost the model flag`).toContain(CODEX_MODEL_CONFIG_FLAG);
      expect(rendered).not.toContain('{{CODEX_MODEL_CONFIG_FLAG}}');
    }
  });

  test('rendered autoplan phase sections resolve the model token at every inline site', () => {
    for (const file of ['ceo-phase.md', 'design-phase.md', 'eng-phase.md', 'dx-phase.md']) {
      const rendered = fs.readFileSync(path.join(ROOT, 'autoplan', 'sections', file), 'utf-8');
      expect(rendered, `${file} lost the model flag`).toContain(CODEX_MODEL_CONFIG_FLAG);
      expect(rendered).not.toContain('{{CODEX_MODEL_CONFIG_FLAG}}');
    }
  });
});


describe('deprecated-flag scanner boundaries', () => {
  test('workspace archives and installed dependencies are excluded before the source walk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-flag-scan-'));
    try {
      for (const file of ['.context/old-checkout/helper.ts', '.git/archive/helper.ts',
        'node_modules/package/helper.ts', 'nested/node_modules/package/helper.ts', '.claude/skills/old/SKILL.md']) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, DEPRECATED);
      }
      expect(grepRepo(DEPRECATED, ['*.ts', '*.md'], root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('real nested source, generated host skills and goldens keep regression coverage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-flag-scan-'));
    const source = ['scripts/resolvers/nested/helper.ts', 'skill/sections/review.md.tmpl'];
    const rendered = ['.agents/skills/gstack-example/SKILL.md', 'skill/sections/review.md', 'test/golden/example.md'];
    try {
      for (const file of [...source, ...rendered]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, DEPRECATED);
      }
      expect(grepRepo(DEPRECATED, ['*.ts', '*.tmpl'], root).sort()).toEqual(source.map(file => path.join(root, file)).sort());
      expect(grepRepo(DEPRECATED, ['SKILL.md', '*.md'], root).sort()).toEqual(rendered.map(file => path.join(root, file)).sort());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
