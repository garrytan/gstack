import { describe, expect, test } from 'bun:test';
import { buildProviderCommentPlan } from '../lib/provider-comment-boundary';

describe('provider reply boundary', () => {
  test('binds an exact repository, PR, comment, intent, and body hash', () => {
    const plan = buildProviderCommentPlan({ operation: 'review.greptile', remoteUrl: 'git@github.com:Org/Repo.git', expectedRepositoryKey: 'github.com/org/repo', pr: 9, commentId: 'c_1', replyIntent: 'a'.repeat(64), body: 'fixed' });
    expect(plan.endpoint).toBe('/repos/Org/Repo/pulls/9/comments/c_1/replies');
    expect(plan.bodyHash).toHaveLength(64);
  });
  test('rejects identity drift and generic comment operations', () => {
    expect(() => buildProviderCommentPlan({ operation: 'comment', remoteUrl: 'https://github.com/Org/Repo', expectedRepositoryKey: 'github.com/org/repo', pr: 1, commentId: '1', replyIntent: 'a'.repeat(64), body: 'x' })).toThrow('provider_comment_operation_invalid');
  });
});
