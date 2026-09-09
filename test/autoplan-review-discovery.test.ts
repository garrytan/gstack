import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateAutoplanReviewFile } from '../scripts/resolvers/composition';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const REVIEWS = ['plan-ceo-review', 'plan-design-review', 'plan-devex-review', 'plan-eng-review'];
let owned: string;
let rendered: string;

function installFile(source: string, destination: string, mode: 'copy' | 'symlink') {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (mode === 'copy') fs.copyFileSync(source, destination);
  else fs.symlinkSync(source, destination);
}

function methodology(phase: string, entry: string, restore: string) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin/gstack-autoplan-snapshot.ts'), 'methodology', phase, entry, restore], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  });
}

function assertBundle(result: ReturnType<typeof methodology>, expected: string[]) {
  expect(result.status, result.stderr).toBe(0);
  const manifest = JSON.parse(result.stdout);
  const bundle = fs.readFileSync(manifest.methodologyPath);
  expect(createHash('sha256').update(bundle).digest('hex')).toBe(manifest.sha256);
  expect(bundle.length).toBe(manifest.bytes);
  expect(manifest.sources.map((part: any) => part.path)).toEqual(expected);
  for (const part of manifest.sources) {
    const actual = fs.readFileSync(part.path);
    expect(bundle.subarray(part.startByte, part.endByte)).toEqual(actual);
    expect(createHash('sha256').update(actual).digest('hex')).toBe(part.sha256);
    expect(actual.length).toBe(part.bytes);
  }
  if (process.platform !== 'win32') expect(fs.statSync(manifest.methodologyPath).mode & 0o777).toBe(0o444);
  return manifest;
}

beforeAll(() => {
  owned = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-autoplan-discovery-'));
  rendered = path.join(owned, 'rendered');
  const result = spawnSync(process.execPath, ['run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', rendered], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  });
  expect(result.status, result.stderr).toBe(0);
}, 120_000);

afterAll(() => { if (owned) fs.rmSync(owned, { recursive: true, force: true }); });

