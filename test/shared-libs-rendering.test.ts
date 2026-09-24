import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { discoverTemplates } from '../scripts/discover-skills';
import { sharedLibsPlanExcerpt } from './helpers/shared-libs-plan-excerpt';

const ROOT = resolve(import.meta.dir, '..');
let output: string;

function rendered(host: (typeof ALL_HOST_CONFIGS)[number], skill: string): string {
  const dir = host.name === 'claude' ? join(output, skill)
    : join(output, host.hostSubdir, 'skills', `gstack-${skill}`);
  const sections = join(dir, 'sections');
  return readFileSync(join(dir, 'SKILL.md'), 'utf8') + (existsSync(sections)
    ? readdirSync(sections).filter(f => f.endsWith('.md')).sort()
      .map(f => '\n' + readFileSync(join(sections, f), 'utf8')).join('') : '');
}

describe('shared-code skill distribution', () => {
  beforeAll(() => {
    output = mkdtempSync(join(tmpdir(), 'gstack-shared-libs-render-'));
    const result = spawnSync('bun', ['run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', output],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);
  afterAll(() => { if (output) rmSync(output, { recursive: true, force: true }); });

  test('the new authored template is discovered without a hand-maintained installer list', () => {
    expect(discoverTemplates(ROOT)).toContainEqual({
      tmpl: 'deslop-shared-libs/SKILL.md.tmpl', output: 'deslop-shared-libs/SKILL.md',
    });
    expect(readFileSync(join(output, 'gstack/llms.txt'), 'utf8')).toContain('deslop-shared-libs');
    expect(readFileSync(join(output, 'SKILL.md'), 'utf8')).toContain('invoke `/deslop-shared-libs`');
  });

  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name}: all three workflows receive the same evaluation criteria`, () => {
      const texts = ['deslop-shared-libs', 'plan-eng-review', 'review'].map(skill => rendered(host, skill));
      for (const text of texts) {
        expect(text.match(/### Shared-code evaluation rubric/g)?.length).toBe(1);
        expect(text).toContain('at least two verified, first-party authored source');
        expect(text).toContain('Count moved code on both sides');
        expect(text).toContain('Only an engineering-plan review may use proposed callers');
        expect(text).not.toContain('{{SHARED_LIBS_RUBRIC}}');
      }
      const standalone = texts[0];
      expect(standalone).not.toContain('gstack-skill-start');
      expect(standalone).not.toContain('gstack-skill-end');
      expect(standalone).not.toContain('## Preamble');
      expect(standalone).toContain('five metadata pages and fifty');
      expect(standalone).toContain('including repeated page numbers');
      expect(standalone).toContain('temporary files and files outside the repository');
      expect(standalone).toContain('Keep API responses and intermediate data on stdout or in memory');
      expect(standalone).toContain('--no-lazy-fetch');
      expect(standalone).toContain('log.showSignature=false');
      expect(standalone).toContain('python3 -I -S');
      expect(standalone).toContain('two explicit committed object IDs');
      expect(standalone).toContain('same Git tree');
      expect(standalone).toContain('Do not invoke Git');
      expect(standalone).toContain('transports, including `ls-remote`');
      expect(standalone).toContain('including by decoding loose');
      expect(texts[2]).toContain('snapshot_covered_paths');
      expect(texts[2]).toContain('Exclude assume-unchanged, skip-worktree');
      expect(texts[2]).toContain('byte-for-byte with its blob');
      for (const parent of [texts[2], rendered(host, 'ship')]) {
        const validation = parent.indexOf('**Validate advisory severity first.**');
        expect(validation).toBeGreaterThanOrEqual(0);
        expect(validation).toBeLessThan(parent.indexOf('Before classifying findings, check'));
        expect(parent).toContain('remove `advisory` and retain its `CRITICAL` severity');
        expect(parent).toContain('Never downgrade severity to make advisory metadata consistent');
        expect(parent).toContain('Valid INFORMATIONAL advisories remain advisory in every category, including simplification');
        expect(parent).toContain('contradictory CRITICAL/advisory metadata cannot establish a skipped defect or advisory decision');
        const merge = parent.indexOf('**Parse findings:**');
        if (merge >= 0) {
          expect(parent.indexOf('**Validate advisory severity first.**', merge))
            .toBeLessThan(parent.indexOf('**Fingerprint and deduplicate:**', merge));
        }
      }
    });
  }

  test('Codex keeps the core check when Review Army is suppressed', () => {
    const codex = ALL_HOST_CONFIGS.find(host => host.name === 'codex')!;
    const review = rendered(codex, 'review');
    expect(review).not.toContain('### Dispatch specialists');
    expect(review).toContain('### Shared-code evaluation rubric');
    expect(review).toContain('sharedLibsFingerprint');
    expect(review).toContain('advisory');
    expect(review).toContain('ASK');
  });

  test('the bounded plan fixture includes the generated decision prerequisites before Code Quality', () => {
    const entrypoint = readFileSync(join(output, 'plan-eng-review/SKILL.md'), 'utf8');
    const review = readFileSync(join(output, 'plan-eng-review/sections/review-sections.md'), 'utf8');
    const excerpt = sharedLibsPlanExcerpt(entrypoint, review);
    const headings = ['## AskUserQuestion Format', '## My engineering preferences',
      '## Review record and write policy', '**Plan-review evidence:**',
      '## Confidence Calibration', '## Decision procedure',
      '### 1. Establish current state', '### 2. Separate independent choices',
      '### 3. Compare one choice', '### 4. Save the pending record',
      '### 5. Ask and wait', '### 6. Apply and refresh',
      '### 2. Code quality review', '### Shared-code evaluation rubric', '**Blocked outcome:**'];
    const positions = headings.map(heading => excerpt.indexOf(heading));
    expect(positions.every(index => index >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(excerpt.match(/^## Decision procedure$/gm)).toHaveLength(1);
    expect(excerpt).toContain('AskUserQuestion({ questions: [currentDecision] })');
    expect(excerpt).toContain('D-numbering: exclude the initial target menu');
    expect(excerpt).toContain('**Check each artifact and parent directory\'s permission before writing.**');
    expect(excerpt).toContain('Check the Write/Edit result, then use Read to fetch the entire saved record.');
    expect(excerpt).toContain('Check the save result, then Read the entire resolution block, including State.');
    expect(excerpt).toContain('Only an engineering-plan review may use proposed callers');
    expect(excerpt).not.toMatch(/^## (?:Scope Challenge|Outside Voice|Required outputs)/m);
    expect(excerpt).not.toMatch(/^### [134]\. (?:Architecture|Test|Performance) review/m);
    expect(excerpt).not.toContain('gstack-skill-start --');

    // Exact source slices preserve the complete native brief and decision loop.
    for (const [source, start, end] of [
      [entrypoint, '## AskUserQuestion Format', '## Artifacts Sync'],
      [review, '## Review record and write policy', '## Prior Learnings'],
      [review, '## Decision procedure', '## Scope Challenge'],
      [review, '### 2. Code quality review', '### 3. Test review'],
    ]) expect(excerpt).toContain(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))));

    for (const [source, marker] of [[entrypoint, '## AskUserQuestion Format'],
      [review, '## Review record and write policy'], [review, '## Decision procedure'],
      [review, '## Scope Challenge']] as const) {
      const damaged = source.replace(marker, '## Missing prerequisite');
      expect(() => sharedLibsPlanExcerpt(source === entrypoint ? damaged : entrypoint,
        source === review ? damaged : review)).toThrow(/marker not found/);
    }
  });

  test('standalone catalog entry adds exactly the approved 82 bytes', () => {
    const skill = readFileSync(join(output, 'deslop-shared-libs/SKILL.md'), 'utf8');
    const description = skill.match(/^description: (.+)$/m)?.[1];
    expect(description).toBe('Find worthwhile shared-code extractions in recent work. (gstack)');
    expect(Buffer.byteLength('deslop-shared-libs') + Buffer.byteLength(description!)).toBe(82);
  });
});
