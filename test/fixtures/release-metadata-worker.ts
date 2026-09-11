import * as fs from 'node:fs';
import * as path from 'node:path';
import { releaseMetadata } from '../../lib/release-metadata';
import { releaseFixtureDependencies } from '../helpers/release-metadata-fixture';

const [root, state, crash, provideEntry = 'yes'] = process.argv.slice(2);
try {
  const dependencies = releaseFixtureDependencies(root, state);
  dependencies.observe = phase => {
    fs.appendFileSync(path.join(state, 'trace'), `${process.pid}:${phase}\n`);
    if (phase === crash) process.kill(process.pid, 'SIGKILL');
  };
  const result = await releaseMetadata({ cwd: root, operation: 'write', bump: 'patch', entryBody: () => {
    if (provideEntry !== 'yes') throw new Error('original_stdin_gone');
    return '- Release fixture.\r\n- Preserve metadata bytes.';
  } }, dependencies);
  process.stdout.write(JSON.stringify(result));
} catch (error) { process.stderr.write(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