describe('autoplan reads installed host methodology', () => {
  for (const host of ALL_HOST_CONFIGS) {
    for (const mode of (process.platform === 'win32' ? ['copy'] : ['copy', 'symlink']) as Array<'copy' | 'symlink'>) {
    test(`${host.name} reads its generated review files from ${host.name === 'claude' ? 'the canonical global path' : 'local and global paths'} in ${mode} installations`, () => {
      const generatedRoot = host.name === 'claude' ? rendered : path.join(rendered, host.hostSubdir, 'skills');
      const entryName = host.name === 'claude' ? 'autoplan' : 'gstack-autoplan';
      const generatedEntry = path.join(generatedRoot, entryName, 'SKILL.md');
      const body = fs.readFileSync(generatedEntry, 'utf8');
      if (host.name === 'claude') {
        for (const review of REVIEWS) expect(body).toContain(`~/.claude/skills/gstack/${review}/SKILL.md`);
      } else {
        // Read the path actually emitted in the entrypoint. Resolving it from
        // the installed entrypoint works for copied installs and symlinked ones.
        const refs = [...body.matchAll(/`(\.\.\/gstack-plan-[a-z-]+\/SKILL\.md)`/g)].map(match => match[1]!);
        expect([...new Set(refs)].sort()).toEqual(REVIEWS.map(name => `../gstack-${name}/SKILL.md`).sort());
        for (const review of REVIEWS) expect(body).not.toContain(`$GSTACK_ROOT/${review}/SKILL.md`);
        expect(body).toContain('same installed skill registry as /autoplan');
      }
      const roots = host.name === 'claude'
        ? [path.join(owned, host.name, mode, 'home', host.globalRoot)]
        : [path.join(owned, host.name, mode, 'repo', path.dirname(host.localSkillRoot)), path.join(owned, host.name, mode, 'home', path.dirname(host.globalRoot))];
      if (host.name === 'codex') roots.push(path.join(owned, 'codex', mode, 'custom-codex-home', 'skills'));
      for (const registry of roots) {
        const entry = path.join(registry, entryName, 'SKILL.md');
        installFile(generatedEntry, entry, mode);
        for (const review of REVIEWS) {
          const reviewName = host.name === 'claude' ? review : `gstack-${review}`;
          const generatedReview = path.join(generatedRoot, reviewName, 'SKILL.md');
          installFile(generatedReview, path.join(registry, reviewName, 'SKILL.md'), mode);
          // A runtime root may be an unrelated checkout. Its old canonical
          // review file must never be selected instead of the installed host.
          const stale = path.join(registry, 'gstack', review, 'SKILL.md');
          fs.mkdirSync(path.dirname(stale), { recursive: true });
          fs.writeFileSync(stale, 'STALE FOREIGN HARNESS SKILL');
          const reference = host.name === 'claude' ? `../${review}/SKILL.md` : [...body.matchAll(/`(\.\.\/gstack-plan-[a-z-]+\/SKILL\.md)`/g)].find(match => match[1] === `../gstack-${review}/SKILL.md`)![1]!;
          const loaded = fs.readFileSync(path.resolve(path.dirname(entry), reference), 'utf8');
          expect(loaded).toBe(fs.readFileSync(generatedReview, 'utf8'));
          expect(loaded).not.toContain('STALE FOREIGN HARNESS SKILL');
          if (host.name === 'codex') expect(loaded).toContain('"outside_provider":"claude-code"');
          const phase = review === 'plan-devex-review' ? 'dx' : review.split('-')[1]!;
          const phaseBody = host.name === 'claude'
            ? fs.readFileSync(path.join(generatedRoot, 'autoplan', 'sections', `${phase}-phase.md`), 'utf8')
            : body;
          const directive = phaseBody.split('\n').find(line => line.startsWith('Before dispatch, fully Read ')
            && (line.includes(`methodology ${phase} `) || line.includes(`/${review}/SKILL.md`) || line.includes(`/gstack-${review}/SKILL.md`)));
          expect(directive).toBeDefined();
          expect(phaseBody.indexOf(directive!)).toBeLessThan(phaseBody.indexOf(`create ${phase} `));
          // U's CEO loaded this section only after its child finished. Pin the
          // concrete prerequisite, then resolve the rendered path in real
          // copy/symlink installations; references alone are not its contents.
          if (host.name === 'claude') {
            expect(directive).toContain(`methodology ${phase} `);
            expect(directive).toContain('`methodologyPath` from');
            expect(directive).toContain('"<REVIEW_SKILL>"');
            const relative = 'sections/review-sections.md';
            const sectionSource = path.join(generatedRoot, review, relative);
            const sectionInstalled = path.resolve(path.dirname(entry), reference, '..', relative);
            installFile(sectionSource, sectionInstalled, mode);
            const section = fs.readFileSync(sectionInstalled, 'utf8');
            expect(section).toBe(fs.readFileSync(sectionSource, 'utf8'));
            expect(section).toContain('## Review Sections');
            // W read the whole main file but skipped this section before Agent
            // dispatch. A real helper invocation now supplies one complete
            // byte-preserving target, instead of asking the model to concatenate.
            expect(loaded).not.toContain('## Review Sections');
            const restore = path.join(registry, 'restore.md');
            fs.writeFileSync(restore, 'owned restore\n');
            const skillPath = path.resolve(path.dirname(entry), reference);
            assertBundle(methodology(phase, skillPath, restore), [skillPath, sectionInstalled]);
          } else {
            expect(directive).not.toContain('sections/review-sections.md');
            expect(loaded).toContain('## Review Sections');
            const restore = path.join(registry, 'restore.md');
            fs.writeFileSync(restore, 'owned restore\n');
            const skillPath = path.resolve(path.dirname(entry), reference);
            assertBundle(methodology(phase, skillPath, restore), [skillPath]);
          }
        }
      }
    });
    }
  }

  test('host identity, not the model overlay, selects the registry; invalid skills fail closed', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const ctx = { skillName: 'autoplan', tmplPath: '', host: host.name, paths: HOST_PATHS[host.name] } as TemplateContext;
      for (const review of REVIEWS) {
        expect(generateAutoplanReviewFile({ ...ctx, model: 'gpt' }, [review])).toBe(generateAutoplanReviewFile({ ...ctx, model: 'claude' }, [review]));
      }
      expect(() => generateAutoplanReviewFile(ctx, ['../foreign'])).toThrow();
      expect(() => generateAutoplanReviewFile(ctx, ['plan-ceo-review', '../foreign'])).toThrow();
    }
  });

  test('methodology validation fails before publication; repeated valid loads keep prior bytes', () => {
    const registry = fs.mkdtempSync(path.join(owned, 'method-errors-'));
    const entry = path.join(registry, 'SKILL.md');
    const section = path.join(registry, 'sections/review-sections.md');
    const restore = path.join(registry, 'restore.md');
    fs.mkdirSync(path.dirname(section));
    fs.writeFileSync(restore, 'restore remains exact\n');
    const main = '---\r\nname: plan-ceo-review\r\n---\r\n## Section index\r\n| when | `sections/review-sections.md` |\r\n## Step 0\r\nFull first step 🌱\r\n';
    const deep = '## Review Sections\r\nRequired late verification β\r\n';
    fs.writeFileSync(entry, main);
    const reject = () => {
      const before = fs.readdirSync(registry).sort();
      const result = methodology('ceo', entry, restore);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('gstack-autoplan-snapshot:');
      expect(fs.readdirSync(registry).sort()).toEqual(before);
      expect(fs.readFileSync(restore, 'utf8')).toBe('restore remains exact\n');
    };
    reject(); // required section absent
    fs.writeFileSync(section, '```md\n## Review Sections\n```\n'); reject();
    fs.writeFileSync(section, deep + 'Read `sections/missing.md`.\n'); reject();
    fs.writeFileSync(section, deep);
    fs.writeFileSync(entry, main.replace('name: plan-ceo-review', 'name: plan-eng-review')); reject();
    fs.writeFileSync(entry, main.replace('## Step 0', '| extra | `sections/extra.md` |\r\n## Step 0')); reject();
    fs.writeFileSync(entry, main);
    const first = assertBundle(methodology('ceo', entry, restore), [entry, section]);
    const original = fs.readFileSync(first.methodologyPath);
    const second = assertBundle(methodology('ceo', entry, restore), [entry, section]);
    expect(second.methodologyPath).not.toBe(first.methodologyPath);
    expect(fs.readFileSync(first.methodologyPath)).toEqual(original);
    expect(fs.readFileSync(entry, 'utf8')).toBe(main);
    expect(fs.readFileSync(section, 'utf8')).toBe(deep);
  });

  test('the new discovery contract selects the affected live autoplan workflows', () => {
    for (const name of ['autoplan-chain-pty', 'autoplan-dual-voice', 'carve-section-loading']) {
      expect(E2E_TOUCHFILES[name]).toContain('test/autoplan-review-discovery.test.ts');
      expect(E2E_TOUCHFILES[name]).toContain('scripts/resolvers/composition.ts');
    }
  });
});
