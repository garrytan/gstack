import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DOC_PATH, docsCandidate, fixtureDocs, repoSnapshot } from './helpers/docsync-fixture';
import { DOCS_CHECKPOINT_MARKER, DOCS_SEEDED_AUDIT_ID, docsActorCommand, docsActorHook, docsActorSeeded, installDocsActor, seedDocsFirstAttempt, type DocsActorState } from './helpers/docsync-fault-actor';
import { docsActorVerdict } from './helpers/docsync-fault-eval';
import { extractDocsDispatch, parseDocsCompletion } from './helpers/docsync-contract';
import { docsNativeInterface, docsWriteFailures, observeDocsWrites } from './helpers/docsync-observer';

test.skipIf(process.platform !== 'linux')('actor CLI validates owned state before creating even transient locks', async () => {
  const fixture = fixtureDocs('current');
  let observer: Awaited<ReturnType<typeof observeDocsWrites>> | undefined;
  try {
    const stateFile = installDocsActor(fixture, 'missing-asset');
    const stateBefore = fs.readFileSync(stateFile, 'utf8');
    const actor = path.join(import.meta.dir, 'helpers/docsync-fault-actor.ts');
    const malformed = path.join(fixture.repo, 'malformed-state.json');
    const foreign = path.join(fixture.repo, 'foreign-state.json');
    const otherRoot = path.join(fixture.home, 'other-owner');
    fs.mkdirSync(otherRoot);
    fs.writeFileSync(malformed, '{');
    fs.writeFileSync(foreign, JSON.stringify({ root: otherRoot }));
    const invalid = [['--help'], [], ['inspect'], ['hook'],
      ['inspect', path.join(fixture.repo, 'missing-state.json')], ['inspect', malformed], ['inspect', foreign]];
    for (const args of invalid) {
      observer = await observeDocsWrites(fixture);
      const result = Bun.spawnSync([process.execPath, actor, ...args], { cwd: fixture.repo,
        stdin: Buffer.from('{}'), stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
      const observation = observer.stop(); observer = undefined;
      expect(result.exitCode, JSON.stringify(args)).not.toBe(0);
      expect(observation.complete).toBe(true);
      expect(docsWriteFailures(observation, [])).toEqual([]);
      expect(fs.readFileSync(stateFile, 'utf8')).toBe(stateBefore);
    }
    observer = await observeDocsWrites(fixture);
    expect(docsActorCommand(stateFile, 'inspect').exit).toBe(0);
    const valid = observer.stop(); observer = undefined;
    expect(valid.complete).toBe(true);
    expect(docsWriteFailures(valid, [])).toEqual([]);

    observer = await observeDocsWrites(fixture);
    const forbidden = path.join(fixture.repo, 'unapproved.lock');
    fs.writeFileSync(forbidden, ''); fs.unlinkSync(forbidden);
    const control = observer.stop(); observer = undefined;
    expect(control.complete).toBe(true);
    expect(docsWriteFailures(control, [])).toEqual(['forbidden docs write: unapproved.lock']);
  } finally {
    observer?.stop();
    fixture.clean();
  }
});

test('prepare copies the exact generated prompt and snapshots actual inputs without accepting an audit', () => {
  const fixture = fixtureDocs('current');
  try {
    const stateFile = installDocsActor(fixture, 'stale-before');
    const before = repoSnapshot(fixture.repo);
    const response = docsActorCommand(stateFile, 'prepare', { audit_id: 'first' });
    expect(response.exit).toBe(0);
    const prepared = JSON.parse(response.text);
    const candidate = JSON.parse(fs.readFileSync(prepared.candidate, 'utf8'));
    expect(candidate).toEqual(docsCandidate(fixture.repo, 'first', 'edit', candidate.base_sha));
    const supplied = JSON.parse(fs.readFileSync(path.join(fixture.home, 'candidate.json'), 'utf8'));
    expect(candidate.selected_paths).toEqual(supplied.selected_paths);
    expect(fs.readFileSync(fixture.invocation, 'utf8')).toContain('prepare saves the same selection with current hashes, so it needs no separate Read.');
    const source = extractDocsDispatch(fs.readFileSync(path.join(fixture.skills, 'ship/sections/documentation.md'), 'utf8'));
    expect(fs.readFileSync(prepared.prompt, 'utf8')).toBe(source.replaceAll('${HOME}', fixture.home)
      .replaceAll('<branch>', 'feature/docs').replaceAll('<base>', 'main')
      .replaceAll('<candidate-path>', prepared.candidate).replaceAll('<audit-id>', 'first').replaceAll('<mode>', 'edit')
      + '\n\n' + docsNativeInterface(fixture));
    expect(repoSnapshot(fixture.repo)).toEqual(before);
    const firstBytes = fs.readFileSync(prepared.candidate, 'utf8');
    expect(docsActorCommand(stateFile, 'prepare', { audit_id: 'first' }).exit).toBe(24);
    expect(fs.readFileSync(prepared.candidate, 'utf8')).toBe(firstBytes);
    expect(docsActorCommand(stateFile, 'dispatch', { ...prepared, run_in_background: 'false' }).exit).toBe(0);
    const refreshed = JSON.parse(docsActorCommand(stateFile, 'prepare', { audit_id: 'second' }).text);
    const second = JSON.parse(fs.readFileSync(refreshed.candidate, 'utf8'));
    expect(second.content_hashes['app.ts']).not.toBe(candidate.content_hashes['app.ts']);
    expect(second.content_hashes['app.ts']).toBe(createHash('sha256').update(fs.readFileSync(path.join(fixture.repo, 'app.ts'))).digest('hex'));
    expect(fs.readFileSync(prepared.candidate, 'utf8')).toBe(firstBytes);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.acceptedId).toBeNull();
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].observed_candidate).toEqual(candidate);
    const savedPreparation = JSON.parse(state.events.find(event => event.action === 'prepare').detail);
    expect(savedPreparation.candidate).toEqual(candidate);
    expect(savedPreparation.prompt).toBe(fs.readFileSync(prepared.prompt, 'utf8'));
    for (const file of [prepared.candidate, prepared.prompt, refreshed.candidate, refreshed.prompt]) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  } finally { fixture.clean(); }
});

