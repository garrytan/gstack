import type { LegacyReleasePolicy, ReleaseTitlePolicy, TrustedReleaseDecision } from './release-policy';

export type ResolvedTitleDecision = LegacyReleasePolicy | TrustedReleaseDecision;

const VERSION_INPUT = /^[0-9]+(?:\.[0-9]+)*$/;
const VERSION_PREFIX = /^v[0-9]+(?:\.[0-9]+)+(?: |$)/;
const CONVENTIONAL_TITLE = /^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!?: [^\r\n]+$/;

function policyOf(decision: ResolvedTitleDecision): ReleaseTitlePolicy {
  return decision.source === 'legacy_seam' ? decision.titlePolicy : decision.title_policy;
}

function withoutVersionPrefix(title: string): string {
  return title.replace(VERSION_PREFIX, '');
}

export function rewritePrTitle(input: {
  decision: ResolvedTitleDecision;
  title: string;
  version?: string;
}): string {
  const policy = policyOf(input.decision);
  if (policy === 'free') return input.title;
  if (policy === 'conventional') {
    const title = withoutVersionPrefix(input.title);
    if (!CONVENTIONAL_TITLE.test(title)) throw new Error('release_title_conventional_invalid');
    return title;
  }
  if (!input.version || !VERSION_INPUT.test(input.version)) throw new Error('release_title_version_invalid');
  const currentPrefix = `v${input.version}`;
  if (input.title === currentPrefix || input.title.startsWith(`${currentPrefix} `)) return input.title;
  const rest = withoutVersionPrefix(input.title);
  return rest ? `v${input.version} ${rest}` : `v${input.version}`;
}

export function rewriteResolvedPrTitle(input: {
  decision: ResolvedTitleDecision;
  title: string;
  version?: string;
}): string {
  const policy = policyOf(input.decision);
  const inactiveVersionPrefix = input.decision.source === 'trusted_profile' && !input.decision.applicable && policy === 'version_prefix';
  if (policy === 'version_prefix' && !inactiveVersionPrefix) {
    if (!input.version) throw new Error('release_title_version_required');
    if (input.decision.source === 'trusted_profile' && input.decision.current_version !== input.version) throw new Error('release_title_version_mismatch');
  } else if (input.version !== undefined) {
    throw new Error('release_title_version_not_applicable');
  }
  const decision = inactiveVersionPrefix ? { ...input.decision, title_policy: 'free' as const } : input.decision;
  return rewritePrTitle({ decision, title: input.title, version: input.version });
}
