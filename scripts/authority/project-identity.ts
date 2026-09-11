import { resolveProjectIdentity } from '../../lib/project-identity';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--shell')) {
    throw new Error('project_identity_arguments_invalid');
  }
  const identity = resolveProjectIdentity(process.cwd(), {
    mode: process.env.ECPE_PROFILE_MODE === 'profile' ? 'profile' : 'legacy',
  });
  if (args[0] === '--shell') {
    process.stdout.write([
      `SLUG=${shellQuote(identity.write_slug)}`,
      `BRANCH=${shellQuote(identity.write_branch)}`,
      `REPO_ID=${shellQuote(identity.repo_id)}`,
      `BRANCH_REF=${shellQuote(identity.raw_branch)}`,
      `READ_SLUGS_JSON=${shellQuote(JSON.stringify(identity.read_slugs))}`,
      `READ_BRANCHES_JSON=${shellQuote(JSON.stringify(identity.read_branches))}`,
    ].join('\n') + '\n');
  } else {
    process.stdout.write(JSON.stringify(identity) + '\n');
  }
} catch (error) {
  const code = error instanceof Error ? error.message : 'project_identity_failed';
  process.stderr.write(JSON.stringify({ result: null, error: { code } }) + '\n');
  process.exitCode = 2;
}
