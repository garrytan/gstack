export const AUTHORITY_COMMANDS = Object.freeze({
  'gstack-candidate-preview': 'scripts/authority/candidate-preview.ts',
  'gstack-counterpart-proof': 'scripts/authority/counterpart-proof.ts',
  'gstack-effect-scope': 'scripts/authority/effect-scope.ts',
  'gstack-pr-checks': 'scripts/authority/pr-checks.ts',
  'gstack-pr-head-guard': 'scripts/authority/pr-head-guard.ts',
  'gstack-review-read': 'scripts/authority/review-read.ts',
  'gstack-project-identity': 'scripts/authority/project-identity.ts',
  'gstack-section-delivery': 'scripts/authority/section-delivery.ts',
  'gstack-ship-handoff': 'scripts/authority/ship-handoff.ts',
  'gstack-lane-canary': 'scripts/authority/lane-canary.ts',
  'gstack-work-profile': 'scripts/authority/work-profile.ts',
  'gstack-semantic-manifest': 'scripts/authority/semantic-manifest.ts',
  'gstack-execution-plan': 'scripts/authority/execution-plan.ts',
  'gstack-next-version': 'bin/gstack-next-version',
  'gstack-pr-title-rewrite': 'bin/gstack-pr-title-rewrite',
  'gstack-validator-runtime': 'scripts/authority/validator-runtime.ts',
  'gstack-version-bump': 'bin/gstack-version-bump',
} as const);

export type AuthorityCommand = keyof typeof AUTHORITY_COMMANDS;

export function authorityEntrypoint(command: string): string {
  if (!Object.hasOwn(AUTHORITY_COMMANDS, command)) throw new Error('authority_command_unknown');
  return AUTHORITY_COMMANDS[command as AuthorityCommand];
}
