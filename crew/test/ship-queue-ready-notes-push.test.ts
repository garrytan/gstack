/**
 * `gstack-ship-queue ready` under a train policy records its READY receipt on
 * origin's refs/notes/gstack-trains, which `land --pin` reads. When that push
 * never reaches origin, ready must refuse instead of printing "notes pushed"
 * and exiting 0 (reports/GSTA-461.md item 19: #4245's land refused
 * QUEUE_NOT_READY because origin had no note).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../../lib/headless-artifacts';
import { CHECK_IDS } from '../../lib/pregate/index';
import { cleanup, runBin } from '../../test/helpers/restamp-fixture';
import { line, openPr, queue, repoKey, trainFixture, type TrainFixture } from '../../test/helpers/ship-queue-train-fixture';

const NOTES = 'refs/notes/gstack-trains';
const FULL_CHECKS = CHECK_IDS.map(id => ({ id, status: 'pass' }));
const fixtures: TrainFixture[] = [];
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

function readyFixture() {
  const fx = trainFixture();
  fixtures.push(fx);
  const head = openPr(fx, '1');
  fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
  const tree = runBin(fx.repo, 'gstack-wtree', []).out.trim();
  const pregate = path.join(fx.repo.root, 'pregate.json');
  fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: FULL_CHECKS }));
  return { fx, head, pregate };
}

function hook(fx: TrainFixture, name: 'pre-receive' | 'post-receive', body: string): void {
  fs.writeFileSync(path.join(fx.repo.origin, 'hooks', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

const remoteNotes = (fx: TrainFixture) => fx.repo.git('ls-remote', 'origin', NOTES).split(/\s+/)[0] ?? '';
const localNotes = (fx: TrainFixture) => fx.repo.git('rev-parse', '--verify', '--quiet', NOTES);

describe('ready refuses a READY note that never reached origin', () => {
  // Value: protects=a lane never reports READY while origin lacks the note land reads; fails_when=ready ignores persist's pushed:false and exits 0 with "notes pushed"; why_new=no case pushes ready's note to a remote that rejects it; seam=a pre-receive hook in the fixture's bare origin; no_claim=GitHub's own rejection messages
  test('origin rejects refs/notes/*: ready exits refused with QUEUE_READY_NOTE_UNPUSHED and prints no success', () => {
    const { fx, head, pregate } = readyFixture();
    hook(fx, 'pre-receive', 'while read old new ref; do case "$ref" in refs/notes/*) echo "notes refused by fixture" >&2; exit 1;; esac; done; exit 0');
    const r = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(QUEUE_READY_NOTE_UNPUSHED)');
    expect(r.out).not.toContain('notes pushed');
    expect(line(r.out, 'GSTACK_RESULT:')).toContain('status=refused');
    expect(line(r.out, 'NEXT:')).toContain('gstack-ship-queue ready --pr 1 --no-screen');
    expect(remoteNotes(fx)).toBe('');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'ready', repoKey(fx), `1-${head}.json`))).toBe(true);
  }, 120_000);

  // Value: protects=success is printed only after origin is read back holding the note; fails_when=a push that exits 0 without moving origin's ref passes as pushed; why_new=the case above covers a push git reports as failed; seam=a post-receive hook that deletes the ref after accepting it, standing in for a proxy that drops the update; no_claim=which proxy dropped #4245's push
  test('a push that exits 0 but leaves origin without the note is refused too', () => {
    const { fx, pregate } = readyFixture();
    hook(fx, 'post-receive', `git update-ref -d ${NOTES} 2>/dev/null; exit 0`);
    const r = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(QUEUE_READY_NOTE_UNPUSHED)');
    expect(r.out).not.toContain('notes pushed');
    expect(remoteNotes(fx)).toBe('');
  }, 120_000);

  // Value: protects=the normal push still succeeds and origin holds exactly the local notes tip; fails_when=the confirmation read refuses a push that did land; why_new=hold case for the two refusals above; seam=none; no_claim=a real GitHub remote
  test('hold: a normal push succeeds, prints notes pushed, and origin holds the local notes tip', () => {
    const { fx, pregate } = readyFixture();
    const r = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(r.status).toBe(EXIT.ok);
    expect(line(r.out, 'READY_RECEIPT:')).toEndWith(`(notes pushed to origin ${NOTES})`);
    expect(remoteNotes(fx)).toBe(localNotes(fx));
  }, 120_000);

  // Value: protects=rerunning ready once origin accepts notes pushes the kept receipt and succeeds; fails_when=the refusal's NEXT command cannot recover; why_new=the documented fix for QUEUE_READY_NOTE_UNPUSHED; seam=the pre-receive hook removed between runs; no_claim=none beyond the fixture
  test('rerunning ready after origin accepts notes again pushes the note and succeeds', () => {
    const { fx, pregate } = readyFixture();
    hook(fx, 'pre-receive', 'exit 1');
    expect(queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']).status).toBe(EXIT.refused);
    fs.rmSync(path.join(fx.repo.origin, 'hooks', 'pre-receive'));
    const again = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(again.status).toBe(EXIT.ok);
    expect(remoteNotes(fx)).toBe(localNotes(fx));
  }, 120_000);
});