test('prepare rejects path escapes, symlink destinations and an unsettled writer', () => {
  const fixture = fixtureDocs('current');
  try {
    const state = installDocsActor(fixture, 'timeout-unsettled');
    for (const audit_id of ['../escape', '/absolute', '', 'a b', 'a;git', 'a'.repeat(81)]) {
      expect(docsActorCommand(state, 'prepare', { audit_id }).exit).toBe(24);
    }
    fs.symlinkSync('/etc/hosts', path.join(fixture.home, 'candidate-link.json'));
    expect(docsActorCommand(state, 'prepare', { audit_id: 'link' }).exit).toBe(24);
    const prepared = JSON.parse(docsActorCommand(state, 'prepare', { audit_id: 'running' }).text);
    expect(docsActorCommand(state, 'dispatch', { ...prepared, run_in_background: 'false' }).exit).toBe(0);
    expect(docsActorCommand(state, 'prepare', { audit_id: 'overlap' }).exit).toBe(24);
    expect(fs.existsSync(path.join(fixture.home, 'candidate-overlap.json'))).toBe(false);
  } finally { fixture.clean(); }
});

test('inspect returns batched read-only repo observations without private state, verdict or mutation', () => {
  const fixture = fixtureDocs('current');
  try {
    const stateFile = installDocsActor(fixture, 'recovery');
    const before = repoSnapshot(fixture.repo);
    const beforeState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const response = docsActorCommand(stateFile, 'inspect');
    expect(response.exit).toBe(0);
    const observation = JSON.parse(response.text);
    expect(observation.operation).toBe('inspect');
    expect(observation.head).toBe(before.head);
    expect(observation.branch).toBe('feature/docs');
    expect(observation.index).toBe(before.index);
    expect(observation.base_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof observation.pre_existing_dirty).toBe('string');
    expect(observation.diff_committed).toContain('widget.md.tmpl');
    expect(observation.diff_committed).toContain('Supports plain text output.');
    expect(observation.diff_cached).toBe('');
    expect(observation.diff_worktree).toBe('');
    expect(observation.inventory).toEqual(Object.keys(before.contents).sort());
    for (const rel of observation.inventory) {
      const disk = fs.readFileSync(path.join(fixture.repo, rel));
      expect(observation.files[rel].exists).toBe(true);
      expect(observation.files[rel].sha256).toBe(createHash('sha256').update(disk).digest('hex'));
      expect(observation.files[rel].content).toBe(disk.toString('utf8'));
    }
    for (const forbidden of ['scenario', 'tasks', 'events', 'acceptedId', 'accepted_id', 'armed', 'repaired',
      'lateChanged', 'root', 'status', 'reusable', 'stale', 'fresh', 'verdict']) {
      expect(observation[forbidden]).toBeUndefined();
    }
    const afterState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(afterState.tasks).toEqual(beforeState.tasks);
    expect(afterState.acceptedId).toBeNull();
    expect(afterState.repaired).toBe(false);
    expect(afterState.lateChanged).toBe(false);
    expect(repoSnapshot(fixture.repo)).toEqual(before);
    expect(afterState.events.filter((e: any) => e.action === 'inspect')).toHaveLength(1);
    expect(afterState.events.some((e: any) => e.action === 'scheduled-input-edit')).toBe(false);
    expect(fs.readdirSync(fixture.home).some(f => /^candidate-|^prompt-/.test(f))).toBe(false);
  } finally { fixture.clean(); }
});

test('inspect rejects unsupported args, reports tracked deletions, and fails closed on escapes and oversize', () => {
  const fixture = fixtureDocs('current');
  try {
    const stateFile = installDocsActor(fixture, 'recovery');
    expect(docsActorCommand(stateFile, 'inspect').exit).toBe(0);
    for (const args of [{ paths: 'app.ts' }, { task_id: 'x' }, { audit_id: 'a' }]) {
      expect(docsActorCommand(stateFile, 'inspect', args).exit).toBe(24);
    }
    fs.unlinkSync(path.join(fixture.repo, 'app.ts'));
    const deleted = JSON.parse(docsActorCommand(stateFile, 'inspect').text);
    expect(deleted.inventory).toContain('app.ts');
    expect(deleted.files['app.ts']).toEqual({ exists: false });
    expect(deleted.files['README.md'].exists).toBe(true);
    fs.writeFileSync(path.join(fixture.repo, 'app.ts'), 'export const format = "text";\n');
    fs.symlinkSync('/etc/hosts', path.join(fixture.repo, 'link.ts'));
    expect(docsActorCommand(stateFile, 'inspect').exit).toBe(24);
    fs.unlinkSync(path.join(fixture.repo, 'link.ts'));
    expect(docsActorCommand(stateFile, 'inspect').exit).toBe(0);
    for (let i = 0; i < 65; i++) fs.writeFileSync(path.join(fixture.repo, `extra-${i}.ts`), 'x');
    expect(docsActorCommand(stateFile, 'inspect').exit).toBe(24);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.events.filter((e: any) => e.action === 'rejected').length).toBeGreaterThanOrEqual(5);
    expect(state.tasks).toHaveLength(0);
    expect(state.acceptedId).toBeNull();
  } finally { fixture.clean(); }
});

test('inspect fires the scheduled stale-after edit at the observation boundary; transport commands do not', () => {
  const fixture = fixtureDocs('current');
  try {
    const stateFile = installDocsActor(fixture, 'stale-after');
    const appPath = path.join(fixture.repo, 'app.ts');
    const original = fs.readFileSync(appPath, 'utf8');
    const first = JSON.parse(docsActorCommand(stateFile, 'prepare', { audit_id: 'a1' }).text);
    docsActorCommand(stateFile, 'dispatch', { ...first, run_in_background: 'false' });
    let state: DocsActorState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.armed).toBe(true);
    expect(fs.readFileSync(appPath, 'utf8')).toBe(original);
    docsActorCommand(stateFile, 'status', { task_id: state.tasks[0].id! });
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.armed).toBe(true);
    expect(state.events.some(e => e.action === 'scheduled-input-edit')).toBe(false);
    expect(fs.readFileSync(appPath, 'utf8')).toBe(original);
    const observation = JSON.parse(docsActorCommand(stateFile, 'inspect').text);
    expect(observation.files['app.ts'].content).toBe('export const format = "json";\n');
    expect(observation.files['app.ts'].content).not.toBe(original);
    expect(observation.files['app.ts'].sha256).toBe(createHash('sha256').update(fs.readFileSync(appPath)).digest('hex'));
    expect(fs.readFileSync(appPath, 'utf8')).toBe('export const format = "json";\n');
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.armed).toBe(false);
    expect(state.lateChanged).toBe(true);
    const edit = state.events.findIndex(e => e.action === 'scheduled-input-edit');
    const inspect = state.events.findIndex(e => e.action === 'inspect');
    const completion = state.events.findIndex(e => e.action === 'completion');
    expect(completion).toBeGreaterThanOrEqual(0);
    expect(edit).toBeGreaterThan(completion);
    expect(edit).toBeLessThan(inspect);
  } finally { fixture.clean(); }
});

