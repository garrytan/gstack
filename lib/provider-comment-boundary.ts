import { canonicalProviderRemote } from './provider-access';

const OPERATIONS = new Set(['review.greptile', 'ship.greptile']);

export function buildProviderCommentPlan(input: {
  operation: string; remoteUrl: string; expectedRepositoryKey: string;
  pr: number; commentId: string; replyIntent: string; body: string;
}) {
  if (!OPERATIONS.has(input.operation)) throw new Error('provider_comment_operation_invalid');
  const remote = canonicalProviderRemote(input.remoteUrl);
  if (remote.comparisonKey !== input.expectedRepositoryKey.toLowerCase()) throw new Error('provider_repository_mismatch');
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0 || !/^[A-Za-z0-9_.:-]+$/.test(input.commentId)
      || !/^[0-9a-f]{64}$/.test(input.replyIntent) || !input.body.trim()) throw new Error('provider_comment_assertion_invalid');
  const bodyHash = new Bun.CryptoHasher('sha256').update(input.body).digest('hex');
  return Object.freeze({
    operation: input.operation, repositoryKey: remote.comparisonKey, pr: input.pr,
    commentId: input.commentId, replyIntent: input.replyIntent, bodyHash,
    endpoint: `/repos/${remote.owner}/${remote.repository}/pulls/${input.pr}/comments/${input.commentId}/replies`,
  });
}
