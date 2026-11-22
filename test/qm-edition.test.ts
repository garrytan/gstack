import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QM_EDITION, type QmSkill } from '../hosts/qm';
import { commandWords, qmCommandViolations, renderQmEdition, renderSkill, staleQmFiles } from '../scripts/gen-qm-edition';

const ROOT = path.resolve(import.meta.dir, '..');
const edition = renderQmEdition();
const skillFiles = (id: string) => new Map([...edition].filter(([f]) => f.startsWith(`${QM_EDITION.outDir}/${id}/`))
  .map(([f, c]) => [f.slice(`${QM_EDITION.outDir}/${id}/`.length), c]));

describe('QM edition (hosts/qm.ts)', () => {
  test('committed qm/ matches the generator (run: bun run scripts/gen-qm-edition.ts)', () => {
    expect(staleQmFiles()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'qm/edition.json'), 'utf-8')).edition).toBe('gstack-qm');
  });

  test('every shipped file fits QM\'s inline read cap, and descriptions fit its skills index', () => {
    const { fileChars, descriptionChars, indexChars } = QM_EDITION.limits;
    expect(fileChars).toBeLessThan(16_384);
    for (const [file, content] of edition) expect({ file, over: content.length > fileChars }).toEqual({ file, over: false });
    for (const s of QM_EDITION.skills) expect(s.description.length).toBeLessThanOrEqual(descriptionChars);
    const index = QM_EDITION.skills.reduce((n, s) => n + s.id.length + 3 + s.description.length, 0);
    expect(index).toBeLessThanOrEqual(indexChars);
  });

  test('frontmatter carries exactly the name and description QM\'s layer reader requires', () => {
    for (const s of QM_EDITION.skills) {
      const md = edition.get(`${QM_EDITION.outDir}/${s.id}/SKILL.md`)!;
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)![1]!.split('\n');
      expect(fm).toEqual([`name: ${s.id}`, `description: "${s.description}"`]);
      expect(s.id).toMatch(/^gstack-[a-z0-9-]+$/);
      expect(md.slice(md.indexOf('\n---\n') + 5).trim().length).toBeGreaterThan(0);
    }
  });

  test('each first step is literal, in the header and listed with its marker in qm/edition.json', () => {
    const manifest = JSON.parse(edition.get(QM_EDITION.manifest)!);
    expect(manifest.layer_root).toBe(QM_EDITION.outDir);
    for (const s of QM_EDITION.skills) {
      const md = edition.get(`${QM_EDITION.outDir}/${s.id}/SKILL.md`)!;
      expect(md.indexOf(s.firstStep.command)).toBeGreaterThan(0);
      expect(md.indexOf(s.firstStep.command)).toBeLessThan(md.indexOf(s.parts[0]!.heading));
      const row = manifest.skills.find((r: { id: string }) => r.id === s.id);
      expect(row.first_step).toBe(s.firstStep.command);
      expect(new RegExp(row.first_step_marker).test(s.firstStep.command)).toBe(true);
    }
  });

  test('every command a QM skill names is POSIX, git or a script the skill ships', () => {
    for (const s of QM_EDITION.skills) expect(qmCommandViolations(s.id, skillFiles(s.id))).toEqual([]);
  });

  test('the command check refuses what QM\'s sandbox lacks (negative controls)', () => {
    const id = 'gstack-plan';
    const md = (body: string) => new Map([['SKILL.md', body], ['scripts/diff-base.sh', '#!/bin/sh\necho ok\n']]);
    const cases: Array<[string, RegExp]> = [
      ['```bash\ngstack-skill-start --skill review\n```\n', /gstack-skill-start/],
      ['Run `bun run test` first.\n', /"bun"/],
      ['```sh\ngit diff | jq .\n```\n', /"jq"/],
      ['```sh\nsh skills/gstack-plan/scripts/missing.sh\n```\n', /not a script shipped/],
      ['```sh\nsh skills/gstack-other/scripts/diff-base.sh\n```\n', /not a script shipped/],
      ['Read ~/.claude/skills/gstack/review/checklist.md\n', /~\/\.claude/],
      ['{{PREAMBLE}}\n', /\{\{/],
    ];
    for (const [body, want] of cases) expect(qmCommandViolations(id, md(body)).join('\n')).toMatch(want);
    const script = new Map([['SKILL.md', 'x\n'], ['scripts/a.sh', '#!/bin/sh\nnode -e 1\n']]);
    expect(qmCommandViolations(id, script).join('\n')).toMatch(/"node"/);
    expect(qmCommandViolations(id, md('```sh\nsh skills/gstack-plan/scripts/diff-base.sh main\n```\n'))).toEqual([]);
  });

  test('commandWords reads pipelines, substitutions, functions and redirections', () => {
    const { functions, commands } = commandWords('f() {\n  echo "$(git rev-parse HEAD)" 2>&1 | head -n 1\n}\nx=$(git log) || f "a b"\n');
    expect(functions).toEqual(['f']);
    expect(commands.map(w => w[0])).toEqual(['echo', 'head', 'git', 'f', 'git']);
  });

  test('generation fails closed when a source moves', () => {
    const base = QM_EDITION.skills[0]!;
    const variant = (patch: Partial<QmSkill['parts'][number]>): QmSkill => ({ ...base, parts: [{ ...base.parts[0]!, ...patch }] });
    expect(() => renderSkill(variant({ heading: 'No Such Heading' }))).toThrow(/found 0 times/);
    expect(() => renderSkill(variant({ dropBlocks: ['text that is not there'] }))).toThrow(/matched nothing/);
    expect(() => renderSkill(variant({ replaceText: [['text that is not there', 'x']] }))).toThrow(/matched nothing/);
    expect(() => renderSkill(variant({ skipHeadings: ['No Such Heading'] }))).toThrow(/found 0 times/);
    expect(() => renderSkill(variant({ file: 'review/SKILL.md.tmpl', heading: 'Pre-Landing PR Review', level: 1, skipHeadings: [], dropBlocks: [], replaceText: [] }))).toThrow(/unmapped placeholder/);
    // A "# ..." comment inside a code fence is never a heading.
    expect(() => renderSkill(variant({ heading: '$HOME-anchored like the careful/freeze frontmatter hooks: early skill bash runs' }))).toThrow(/found 0 times/);
  });
});