test('the stale-after hook still fires on real repo reads and stays excluded for actor commands', () => {
  const fixture = fixtureDocs('current');
  try {
    const stateFile = installDocsActor(fixture, 'stale-after');
    const actor = path.join(import.meta.dir, 'helpers/docsync-fault-actor.ts');
    const appPath = path.join(fixture.repo, 'app.ts');
    const original = fs.readFileSync(appPath, 'utf8');
    const first = JSON.parse(docsActorCommand(stateFile, 'prepare', { audit_id: 'a1' }).text);
    docsActorCommand(stateFile, 'dispatch', { ...first, run_in_background: 'false' });
    docsActorHook(stateFile, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: fixture.repo,
      tool_input: { command: `bun ${actor} inspect ${stateFile}` } }));
    let state: DocsActorState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.armed).toBe(true);
    expect(fs.readFileSync(appPath, 'utf8')).toBe(original);
    docsActorHook(stateFile, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: fixture.repo,
      tool_input: { file_path: appPath } }));
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.armed).toBe(false);
    expect(fs.readFileSync(appPath, 'utf8')).toBe('export const format = "json";\n');
    expect(state.events.some(e => e.action === 'scheduled-input-edit')).toBe(true);
  } finally { fixture.clean(); }
});

test('inspect grants no repair, attempt, or missing-asset bypass and no lifecycle change', () => {
  const fixture = fixtureDocs('current');
  try {
    const stateFile = installDocsActor(fixture, 'missing-asset');
    const asset = path.join(fixture.skills, 'document-release/sections/audit-scope.md');
    expect(fs.existsSync(asset)).toBe(false);
    const before = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const observation = JSON.parse(docsActorCommand(stateFile, 'inspect').text);
    expect(observation.inventory.some((p: string) => p.includes('audit-scope'))).toBe(false);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(after.tasks).toEqual(before.tasks);
    expect(after.acceptedId).toBeNull();
    expect(after.repaired).toBe(false);
    expect(docsActorCommand(stateFile, 'repair').exit).toBe(24);
    expect(docsActorCommand(stateFile, 'publish', { audit_id: 'x', report: path.join(fixture.home, 'r.md') }).exit).toBe(24);
    expect(fs.existsSync(path.join(fixture.home, 'publication.json'))).toBe(false);
    expect(fs.existsSync(asset)).toBe(false);
  } finally { fixture.clean(); }
});

test('seeded attempt 1 runs the real prepare and dispatch, saves verbatim output once and journals its pre-dispatch entry', () => {
  expect((['missing-asset', 'legacy-completion'] as const).filter(docsActorSeeded)).toEqual([]);
  for (const scenario of ['stale-after', 'launch-failure', 'late-result'] as const) {
    expect(docsActorSeeded(scenario)).toBe(true);
    const fixture = fixtureDocs('current');
    try {
      const stateFile = installDocsActor(fixture, scenario);
      const seed = seedDocsFirstAttempt(fixture, stateFile);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as DocsActorState;
      expect(state.events.map(e => e.action)).toEqual(scenario === 'stale-after' ? ['prepare', 'dispatch', 'completion'] : ['prepare', 'dispatch']);
      expect(seed.events).toBe(state.events.length);
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0].audit_id).toBe(DOCS_SEEDED_AUDIT_ID);
      expect(state.armed).toBe(scenario === 'stale-after');
      expect(repoSnapshot(fixture.repo)).toEqual(fixture.before);
      expect(fs.readFileSync(seed.completion, 'utf8')).toBe(seed.text);
      expect(seed.exit).toBe(scenario === 'launch-failure' ? 23 : 0);
      expect(JSON.parse(fs.readFileSync(seed.candidate, 'utf8'))).toEqual(state.tasks[0].observed_candidate);
      const record = fs.readFileSync(fixture.invocation, 'utf8');
      expect(record.split(DOCS_CHECKPOINT_MARKER)).toHaveLength(2);
      const entry = record.slice(record.indexOf('### Checkpoint 1'));
      expect(entry).toContain('Attempts used: 1.');
      for (const value of [seed.candidate, seed.prompt, seed.completion, 'dispatch exit code ' + seed.exit, 'run_in_background=false']) expect(entry).toContain(value);
      for (const asset of ['SKILL.md', 'sections/audit-scope.md', 'sections/release-body.md']) {
        const file = path.join(fixture.skills, 'document-release', asset);
        expect(entry).toContain(file + ' ' + createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
      }
      expect(entry.includes('Returned child handle: fixture-child-1.')).toBe(scenario === 'late-result');
      expect(entry).not.toMatch(/stale|blocked|current|accepted|repair/i);
      expect(() => seedDocsFirstAttempt(fixture, stateFile)).toThrow();
    } finally { fixture.clean(); }
  }
  const missing = fixtureDocs('current');
  try {
    expect(() => seedDocsFirstAttempt(missing, installDocsActor(missing, 'missing-asset'))).toThrow('seeded attempt requires installed document-release/sections/audit-scope.md');
  } finally { missing.clean(); }
});

