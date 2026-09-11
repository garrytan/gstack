import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveRuntimeStateRoot } from '../../lib/canonical-state-root';
import {
  commitSectionBatch,
  parseSectionDeliveryArgs,
  prepareSectionBatch,
} from '../../lib/section-delivery';

try {
  const args = parseSectionDeliveryArgs(process.argv.slice(2));
  const runtimeRoot = path.resolve(import.meta.dir, '..', '..');
  const prepared = prepareSectionBatch({
    runtimeRoot,
    stateRoot: resolveRuntimeStateRoot().root,
    repositoryRoot: process.cwd(),
    skill: args.skill,
    stage: args.stage,
  });
  // Coverage is committed only after the exact verified payload has reached
  // stdout. A failure on either side remains conservatively unknown.
  fs.writeSync(1, JSON.stringify(prepared.output) + '\n');
  commitSectionBatch(prepared);
} catch (error) {
  process.stderr.write(JSON.stringify({
    result: null,
    error: { code: error instanceof Error ? error.message : 'section_delivery_failed' },
  }) + '\n');
  process.exitCode = 2;
}
