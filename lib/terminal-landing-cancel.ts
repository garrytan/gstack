import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProcessLocalGrant, issueGrant } from './effect-scope';
import { inspectLandingIntent } from './landing-safety';
import { resolveInstalledTool } from './toolchain-policy';

const SHA256 = /^[0-9a-f]{64}$/;
const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id pullRequest(number:$number){id state headRefOid baseRefOid mergeQueueEntry{id}}}}`;
const DEQUEUE = `mutation($pullRequestId:ID!){dequeuePullRequest(input:{pullRequestId:$pullRequestId}){clientMutationId}}`;

export interface TerminalLandingCancellation {
  intentId: string;
  repositorySelector: string;
  repositoryNodeId: string;
  prNumber: number;
  pullRequestNodeId?: string;
  queueId: string;
  expectedHeadOid: string;
  expectedBaseOid: string;
  proposalHash: string;
}

export function resolveTerminalLandingCancellation(root: string, purpose: string, proposalHash: string): TerminalLandingCancellation {
  if (purpose !== 'ecpe-v3-pilot' || !SHA256.test(proposalHash)) throw new Error('terminal_landing_proposal_invalid');
  const matches: TerminalLandingCancellation[] = [];
  for (const name of fs.readdirSync(root)) {
    const match = name.match(/^([0-9a-f]{64})\.json$/);
    if (!match) continue;
    const intent = inspectLandingIntent(root, match[1]);
    if (intent.phase !== 'cancel_required' || intent.result?.proposalHash !== proposalHash) continue;
    const repo = intent.repoId.match(/^github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!repo || typeof intent.result.queueId !== 'string') throw new Error('terminal_landing_intent_invalid');
    matches.push({
      intentId: intent.intentId,
      repositorySelector: `${repo[1]}/${repo[2]}`,
      repositoryNodeId: intent.repositoryNodeId,
      prNumber: intent.prNumber,
      queueId: intent.result.queueId,
      expectedHeadOid: intent.expectedHeadOid,
      expectedBaseOid: intent.expectedBaseOid,
      proposalHash,
    });
  }
  if (matches.length === 0) throw new Error('terminal_landing_proposal_not_found');
  if (matches.length !== 1) throw new Error('terminal_landing_proposal_ambiguous');
  return matches[0];
}

async function runGh(gh: string, args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn([gh, ...args], {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (status !== 0) throw new Error(stderr.trim() || 'terminal_landing_provider_failed');
  return stdout;
}

async function liveState(gh: string, cwd: string, cancellation: TerminalLandingCancellation) {
  const [owner, name] = cancellation.repositorySelector.split('/');
  const raw = await runGh(gh, [
    'api', 'graphql', '--hostname', 'github.com', '-f', `query=${QUERY}`,
    '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${cancellation.prNumber}`,
  ], cwd);
  const repository = (JSON.parse(raw) as any)?.data?.repository;
  const pr = repository?.pullRequest;
  if (repository?.id !== cancellation.repositoryNodeId || !pr?.id || pr.state !== 'OPEN') throw new Error('terminal_landing_provider_identity_mismatch');
  if (pr.headRefOid?.toLowerCase() !== cancellation.expectedHeadOid || pr.baseRefOid?.toLowerCase() !== cancellation.expectedBaseOid) {
    throw new Error('terminal_landing_provider_moved');
  }
  return pr as { id: string; mergeQueueEntry: { id?: string } | null };
}

export async function cancelTerminalLanding(cwd: string, input: {
  purpose: string; proposalHash: string; authorityRoot?: string;
}): Promise<{ status: 'cancelled_observed' | 'already_cancelled'; intentId: string }> {
  if (process.env.ECPE_PR_UPDATE_AUTHORIZED !== '1') throw new Error('grant_required');
  const root = path.resolve(input.authorityRoot ?? process.env.GSTACK_AUTHORITY_ROOT
    ?? path.join(process.env.HOME ?? '', '.gstack', 'authority', 'landing-intents'));
  const cancellation = resolveTerminalLandingCancellation(root, input.purpose, input.proposalHash);
  const gh = (await resolveInstalledTool('gh')).realpath;
  const before = await liveState(gh, cwd, cancellation);
  if (!before.mergeQueueEntry) return { status: 'already_cancelled', intentId: cancellation.intentId };
  if (before.mergeQueueEntry.id !== cancellation.queueId) throw new Error('terminal_landing_queue_moved');
  new ProcessLocalGrant(issueGrant('land-and-deploy', 'pr_update', {
    purpose: input.purpose, proposalHash: input.proposalHash, intentId: cancellation.intentId,
  })).consume('pr_update');
  try {
    await runGh(gh, [
      'api', 'graphql', '--hostname', 'github.com', '-f', `query=${DEQUEUE}`,
      '-F', `pullRequestId=${before.id}`,
    ], cwd);
  } catch (error) {
    const afterLoss = await liveState(gh, cwd, cancellation);
    if (afterLoss.mergeQueueEntry) throw error;
    return { status: 'cancelled_observed', intentId: cancellation.intentId };
  }
  const after = await liveState(gh, cwd, cancellation);
  if (after.mergeQueueEntry) throw new Error('terminal_landing_cancel_unobserved');
  return { status: 'cancelled_observed', intentId: cancellation.intentId };
}