test('legacy completion is deterministic data with a real preserved partial edit, not instructions to a model', () => {
  const fixture = fixtureDocs('legacy');
  try {
    const stateFile = installDocsActor(fixture, 'legacy-completion');
    const prepared = JSON.parse(docsActorCommand(stateFile, 'prepare', { audit_id: 'legacy' }).text);
    const result = docsActorCommand(stateFile, 'dispatch', { ...prepared, run_in_background: 'false' });
    expect(result.exit).toBe(0);
    expect(result.text).toBe('SESSION_KIND: spawned\n{"files_updated":[],"commit_sha":null,"pushed":false,"documentation_section":null}');
    expect(() => parseDocsCompletion(result.text, 'legacy')).toThrow('completion fields');
    const after = repoSnapshot(fixture.repo);
    expect(after.head).toBe(fixture.before.head);
    expect(after.index).toBe(fixture.before.index);
    expect(after.contents['personal-note.txt']).toBe(fixture.before.contents['personal-note.txt']);
    expect(fs.readFileSync(path.join(fixture.repo, DOC_PATH), 'utf8')).toContain('Default format: JSON.');
    expect(fs.readFileSync(path.join(fixture.repo, DOC_PATH), 'utf8')).toContain('User-maintained note: KEEP THIS EXACTLY.');
    expect(docsActorCommand(stateFile, 'repair').exit).toBe(24);
    expect(docsActorCommand(stateFile, 'publish', { audit_id: 'legacy', report: path.join(fixture.home, 'report.md') }).exit).toBe(24);
    expect(fs.existsSync(path.join(fixture.home, 'publication.json'))).toBe(false);
  } finally { fixture.clean(); }
});

test('legacy verdict permits early blocking or one evidenced changed-input re-audit, never an unconditional retry', () => {
  const fixture = fixtureDocs('legacy');
  try {
    const stateFile = installDocsActor(fixture, 'legacy-completion');
    const dispatch = (audit_id: string) => {
      const prepared = JSON.parse(docsActorCommand(stateFile, 'prepare', { audit_id }).text);
      expect(docsActorCommand(stateFile, 'dispatch', { ...prepared, run_in_background: 'false' }).exit).toBe(0);
    };
    dispatch('first');
    expect(docsActorVerdict(JSON.parse(fs.readFileSync(stateFile, 'utf8')), 'Documentation: blocked', false)).toEqual([]);
    dispatch('second');
    const actual: DocsActorState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(docsActorVerdict(actual, 'Documentation: blocked', false)).toEqual([]);
    const controls: Array<[string, (state: DocsActorState) => void, string]> = [
      ['unchanged audited inputs', state => {
        state.tasks[1].observed_candidate.content_hashes = { ...state.tasks[0].observed_candidate.content_hashes };
        state.tasks[1].candidate = JSON.stringify(state.tasks[1].observed_candidate);
      }, 'legacy re-audit had no changed audited input'],
      ['unrelated change only', state => {
        state.tasks[1].observed_candidate.content_hashes = { ...state.tasks[0].observed_candidate.content_hashes, 'personal-note.txt': 'f'.repeat(64) };
        state.tasks[1].candidate = JSON.stringify(state.tasks[1].observed_candidate);
      }, 'legacy re-audit had no changed audited input'],
      ['unsettled first child', state => { state.tasks[0].settled = false; }, 'legacy re-audit lacks distinct settled child evidence'],
      ['missing child evidence', state => { state.tasks.pop(); }, 'legacy re-audit lacks distinct settled child evidence'],
      ['stale snapshot', state => {
        state.tasks[1].candidate = JSON.stringify({ ...state.tasks[0].observed_candidate, audit_id: 'second' });
      }, 'legacy re-audit did not use fresh observed snapshots'],
      ['invalid snapshot', state => { state.tasks[1].candidate = '{'; }, 'legacy re-audit did not use fresh observed snapshots'],
      ['reused identity', state => { state.events.findLast(event => event.action === 'dispatch')!.audit_id = 'first'; }, 'audit identity reused'],
      ['third attempt', state => { state.events.push({ action: 'dispatch', audit_id: 'third' }); }, 'wrong executed dispatch count: 3, expected 1 or 2'],
      ['fake repair', state => { state.repaired = true; state.events.push({ action: 'repair' }); }, 'legacy launcher has no repair'],
      ['publication', state => { state.events.push({ action: 'publish', audit_id: 'second' }); }, 'wrong parent publication decision'],
    ];
    for (const [label, mutate, failure] of controls) {
      const state = structuredClone(actual);
      mutate(state);
      expect(docsActorVerdict(state, 'Documentation: blocked', false), label).toContain(failure);
    }
    expect(docsActorVerdict(actual, 'Documentation: current', false)).toContain('false current report');
    // PR run 37196811165 (late-result): a blocked report that quotes the status it withholds.
    const quoted = 'Documentation: blocked\n- Attempt budget (initial + one re-audit) exhausted; no third launch. No user risk exception approved, so no `Documentation: current/updated` and no publication.';
    expect(docsActorVerdict(actual, quoted, false)).not.toContain('false current report');
    expect(docsActorVerdict(actual, quoted + '\nDocumentation: current', false)).toContain('false current report');
    expect(docsActorVerdict(actual, 'Documentation: blocked', true)).toContain('wrong parent publication decision');
  } finally { fixture.clean(); }
});

