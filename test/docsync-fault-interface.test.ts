import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DOC_PATH, docsSnapshotArgv, fixtureDocs, gitAt, gitBlobId, repoSnapshot } from './helpers/docsync-fixture';
import { DOCS_CHECKPOINT_MARKER, DOCS_SEEDED_AUDIT_ID, docsActorCommand, docsActorHook, docsActorSeeded, installDocsActor, seedDocsFirstAttempt, type DocsActorState } from './helpers/docsync-fault-actor';
import { docsActorVerdict } from './helpers/docsync-fault-eval';
import { extractDocsDispatch, parseDocsCompletion } from './helpers/docsync-contract';
import { docsFaultCallbackScript } from './helpers/docsync-fault-callbacks';
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
    const independent = path.join(fixture.home, 'independent-first.json');
    const argv = docsSnapshotArgv(fixture, 'first', independent);
    expect(spawnSync(argv[0]!, argv.slice(1), { cwd: fixture.repo, encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    expect(candidate).toEqual(JSON.parse(fs.readFileSync(independent, 'utf8')));
    expect(prepared.snapshot_command).toBe(docsSnapshotArgv(fixture, 'first', prepared.candidate).join(' '));
    const supplied = JSON.parse(fs.readFileSync(path.join(fixture.home, 'candidate.json'), 'utf8'));
    expect(candidate.selected).toEqual(supplied.selected_paths);
    expect(candidate.docs).toEqual([DOC_PATH]);
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
    expect(second.hashes['app.ts']).not.toBe(candidate.hashes['app.ts']);
    expect(second.hashes['app.ts']).toBe(gitAt(fixture.repo, 'hash-object', 'app.ts'));
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

// PR gate run 38990111230 and 79 of 198 docsync captures: prepare wrote a record the installed compare
// rejected ("not a gstack-docs-candidate record"), so every fault case was pushed off the documented path.
test('prepare, the installed compare and inspect agree for unchanged inputs, a doc edit, an index change and a deletion', () => {
  const changes: Array<[string, (repo: string) => void, Record<string, unknown>, (o: any, c: any) => void]> = [
    ['unchanged', () => {}, { head_changed: false, index_changed: false, content_changed: [], newly_dirty: [] }, (o, c) => {
      for (const rel of Object.keys(c.hashes)) expect(o.files[rel]?.hash ?? null).toBe(c.hashes[rel]);
    }],
    ['doc edit', repo => fs.appendFileSync(path.join(repo, DOC_PATH), 'Edited.\n'),
      { head_changed: false, index_changed: false, content_changed: [DOC_PATH], newly_dirty: [] },
      (o, c) => expect(o.files[DOC_PATH].hash).not.toBe(c.hashes[DOC_PATH])],
    ['index change', repo => gitAt(repo, 'add', 'personal-note.txt'),
      { head_changed: false, index_changed: true, content_changed: [], newly_dirty: [] },
      (o, c) => expect(o.index).not.toEqual(c.index)],
    ['deletion', repo => fs.unlinkSync(path.join(repo, 'app.ts')),
      { head_changed: false, index_changed: false, content_changed: ['app.ts'], newly_dirty: [] },
      (o, c) => { expect(o.files['app.ts']).toEqual({ exists: false }); expect(c.hashes['app.ts']).toMatch(/^[0-9a-f]{40}$/); }],
  ];
  for (const [label, change, expected, agree] of changes) {
    const fixture = fixtureDocs('current');
    try {
      const stateFile = installDocsActor(fixture, 'recovery');
      const prepared = JSON.parse(docsActorCommand(stateFile, 'prepare', { audit_id: 'seq' }).text);
      const candidate = JSON.parse(fs.readFileSync(prepared.candidate, 'utf8'));
      change(fixture.repo);
      const compare = spawnSync(path.join(fixture.skills, 'bin/gstack-docs-candidate'), ['compare', prepared.candidate],
        { cwd: fixture.repo, encoding: 'utf8', timeout: 30_000 });
      expect(compare.status, `${label}: ${compare.stderr}`).toBe(0);
      expect(JSON.parse(compare.stdout), label).toEqual({ audit_id: 'seq', ...expected });
      const observation = JSON.parse(docsActorCommand(stateFile, 'inspect').text);
      expect(observation.base, label).toBe(candidate.base);
      expect(observation.head, label).toBe(candidate.head);
      expect(observation.index.length > 0, label).toBe(true);
      if (!expected.index_changed) expect(observation.index, label).toEqual(candidate.index);
      agree(observation, candidate);
      for (const rel of observation.inventory) if (observation.files[rel].exists) {
        expect(observation.files[rel].hash, `${label}: ${rel}`).toBe(gitBlobId(fs.readFileSync(path.join(fixture.repo, rel))));
      }
    } finally { fixture.clean(); }
  }
}, 30_000);

// DX confirm round 2: a failed Prepare snapshot must be diagnosable from its own output and files, and a transient
// failure gets exactly one retry under a fresh audit id; the failed id can never be dispatched or reused.
test('a snapshot failure before or after candidate creation reports a bounded redacted reason, keeps its files and allows one retry under a fresh id', () => {
  const secret = 'ghp' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const noisy = (exit: number) => `#!/bin/sh\nyes 'gstack-docs-candidate: noise line' | head -n 200 >&2\necho "token ${secret} at $PWD" >&2\nexit ${exit}\n`;
  const writes = (body: string, exit: number) => `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --out ] && printf '%s' '${body}' > "$2"; shift; done\necho "token ${secret} at $PWD" >&2\nexit ${exit}\n`;
  const stubs: Array<[string, string, string, boolean]> = [
    ['before creation', noisy(3), 'snapshot_exit', false],
    ['after creation', writes('{"schema_version":1', 1), 'snapshot_exit', true],
    ['invalid record', writes('{}', 0), 'snapshot_invalid_record', true],
  ];
  for (const [label, stub, reason, candidateKept] of stubs) {
    const fixture = fixtureDocs('current');
    try {
      const stateFile = installDocsActor(fixture, 'recovery');
      const helper = path.join(fixture.skills, 'bin/gstack-docs-candidate');
      const installed = fs.readFileSync(helper);
      fs.writeFileSync(helper, stub);
      const before = repoSnapshot(fixture.repo);
      const failed = docsActorCommand(stateFile, 'prepare', { audit_id: 'fails' });
      expect(failed.exit, label).toBe(25);
      expect(failed.text, label).toContain(`prepare failed: reason=${reason} `);
      expect(failed.text, label).toContain('retry at most once, with a fresh audit_id');
      expect(failed.text, label).toContain('<REDACTED-github.pat> at <HOME>/repo');
      expect(failed.text, label).not.toContain(secret);
      const failureFile = path.join(fixture.home, 'prepare-fails-failure.json');
      const failure = JSON.parse(fs.readFileSync(failureFile, 'utf8'));
      expect(failure.reason, label).toBe(reason);
      expect(failure.stderr_excerpt.length, label).toBeLessThanOrEqual(800);
      expect(failure.stderr_excerpt, label).not.toContain(fixture.home);
      expect(failed.text, label).toContain(failure.stderr_excerpt);
      expect(failure.stderr_excerpt.startsWith('…'), label).toBe(label === 'before creation');
      const candidate = path.join(fixture.home, 'candidate-fails.json');
      expect(failure.kept, label).toEqual(candidateKept ? [candidate, failureFile] : [failureFile]);
      expect(fs.existsSync(candidate), label).toBe(candidateKept);
      expect(fs.existsSync(path.join(fixture.home, 'prompt-fails.md')), label).toBe(false);
      expect(repoSnapshot(fixture.repo)).toEqual(before);
      const reused = docsActorCommand(stateFile, 'prepare', { audit_id: 'fails' });
      expect([reused.exit, reused.text.includes('reason=snapshot_retry_needs_fresh_id')], label).toEqual([24, true]);
      if (label === 'before creation') {
        const second = docsActorCommand(stateFile, 'prepare', { audit_id: 'fails-again' });
        expect([second.exit, second.text.includes('retry none left')], label).toEqual([25, true]);
        fs.writeFileSync(helper, installed);
        const third = docsActorCommand(stateFile, 'prepare', { audit_id: 'fails-third' });
        expect([third.exit, third.text.includes('reason=snapshot_retry_exhausted')], label).toEqual([24, true]);
        expect(fs.existsSync(path.join(fixture.home, 'candidate-fails-third.json'))).toBe(false);
      } else {
        const dispatched = docsActorCommand(stateFile, 'dispatch', { audit_id: 'fails', candidate, prompt: path.join(fixture.home, 'prompt-fails.md'), run_in_background: 'false' });
        expect([dispatched.exit, dispatched.text.includes('dispatch of a failed prepare')], label).toEqual([24, true]);
        fs.writeFileSync(helper, installed);
        const retried = docsActorCommand(stateFile, 'prepare', { audit_id: 'fails-retry' });
        expect(retried.exit, label).toBe(0);
        expect(JSON.parse(fs.readFileSync(JSON.parse(retried.text).candidate, 'utf8')).audit_id).toBe('fails-retry');
      }
      const state: DocsActorState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.events.map(e => e.action), label)
        .toEqual(label === 'before creation' ? ['prepare-failed', 'rejected', 'prepare-failed', 'rejected'] : ['prepare-failed', 'rejected', 'rejected', 'prepare']);
    } finally { fixture.clean(); }
  }
}, 30_000);

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
    expect(observation.index).toEqual(before.index.split('\n'));
    expect(observation.base).toBe(gitAt(fixture.repo, 'rev-parse', 'main'));
    expect(typeof observation.pre_existing_dirty).toBe('string');
    expect(observation.diff_committed).toContain('widget.md.tmpl');
    expect(observation.diff_committed).toContain('Supports plain text output.');
    expect(observation.diff_cached).toBe('');
    expect(observation.diff_worktree).toBe('');
    expect(observation.inventory).toEqual(Object.keys(before.contents).sort());
    for (const rel of observation.inventory) {
      const disk = fs.readFileSync(path.join(fixture.repo, rel));
      expect(observation.files[rel].exists).toBe(true);
      expect(observation.files[rel].hash).toBe(gitBlobId(disk));
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
    expect(observation.files['app.ts'].hash).toBe(gitAt(fixture.repo, 'hash-object', 'app.ts'));
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
        state.tasks[1].observed_candidate.hashes = { ...state.tasks[0].observed_candidate.hashes };
        state.tasks[1].candidate = JSON.stringify(state.tasks[1].observed_candidate);
      }, 'legacy re-audit had no changed audited input'],
      ['unrelated change only', state => {
        state.tasks[1].observed_candidate.hashes = { ...state.tasks[0].observed_candidate.hashes, 'personal-note.txt': 'f'.repeat(40) };
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

const CALLBACK_SPLITS = [
  ['adapter results', 'consumes actual adapter results|accepts its remaining changed-input audit', 10],
] as const;

for (const [split, pattern, count] of CALLBACK_SPLITS) test(`registered fault callbacks execute actual transport and hook commands, consume results, and reject controls without model calls (${split})`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fault-callback-'));
  const root = path.resolve(import.meta.dir, '..');
  try {
    const script = path.join(dir, 'callbacks.test.ts');
    fs.writeFileSync(script, docsFaultCallbackScript(root));
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const result = Bun.spawnSync([process.execPath, 'test', script, '--test-name-pattern', pattern], {
      env: { ...process.env, EVALS: '', EVALS_TIER: '', EVALS_ALL: '', EVALS_RUN_ID: 'free-docsync-faults',
        HOME: home, USERPROFILE: home,
        GSTACK_EVAL_DIR: path.join(dir, 'evidence'), GSTACK_HOME: path.join(dir, 'state') },
      stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain(`${count} pass`);
    expect(output).toContain(`${36 - count} filtered out`);
    expect(output).toContain('0 fail');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
