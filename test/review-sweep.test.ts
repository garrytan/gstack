/**
 * GST-1322 PR B: the per-stage inventory-diff sweep (lib/review-sweep.ts) that enforces the fetch rule.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BIG_BYTES, foundLines, inventory, sweepDiff } from '../lib/review-sweep';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')));
const repoAt = (dir: string, remote?: string) => {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('bash', ['-c', 'git init -q' + (remote ? ' && git remote add origin "$1"' : ''), '_', remote ?? ''], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  expect(r.status, r.stderr).toBe(0);
};

describe('review-sweep inventory diff', () => {
  // Value: protects=only a new repository with a network remote, or a new big file, counts as a fetch; a local clone, a file:// remote and anything present at the start do not; fails_when=the diff flags local work or misses a network clone or a download;
  //   why_new=GST-1322 PR B (Capy exposes no reader transcript, so the sweep is the enforcement); seam=none; no_claim=which reader made the path
  test('a new network repository and a new big file are found; local and pre-existing repositories are not', async () => {
    const root = tmp();
    const checkout = path.join(root, 'checkout');
    repoAt(checkout, 'https://github.com/me/app.git');
    repoAt(path.join(root, 'old'), 'https://github.com/x/old.git');
    const start = inventory([root], checkout, []);
    await Bun.sleep(30);
    repoAt(path.join(root, 'BEAM'), 'https://github.com/sealed-org/BEAM.git');
    repoAt(path.join(root, 'scp'), 'git@github.com:sealed-org/BEAM.git');
    repoAt(path.join(root, 'local'));
    repoAt(path.join(root, 'filecopy'), 'file:///srv/mirror/app.git');
    repoAt(path.join(checkout, 'vendor', 'nested'), 'https://example.com/n.git');
    fs.mkdirSync(path.join(root, 'dl'));
    fs.writeFileSync(path.join(root, 'dl', 'chats.tar'), '');
    fs.truncateSync(path.join(root, 'dl', 'chats.tar'), BIG_BYTES);
    const found = sweepDiff(start, inventory([root], checkout, []), [checkout]);
    expect(found.map(f => [path.relative(root, f.path), f.kind, f.deletable]).sort()).toEqual([
      ['BEAM', 'repo', true], ['checkout/vendor/nested', 'repo', true], ['dl/chats.tar', 'download', true], ['scp', 'repo', true],
    ]);
    expect(found.find(f => f.path.endsWith('BEAM'))!.remote).toBe('https://github.com/sealed-org/BEAM.git');
  });

  // Value: protects=a delete command is printed only for a path provably created inside the stage window and holding nothing older (GST-1322 d3); fails_when=a path the start inventory missed, a root or a path holding the checkout gets rm -rf;
  //   why_new=GST-1322 autoplan Critical d3 (no unattended rm -rf); seam=none; no_claim=that a KEEP path is safe to keep
  test('a path older than the start, a root, or a parent of the checkout gets KEEP, never DELETE', async () => {
    const root = tmp();
    const checkout = path.join(root, 'ws', 'checkout');
    repoAt(checkout);
    repoAt(path.join(root, 'missed'), 'https://github.com/x/missed.git');
    await Bun.sleep(30);
    const start = inventory([root], checkout, []);
    delete start.repos[path.join(root, 'missed')];
    repoAt(path.join(root, 'ws'), 'https://github.com/x/ws.git');
    const found = sweepDiff(start, inventory([root], checkout, []), [checkout]);
    expect(found.map(f => [path.relative(root, f.path), f.deletable]).sort()).toEqual([['missed', false], ['ws', false]]);
    const lines = foundLines('specialists', 1, found, ['specialist/security']);
    expect(lines.filter(l => l.startsWith('DELETE:'))).toEqual([]);
    expect(lines.filter(l => l.startsWith('KEEP:'))).toHaveLength(2);
    expect(lines[0]).toMatch(/^FETCH_VIOLATION: stage=specialists attempt=1 kind=repo .* readers=specialist\/security \(attributed to the stage/);
  });
});
