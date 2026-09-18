/** Own the entire Sol render; never replace the checkout's installed caches. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGeneration } from '../../scripts/gen-skill-docs';

export async function createSolSkillFixture(temporaryParent = os.tmpdir()) {
  const outputRoot = fs.mkdtempSync(path.join(temporaryParent, 'gstack-sol-generation-'));
  const cleanup = () => fs.rmSync(outputRoot, { recursive: true, force: true });
  try {
    const generated = await runGeneration({
      host: 'codex', model: 'gpt-5.6-sol', outputRoot, contentLinkRoot: null,
    });
    if (generated.exitCode !== 0) {
      throw new Error(`Sol skill generation failed:\n${generated.diagnostics.map(d => d.message).join('\n')}`);
    }
    return {
      outputRoot,
      skillDir: path.join(outputRoot, '.agents', 'skills', 'gstack-investigate'),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
