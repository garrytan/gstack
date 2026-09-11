import { canonicalAssertionPath, validateFullOid } from './effect-scope';
import { resolveGitTransport, type GitTransport } from './git-transport-policy';

export interface GitPushPlan {
  transport: GitTransport;
  sourceOid: string;
  destinationRef: string;
  expectedRemoteOid: string | null;
  argv: string[];
}

export function buildGitPushPlan(input: {
  remoteUrl: string;
  expectedRepositoryKey: string;
  sourceOid: string;
  destinationRef: string;
  expectedRemoteOid: string | null;
}): GitPushPlan {
  const source = validateFullOid(input.sourceOid);
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(input.destinationRef) || input.destinationRef.includes('..')) throw new Error('git_destination_ref_invalid');
  canonicalAssertionPath(input.destinationRef.slice('refs/heads/'.length));
  const expected = input.expectedRemoteOid === null ? '' : validateFullOid(input.expectedRemoteOid);
  const transport = resolveGitTransport(input.remoteUrl, input.expectedRepositoryKey);
  return {
    transport, sourceOid: source, destinationRef: input.destinationRef,
    expectedRemoteOid: input.expectedRemoteOid,
    argv: ['push', transport.normalizedUrl, `${source}:${input.destinationRef}`, `--force-with-lease=${input.destinationRef}:${expected}`],
  };
}
