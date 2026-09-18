import * as fs from 'node:fs';
import * as path from 'node:path';

/** Reuse the real-PTY seed protocol actor before a controlled native replay.
 * Replay listeners receive only a separate slash after the seed's receipt and
 * end-turn acknowledgment; they never mistake pasted content for a command.
 */
export function fakePlanSeedPrelude(): string {
  const source = fs.readFileSync(path.join(import.meta.dir, '../fixtures/plan-seed-cli.ts'), 'utf8');
  const imports = source.match(/^import[^\n]+;$/gm) ?? [];
  if (imports.length !== 2) throw new Error('Plan seed fixture import contract changed');
  return `{
const fs = require('node:fs'), path = require('node:path');
process.env.SEED_CASE = 'native-replay';
${source.replace(/^import[^\n]+;$/gm, '')}
}\n`;
}
