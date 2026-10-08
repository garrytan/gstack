/**
 * After a background reviewer's completion notice starts a new turn, Claude Code
 * no longer applies /autoplan's allowed-tools, so Reads outside the working
 * directory raise permission cards. /autoplan writes its phase artifacts in the
 * project's `.gstack/tmp/autoplan/`, and the publication hook (registered for
 * the whole session) approves exactly /autoplan's own files, leaving every other
 * Read, and every guard verdict, to Claude Code.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { initializePlan, prepareMethodology, createSnapshot, preparePhaseClose } from '../bin/gstack-autoplan-snapshot';
import { runPublicationHook } from '../autoplan/bin/phase-publication-hook.ts';
import { OWNED_READ_APPROVAL } from '../autoplan/bin/owned-read';
import { guardFixture, section } from './helpers/autoplan-guard-fixture';

const ROOT = fs.realpathSync(path.join(import.meta.dir, '..'));
const SHIM = path.join(ROOT, 'autoplan/bin/phase-publication-hook');
const dirs: string[] = [];
let logHome = '', previous: Record<string, string | undefined> = {};
beforeAll(() => {
  logHome = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'autoplan-owned-log-')));
  previous = { GSTACK_STATE_ROOT: process.env.GSTACK_STATE_ROOT, GSTACK_HOME: process.env.GSTACK_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  process.env.GSTACK_STATE_ROOT = logHome; process.env.GSTACK_HOME = logHome; delete process.env.CLAUDE_PROJECT_DIR;
});
afterAll(() => {
  for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(logHome, { recursive: true, force: true });
});
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const scratch = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix))); dirs.push(d); return d; };

/** A real Phase 1 close with the restore point and artifacts in `<repo>/.gstack/tmp/autoplan/`, as Step 1 places them. */
function ceoClose() {
  const repo = scratch('autoplan-owned-repo-'), store = path.join(repo, '.gstack', 'tmp', 'autoplan'), session = path.join(repo, 'packages', 'app');
  fs.mkdirSync(store, { recursive: true }); fs.mkdirSync(session, { recursive: true });
  const source = path.join(repo, 'PLAN.md'), active = path.join(repo, 'active.md'), restore = path.join(store, 'main-autoplan-restore.md');
  fs.writeFileSync(source, '# Plan: greet\nAdd a greet command.\n');
  initializePlan(source, active, restore);
  const skill = path.join(repo, 'SKILL.md');
  fs.writeFileSync(skill, '---\nname: plan-ceo-review\n---\n## Review Sections\nApply every criterion.\n');
  const method = prepareMethodology('ceo', skill, restore).methodologyPath;
  const snapshot = createSnapshot('ceo', active, restore, method);
  fs.appendFileSync(active, '<!-- autoplan-accepted:ceo -->\nNone: retain the current behavior.\n<!-- /autoplan-accepted:ceo -->\n');
  return { repo, session, method, snapshot, packet: preparePhaseClose('ceo', active, snapshot.snapshotPath, restore, method).closePacketPath as string };
}
const read = (cwd: string, file: string, extra: object = {}) => ({ hook_event_name: 'PreToolUse', session_id: 'parent', cwd,
  transcript_path: path.join(cwd, 'no-config', 'projects', 'p', 'parent.jsonl'), tool_name: 'Read', tool_use_id: 'current',
  tool_input: { file_path: file }, ...extra });