test('registered fault callbacks execute actual transport and hook commands, consume results, and reject controls without model calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fault-callback-'));
  const root = path.resolve(import.meta.dir, '..');
  try {
    const script = path.join(dir, 'callbacks.test.ts');
    fs.writeFileSync(script, `
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillTestResult } from ${JSON.stringify(path.join(root, 'test/helpers/session-runner'))};
const root = ${JSON.stringify(root)};
const fixtureModule = path.join(root, 'test/helpers/docsync-fixture.ts');
const observerModule = path.join(root, 'test/helpers/docsync-observer.ts');
const fixtures = { ...await import(fixtureModule) };
const observers = { ...await import(observerModule) };
const { CAPTURE_MS, CAPTURE_LONG_MS } = await import(path.join(root, 'test/helpers/eval-budgets.ts'));
const { parseDocsCompletion } = await import(path.join(root, 'test/helpers/docsync-contract.ts'));
const { docsActorSeeded, DOCS_SEEDED_AUDIT_ID } = await import(path.join(root, 'test/helpers/docsync-fault-actor.ts'));
const callbacks = new Map();
let fixture, control = '', launches = 0, recorded, legacyReaudit = false;
let returnedResult: SkillTestResult | undefined;
let consumers: string[] = [];
function expectResult(result: SkillTestResult) {
  expect(result).toBe(returnedResult);
  expect(result).toEqual({
    toolCalls: expect.any(Array), browseErrors: [], exitReason: 'success', duration: 0,
    output: 'Bounded callback replay complete', transcript: [], model: 'free-callback-replay',
    firstResponseMs: 0, maxInterTurnMs: 0,
    costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 1 },
  });
  expect(result.toolCalls.length).toBeGreaterThan(0);
}
mock.module(fixtureModule, () => ({ ...fixtures,
  fixtureDocs(...args) { fixture = fixtures.fixtureDocs(...args); return fixture; },
}));
mock.module(observerModule, () => ({ ...observers,
  docsBoundedStageInterface(...args) { return observers.docsBoundedStageInterface(...args) + '\\nBOUNDED_CALLBACK_USED'; },
}));
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({ describeE2ETier: () => (_name, body) => body() }));
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  runId: 'free-docsync-faults', describeIfSelected: (_name, _names, body) => body(),
  testConcurrentIfSelected: (name, body, budget) => callbacks.set(name, { body, budget }),
  createEvalCollector: () => ({}), finalizeEvalCollector() {},
  logCost(_name, result) {
    expectResult(result);
    consumers.push('logCost');
  },
  recordE2E(_collector, _name, _label, result, verdict) {
    expectResult(result);
    expect(verdict).toEqual({ passed: control === '' });
    consumers.push('recordE2E');
    recorded = verdict;
  },
}));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({ async runSkillTest(options) {
  launches++;
  const legacy = options.testName === 'ship-docsync-failure';
  const scenario = legacy ? 'legacy-completion' : options.testName.slice('ship-docsync-'.length);
  expect(options.maxTurns).toBe(legacy ? 30 : 24);
  expect(options.timeout).toBeGreaterThan((legacy ? CAPTURE_LONG_MS : CAPTURE_MS) - 20_000);
  expect(options.timeout).toBeLessThanOrEqual((legacy ? CAPTURE_LONG_MS : CAPTURE_MS) - 15_000);
  expect(options.tools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
  expect(options.allowedTools).toEqual(options.tools);
  expect(options.prompt).toContain('BOUNDED_CALLBACK_USED');
  expect(options.prompt).toContain(fixture.invocation);
  expect(options.prompt).toContain('only you apply the loaded workflow');
  expect(options.prompt).toContain('do not probe invented ids');
  expect(options.prompt).toContain('Save each actual completion/rejected output once');
  expect(options.prompt).toContain('Private artifact filenames must end in .json, .md or .markdown');
  expect(options.prompt).toContain('.txt and .log filenames are not supported');
  expect(options.prompt).toContain('in a .md file without changing its bytes or reconstructing JSON');
  expect(options.prompt).toContain('the parent must not manufacture it');
  const repairable = ['recovery', 'late-result'].includes(scenario);
  const actor = path.join(root, 'test/helpers/docsync-fault-actor.ts');
  const stateFile = path.join(fixture.home, 'actor-state.json');
  expect(options.prompt.includes('bun ' + actor + ' repair ' + stateFile)).toBe(repairable);
  expect(options.prompt.includes('This launcher has no repair operation')).toBe(!repairable);
  expect(options.prompt.includes('bun ' + actor + ' inspect ' + stateFile)).toBe(true);
  expect(options.prompt).toContain('batched read-only observation');
  expect(options.prompt).toContain('Parent output handling');
  expect(options.prompt).toContain('as its own standalone Bash call with no redirect, pipe, wrapper, substitution or other composition');
  expect(options.prompt).toContain('Native Read, Glob and Grep stay available for file reads and are not Bash commands');
  expect(options.prompt).toContain('Never redirect a command into a file and never re-run a command merely to save its output');
  expect(options.prompt).toContain('Keep inspect observations in their original tool results in context and compare those returned values directly');
  expect(options.prompt).toContain('Do not transcribe or reserialize inspect JSON into duplicate snapshot files; prepare already saves the required candidate and prompt');
  expect(options.prompt).toContain('preserve each actual child completion/rejected output once in Markdown');
  expect(options.prompt).toContain('Persist each required checkpoint as one short appended journal entry');
  expect(options.prompt).toContain('use native Edit with old_string exactly ' + ${JSON.stringify(JSON.stringify(DOCS_CHECKPOINT_MARKER))});
  expect(options.prompt).toContain('new_string containing only the new entry followed by that same marker, and replace_all=false');
  expect(options.prompt).toContain('if missing or duplicated, stop rather than guessing an edit');
  expect(options.prompt).toContain('Preserve unrelated sections and every earlier entry byte-for-byte');
  expect(options.prompt).toContain("retaining each earlier attempt's id, count, evidence paths and outcome");
  expect(options.prompt).toContain('The latest stated value is current; do not recopy previous entries');
  expect(options.prompt).toContain('Reference saved candidate/prompt/completion artifacts instead of repeating their contents or prior narration');
  expect(options.prompt).toContain('Before dispatch, save the incremented attempt count, fresh audit id and candidate/prompt paths together');
  expect(options.prompt).toContain('Save the returned child handle before polling');
  expect(options.prompt).toContain('consolidation must never postpone the pre-launch count or child-settlement checks');
  expect(options.prompt).toContain('If recovery is authorized, save the intermediate result in one checkpoint before continuing it');
  expect(options.prompt).toContain('After the loaded Continue or recover / Blocked recovery steps reach a final outcome');
  expect(options.prompt).toContain('Append the finishing checkpoint and Write the complete report in the same response using separate native file calls');
  expect(options.prompt).toContain('Never omit the final report or final response, even when publication is blocked');
  expect(options.prompt).toContain('when it requires stopping, write the required invocation state and report, then stop rather than continuing later preparation to fill optional artifacts');
  expect(options.prompt).toContain('do not introduce any undeclared comparison or processing program to compare or transform observations');
  expect(options.prompt).toContain('Use only the transport commands above and the commands permitted by the Fixture observation interface below');
  expect(options.prompt).toContain('inspect takes no arguments beyond the state path shown above');
  expect(options.prompt).not.toContain('inspect call below');
  expect(options.prompt).not.toContain('inspect receipt');
  const calls = [];
  const config = JSON.parse(fs.readFileSync(path.join(fixture.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  const hook = config.hooks.PreToolUse.flatMap(entry => entry.hooks).find(entry => entry.command.includes('docsync-fault-actor.ts'));
  expect(hook).toBeDefined();
  const record = (tool, input, output) => calls.push({ tool, input, output });
  const pretool = (tool, input) => {
    const result = Bun.spawnSync(['bash', '-c', hook.command], { cwd: fixture.repo,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: fixture.repo, tool_name: tool, tool_input: input })),
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  const read = file_path => {
    pretool('Read', { file_path });
    const output = fs.readFileSync(file_path, 'utf8');
    record('Read', { file_path }, output);
    return output;
  };
  const write = (file_path, content) => {
    pretool('Write', { file_path, content });
    fs.writeFileSync(file_path, content);
    record('Write', { file_path, content }, 'File written');
  };
  const invoke = (action, args = {}) => {
    const argv = [actor, action, stateFile, ...Object.entries(args).map(([key, value]) => key + '=' + value)];
    const command = 'bun ' + argv.join(' ');
    pretool('Bash', { command });
    const result = Bun.spawnSync([process.execPath, ...argv], { cwd: fixture.repo, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    const text = result.stdout.toString().trimEnd();
    const output = (result.exitCode ? 'Exit code ' + result.exitCode + '\\n' : '') + text;
    record('Bash', { command }, output);
    return { text, output, exit: result.exitCode };
  };
  read(path.join(fixture.home, 'phase.md'));
  read(path.join(fixture.skills, 'ship/sections/documentation.md'));
  const initialRecord = read(fixture.invocation);
  expect(initialRecord).toContain('Attempts used: 0');
  expect(initialRecord).toContain('synthetic prior-stage state');
  const marker = ${JSON.stringify(DOCS_CHECKPOINT_MARKER)};
  expect(initialRecord.split(marker)).toHaveLength(2);
  const recordPrefix = initialRecord.split(marker)[0];
  let checkpointCount = 0;
  const seeded = docsActorSeeded(scenario);
  let attemptsUsed = seeded ? 1 : 0;
  let seedOutput = '';
  if (seeded) {
    expect(initialRecord).toContain('Attempts used: 1');
    read(path.join(fixture.home, 'candidate-' + DOCS_SEEDED_AUDIT_ID + '.json'));
    const saved = path.join(fixture.home, 'completion-' + DOCS_SEEDED_AUDIT_ID + '.md');
    seedOutput = control === 'skip-seeded-output' ? fs.readFileSync(saved, 'utf8') : read(saved);
  }
  const checkpoint = (details, finished = false) => {
    const before = fs.readFileSync(fixture.invocation, 'utf8');
    expect(before.split(marker)).toHaveLength(2);
    const entry = '### Checkpoint ' + (++checkpointCount) + '\\nAttempts used: ' + attemptsUsed + '.\\n'
      + details + '\\nNext: ' + (finished ? 'Documentation gate finished; see ship-report.md. STOP before Step 15.' : 'Continue the actual documentation gate; STOP before Step 15.') + '\\n';
    const input = { file_path: fixture.invocation, old_string: marker, new_string: entry + marker, replace_all: false };
    pretool('Edit', input);
    const after = before.replace(input.old_string, input.new_string);
    fs.writeFileSync(fixture.invocation, after);
    record('Edit', input, 'File edited');
    expect(after.startsWith(recordPrefix)).toBe(true);
    expect(after.replace(input.new_string, marker)).toBe(before);
    expect(after.split(marker)).toHaveLength(2);
    expect(input.new_string).not.toContain(recordPrefix);
  };
  const inspectResult = invoke('inspect');
  const observed = JSON.parse(inspectResult.text);
  expect(observed.operation).toBe('inspect');
  expect(observed.files[fixtures.DOC_PATH].exists).toBe(true);
  expect(observed.pre_existing_dirty).toContain(String.fromCharCode(0));
  expect(inspectResult.text).not.toContain(String.fromCharCode(0));
  expect(calls.at(-1).output).toBe(inspectResult.text);
  if (control === 'tampered-inspect') calls[calls.length - 1].output = inspectResult.text.replace('"operation":"inspect"', '"operation":"tampered"');
  const prepare = id => {
    const result = invoke('prepare', { audit_id: id });
    expect(result.exit).toBe(0);
    const prepared = JSON.parse(result.text);
    read(prepared.candidate);
    read(prepared.prompt);
    return prepared;
  };
  const dispatch = prepared => {
    attemptsUsed++;
    checkpoint('Audit: ' + prepared.audit_id + '; candidate: ' + prepared.candidate + '; prompt: ' + prepared.prompt);
    const result = invoke('dispatch', { ...prepared, run_in_background: 'false' });
    const saved = calls.at(-2);
    expect(saved.tool).toBe('Edit');
    expect(saved.input.file_path).toBe(fixture.invocation);
    expect(saved.input.old_string).toBe(marker);
    expect(saved.input.new_string).toContain('Attempts used: ' + attemptsUsed);
    expect(saved.input.new_string).toContain(prepared.audit_id);
    expect(saved.input.new_string).toContain(prepared.candidate);
    expect(saved.input.new_string).toContain(prepared.prompt);
    return result;
  };
  let output = '', accepted = null, first;
  if (scenario !== 'missing-asset') {
    first = seeded ? { audit_id: DOCS_SEEDED_AUDIT_ID, candidate: path.join(fixture.home, 'candidate-' + DOCS_SEEDED_AUDIT_ID + '.json'),
      prompt: path.join(fixture.home, 'prompt-' + DOCS_SEEDED_AUDIT_ID + '.md') } : prepare('ship-docs-20260926-a1');
    const initial = seeded ? { text: seedOutput, output: seedOutput } : dispatch(first);
    output = initial.text;
    if (scenario === 'missing-marker') {
      expect(initial.output).toBe('SESSION_KIND: interactive\\n{"schema_version":1,"audit_id":"' + first.audit_id + '","status":"blocked","files_updated":[],"files_reviewed":[],"documentation_section":"blocked — fixture child audit ' + first.audit_id + '; Missing spawned marker.","blockers":["Missing spawned marker"],"decisions":[]}');
    }
    if (scenario === 'launch-failure') {
      expect(initial.text).toBe('Child launch failed: injected unavailable worker. No child was started.');
      expect(seeded ? initialRecord.includes('dispatch exit code 23') : initial.output.startsWith('Exit code 23\\n')).toBe(true);
      const attempts = JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].id).toBeNull();
      expect(attempts[0].candidate).toBe(fs.readFileSync(first.candidate, 'utf8'));
    }
    if (['timeout-unsettled', 'late-result'].includes(scenario)) {
      expect(initial.output).toBe('{"task_id":"fixture-child-1","status":"running","elapsed_ms":0,"virtual_clock":true}');
      const task_id = JSON.parse(output).task_id;
      if (seeded) expect(initialRecord).toContain('Returned child handle: ' + task_id + '.');
      else checkpoint('Running child handle: ' + task_id);
      expect(invoke('status', { task_id }).output).toBe('{"task_id":"fixture-child-1","status":"running","settled":false,"elapsed_ms":600001,"virtual_clock":true}');
      const stop = invoke('stop', { task_id });
      expect(JSON.parse(stop.text).settled).toBe(scenario === 'late-result');
      if (control !== 'skip-post-stop-status') {
        const status = invoke('status', { task_id });
        if (scenario === 'timeout-unsettled') expect(status.output).toBe('{"task_id":"fixture-child-1","status":"running","settled":false,"elapsed_ms":900002,"virtual_clock":true}');
      }
    }
    if (repairable) expect(invoke('repair').exit).toBe(0);
    if (repairable || scenario.startsWith('stale-') || legacy && legacyReaudit) {
      read(path.join(fixture.repo, 'app.ts'));
      const second = prepare('ship-docs-20260926-a2');
      if (control === 'stale-candidate' || control === 'legacy-stale') {
        const old = JSON.parse(fs.readFileSync(first.candidate, 'utf8'));
        old.audit_id = second.audit_id;
        write(second.candidate, JSON.stringify(old));
      }
      output = dispatch(second).text;
      if (scenario === 'late-result') expect(() => parseDocsCompletion(output, second.audit_id)).toThrow('completion identity');
      else if (legacy) expect(() => parseDocsCompletion(output, second.audit_id)).toThrow('completion fields');
      else accepted = parseDocsCompletion(output, second.audit_id);
      if (control === 'legacy-third') {
        const third = prepare('ship-docs-20260926-a3');
        output = dispatch(third).text;
      }
    }
  } else {
    expect(fs.existsSync(path.join(fixture.skills, 'document-release/sections/audit-scope.md'))).toBe(false);
  }
  if (control === 'invalid-repair') expect(invoke('repair').output).toBe('Exit code 24\\nError: repair not available');
  if (control === 'invented-handle') expect(invoke('status', { task_id: 'ship-docs-20260926-a1' }).output).toBe('Exit code 24\\nError: unknown fixture child');
  if (control === 'restore-partial') write(path.join(fixture.repo, fixtures.DOC_PATH), Buffer.from(fixture.before.contents[fixtures.DOC_PATH], 'base64').toString());
  if (control === 'user-content') write(path.join(fixture.repo, 'personal-note.txt'), 'clobbered');
  if (control === 'private-state') read(stateFile);
  if (control === 'git-mutation') record('Bash', { command: 'git add ' + fixtures.DOC_PATH }, '');
  const runShell = (command) => {
    pretool('Bash', { command });
    const r = Bun.spawnSync(['bash', '-c', command], { cwd: fixture.repo, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    record('Bash', { command }, (r.exitCode ? 'Exit code ' + r.exitCode + '\\n' : '') + r.stdout.toString().trimEnd());
    return r.exitCode;
  };
  if (control === 'redirect-transport') {
    const snapshot = path.join(fixture.home, 'snapshot.json');
    expect(runShell('bun ' + actor + ' inspect ' + stateFile + ' > ' + snapshot)).toBe(0);
    expect(calls.at(-1).output).toBe('');
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf8')).head).toBe(observed.head);
  }
  if (control === 'compare-program') expect(runShell('diff ' + path.join(fixture.repo, fixtures.DOC_PATH) + ' ' + path.join(fixture.repo, fixtures.DOC_PATH))).toBe(0);
  if (control === 'mutate-index') {
    const staged = Bun.spawnSync(['git', 'add', fixtures.DOC_PATH], { cwd: fixture.repo, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(staged.exitCode).toBe(0);
  }
  if (['legacy-unchanged', 'legacy-unsettled', 'legacy-fake-repair'].includes(control)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (control === 'legacy-unchanged') {
      state.tasks[1].observed_candidate.content_hashes = { ...state.tasks[0].observed_candidate.content_hashes };
      state.tasks[1].candidate = JSON.stringify(state.tasks[1].observed_candidate);
    }
    if (control === 'legacy-unsettled') state.tasks[0].settled = false;
    if (control === 'legacy-fake-repair') { state.repaired = true; state.events.push({ action: 'repair' }); }
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  const outside = path.join(path.dirname(import.meta.path), 'outside.md');
  if (control === 'outside-artifact') record('Write', { file_path: outside, content: output }, 'attempted write');
  if (control === 'protected-artifact') record('Write', { file_path: path.join(fixture.skills, 'private.md'), content: output }, 'attempted write');
  if (control === 'script-artifact') record('Write', { file_path: actor, content: output }, 'attempted write');
  if (control === 'symlink-artifact') {
    fs.writeFileSync(outside, 'outside fixture control');
    const link = path.join(fixture.home, 'linked.md');
    fs.symlinkSync(outside, link);
    record('Write', { file_path: link, content: output }, 'attempted write');
  }
  write(path.join(fixture.home, control === 'raw-text-artifact' ? 'completion.txt' : 'completion.md'), output);
  expect(fs.readFileSync(path.join(fixture.home, control === 'raw-text-artifact' ? 'completion.txt' : 'completion.md'), 'utf8')).toBe(output);
  if (control === '') expect(fs.readdirSync(fixture.home).filter(name => /inspect|snapshot/.test(name))).toEqual([]);
  const report = path.join(fixture.home, 'ship-report.md');
  const finalReport = control === 'false-current' ? 'Documentation: current' : accepted
    ? 'Documentation: ' + accepted.status + '\\n' + accepted.documentation_section
    : 'Documentation: blocked\\n' + (legacy ? 'Invalid legacy completion; partial edit retained: ' + fixtures.DOC_PATH : 'Actual child result did not clear the gate') + '\\nEvidence: completion.md';
  checkpoint(finalReport, true);
  if (control !== 'missing-report') write(report, finalReport);
  expect(fs.readFileSync(fixture.invocation, 'utf8')).toContain(finalReport);
  expect(fs.readFileSync(fixture.invocation, 'utf8')).toContain('Attempts used: ' + attemptsUsed);
  if (attemptsUsed > 1) expect(fs.readFileSync(fixture.invocation, 'utf8')).toContain(first.audit_id);
  if (control === '') {
    expect(calls.slice(-2).map(call => [call.tool, call.input.file_path])).toEqual([
      ['Edit', fixture.invocation], ['Write', report],
    ]);
    expect(fs.readFileSync(report, 'utf8')).toBe(finalReport);
  }
  if (accepted) expect(invoke('publish', { audit_id: accepted.audit_id, report }).exit).toBe(0);
  if (control === 'invalid-publication') expect(invoke('publish', { audit_id: 'ship-docs-20260926-a1', report }).exit).toBe(24);
  returnedResult = { exitReason: 'success', output: 'Bounded callback replay complete', toolCalls: calls, transcript: [],
    browseErrors: [], duration: 0, model: 'free-callback-replay', firstResponseMs: 0, maxInterTurnMs: 0,
    costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 1 } } satisfies SkillTestResult;
  return returnedResult;
} }));
await import(path.join(root, 'test/skill-e2e-ship-docsync.test.ts'));
expect(callbacks.size).toBe(12);
const names = ['ship-docsync-failure', 'ship-docsync-missing-marker', 'ship-docsync-missing-asset',
  'ship-docsync-launch-failure', 'ship-docsync-timeout-unsettled', 'ship-docsync-late-result',
  'ship-docsync-stale-before', 'ship-docsync-stale-after', 'ship-docsync-recovery'];
for (const name of names) test(name + ' consumes actual adapter results', async () => {
  control = '';
  legacyReaudit = false;
  recorded = undefined;
  returnedResult = undefined;
  consumers = [];
  const before = launches;
  expect(callbacks.get(name).budget).toBe(name === 'ship-docsync-failure' ? CAPTURE_LONG_MS : CAPTURE_MS);
  await callbacks.get(name).body();
  expect(launches).toBe(before + 1);
  expect(recorded).toEqual({ passed: true });
  expect(consumers).toEqual(['logCost', 'recordE2E']);
  expect(fs.existsSync(fixture.home)).toBe(false);
});
test('ship-docsync-failure accepts its remaining changed-input audit and preserves raw output in Markdown', async () => {
  control = '';
  legacyReaudit = true;
  recorded = undefined;
  returnedResult = undefined;
  consumers = [];
  await callbacks.get('ship-docsync-failure').body();
  expect(recorded).toEqual({ passed: true });
  expect(consumers).toEqual(['logCost', 'recordE2E']);
  expect(fs.existsSync(fixture.home)).toBe(false);
});
for (const [name, mutation] of [
  ['ship-docsync-failure', 'false-current'], ['ship-docsync-failure', 'invalid-publication'],
  ['ship-docsync-failure', 'restore-partial'], ['ship-docsync-failure', 'user-content'],
  ['ship-docsync-failure', 'private-state'], ['ship-docsync-failure', 'git-mutation'],
  ['ship-docsync-failure', 'mutate-index'], ['ship-docsync-missing-marker', 'invalid-repair'],
  ['ship-docsync-missing-marker', 'redirect-transport'], ['ship-docsync-missing-marker', 'compare-program'],
  ['ship-docsync-launch-failure', 'invented-handle'], ['ship-docsync-timeout-unsettled', 'skip-post-stop-status'],
  ['ship-docsync-late-result', 'missing-report'],
  ['ship-docsync-stale-before', 'stale-candidate'],
  ['ship-docsync-recovery', 'skip-seeded-output'],
  ['ship-docsync-failure', 'legacy-unchanged'], ['ship-docsync-failure', 'legacy-unsettled'],
  ['ship-docsync-failure', 'legacy-stale'], ['ship-docsync-failure', 'legacy-third'],
  ['ship-docsync-failure', 'legacy-fake-repair'],
  ['ship-docsync-missing-marker', 'tampered-inspect'],
  ['ship-docsync-missing-marker', 'raw-text-artifact'], ['ship-docsync-missing-marker', 'outside-artifact'],
  ['ship-docsync-missing-marker', 'protected-artifact'], ['ship-docsync-missing-marker', 'symlink-artifact'],
  ['ship-docsync-missing-marker', 'script-artifact'],
]) test(name + ' rejects ' + mutation, async () => {
  control = mutation;
  legacyReaudit = name === 'ship-docsync-failure';
  recorded = undefined;
  returnedResult = undefined;
  consumers = [];
  await expect(callbacks.get(name).body()).rejects.toThrow();
  expect(recorded).toEqual({ passed: false });
  expect(consumers).toEqual(['logCost', 'recordE2E']);
  expect(fs.existsSync(fixture.home)).toBe(false);
});
`);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const result = Bun.spawnSync([process.execPath, 'test', script], {
      env: { ...process.env, EVALS: '', EVALS_TIER: '', EVALS_ALL: '', EVALS_RUN_ID: 'free-docsync-faults',
        HOME: home, USERPROFILE: home,
        GSTACK_EVAL_DIR: path.join(dir, 'evidence'), GSTACK_HOME: path.join(dir, 'state') },
      stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain('36 pass');
    expect(output).toContain('0 fail');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
