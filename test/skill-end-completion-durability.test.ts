/** Completion durability and privacy at the real skill-end boundary.
 * All Git writes stay in disposable local fixtures; no live remote/API. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(import.meta.dir, '../bin');
const TIMELINE = 'projects/completion-order/timeline.jsonl';
let fixture: string, state: string, remote: string;
let env: Record<string, string>;

function run(bin: string, args: string[] = [], extra: Record<string, string> = {}) {
  const r = spawnSync(path.join(BIN, bin), args, {
    cwd: fixture, env: { ...env, ...extra }, encoding: 'utf-8', timeout: 30_000,
  });
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(0);
  return r;
}
function git(args: string[], dir = state): string {
  const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf-8', timeout: 30_000 });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}
function write(rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(state, rel)), { recursive: true });
  fs.writeFileSync(path.join(state, rel), text);
}
function remoteText(rel: string): string { return git(['show', `main:${rel}`], remote); }
function remotePaths(): string { return git(['ls-tree', '-r', '--name-only', 'main'], remote); }
function queue(): string {
  const dir = path.join(state, '.brain-queue.d');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')).map(x => fs.readFileSync(path.join(dir, x), 'utf8')).join('') : '';
}
function seedTrackedTimeline() {
  run('gstack-timeline-log', [JSON.stringify({ skill: 'qa', event: 'started' })]);
  run('gstack-brain-sync', ['--discover-new']);
  run('gstack-brain-sync', ['--once']);
  expect(remoteText(TIMELINE)).toContain('started');
}
function end(extra: Record<string, string> = {}) {
  return run('gstack-skill-end', ['--skill', 'qa', '--outcome', 'success', '--session-id', 'completion-fixture'], extra);
}

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-completion-'));
  state = path.join(fixture, 'state'); remote = path.join(fixture, 'remote.git');
  fs.mkdirSync(state);
  // Do not inherit live state-root overrides, git configuration or API keys.
  const config = path.join(fixture, 'gitconfig');
  fs.writeFileSync(config, '[user]\n name = Fixture\n email = fixture@example.invalid\n');
  env = { PATH: process.env.PATH!, HOME: fixture, GSTACK_HOME: state, GSTACK_STATE_ROOT: state,
    GSTACK_PROJECT_SLUG: 'completion-order', GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GSTACK_SESSION_KIND: 'interactive' };
  git(['init', '--bare', '-q', '-b', 'main', remote], fixture);
  run('gstack-artifacts-init', ['--remote', remote]);
  run('gstack-config', ['set', 'artifacts_sync_mode', 'full']);
  run('gstack-config', ['set', 'telemetry', 'off']);
  run('gstack-config', ['set', 'transcript_ingest_mode', 'off']);
});
afterEach(() => { fs.rmSync(fixture, { recursive: true, force: true }); });

describe('skill-end completion durability', () => {
  test('full: the same final drain pushes a completion into an already tracked timeline', () => {
    seedTrackedTimeline();
    end();
    expect(remoteText(TIMELINE)).toContain('completed');
    expect(git(['status', '--porcelain'])).toBe('');
    expect(queue()).toBe('');
  }, 30_000);

  test('full: a new completion timeline reaches the remote at its first end boundary', () => {
    end();
    expect(remotePaths()).toContain(TIMELINE);
    expect(remoteText(TIMELINE)).toContain('completed');
    expect(queue()).toBe('');
  }, 30_000);

  test('artifacts-only: a formerly tracked behavioral timeline stays local and privacy-held', () => {
    seedTrackedTimeline();
    const before = remoteText(TIMELINE);
    run('gstack-config', ['set', 'artifacts_sync_mode', 'artifacts-only']);
    end();
    expect(remoteText(TIMELINE)).toBe(before);
    expect(fs.readFileSync(path.join(state, TIMELINE), 'utf8')).toContain('completed');
    expect(queue()).toContain(TIMELINE);
    expect(JSON.parse(fs.readFileSync(path.join(state, '.brain-sync-status.json'), 'utf8')).message).toContain('privacy-held');
    // Privacy does not promise a clean old full-tier checkout after downgrade.
    expect(git(['diff', '--name-only'])).toBe(TIMELINE);
  }, 30_000);

  test('full: secret and unconsented transcript holds survive while completion metadata pushes', () => {
    const held = 'projects/completion-order/learnings.jsonl';
    const transcript = 'transcripts/run-fixture-1/session.md';
    const synthetic = ['ghp', 'abcdefghij1234567890abcdef1234567890'].join('_');
    write(held, JSON.stringify({ insight: synthetic }) + '\n');
    write(transcript, '# Synthetic private fixture\n');
    run('gstack-brain-enqueue', [held]); run('gstack-brain-enqueue', [transcript]);
    end();
    expect(remoteText(TIMELINE)).toContain('completed');
    expect(remotePaths()).not.toContain(held); expect(remotePaths()).not.toContain(transcript);
    expect(queue()).toContain(held); expect(queue()).toContain(transcript);
    expect(fs.readFileSync(path.join(state, transcript), 'utf8')).toContain('Synthetic');
    expect(JSON.parse(fs.readFileSync(path.join(state, '.brain-sync-status.json'), 'utf8')).status).toBe('held');
  }, 30_000);

  test('unattended: completion remains local; no drain, push or new queue entry', () => {
    const rel = 'projects/completion-order/ceo-plans/fixture.md';
    write(rel, '# Fixture\n'); run('gstack-brain-enqueue', [rel]);
    const beforeQueue = queue(), head = git(['rev-parse', 'main'], remote);
    expect(end({ GSTACK_SESSION_KIND: 'unattended' }).stdout).toContain('ARTIFACTS_SYNC: skipped');
    expect(git(['rev-parse', 'main'], remote)).toBe(head); expect(queue()).toBe(beforeQueue);
    expect(fs.readFileSync(path.join(state, TIMELINE), 'utf8')).toContain('completed');
    expect(fs.existsSync(path.join(state, 'analytics/skill-usage.jsonl'))).toBe(false);
  }, 30_000);

  test('concurrent drain owner: completion remains queued and a later drain publishes it', async () => {
    const holder = Bun.spawn(['bash', '-c', '. "$1"; gstack_brain_lock_acquire "$2" try || exit 9; echo locked; read -r release; gstack_brain_lock_release', '_', path.join(BIN, 'gstack-brain-lock.sh'), state],
      { env, cwd: fixture, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
      end();
      expect(queue()).toContain(TIMELINE); expect(remotePaths()).not.toContain(TIMELINE);
    } finally { holder.stdin.write('release\n'); holder.stdin.end(); expect(await holder.exited).toBe(0); }
    run('gstack-brain-sync', ['--once']);
    expect(remoteText(TIMELINE)).toContain('completed'); expect(queue()).toBe('');
  }, 30_000);

  test('sync off: completion is written locally with no queue entry and no push', () => {
    seedTrackedTimeline();
    const head = git(['rev-parse', 'main'], remote);
    run('gstack-config', ['set', 'artifacts_sync_mode', 'off']);
    end();
    expect(fs.readFileSync(path.join(state, TIMELINE), 'utf8')).toContain('completed');
    expect(git(['rev-parse', 'main'], remote)).toBe(head);
    expect(queue()).toBe('');
  }, 30_000);

  test('logger returns only after a delayed enqueue makes its spool record durable', () => {
    const shadow = path.join(fixture, 'bin'); fs.mkdirSync(shadow);
    fs.symlinkSync(path.resolve(BIN, '../lib'), path.join(fixture, 'lib'));
    for (const f of fs.readdirSync(BIN)) { fs.symlinkSync(path.join(BIN, f), path.join(shadow, f)); }
    for (const f of ['gstack-timeline-log', 'gstack-brain-enqueue']) { fs.unlinkSync(path.join(shadow, f)); }
    fs.copyFileSync(path.join(BIN, 'gstack-timeline-log'), path.join(shadow, 'gstack-timeline-log'));
    const marker = path.join(fixture, 'enqueue-done');
    fs.writeFileSync(path.join(shadow, 'gstack-brain-enqueue'), '#!/bin/sh\nsleep 0.4\n' + 'printf done > "$ENQUEUE_MARKER"\n', { mode: 0o755 });
    const r = spawnSync(path.join(shadow, 'gstack-timeline-log'), [JSON.stringify({ skill: 'qa', event: 'completed' })],
      { cwd: fixture, env: { ...env, ENQUEUE_MARKER: marker }, stdio: 'ignore', timeout: 30_000 });
    expect(r.status).toBe(0); expect(fs.existsSync(marker)).toBe(true);
  }, 30_000);
});
