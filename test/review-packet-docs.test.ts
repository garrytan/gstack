/**
 * Step 14.5 by packet (GSTA-167 PR 4): gstack-review-packet build --audit docs writes one
 * read-only auditor packet over a gstack-docs-candidate snapshot, and
 * gstack-docs-candidate apply makes the reader's proposed edits. Fixture repositories
 * live under the OS temp directory, outside this checkout, with an explicit seed identity.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditPrompt } from '../lib/review-packet';
import { DOCS_NAMED_LINES } from '../lib/review-packet-docs';

const ROOT = path.join(import.meta.dir, '..');
const PACKET = path.join(ROOT, 'bin', 'gstack-review-packet');
const CANDIDATE = path.join(ROOT, 'bin', 'gstack-docs-candidate');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; };

interface Fx { dir: string; home: string; out: string; run(bin: string, args: string[]): ReturnType<typeof spawnSync>; candidate(mode?: string, docs?: string[]): string }
function fixture(base: Record<string, string>, feat: Record<string, string>): Fx {
  const dir = tmp('docs-packet-');
  expect(path.relative(ROOT, dir).startsWith('..')).toBe(true);
  const home = tmp('docs-packet-home-');
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  const write = (files: Record<string, string>) => { for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); } };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false');
  write(base); git('add', '.');
  expect(git('commit', '-qm', 'base').status).toBe(0);
  git('checkout', '-qb', 'feat'); write(feat); git('add', '.');
  expect(git('commit', '-qm', 'feat').status).toBe(0);
  const run = (bin: string, args: string[]) => spawnSync(bin, args, { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GSTACK_STATE_ROOT: path.join(home, 'state') } });
  return { dir, home, out: path.join(home, 'packets'), run, candidate: (mode = 'edit', docs = ['README.md', 'docs']) => {
    const file = path.join(home, `cand-${mode}.json`);
    const r = run(CANDIDATE, ['snapshot', '--out', file, '--audit-id', 'audit-7', '--mode', mode, '--base', 'main', ...docs.flatMap(d => ['--docs', d])]);
    expect(r.status).toBe(0);
    return file;
  } };
}
const packetOf = (stdout: string | Buffer) => { const m = /^PACKET: audit docs .* read=(\S+) file=(\S+) out=(\S+)$/m.exec(String(stdout)); return m ? { read: m[1]!, file: m[2]!, out: m[3]!, text: fs.readFileSync(m[2]!, 'utf8') } : null; };

const BASE = {
  'README.md': '# Tool\n\nRun `bin/tool-run --fast` to start.\n\nUser-maintained note: KEEP.\n',
  'docs/guide.md': '# Guide\n\nThe parser lives in src/parser.ts.\n',
  'docs/other.md': '# Other\n\nUnrelated page.\n',
  'src/parser.ts': 'export const parse = 1;\n',
  'src/unrelated.ts': 'export const UNRELATED = 1;\n',
  'bin/tool-run': '#!/bin/sh\necho fast\n',
};

describe('build --audit docs', () => {
  // Value: protects=the auditor reads one packet holding its prompt, the doc surfaces, the doc lines naming changed code and only that code's diff; fails_when=the packet drops the prompt or a doc line, or ships the diff of code no doc names past the cap, or the test diff;
  //   why_new=the Step 14.5 packet is new; seam=gstack-docs-candidate snapshot; no_claim=what a model does with the packet
  test('one read-only packet: prompt with the audit id and mode, doc surfaces, doc lines naming changed code, and that diff', () => {
    const f = fixture(BASE, { 'src/parser.ts': 'export const parse = 2;\nexport const PARSER_CHANGE = 1;\n', 'docs/guide.md': '# Guide\n\nThe parser lives in src/parser.ts. GUIDE_EDIT\n', 'test/parser.test.ts': 'TEST_PAYLOAD\n' });
    const b = f.run(PACKET, ['build', '--audit', 'docs', '--candidate', f.candidate(), '--base', 'main', '--gate-tagged', '0', '--out-dir', f.out]);
    expect(b.status).toBe(0);
    const p = packetOf(b.stdout)!;
    expect(b.stdout).toMatch(new RegExp(`^BUDGET_NEXT: dispatch:specialist@${/^PACKET: audit docs .* bytes=(\d+) /m.exec(String(b.stdout))![1]}$`, 'm'));
    expect(p.text).toContain('You are the /ship documentation auditor (Step 14.5). Read-only');
    expect(p.text).toContain('Audit id: audit-7. Mode: edit.');
    expect(p.text).not.toContain('<audit-id>');
    expect(p.text).toContain('- docs/guide.md (changed)');
    expect(p.text).toContain('- docs/other.md\n');
    expect(p.text).toContain('docs/guide.md:3: The parser lives in src/parser.ts.');
    expect(p.text).toContain('+export const PARSER_CHANGE = 1;');
    expect(p.text).toContain('GUIDE_EDIT');
    expect(p.text).not.toContain('+TEST_PAYLOAD');
    expect(p.text).toContain(`Output path: \`${p.out}\``);
    expect(p.text.trimEnd().endsWith('END OF PACKET docs')).toBe(true);
  });

  // Value: protects=the build refuses without a usable candidate and the audit prompt comes only from the section fence; fails_when=a build without --candidate writes a packet, or a section without its fence yields an empty prompt;
  //   why_new=--candidate is new; seam=none; no_claim=the parent's recovery prose
  test('a missing or unusable candidate is a usage refusal with no packet; a section without its prompt fence throws', () => {
    const f = fixture(BASE, { 'src/parser.ts': 'export const parse = 3;\n' });
    const none = f.run(PACKET, ['build', '--audit', 'docs', '--base', 'main', '--gate-tagged', '0', '--out-dir', f.out]);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('--audit docs needs --candidate');
    const bad = path.join(f.home, 'bad.json');
    fs.writeFileSync(bad, '{"schema_version":1}');
    expect(f.run(PACKET, ['build', '--audit', 'docs', '--candidate', bad, '--base', 'main', '--gate-tagged', '0', '--out-dir', f.out]).status).toBe(2);
    expect(fs.existsSync(path.join(f.out, 'docs.packet.md'))).toBe(false);
    const skill = tmp('docs-skill-');
    fs.mkdirSync(path.join(skill, 'ship', 'sections'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'ship', 'sections', 'documentation.md'), '# no fence\n');
    expect(() => auditPrompt(skill, 'docs', 'main')).toThrow('ship/sections/documentation.md has no prompt fence');
    expect(auditPrompt(ROOT, 'docs', 'main')).toContain('"action":"edit|block|note"');
  });

  // Value: protects=the quoted doc lines stay bounded however many lines name a changed path; fails_when=the cap is dropped and a large doc set floods the packet;
  //   why_new=the cap is new; seam=none; no_claim=which lines are most useful
  test('doc lines naming changed code are capped and counted', () => {
    const many = Array.from({ length: DOCS_NAMED_LINES + 30 }, (_, i) => `line ${i} uses src/parser.ts`).join('\n') + '\n';
    const f = fixture({ ...BASE, 'docs/big.md': many }, { 'src/parser.ts': 'export const parse = 4;\n' });
    const p = packetOf(f.run(PACKET, ['build', '--audit', 'docs', '--candidate', f.candidate(), '--base', 'main', '--gate-tagged', '0', '--out-dir', f.out]).stdout)!;
    expect(p.text).toContain(`(${DOCS_NAMED_LINES + 31}, first ${DOCS_NAMED_LINES})`);
  });
});

describe('gstack-docs-candidate apply', () => {
  const findings = (rows: object[], last: object = { schema_version: 1, audit_id: 'audit-7', files_reviewed: ['README.md', 'docs/guide.md'], documentation_section: 'Scope: README and docs/.' }) =>
    [...rows, last].map(r => JSON.stringify(r)).join('\n') + '\n';
  const lastJson = (stdout: string) => JSON.parse(stdout.trimEnd().split('\n').at(-1)!);

  // Value: protects=apply makes exactly the unique edits in candidate docs and reports the rest as blockers in the child result schema, and the existing ownership check sees only those paths; fails_when=an ambiguous, protected, generated, outside or uncandidated edit is written, or a block finding is dropped;
  //   why_new=apply is new; seam=gstack-docs-candidate compare; no_claim=whether a proposed edit is true
  test('applies unique edits to candidate docs; protected, generated, ambiguous, uncandidated and block findings become blockers', () => {
    const f = fixture({ ...BASE, 'CHANGELOG.md': '# Changelog\n', 'docs/gen.md': '<!-- AUTO-GENERATED from gen.md.tmpl -->\nold\n', 'docs/twice.md': 'same\nsame\n' }, { 'bin/tool-run': '#!/bin/sh\necho quick\n' });
    const cand = f.candidate('edit', ['README.md', 'docs', 'CHANGELOG.md']);
    const out = path.join(f.home, 'docs.out');
    fs.writeFileSync(out, findings([
      { path: 'README.md', line: 3, action: 'edit', kind: 'stale', summary: 'flag renamed', old: '--fast', new: '--quick' },
      { path: 'docs/twice.md', action: 'edit', kind: 'stale', summary: 'ambiguous', old: 'same', new: 'x' },
      { path: 'CHANGELOG.md', action: 'edit', kind: 'stale', summary: 'protected', old: '# Changelog', new: 'x' },
      { path: 'docs/gen.md', action: 'edit', kind: 'stale', summary: 'generated', old: 'old', new: 'new' },
      { path: 'src/parser.ts', action: 'edit', kind: 'stale', summary: 'not a doc', old: 'parse', new: 'x' },
      { path: 'docs/other.md', action: 'block', kind: 'contradiction', summary: 'narrative rewrite needed' },
      { path: 'docs/guide.md', action: 'note', kind: 'coverage', summary: '--quick has no how-to' },
    ]));
    const r = f.run(CANDIDATE, ['apply', cand, '--findings', out]);
    expect(r.status).toBe(3);
    const res = lastJson(String(r.stdout));
    expect(res).toMatchObject({ schema_version: 1, audit_id: 'audit-7', status: 'blocked', files_updated: ['README.md'], files_reviewed: ['README.md', 'docs/guide.md'], decisions: ['docs/guide.md: --quick has no how-to'] });
    expect(res.blockers.join('\n')).toMatch(/twice\.md.*more than once[\s\S]*CHANGELOG\.md.*protected[\s\S]*gen\.md.*generated[\s\S]*parser\.ts.*not a doc[\s\S]*other\.md: narrative/);
    expect(res.documentation_section.startsWith('**Status:** blocked')).toBe(true);
    expect(fs.readFileSync(path.join(f.dir, 'README.md'), 'utf8')).toContain('bin/tool-run --quick');
    expect(fs.readFileSync(path.join(f.dir, 'README.md'), 'utf8')).toContain('User-maintained note: KEEP.');
    for (const p of ['docs/twice.md', 'CHANGELOG.md', 'docs/gen.md', 'src/parser.ts']) expect(spawnSync('git', ['diff', '--quiet', '--', p], { cwd: f.dir, timeout: 10_000 }).status).toBe(0);
    const cmp = JSON.parse(String(f.run(CANDIDATE, ['compare', cand]).stdout));
    expect(cmp).toMatchObject({ head_changed: false, index_changed: false, content_changed: ['README.md'], newly_dirty: [] });
  });

  // Value: protects=a clean audit is current or updated with exit 0, read-only mode never writes, and an unusable last line or another audit id is exit 1; fails_when=read-only edits apply, or a stale reader output is accepted;
  //   why_new=apply is new; seam=none; no_claim=the parent's recovery
  test('current and updated exit 0; read-only mode blocks every edit; a wrong audit id or prose last line is unusable', () => {
    const f = fixture(BASE, { 'src/parser.ts': 'export const parse = 5;\n' });
    const out = path.join(f.home, 'docs.out');
    fs.writeFileSync(out, findings([]));
    const cur = f.run(CANDIDATE, ['apply', f.candidate(), '--findings', out]);
    expect(cur.status).toBe(0);
    expect(lastJson(String(cur.stdout))).toMatchObject({ status: 'current', files_updated: [], blockers: [] });
    fs.writeFileSync(out, findings([{ path: 'docs/guide.md', action: 'edit', kind: 'stale', summary: 'path moved', old: 'src/parser.ts', new: 'src/parse.ts' }]));
    const ro = f.run(CANDIDATE, ['apply', f.candidate('read-only'), '--findings', out]);
    expect(ro.status).toBe(3);
    expect(lastJson(String(ro.stdout)).blockers[0]).toContain('read-only mode');
    expect(fs.readFileSync(path.join(f.dir, 'docs/guide.md'), 'utf8')).toContain('src/parser.ts');
    const up = f.run(CANDIDATE, ['apply', f.candidate(), '--findings', out]);
    expect(up.status).toBe(0);
    expect(lastJson(String(up.stdout))).toMatchObject({ status: 'updated', files_updated: ['docs/guide.md'] });
    fs.writeFileSync(out, findings([], { schema_version: 1, audit_id: 'audit-other', files_reviewed: [], documentation_section: 'x' }));
    expect(f.run(CANDIDATE, ['apply', f.candidate(), '--findings', out]).status).toBe(1);
    fs.writeFileSync(out, 'All docs are current.\n');
    const prose = f.run(CANDIDATE, ['apply', f.candidate(), '--findings', out]);
    expect(prose.status).toBe(1);
    expect(String(prose.stdout)).toContain('DOCS_AUDIT_UNUSABLE');
  });

  // Value: protects=a doc symlinked outside the repository is never written through; fails_when=apply follows the link;
  //   why_new=apply is new; seam=none; no_claim=symlinks inside the repository
  test('a candidate doc that resolves outside the repository is refused, never written through', () => {
    const outside = tmp('docs-outside-');
    fs.writeFileSync(path.join(outside, 'target.md'), 'secret target\n');
    const f = fixture(BASE, { 'src/parser.ts': 'export const parse = 6;\n' });
    fs.symlinkSync(path.join(outside, 'target.md'), path.join(f.dir, 'docs', 'link.md'));
    const out = path.join(f.home, 'docs.out');
    fs.writeFileSync(out, findings([{ path: 'docs/link.md', action: 'edit', kind: 'stale', summary: 'x', old: 'secret', new: 'changed' }]));
    const r = f.run(CANDIDATE, ['apply', f.candidate(), '--findings', out]);
    expect(lastJson(String(r.stdout)).blockers[0]).toContain('outside the repository');
    expect(fs.readFileSync(path.join(outside, 'target.md'), 'utf8')).toBe('secret target\n');
  });
});

describe('docs audit apply: generated files behind frontmatter', () => {
  // Value: protects=a generated SKILL.md whose AUTO-GENERATED marker follows YAML frontmatter is refused like any generated file; fails_when=apply edits a generated skill file and Skill Docs Freshness fails on the next run;
  //   why_new=GSTA-167 /ship red team on #3633 (CRITICAL); seam=none; no_claim=which docs the candidate lists
  test('an edit to a frontmatter-first generated file is a blocker, not a write', async () => {
    const { applyDocsFindings } = await import('../lib/docs-audit-apply');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-gen-'));
    try {
      const text = '---\nname: x\ndescription: y\nallowed-tools:\n  - Bash\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl -->\nold\n';
      fs.mkdirSync(path.join(root, 'x')); fs.writeFileSync(path.join(root, 'x', 'SKILL.md'), text);
      const out = [JSON.stringify({ path: 'x/SKILL.md', action: 'edit', kind: 'stale', summary: 's', old: 'old', new: 'new' }), JSON.stringify({ schema_version: 1, audit_id: 'a1', documentation_section: 'Docs.' })].join('\n');
      const res = applyDocsFindings(root, { audit_id: 'a1', mode: 'write', docs: ['x/SKILL.md'] }, out);
      expect(res.result?.blockers.join('\n')).toContain('generated file');
      expect(fs.readFileSync(path.join(root, 'x', 'SKILL.md'), 'utf8')).toBe(text);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
