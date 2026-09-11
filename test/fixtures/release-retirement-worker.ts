import * as fs from 'node:fs';
import { retireReleaseAllocation } from '../../lib/release-metadata';
import { inspectShipHandoff, type EvidenceRecordV2 } from '../../lib/evidence-envelope';
import { releaseFixtureDependencies } from '../helpers/release-metadata-fixture';

const [root, state, configPath] = process.argv.slice(2);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    version: string; cleanQueue: string; rawQueue: string;
    identity: { number: number; base_oid: string; head_oid: string; head_repository_node_id: string; head_ref: string };
    receipt: EvidenceRecordV2;
  };
  const dependencies = releaseFixtureDependencies(root, state);
  dependencies.observeQueue = () => ({ claimed: [{ pr: 0, branch: `origin/${config.identity.head_ref}`, version: config.version }, { pr: config.identity.number, branch: config.identity.head_ref, version: config.version }],
    snapshot: config.rawQueue, currentPrIdentity: config.identity, possibleSelfClaim: true,
    exactSelfClaim: { identity: config.identity, repository_node_id: config.identity.head_repository_node_id, version: config.version, claimed: [], snapshot: config.cleanQueue }, unresolvedSelfClaim: false });
  dependencies.inspectShipReceipt = () => inspectShipHandoff([config.receipt], { repoId: 'fixture', pr: config.identity.number, baseRef: 'origin/main', baseSha: config.identity.base_oid,
    remotePrHeadSha: config.identity.head_oid, stateRootId: `state_${'f'.repeat(32)}`, repositoryNodeId: config.identity.head_repository_node_id,
    headRepositoryNodeId: config.identity.head_repository_node_id, headRefName: config.identity.head_ref });
  const result = await retireReleaseAllocation({ cwd: root, lane: 'single_repo_code', releaseRequested: true }, dependencies);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
}
