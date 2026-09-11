import { readSync } from 'node:fs';
import { releaseMetadata, type ReleaseMetadataInput } from './release-metadata';
import { inspectAssertedShipHandoff } from './ship-handoff';

export type ReleaseMetadataCommand = Omit<ReleaseMetadataInput, 'cwd' | 'entryBody' | 'assertTargetSha'> & { entryStdin?: boolean };
/** Closed frontend: input contains intent and equality assertions only. */
export function parseReleaseMetadataCommand(argv: string[]): ReleaseMetadataCommand {
  const [command, ...args] = argv;
  const operations = { classify: 'inspect', inspect: 'inspect', allocate: 'allocate', write: 'write', repair: 'recover', recover: 'recover', retire: 'retire' } as const;
  if (!Object.hasOwn(operations, command)) throw new Error('release_operation_invalid');
  const result: ReleaseMetadataCommand = { operation: operations[command as keyof typeof operations] };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('release_argument_duplicate');
    seen.add(flag);
    if (flag === '--json') continue;
    if (flag === '--release-requested') { result.releaseRequested = true; continue; }
    if (flag === '--entry-stdin') { result.entryStdin = true; continue; }
    if (!['--assert-target-ref', '--assert-release-mode', '--current-version', '--assert-version', '--bump', '--lane'].includes(flag)) throw new Error('release_argument_forbidden');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('release_argument_value_missing');
    if (flag === '--assert-target-ref') result.assertTargetRef = value;
    if (flag === '--lane') {
      if (!['docs_ux', 'single_repo_code', 'cross_repo_contract'].includes(value)) throw new Error('release_lane_invalid');
      result.lane = value as ReleaseMetadataCommand['lane'];
    }
    if (flag === '--current-version') result.currentVersion = value;
    if (flag === '--assert-version') result.assertVersion = value;
    if (flag === '--assert-release-mode') {
      if (!['per_pr', 'required_on_release', 'none'].includes(value)) throw new Error('release_mode_assertion_invalid');
      result.assertReleaseMode = value as ReleaseMetadataCommand['assertReleaseMode'];
    }
    if (flag === '--bump') {
      if (!['major', 'minor', 'patch', 'micro'].includes(value)) throw new Error('release_bump_invalid');
      result.bump = value as ReleaseMetadataCommand['bump'];
    }
  }
  if (result.entryStdin && result.operation !== 'write') throw new Error('release_argument_forbidden');
  return result;
}
function entryBody(): string {
  const parts: Buffer[] = []; let total = 0;
  for (;;) {
    const buffer = Buffer.alloc(4096), count = readSync(0, buffer, 0, buffer.length, null);
    if (!count) break;
    total += count; if (total > 16384) throw new Error('release_changelog_entry_invalid');
    parts.push(buffer.subarray(0, count));
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
}
export async function runReleaseMetadataCommand(argv: string[], cwd = process.cwd()) {
  const { entryStdin, ...input } = parseReleaseMetadataCommand(argv);
  return releaseMetadata({ ...input, cwd, ...(entryStdin ? { entryBody } : {}) }, { inspectShipReceipt: inspectAssertedShipHandoff });
}
