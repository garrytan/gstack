import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
    expect(fs.readFileSync(path.join(ROOT, 'qm/sandbox/skills/gstack-review/scripts/diff-base.sh'), 'utf-8'))
      .toBe(fs.readFileSync(path.join(ROOT, 'hosts/qm/scripts/diff-base.sh'), 'utf-8'));
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
    const id = 'gstack-review';
    const md = (body: string) => new Map([['SKILL.md', body], ['scripts/diff-base.sh', '#!/bin/sh\necho ok\n']]);
    const cases: Array<[string, RegExp]> = [
      ['```bash\ngstack-skill-start --skill review\n```\n', /gstack-skill-start/],
      ['Run `bun run test` first.\n', /"bun"/],
      ['```sh\ngit diff | jq .\n```\n', /"jq"/],
      ['```sh\nsh skills/gstack-review/scripts/missing.sh\n```\n', /not a script shipped/],
      ['```sh\nsh skills/gstack-plan/scripts/diff-base.sh\n```\n', /not a script shipped/],
      ['Read ~/.claude/skills/gstack/review/checklist.md\n', /~\/\.claude/],
      ['{{PREAMBLE}}\n', /\{\{/],
    ];
    for (const [body, want] of cases) expect(qmCommandViolations(id, md(body)).join('\n')).toMatch(want);
    const script = new Map([['SKILL.md', 'x\n'], ['scripts/a.sh', '#!/bin/sh\nnode -e 1\n']]);
    expect(qmCommandViolations(id, script).join('\n')).toMatch(/"node"/);
    expect(qmCommandViolations(id, md('```sh\nsh skills/gstack-review/scripts/diff-base.sh main\n```\n'))).toEqual([]);
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

describe('diff-base.sh (gstack-review first step)', () => {
  const script = path.join(ROOT, QM_EDITION.scriptSourceDir, 'diff-base.sh');
  const shell = fs.existsSync('/bin/dash') ? '/bin/dash' : 'sh';
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=qm-test', '-c', 'user.email=qm-test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf-8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync(shell, [script, ...args], { cwd, encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(0);
    return r.stdout;
  };
  const repo = (branch = 'main') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-diff-base-'));
    git(dir, 'init', '-q', '-b', branch);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    return dir;
  };

  test('parses under sh -n', () => {
    expect(spawnSync(shell, ['-n', script], { timeout: 30_000 }).status).toBe(0);
  });

  test('a feature branch: base, merge base, diff stat and the next command', () => {
    const dir = repo();
    const mb = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    git(dir, 'commit', '-qam', 'change');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    const out = run(dir);
    expect(out).toContain('BASE: main\n');
    expect(out).toContain(`MERGE_BASE: ${mb}\n`);
    expect(out).toContain('a.txt');
    expect(out).toContain('new.txt');
    expect(out).toContain(`NEXT: git diff ${mb}\n`);
    expect(run(dir, 'main')).toContain('BASE: main\n');
    fs.rmSync(path.join(dir, 'new.txt'));
    expect(run(dir, 'feature')).toContain('NOTHING_TO_REVIEW');
  });

  test('more than 30 untracked files: the first 30 are listed and the rest are named, never dropped silently', () => {
    const dir = repo();
    git(dir, 'checkout', '-qb', 'feature');
    for (let i = 0; i < 31; i++) fs.writeFileSync(path.join(dir, `u${String(i).padStart(2, '0')}.txt`), 'u\n');
    const out = run(dir);
    expect(out).toContain('u29.txt');
    expect(out).not.toContain('u30.txt');
    expect(out).toContain('UNTRACKED_MORE: 1 more untracked files; list them all with git ls-files --others --exclude-standard\n');
    expect(run(repo())).not.toContain('UNTRACKED_MORE');
  });

  test('origin/HEAD wins when the repository is a clone', () => {
    const upstream = repo();
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-diff-base-clone-'));
    git(clone, 'clone', '-q', upstream, '.');
    expect(run(clone)).toContain('BASE: origin/main\n');
  });

  test('clean base branch, no main or master, unrelated history, empty repo and no repo all exit 0 with guidance', () => {
    expect(run(repo())).toContain('NOTHING_TO_REVIEW');
    expect(run(repo('trunk'))).toContain('BASE: none (no origin/HEAD, main or master)');
    const orphan = repo();
    git(orphan, 'checkout', '-q', '--orphan', 'other');
    git(orphan, 'commit', '-qm', 'unrelated');
    expect(run(orphan)).toContain('BASE: none (main has no merge base with HEAD)');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-diff-base-empty-'));
    git(empty, 'init', '-q');
    expect(run(empty)).toContain('BASE: none');
    expect(run(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-diff-base-none-')))).toContain('NOT_A_GIT_REPO');
  });
});
