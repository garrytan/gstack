import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareLandingIntent, reconcileLandingIntent } from '../lib/landing-safety';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('terminal landing cancellation resolution', () => {
  test('derives the exact task-owned queue solely from the canonical proposal hash', async () => {
    const boundary = await import('../lib/terminal-landing-cancel').catch(() => null);
    expect(boundary).not.toBeNull();
    if (!boundary) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-terminal-cancel-')); roots.push(root);
    const intent = prepareLandingIntent(root, {
      repoId: 'github.com/owner/repo', repositoryNodeId: 'R_123', prNumber: 7,
      expectedHeadOid: '1'.repeat(40), expectedBaseOid: '2'.repeat(40), targetRef: 'origin/main',
      mode: 'direct_observed', providerOperationId: 'github.com:queue-pr:7',
    });
    const proposal = reconcileLandingIntent(root, intent.intentId, {
      terminal: true, providerState: 'queued', headOid: '1'.repeat(40), baseOid: '2'.repeat(40), queueId: 'Q_7',
    });
    expect(boundary.resolveTerminalLandingCancellation(root, 'ecpe-v3-pilot', proposal.proposalHash as string)).toMatchObject({
      intentId: intent.intentId, repositorySelector: 'owner/repo', prNumber: 7,
      queueId: 'Q_7', expectedHeadOid: '1'.repeat(40), expectedBaseOid: '2'.repeat(40),
    });
    expect(() => boundary.resolveTerminalLandingCancellation(root, 'ecpe-v3-pilot', 'a'.repeat(64)))
      .toThrow('terminal_landing_proposal_not_found');
  });
});
