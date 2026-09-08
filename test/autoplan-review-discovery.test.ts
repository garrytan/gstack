import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
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
    }
  });

  test('the new discovery contract selects the affected live autoplan workflows', () => {
    for (const name of ['autoplan-chain-pty', 'autoplan-dual-voice', 'carve-section-loading']) {
      expect(E2E_TOUCHFILES[name]).toContain('test/autoplan-review-discovery.test.ts');
      expect(E2E_TOUCHFILES[name]).toContain('scripts/resolvers/composition.ts');
    }
  });
});
