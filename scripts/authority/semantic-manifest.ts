import { buildChangeManifest } from '../../lib/change-manifest';
import { resolveTrustedWorkProfile } from '../../lib/trusted-base';

function fail(error: unknown): never { process.stderr.write(JSON.stringify({ result: null, error: { code: error instanceof Error ? error.message : 'semantic_manifest_failed' } }) + '\n'); process.exit(2); }
try {
  const args = process.argv.slice(2); if (args.shift() !== 'resolve') throw new Error('semantic_manifest_command_invalid'); let assertTargetRef: string | undefined; let json = false;
  while (args.length) { const flag = args.shift(); if (flag === '--json') { json = true; continue; } const value = args.shift(); if (flag !== '--assert-target-ref' || !value) throw new Error('semantic_manifest_arguments_invalid'); assertTargetRef = value; }
  if (!json) throw new Error('semantic_manifest_json_required');
  const resolved = resolveTrustedWorkProfile({ cwd: process.cwd(), lane: 'single_repo_code', assertTargetRef });
  if (!resolved.effective) throw new Error('semantic_profile_unavailable');
  process.stdout.write(JSON.stringify(buildChangeManifest({ cwd: process.cwd(), profile: resolved.effective, targetBaseRef: resolved.trusted_base.target_ref ?? undefined, targetBaseSha: resolved.trusted_base.target_sha, mergeBaseSha: resolved.trusted_base.merge_base_sha })) + '\n');
} catch (error) { fail(error); }
