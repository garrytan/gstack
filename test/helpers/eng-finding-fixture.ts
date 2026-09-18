import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedPlanReviewProject } from './ceo-finding-fixture';

/** Supply the existing behavior that the plan says it will rewrite. The new
 * AuthBroker/SessionMint/cache implementation remains proposed and absent. */
export function seedEngFindingProject(projectDir: string, plan: string): string {
  const input = plan + '\n\n## Existing behavior and boundaries\n' + [
    'Read `src/legacy-auth.ts`: this is the existing flow, not the proposed refactor.',
    'The HTTP admission middleware, IDP policy client, and session service keep their',
    'documented contracts. The five policy names identify the existing independent',
    'read-only verdict calls made by this function.',
    'For this synthetic fixture, the unchanged platform admission limit and IDP quota',
    'reserve concurrency and rate capacity for five policy calls per admitted request,',
    'including denied requests. This refactor does not require a capacity rollout.',
    'Preserve the return value, all three public failure codes, and which outcome',
    'wins: evaluate failures in the existing POLICIES order, not response-arrival order.',
    'No session lifecycle, HTTP protocol, schema, or deployment change is proposed.',
    'Those adapter implementations belong to the existing platform outside this',
    'fixture; their interface here defines the boundary of this refactor.',
    'The existing deployment system restores the prior build artifact for rollback;',
    'there is no per-function rollout flag in this module or deployment change here.',
    'This is a Bun TypeScript package. Use its existing `bun test` command for new',
    'tests; choosing a different runner or adding a toolchain is outside the refactor.',
    '',
    '## Proposed class roles',
    'The four classes are a proposed organization of operations and values already',
    'present in `legacyAuthFlow`, not additional product features or implemented code:',
    '- AuthBroker coordinates the policy checks and the existing session call.',
    '- SessionMint delegates to `platform.issueSession(identity)`; the platform still',
    '  owns session IDs, expiry, revocation, and storage.',
    '- TokenStore is a request-local holder for the existing Identity and returned',
    '  Session values; it adds no persistence, token issuance, or renewal.',
    '- RequestPolicy wraps one existing POLICIES entry and its `checkPolicy` call;',
    '  it adds no policy, configuration, or precedence rule.',
    'This class arrangement is still a proposal to review, not an accepted design.',
    'The separately proposed shared mutable AuthCache remains in the plan.',
    '',
    '## Undecided internal failure interface',
    // Newly authored synthetic input; this is not evidence about prior reviews.
    'The proposed validateAndDispatch catches would swallow failures. The refactor',
    'has not chosen how those failures reach the existing public auth boundary:',
    'typed exception propagation or a discriminated result handled exhaustively',
    'before that boundary.',
    'Both must preserve the public failure codes, causes and POLICIES-order precedence.',
    'This internal choice fits the accepted single-function/module or class organization;',
    'it does not require a new helper or adapter. It is independent of sequential or',
    'parallel IDP dispatch and the algorithm used to settle the policy outcomes.',
  ].join('\n') + '\n';
  seedPlanReviewProject(projectDir, input, 'plan-eng-review');
  fs.mkdirSync(path.join(projectDir, 'src'));
  fs.copyFileSync(path.resolve(import.meta.dir, '../fixtures/eng-existing-auth/legacy-auth.ts'), path.join(projectDir, 'src/legacy-auth.ts'));
  fs.copyFileSync(path.resolve(import.meta.dir, '../fixtures/eng-existing-auth/package.json'), path.join(projectDir, 'package.json'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 10_000 });
  git('add', 'src/legacy-auth.ts', 'package.json');
  git('-c', 'user.name=Finding fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-m', 'Supply existing auth behavior');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return input;
}
