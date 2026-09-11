// A process fixture, not an environment-selectable production command seam.
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { releaseMetadata as productionMetadata } from '../../lib/release-metadata';
import { releaseFixtureDependencies } from '../helpers/release-metadata-fixture';
const [root, state, crash, ...argv] = process.argv.slice(2);
const actualMetadata = productionMetadata;
const dependencies = releaseFixtureDependencies(root, state);
dependencies.observe = phase => {
  fs.appendFileSync(path.join(state, 'trace'), `${phase}\n`);
  if (phase === crash) process.kill(process.pid, 'SIGKILL');
};
mock.module('../../lib/release-metadata', () => ({ releaseMetadata: (input: Parameters<typeof productionMetadata>[0]) => actualMetadata(input, dependencies) }));
const { runVersionBump } = await import('../../bin/gstack-version-bump');
try { await runVersionBump(argv, root); }
catch (error) { process.stderr.write(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