describe('/autoplan owned reads after the skill turn', () => {
  test('the shipped hook approves the shared close section and the installed link spelling', () => {
    const home = scratch('autoplan-owned-home-'), cwd = scratch('autoplan-owned-cwd-');
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(ROOT, path.join(home, '.claude', 'skills', 'gstack'), 'dir');
    for (const file of [path.join(ROOT, 'autoplan/sections/phase-close.md'), path.join(home, '.claude/skills/gstack/autoplan/sections/phase-close.md')]) {
      const child = spawnSync('bash', [SHIM], { input: JSON.stringify(read(cwd, file)), encoding: 'utf8', timeout: 8_000,
        env: { ...process.env, HOME: home, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(OWNED_READ_APPROVAL);
    }
  });

  test('a session started below the repository root reads the close packet without a journal or a card', async () => {
    const c = ceoClose();
    expect(await runPublicationHook(read(c.session, c.packet), ROOT)).toEqual(OWNED_READ_APPROVAL);
  });

  test('guarded phase artifacts and the next driver are approved once the guard verifies them', async () => {
    const f = guardFixture('ceo', { restoreInProject: true });
    try {
      const dir = path.dirname(f.snapshot.snapshotPath);
      const files = [f.method, path.join(path.dirname(f.method), 'methodology.json'), f.snapshot.snapshotPath,
        path.join(dir, 'snapshot.json'), path.join(dir, 'source-implementation.md'), path.join(dir, 'native-prompt.md'), f.packet.closePacketPath];
      for (const [i, file] of files.entries()) {
        f.use(`artifact-${i}`, 'Read', { file_path: file }); f.journal();
        expect({ file, output: await f.hook(f.input(`artifact-${i}`, 'Read', { file_path: file })) }).toEqual({ file, output: OWNED_READ_APPROVAL });
        f.readResult(`artifact-${i}`, file);
      }
      f.publish(); f.use('next', 'Read', { file_path: section('design-phase.md') }); f.journal();
      expect(await f.hook(f.input('next', 'Read', { file_path: section('design-phase.md') }))).toEqual(OWNED_READ_APPROVAL);
      // Six guarded artifact Reads and the Phase 2 entry, each a verified allow; the close packet is not a guarded Read.
      expect(f.log().map(e => [e.decision, e.disposition])).toEqual(Array(7).fill(['allow', 'allow']));
    } finally { f.cleanup(); }
  });

  test('look-alikes and everything else keep Claude Code\'s own permission check', async () => {
    const c = ceoClose(), other = ceoClose();
    const foreign = scratch('autoplan-owned-foreign-');
    fs.mkdirSync(path.join(foreign, 'autoplan', 'sections'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'autoplan/sections/phase-close.md'), path.join(foreign, 'autoplan/sections/phase-close.md'));
    const store = path.dirname(path.dirname(c.packet));
    const writable = path.join(store, 'autoplan-ceo-copy'), alias = path.join(store, 'autoplan-ceo-alias');
    fs.mkdirSync(writable); fs.copyFileSync(c.packet, path.join(writable, 'close-packet.md'));
    fs.chmodSync(path.join(writable, 'close-packet.md'), 0o644);
    fs.mkdirSync(alias); fs.symlinkSync(c.packet, path.join(alias, 'close-packet.md'));
    fs.writeFileSync(path.join(path.dirname(c.packet), 'notes.md'), 'not an artifact\n', { mode: 0o444 });
    for (const file of [
      other.packet,
      path.join(foreign, 'autoplan/sections/phase-close.md'),
      path.join(ROOT, 'autoplan/sections/../SKILL.md'),
      path.join(ROOT, 'autoplan/sections/manifest.json'),
      path.join(ROOT, 'package.json'),
      path.join(writable, 'close-packet.md'),
      path.join(alias, 'close-packet.md'),
      path.join(path.dirname(c.packet), 'notes.md'),
      path.join(c.repo, 'PLAN.md'),
    ]) expect({ file, output: await runPublicationHook(read(c.session, file), ROOT) }).toEqual({ file, output: {} });
    expect(await runPublicationHook(read(c.session, c.packet, { agent_id: 'reviewer-child' }), ROOT)).toEqual({});
    expect(await runPublicationHook({ ...read(c.session, c.packet), tool_name: 'Bash', tool_input: { command: `cat ${c.packet}` } }, ROOT)).toEqual({});
  });

  test('a guard denial is never turned into an approval', async () => {
    const cwd = scratch('autoplan-owned-deny-');
    const output: any = await runPublicationHook(read(cwd, path.join(ROOT, 'autoplan/sections/design-phase.md')), ROOT);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
