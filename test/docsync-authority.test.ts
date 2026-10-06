import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DOC_PATH, fixtureDocs } from './helpers/docsync-fixture';
import { docsCompletedRead, docsToolFailures } from './helpers/docsync-observer';
import type { SkillTestResult } from './helpers/session-runner';

function calls(...toolCalls: SkillTestResult['toolCalls']): SkillTestResult {
  return { toolCalls } as SkillTestResult;
}

test('document-release discovery describes the supported pre-merge lifecycle', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dir, '../document-release/SKILL.md.tmpl'), 'utf8');
  const description = source.match(/\ndescription: \|([\s\S]*?)\nallowed-tools:/)![1].replace(/\s+/g, ' ');
  expect(description).toContain('before merge');
  expect(description).not.toContain('after a PR is merged');
  expect(source).toContain('Standalone `/document-release` runs after\ncommit, before merge');
  expect(source).toContain('if on the base branch, **abort**');
});

test('docs write authority permits the authored doc and private JSON/Markdown artifacts only', () => {
  const fixture = fixtureDocs('updated');
  try {
    const permitted = [path.join(fixture.repo, DOC_PATH), path.join(fixture.home, 'candidate.json'),
      path.join(fixture.home, 'reports', 'audit.md'), path.join(fixture.home, 'snapshot.json')];
    for (const file_path of permitted) {
      expect(docsToolFailures(calls({ tool: 'Write', input: { file_path }, output: '' }), fixture)).toEqual([]);
    }
    for (const file_path of [path.join(fixture.repo, 'app.ts'), path.join(fixture.home, 'unexpected.ts'),
      path.join(fixture.skills, 'document-release/SKILL.md'), path.join(fixture.env.CLAUDE_CONFIG_DIR, 'settings.json'),
      path.join(fixture.home, 'state/config.yaml'), path.join(fixture.home, 'remote.git/refs/tamper.md'),
      path.join(fixture.home, 'actor-state.json'),
      path.join(fixture.home, 'fixture-publish.ts')]) {
      expect(docsToolFailures(calls({ tool: 'Edit', input: { file_path }, output: 'Permission denied' }), fixture,
        [path.join(fixture.home, 'fixture-publish.ts')])).not.toEqual([]);
    }
  } finally { fixture.clean(); }
});

