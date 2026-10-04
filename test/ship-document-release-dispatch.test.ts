import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runGeneration } from '../scripts/gen-skill-docs';
import { docsDispatchIndex, extractDocsDispatch, parseDocsCompletion, vetDocsCompletion } from './helpers/docsync-contract';
import { fixtureDocs, repoSnapshot, changedFiles, gitAt, DOC_PATH, preserveDocsEvidence } from './helpers/docsync-fixture';
import type { SkillTestResult } from './helpers/session-runner';
import { observeDocsWrites, docsWriteFailures, docsCommandAllowed, docsPreambleCommands, docsCompletedRead } from './helpers/docsync-observer';
import { docsActorCommand, docsActorHook, installDocsActor, type DocsActorState, type DocsFault } from './helpers/docsync-fault-actor';
import { docsActorVerdict } from './helpers/docsync-fault-eval';

const ROOT = path.join(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let generated: string;

beforeAll(async () => {
  generated = fs.mkdtempSync(path.join(os.tmpdir(), 'docsync-render-'));
  for (const host of ['claude', 'codex', 'factory'] as const) {
    const result = await runGeneration({ host, outputRoot: generated, contentLinkRoot: null, log: () => {} });
    expect(result.exitCode).toBe(0);
  }
});

afterAll(() => fs.rmSync(generated, { recursive: true, force: true }));

describe('pre-publication documentation lifecycle', () => {
  test('final verification orders build, bounded documentation refresh, freeze and evidence', () => {
    const body = read('ship/SKILL.md.tmpl');
    const gate = body.slice(body.indexOf('## Step 16:'), body.indexOf('## Step 17:'));
    const steps = ['### 1. Finish writers and prepare outputs', '### 2. Choose the change route',
      '### 3. Resolve documentation freshness', '### 4. Verify the frozen candidate', '### 5. Report, then push'];
    const positions = steps.map(step => gate.indexOf(step));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const recovery = body.slice(body.indexOf('### 3. Resolve documentation freshness'), body.indexOf('### 4. Verify the frozen candidate')).replace(/\s+/g, ' ');
    expect(recovery).toContain('Validate the outcome before Step 15');
    expect(recovery).toContain('restart Step 16 stage 1 to regenerate and compare again');
    expect(recovery).toContain('Never run a third audit');
    expect(body.replace(/\s+/g, ' ')).toContain('its initial-plus-ONE limit never resets');
    expect(gate.replace(/\s+/g, ' ')).toContain('Docs, TODO edits, new/generated tests and fixes make evidence STALE');
    const docs = read('ship/sections/documentation.md.tmpl');
    expect(docs.replace(/\s+/g, ' ')).toContain('never a third attempt, even after Step 16 changes');
    expect(docs.replace(/\s+/g, ' ')).toContain('Otherwise STOP before commit/publication and do not launch another child');
  });

  test('dispatch is carved before commit and final verification on every host', () => {
    const claude = fs.readFileSync(path.join(generated, 'ship/SKILL.md'), 'utf8');
    const marker = '## Step 14.5: Documentation audit (every ship)';
    expect(claude.indexOf(marker)).toBeGreaterThan(0);
    expect(claude.indexOf('ship/sections/documentation.md', claude.indexOf(marker))).toBeLessThan(claude.indexOf('## Step 15:'));
    expect(claude).not.toContain('Dispatch /document-release as a subagent');
    // C4: ship is carved on external hosts too; the pointer is relative to the installed skill.
    for (const dir of ['.agents/skills/gstack-ship', '.factory/skills/gstack-ship']) {
      const body = fs.readFileSync(path.join(generated, dir, 'SKILL.md'), 'utf8');
      const pointer = body.indexOf('`sections/documentation.md` relative to the installed `gstack-ship` SKILL.md directory', body.indexOf(marker));
      expect(pointer).toBeGreaterThan(body.indexOf(marker));
      expect(pointer).toBeLessThan(body.indexOf('## Step 15:'));
      expect(body).not.toContain('Dispatch /document-release as a subagent');
      expect(fs.readFileSync(path.join(generated, dir, 'sections/documentation.md'), 'utf8')).toContain('Dispatch /document-release as a subagent');
      expect(body.indexOf('## Step 16:')).toBeLessThan(body.indexOf('## Step 17:'));
    }
  });

  test('the actual dispatch has foreground, marker, typed result and ownership guards', () => {
    const body = fs.readFileSync(path.join(generated, 'ship/sections/documentation.md'), 'utf8');
    expect(body).toContain('run_in_background: false');
    expect(body).toContain('subagent_type: "general-purpose"');
    const prompt = extractDocsDispatch(body);
    for (const marker of ['GSTACK_SESSION_KIND=spawned', 'LAST nonempty line', 'schema_version', 'read-only',
      'no Git mutation', 'CHANGELOG or TODOS mutation', 'never auto-approve', 'staged, unstaged and selected new']) expect(prompt).toContain(marker);
    expect(docsDispatchIndex([{ tool: 'Agent', input: { prompt } }])).toBe(0);
    expect(docsDispatchIndex([{ tool: 'Agent', input: { prompt: body } }])).toBe(-1);
    expect(() => extractDocsDispatch('no markers')).toThrow();
  });

  test('documentation preflight follows the installed host layout', () => {
    const claude = fs.readFileSync(path.join(generated, 'ship/sections/documentation.md'), 'utf8');
    expect(claude.replace(/\s+/g, ' ')).toContain('full audit-scope/release-body content, linked as sections or inlined for external hosts');
    for (const section of ['audit-scope', 'release-body']) {
      expect(fs.existsSync(path.join(generated, `document-release/sections/${section}.md`))).toBe(true);
    }
    for (const host of ['.agents', '.factory']) {
      const ship = fs.readFileSync(path.join(generated, host, 'skills/gstack-ship/sections/documentation.md'), 'utf8');
      const directory = path.join(generated, host, 'skills/gstack-document-release');
      const document = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
      expect(ship).toContain('linked as sections or inlined for external hosts');
      expect(document).toContain('# Documentation scope and discovery');
      expect(document).toContain('## Step 2: Per-File Documentation Audit');
      expect(document).toContain('## Ship-owned documentation mode');
      expect(fs.existsSync(path.join(directory, 'sections/audit-scope.md'))).toBe(false);
      expect(fs.existsSync(path.join(directory, 'sections/release-body.md'))).toBe(false);
    }
  });

  test('failure is visible, bounded and settled before another writer', () => {
    const body = read('ship/sections/documentation.md.tmpl').replace(/\s+/g, ' ');
    for (const text of ['Terminal completion or confirmed termination is sufficient', 'the request alone is insufficient',
      'an initial audit plus ONE repair/re-audit', 'specific named documentation risk', 'Preserve partial',
      'Compare actual changes against the candidate',
      'enforcing prompt/audit-scope permissions and protected-file exclusions',
      'HEAD and index must be unchanged, existing dirty/untracked user content preserved',
      'changed paths exactly `files_updated`. Reject any read-only write',
      'Only verified permitted child edits may differ. Other edits or base changes make the audit stale',
      'Later changes require the remaining re-audit or a risk decision',
      'never silently refreshed hashes']) expect(body).toContain(text);
    expect(body).not.toContain('Do not block /ship on subagent failure');
  });

  test('stale detection does not spend the remaining audit, but repair and inline takeover do', () => {
    const body = read('ship/sections/documentation.md.tmpl').replace(/\s+/g, ' ');
    for (const text of ['Increment before each launch or inline takeover',
      'including failed launches',
      'A stale snapshot is neither a new attempt nor a current audit',
      'inline work follows the same validation gates',
      'never a third attempt, even after Step 16 changes',
      'Confirm the child stopped before any repair, retry, inline takeover or other writer',
      'request stop and inspect its status; the request alone is insufficient',
      'If an attempt remains and either the audited inputs changed or a concrete launch/input/permission correction or reviewed patch repair is available',
      'using current inputs and a fresh id/snapshot, run the remaining attempt, then validate it through Parent processing',
      'Otherwise STOP before commit/publication',
      'do not launch another child']) expect(body).toContain(text);
    expect(body).not.toContain('A stale audit consumes the same ONE repair/re-audit attempt');
  });

  test('PR creation and reruns keep current and blocked audits visible', () => {
    const body = read('ship/sections/pr-body.md.tmpl');
    expect(body).toContain("Use Step 18's `NEW_TITLE`");
    expect(body).toContain('`NEW_TITLE` unchanged; its version prefix is already present');
    expect(body).toContain('printf \'%s\' "$NEW_TITLE" |');
    expect(body).toContain('gh pr create --base <base> --title "$NEW_TITLE"');
    expect(body).toContain('gh pr edit --title "$NEW_TITLE"');
    expect(body).toContain('glab mr create -b <base> -t "$NEW_TITLE"');
    expect(body).not.toContain('Dispatch /document-release');
    expect(body).toContain("Never omit this section or reuse another invocation's audit");
    expect(body).toContain('gh pr edit --body-file "$PR_BODY_FILE"');
    expect(body).toContain('gstack-redact --from-file "$PR_BODY_FILE"');
    expect(read('ship/SKILL.md.tmpl')).toContain('existing PRs and docs-only changes');
    expect(read('ship/sections/apple-release.md.tmpl')).toContain('read-only');
    expect(read('ship/sections/apple-release.md.tmpl')).toContain('ship/sections/documentation.md');
  });

  test('ship-owned documentation_section carries its status so /ship embeds it unchanged', () => {
    // ci-36641820398-1-gate-census-3 ship-docsync-completion: the section had scope, health and debt but no result,
    // so the parent spliced a Status line into it and the report no longer contained the returned section.
    const scope = read('document-release/sections/audit-scope.md.tmpl').replace(/\s+/g, ' ');
    expect(scope).toContain('complete for verbatim embedding: a first `**Status:**` line with `status` and the result, audited scope');
    expect(read('ship/sections/documentation.md.tmpl')).toContain('nonempty Markdown with scope, result and debt');
    expect(read('ship/sections/pr-body.md.tmpl')).toContain("Embed Step 14.5's vetted nonempty `documentation_section`");
  });

  test('a missing installed document-release section blocks before launch', () => {
    // ci-36709485593-1-eval-slices-2 ship-docsync-missing-asset: audit-scope.md was absent, but the parent saw the
    // SKILL.md "Ship-owned documentation mode" heading, read the gate as satisfied and dispatched.
    const gate = read('ship/sections/documentation.md.tmpl').replace(/\s+/g, ' ');
    expect(gate).toContain('full audit-scope/release-body content, linked as sections or inlined for external hosts. A missing section or old `Ship-owned documentation mode` blocks before launch; never substitute.');
  });

  test('nested authored discovery and standalone protections survive', () => {
    const skill = read('document-release/SKILL.md.tmpl') + read('document-release/sections/audit-scope.md.tmpl');
    expect(skill).not.toContain('find . -maxdepth 2');
    for (const text of ['declared documentation roots', '.tmpl', 'generated output', 'Read before editing',
      'Ship-owned documentation mode', 'standalone branch gate']) expect(skill).toContain(text);
    const body = read('document-release/sections/release-body.md.tmpl');
    for (const text of ['never `git add -A`', 'Never regenerate a CHANGELOG entry',
      'body-original.md', 'UNTRUSTED TRACKER CONTENT', 'gstack-redact --from-file']) expect(body).toContain(text);
    const versionStep = body.slice(body.indexOf('## Step 8'), body.indexOf('\n## ', body.indexOf('## Step 8') + 1));
    expect(versionStep).toMatch(/ask[^\n]*before[^\n]*VERSION/i);
    expect(body).toMatch(/does not rewrite, replace, or regenerate CHANGELOG/i);
  });
});

const current = {
  schema_version: 1, audit_id: 'audit-1', status: 'current', files_updated: [],
  files_reviewed: ['docs/reference/cli.md.tmpl'], documentation_section: 'Current — CLI reference reviewed.',
  blockers: [], decisions: [],
};
const evidence = {
  settled: true, markerSeen: true, headUnchanged: true, indexUnchanged: true,
  candidateUnchanged: true, readOnly: false, changedPaths: [] as string[],
  allowedDocs: ['docs/reference/cli.md.tmpl'],
};

describe('completion observer negative controls', () => {
  test('updated, current, and partial blocked results retain their actual meaning', () => {
    for (const value of [current,
      { ...current, status: 'updated', files_updated: evidence.allowedDocs },
      { ...current, status: 'blocked', files_updated: evidence.allowedDocs, blockers: ['Security narrative requires a decision'] }]) {
      const parsed = parseDocsCompletion(`Audit complete\n${JSON.stringify(value)}\n`, 'audit-1');
      vetDocsCompletion(parsed, { ...evidence, changedPaths: value.files_updated });
      expect(parsed.status).toBe(value.status);
    }
  });

  test.each([
    ['old shape', { files_updated: [], commit_sha: null, pushed: false, documentation_section: null }],
    ['old version', { ...current, schema_version: 0 }],
    ['late callback', { ...current, audit_id: 'abandoned' }],
    ['missing key', { ...current, decisions: undefined }],
    ['null summary', { ...current, documentation_section: null }],
    ['empty summary', { ...current, documentation_section: '' }],
    ['error field', { ...current, error: 'preamble failed' }],
    ['false current', { ...current, files_updated: evidence.allowedDocs }],
    ['empty updated', { ...current, status: 'updated' }],
    ['false blocked', { ...current, status: 'blocked' }],
    ['invalid array', { ...current, files_reviewed: [1] }],
    ['path escape', { ...current, files_reviewed: ['../README.md'] }],
    ['duplicate path', { ...current, files_reviewed: ['README.md', 'README.md'] }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseDocsCompletion(JSON.stringify(value), 'audit-1')).toThrow();
  });

  test.each(['{broken', 'agent_id: 123', `${JSON.stringify(current)}\nDone`, `${JSON.stringify(current)}\n\`\`\``])('rejects malformed or non-last-line completion %s', output => {
    expect(() => parseDocsCompletion(output, 'audit-1')).toThrow();
  });

  test.each([
    ['running after timeout', { settled: false }], ['missing marker', { markerSeen: false }],
    ['unexpected commit', { headUnchanged: false }], ['staged edits', { indexUnchanged: false }],
    ['edit before callback', { candidateUnchanged: false }], ['edit after callback', { candidateUnchanged: false }],
    ['unreported partial edit', { changedPaths: evidence.allowedDocs }],
  ])('blocks %s', (_name, overrides) => {
    expect(() => vetDocsCompletion(parseDocsCompletion(JSON.stringify(current), 'audit-1'), { ...evidence, ...overrides })).toThrow();
  });

  test.each(['VERSION', 'CHANGELOG.md', 'TODOS.md', 'package.json', 'nested/manifest.json', 'docs/generated.md', 'app.ts'])('rejects actual protected or unapproved change %s', changed => {
    const result = parseDocsCompletion(JSON.stringify({ ...current, status: 'updated', files_updated: [changed] }), 'audit-1');
    expect(() => vetDocsCompletion(result, { ...evidence, changedPaths: [changed] })).toThrow();
  });

  test('read-only store mode cannot accept an updated document', () => {
    const result = parseDocsCompletion(JSON.stringify({ ...current, status: 'updated', files_updated: evidence.allowedDocs }), 'audit-1');
    expect(() => vetDocsCompletion(result, { ...evidence, readOnly: true, changedPaths: evidence.allowedDocs })).toThrow();
  });
});

describe('native docs fixture preflight', () => {
  test('staged, unstaged and new content are distinct from HEAD and user content is excluded', () => {
    const fixture = fixtureDocs('updated', generated);
    try {
      expect(gitAt(fixture.repo, 'diff', '--cached', '--name-only')).toBe('app.ts');
      expect(gitAt(fixture.repo, 'diff', '--name-only')).toBe('README.md');
      const candidate = JSON.parse(fs.readFileSync(fixture.candidate, 'utf8'));
      expect(candidate.selected_paths).toContain('options.ts');
      expect(candidate.selected_paths).toContain(DOC_PATH);
      expect(candidate.selected_paths).not.toContain('personal-note.txt');
      expect(gitAt(fixture.repo, 'show', 'HEAD:app.ts')).toContain('text');
      expect(fs.readFileSync(path.join(fixture.repo, 'app.ts'), 'utf8')).toContain('json');
      fs.writeFileSync(path.join(fixture.repo, 'VERSION'), '9.9.9.9\n');
      expect(changedFiles(fixture.before, repoSnapshot(fixture.repo))).toEqual(['VERSION']);
    } finally { fixture.clean(); }
  });

  test('docs-only repeat fixture is actually committed and already pushed', () => {
    const fixture = fixtureDocs('current', generated);
    try {
      expect(gitAt(fixture.repo, 'rev-parse', 'HEAD')).toBe(gitAt(fixture.repo, 'rev-parse', '@{u}'));
      expect(gitAt(fixture.repo, 'diff', 'main...HEAD', '--name-only')).toBe(DOC_PATH);
    } finally { fixture.clean(); }
  });

  test('store fixture stays on base and supplies a read-only candidate', () => {
    const fixture = fixtureDocs('store', generated);
    try {
      expect(gitAt(fixture.repo, 'branch', '--show-current')).toBe('main');
      expect(JSON.parse(fs.readFileSync(fixture.candidate, 'utf8')).mode).toBe('read-only');
    } finally { fixture.clean(); }
  });

  test.each(['before callback', 'after callback'])('a real late content edit invalidates evidence %s', order => {
    const fixture = fixtureDocs('current', generated);
    try {
      const completion = () => parseDocsCompletion(JSON.stringify(current), 'audit-1');
      let result = order === 'after callback' ? completion() : undefined;
      fs.appendFileSync(path.join(fixture.repo, 'app.ts'), 'export const lateChange = true;\n');
      result ??= completion();
      const after = repoSnapshot(fixture.repo);
      expect(() => vetDocsCompletion(result!, {
        ...evidence, candidateUnchanged: changedFiles(fixture.before, after).length === 0,
      })).toThrow('stale candidate');
    } finally { fixture.clean(); }
  });

  test('snapshotting rejects a documentation symlink outside the product root', () => {
    const fixture = fixtureDocs('current', generated);
    try {
      fs.writeFileSync(path.join(fixture.home, 'outside.md'), 'outside');
      fs.symlinkSync(path.join(fixture.home, 'outside.md'), path.join(fixture.repo, 'escape.md'));
      expect(() => repoSnapshot(fixture.repo)).toThrow('fixture path escaped');
      expect(fs.readFileSync(path.join(fixture.home, 'outside.md'), 'utf8')).toBe('outside');
    } finally { fixture.clean(); }
  });

  test('the real preamble marker and private fixture evidence survive cleanup', () => {
    const fixture = fixtureDocs('risky', generated);
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-evidence-'));
    let retained: string | undefined;
    try {
      const result = spawnSync('bash', [path.join(fixture.skills, 'bin/gstack-skill-start'), '--skill', 'document-release'], {
        cwd: fixture.repo, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ...fixture.env, GSTACK_SESSION_KIND: 'spawned' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('SESSION_KIND: spawned');
      retained = preserveDocsEvidence(fixture, { output: 'preflight', toolCalls: [] } as unknown as SkillTestResult,
        `docs-free-${path.basename(fixture.home)}`, 'fixture', {}, evidenceRoot);
      fixture.clean();
      expect(fs.existsSync(retained)).toBe(true);
      expect(fs.statSync(retained).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(retained, 'utf8')).before.contents['SECURITY.md']).toBeDefined();
    } finally {
      fixture.clean();
      fs.rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

(process.platform === 'linux' ? describe : describe.skip)('independent docs write observer', () => {
  test('read-only native Git commands generate no forbidden writes', async () => {
    const fixture = fixtureDocs('current', generated);
    const observer = await observeDocsWrites(fixture);
    try {
      gitAt(fixture.repo, 'status', '--porcelain');
      gitAt(fixture.repo, 'diff', 'main...HEAD');
      expect(docsWriteFailures(observer.stop(), [])).toEqual([]);
    } finally { fixture.clean(); }
  });

  test.each(['write-revert', 'rename-revert', 'delete-recreate', 'git-config-revert', 'shell-write-revert'])('rejects transient %s despite restored bytes', async operation => {
    const fixture = fixtureDocs('current', generated);
    const file = path.join(fixture.repo, operation === 'git-config-revert' ? '.git/config' : 'app.ts');
    const before = fs.readFileSync(file);
    const observer = await observeDocsWrites(fixture);
    try {
      if (operation === 'rename-revert') {
        fs.renameSync(file, file + '.moved');
        fs.renameSync(file + '.moved', file);
      } else if (operation === 'delete-recreate') {
        fs.unlinkSync(file);
        fs.writeFileSync(file, before);
      } else if (operation === 'git-config-revert') {
        gitAt(fixture.repo, 'config', 'docs.fixture', 'transient');
        fs.writeFileSync(file, before);
      } else if (operation === 'shell-write-revert') {
        const child = spawnSync(process.execPath, ['-e', 'const fs=require("fs");const p=process.argv[1];const b=fs.readFileSync(p);fs.writeFileSync(p,"transient");fs.writeFileSync(p,b)', file], { timeout: 10000, encoding: 'utf8' });
        expect(child.status).toBe(0);
      } else {
        fs.writeFileSync(file, 'transient');
        fs.writeFileSync(file, before);
      }
      const observation = observer.stop();
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(observation.events.some(e => e.path === path.relative(fixture.repo, file))).toBe(true);
      expect(docsWriteFailures(observation, [])).not.toEqual([]);
    } finally { fixture.clean(); }
  });

  test.each(['overflow', 'truncated', 'unknown-watch'])('fails closed on %s observations', async fault => {
    const fixture = fixtureDocs('current', generated);
    const observer = await observeDocsWrites(fixture);
    try {
      const record = Buffer.alloc(fault === 'truncated' ? 1 : 16);
      if (record.length === 16) {
        record.writeInt32LE(-1, 0);
        record.writeUInt32LE(fault === 'overflow' ? 0x4000 : 0x2, 4);
      }
      observer.injectKernelRecordsForTest(record);
      const observation = observer.stop();
      expect(observation.complete).toBe(false);
      expect(docsWriteFailures(observation, [DOC_PATH])).toContain('incomplete docs write observation');
    } finally { fixture.clean(); }
  });

  test('allows named authored edits while retaining their full mutation trace', async () => {
    const fixture = fixtureDocs('updated', generated);
    const observer = await observeDocsWrites(fixture);
    try {
      const file = path.join(fixture.repo, DOC_PATH);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('text.', 'JSON.'));
      const observation = observer.stop();
      expect(docsWriteFailures(observation, [DOC_PATH])).toEqual([]);
      expect(docsWriteFailures(observation, [])).not.toEqual([]);
      expect(observation.changed).toContain(DOC_PATH);
    } finally { fixture.clean(); }
  });

  test('kernel evidence remains private and readable after fixture cleanup', async () => {
    const fixture = fixtureDocs('current', generated);
    const observer = await observeDocsWrites(fixture);
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-evidence-'));
    let evidence: string | undefined;
    try {
      const file = path.join(fixture.repo, 'app.ts');
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, 'transient');
      fs.writeFileSync(file, original);
      const observation = observer.stop();
      evidence = preserveDocsEvidence(fixture, { output: 'observer preflight', toolCalls: [] },
        `docs-observer-${path.basename(fixture.home)}`, 'transient', { observation }, evidenceRoot);
      fixture.clean();
      expect(fs.statSync(evidence).mode & 0o777).toBe(0o600);
      const retained = JSON.parse(fs.readFileSync(evidence, 'utf8')).observation;
      expect(retained.complete).toBe(true);
      expect(docsWriteFailures(retained, [])).toContain('forbidden docs write: app.ts');
    } finally {
      fixture.clean();
      fs.rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });

  test('declared native interface rejects interpreters, shell composition and Git writes', () => {
    const fixture = fixtureDocs('current', generated);
    try {
      for (const command of ['bun -e "new Uint8Array(1)"', 'python3 -c "pass"', 'git status && node attack.js',
        'git hash-object -w app.ts', 'git diff --output=app.ts', 'git show --textconv HEAD:app.ts', 'git config x.y z']) {
        expect(docsCommandAllowed(command, fixture)).toBe(false);
      }
      for (const command of ['git status --porcelain', 'git diff --cached', 'git hash-object app.ts', ...docsPreambleCommands(fixture)]) {
        expect(docsCommandAllowed(command, fixture)).toBe(true);
      }
    } finally { fixture.clean(); }
  });

  test('source-read evidence resolves installed paths but rejects a partial excerpt', () => {
    const fixture = fixtureDocs('current', generated);
    try {
      const file = path.join(fixture.skills, 'ship/sections/documentation.md');
      const output = fs.readFileSync(file, 'utf8').split('\n').map((line, i) => `${i + 1}→${line}`).join('\n');
      for (const file_path of [file, '~/.claude/skills/gstack/ship/sections/documentation.md']) {
        const result = { toolCalls: [{ tool: 'Read', input: { file_path }, output }] } as SkillTestResult;
        expect(docsCompletedRead(result, file, fixture)).toBe(true);
        result.toolCalls[0].output = '# Documentation audit gate';
        expect(docsCompletedRead(result, file, fixture)).toBe(false);
      }
    } finally { fixture.clean(); }
  });
});

describe('deterministic native-parent fault actor preflight', () => {
  function setup(scenario: DocsFault) {
    const fixture = fixtureDocs('current', generated);
    const stateFile = installDocsActor(fixture, scenario);
    const prompt = path.join(fixture.home, 'prompt.md');
    const dispatch = (id: string) => {
      fs.writeFileSync(prompt, `document-release files_updated audit ${id}`);
      return docsActorCommand(stateFile, 'dispatch', { audit_id: id, candidate: fixture.candidate, prompt, run_in_background: 'false' });
    };
    const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')) as DocsActorState;
    return { fixture, stateFile, dispatch, state };
  }

  test.each(['missing-marker', 'launch-failure'] as const)('%s cannot publish', fault => {
    const x = setup(fault);
    try {
      const response = x.dispatch('a');
      expect(response.exit).toBe(fault === 'launch-failure' ? 23 : 0);
      expect(docsActorVerdict(x.state(), 'Documentation: blocked', false)).toEqual([]);
      expect(docsActorVerdict(x.state(), 'Documentation: current', true)).not.toEqual([]);
    } finally { x.fixture.clean(); }
  });

  test('missing asset is actually absent and requires zero dispatches', () => {
    const x = setup('missing-asset');
    try {
      expect(fs.existsSync(path.join(x.fixture.skills, 'document-release/sections/audit-scope.md'))).toBe(false);
      expect(docsActorVerdict(x.state(), 'Documentation: blocked', false)).toEqual([]);
      x.dispatch('a');
      expect(docsActorVerdict(x.state(), 'Documentation: blocked', false)).not.toEqual([]);
    } finally { x.fixture.clean(); }
  });

  test('unsettled cancellation is distinct from a stop acknowledgment', () => {
    const x = setup('timeout-unsettled');
    try {
      const task = JSON.parse(x.dispatch('a').text).task_id;
      expect(JSON.parse(docsActorCommand(x.stateFile, 'status', { task_id: task }).text).elapsed_ms).toBeGreaterThan(600000);
      expect(JSON.parse(docsActorCommand(x.stateFile, 'stop', { task_id: task }).text).settled).toBe(false);
      expect(docsActorVerdict(x.state(), 'Documentation: blocked', false)).not.toEqual([]);
      docsActorCommand(x.stateFile, 'status', { task_id: task });
      expect(docsActorVerdict(x.state(), 'Documentation: blocked', false)).toEqual([]);
      expect(x.dispatch('b').exit).not.toBe(0);
    } finally { x.fixture.clean(); }
  });

  test('late callback after settlement and transport repair remains tied to the old audit', () => {
    const x = setup('late-result');
    try {
      const task = JSON.parse(x.dispatch('a').text).task_id;
      docsActorCommand(x.stateFile, 'status', { task_id: task });
      docsActorCommand(x.stateFile, 'stop', { task_id: task });
      docsActorCommand(x.stateFile, 'repair');
      const late = x.dispatch('b').text;
      expect(() => parseDocsCompletion(late, 'b')).toThrow('completion identity');
      expect(docsActorVerdict(x.state(), 'Documentation: blocked', false)).toEqual([]);
      expect(docsActorVerdict(x.state(), 'Documentation: current', true)).not.toEqual([]);
    } finally { x.fixture.clean(); }
  });

  test.each(['stale-before', 'stale-after', 'recovery'] as const)('%s requires a fresh successful audit before publication', fault => {
    const x = setup(fault);
    try {
      x.dispatch('a');
      if (fault === 'recovery') docsActorCommand(x.stateFile, 'repair');
      else if (fault === 'stale-after') {
        expect(fs.readFileSync(path.join(x.fixture.repo, 'app.ts'), 'utf8')).toContain('text');
        docsActorHook(x.stateFile, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: x.fixture.repo,
          tool_name: 'Bash', tool_input: { command: 'git diff' } }));
      }
      if (fault.startsWith('stale-')) expect(fs.readFileSync(path.join(x.fixture.repo, 'app.ts'), 'utf8')).toContain('json');
      const result = parseDocsCompletion(x.dispatch('b').text, 'b');
      const report = path.join(x.fixture.home, 'report.md');
      fs.writeFileSync(report, result.documentation_section);
      expect(docsActorCommand(x.stateFile, 'publish', { audit_id: 'b', report }).exit).toBe(0);
      expect(docsActorVerdict(x.state(), result.documentation_section, true)).toEqual([]);
      const bad = x.state();
      bad.events = bad.events.filter(e => e.action !== (fault === 'recovery' ? 'repair' : 'scheduled-input-edit'));
      expect(docsActorVerdict(bad, result.documentation_section, true)).not.toEqual([]);
    } finally { x.fixture.clean(); }
  });

  test('native command entrypoint returns the injected result and records real tool state', () => {
    const x = setup('missing-marker');
    try {
      const prompt = path.join(x.fixture.home, 'native-prompt.md');
      fs.writeFileSync(prompt, 'document-release files_updated audit native');
      const result = spawnSync(process.execPath, [path.join(ROOT, 'test/helpers/docsync-fault-actor.ts'), 'dispatch', x.stateFile,
        'audit_id=native', `candidate=${x.fixture.candidate}`, `prompt=${prompt}`, 'run_in_background=false'], {
        cwd: x.fixture.repo, timeout: 10000, encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(parseDocsCompletion(result.stdout, 'native').status).toBe('blocked');
      expect(x.state().events[0].action).toBe('dispatch');
    } finally { x.fixture.clean(); }
  });

  test('the registered native callback delivers the after-result edit, not a guessed delay', () => {
    const x = setup('stale-after');
    try {
      x.dispatch('a');
      const config = JSON.parse(fs.readFileSync(path.join(x.fixture.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
      const hook = config.hooks.PreToolUse.at(-1).hooks[0];
      const event = { hook_event_name: 'PreToolUse', cwd: x.fixture.repo, tool_name: 'Bash',
        tool_input: { command: 'git diff' }, session_id: 'fixture-session', tool_use_id: 'fixture-call' };
      const invoke = (cwd: string) => spawnSync('bash', ['-c', hook.command], {
        cwd: x.fixture.repo, input: JSON.stringify({ ...event, cwd }), encoding: 'utf8', timeout: 10000,
      });
      expect(invoke(x.fixture.home).status).toBe(0);
      expect(x.state().lateChanged).toBe(false);
      expect(invoke(x.fixture.repo).status).toBe(0);
      expect(x.state().lateChanged).toBe(true);
      expect(fs.readFileSync(path.join(x.fixture.repo, 'app.ts'), 'utf8')).toContain('json');
      const actions = x.state().events.map(e => e.action);
      expect(actions.indexOf('scheduled-input-edit')).toBeGreaterThan(actions.indexOf('completion'));
    } finally { x.fixture.clean(); }
  });
});