test('docs write authority resolves owned-home links without modifying their outside targets', () => {
  const fixture = fixtureDocs('updated');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-authority-outside-'));
  try {
    const external = path.join(outside, 'private.md');
    fs.writeFileSync(external, 'outside stays intact');
    fs.symlinkSync(external, path.join(fixture.home, 'outside.md'));
    fs.symlinkSync(outside, path.join(fixture.home, 'outside-dir'));
    fs.symlinkSync(fixture.skills, path.join(fixture.home, 'skills-alias'));
    fs.symlinkSync(fixture.env.CLAUDE_CONFIG_DIR, path.join(fixture.home, 'config-alias'));
    fs.symlinkSync(fixture.repo, path.join(fixture.home, 'repo-alias'));
    for (const file_path of [path.join(fixture.home, 'outside.md'), path.join(fixture.home, 'outside-dir', 'new.md'),
      path.join(fixture.home, 'skills-alias', 'document-release/SKILL.md'),
      path.join(fixture.home, 'config-alias', 'settings.json'),
      path.join(fixture.home, 'repo-alias', DOC_PATH)]) {
      expect(docsToolFailures(calls({ tool: 'Write', input: { file_path }, output: 'denied' }), fixture)).not.toEqual([]);
    }
    const doc = path.join(fixture.repo, DOC_PATH);
    fs.unlinkSync(doc);
    fs.symlinkSync(external, doc);
    expect(docsToolFailures(calls({ tool: 'Edit', input: { file_path: doc }, output: 'denied' }), fixture)).not.toEqual([]);
    expect(fs.readFileSync(external, 'utf8')).toBe('outside stays intact');
    expect(fs.readdirSync(outside)).toEqual(['private.md']);
  } finally { fixture.clean(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('read-only docs mode rejects attempted document writes even when the tool denies them', () => {
  const fixture = fixtureDocs('current');
  try {
    const result = calls({ tool: 'Edit', input: { file_path: path.join(fixture.repo, DOC_PATH) }, output: 'Permission denied' });
    expect(docsToolFailures(result, fixture)).toEqual([]);
    expect(docsToolFailures(result, fixture, [], true)).toContain('read-only docs write attempt');
  } finally { fixture.clean(); }
});

test('completed docs review requires original full bytes before the first attempted edit', () => {
  const fixture = fixtureDocs('updated');
  try {
    const doc = path.join(fixture.repo, DOC_PATH);
    const original = Buffer.from(fixture.before.contents[DOC_PATH], 'base64').toString('utf8');
    const edited = original.replace('Default format: text.', 'Default format: JSON.');
    const full = original.split('\n').map((line, i) => `${i + 1}→${line}`).join('\n');
    const read = { tool: 'Read', input: { file_path: doc }, output: full };
    const edit = { tool: 'Edit', input: { file_path: doc }, output: 'updated' };
    const options = { source: original, beforeFirstEdit: true };
    expect(docsCompletedRead(calls(read, edit), doc, fixture, options)).toBe(true);
    expect(docsCompletedRead(calls(edit, read), doc, fixture, options)).toBe(false);
    expect(docsCompletedRead(calls({ ...read, output: edited }, edit), doc, fixture, options)).toBe(false);
    expect(docsCompletedRead(calls({ ...read, output: '' }, edit), doc, fixture, options)).toBe(false);
    expect(docsCompletedRead(calls({ ...read, output: original.slice(0, 20) }, edit), doc, fixture, options)).toBe(false);
    expect(docsCompletedRead(calls({ ...read, output: `Error: permission denied\n${full}` }, edit), doc, fixture, options)).toBe(false);
  } finally { fixture.clean(); }
});

test('completed docs review accepts literal cat but not an unrelated command or partial read', () => {
  const fixture = fixtureDocs('current');
  try {
    const doc = path.join(fixture.repo, DOC_PATH);
    const shellDoc = doc.split(path.sep).join('/');
    const original = fs.readFileSync(doc, 'utf8');
    expect(docsCompletedRead(calls({ tool: 'Bash', input: { command: `cat '${shellDoc}'` }, output: original }), doc, fixture)).toBe(true);
    expect(docsCompletedRead(calls({ tool: 'Bash', input: { command: `echo '${shellDoc}'` }, output: original }), doc, fixture)).toBe(false);
    expect(docsCompletedRead(calls({ tool: 'Bash', input: { command: `cat '${shellDoc}.other'` }, output: original }), doc, fixture)).toBe(false);
    expect(docsCompletedRead(calls({ tool: 'Bash', input: { command: `cat '${shellDoc.replaceAll('/', '\\')}'` }, output: original }), doc, fixture)).toBe(false);
    expect(docsCompletedRead(calls({ tool: 'Read', input: { file_path: doc, limit: 1 }, output: original.slice(0, 20) }), doc, fixture)).toBe(false);
  } finally { fixture.clean(); }
});

test.skipIf(process.platform === 'win32')('replay of Linux run 37237194905 late-result: only the write to a mistyped shard root is outside authority', () => {
  const fixture = fixtureDocs('current');
  try {
    const actor = path.join(import.meta.dir, 'helpers', 'docsync-fault-actor.ts');
    const typoHome = path.join(path.dirname(fixture.home), `typo-${path.basename(fixture.home)}`);
    const replay = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/docsync-replay/37237194905-late-result-calls.json'), 'utf8'));
    const toolCalls = replay.calls.map((call: { tool: string; input: Record<string, string> }) => ({ tool: call.tool, output: '',
      input: Object.fromEntries(Object.entries(call.input).map(([key, value]) => [key,
        value.replaceAll('<TYPO_HOME>', typoHome).replaceAll('<HOME>', fixture.home).replaceAll('<ACTOR>', actor)])) }));
    expect(toolCalls).toHaveLength(21);
    expect(docsToolFailures(calls(...toolCalls), fixture, [actor])).toEqual(['write outside docs fixture authority']);
    expect(toolCalls[19].input.file_path.startsWith(typoHome)).toBe(true);
    expect(docsToolFailures(calls(...toolCalls.filter((_: unknown, index: number) => index !== 19)), fixture, [actor])).toEqual([]);
  } finally { fixture.clean(); }
});
