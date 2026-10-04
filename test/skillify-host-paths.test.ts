/**
 * /skillify resolved the browse SDK at ~/.claude/skills/gstack on every host,
 * so on Codex and the other external hosts it read another host's install (or
 * nothing). The install root now comes from the host config (INSTALLED_ROOT).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { runGeneration } from '../scripts/gen-skill-docs';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skillify-paths-'));
beforeAll(async () => { expect((await runGeneration({ host: 'all', outputRoot: out })).exitCode).toBe(0); });
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

describe('skillify resolves the browse SDK from its own host install', () => {
  for (const host of ALL_HOST_CONFIGS) {
    test(host.name, () => {
      const file = host.name === 'claude' ? path.join(out, 'skillify/SKILL.md') : path.join(out, host.hostSubdir, 'skills/gstack-skillify/SKILL.md');
      if (!fs.existsSync(file)) return;
      const text = fs.readFileSync(file, 'utf8');
      const sdk = text.split('\n').filter(l => l.includes('browse-client.ts') && /homedir|replace/.test(l));
      expect(sdk).toEqual([`    '~/${host.globalRoot}/browse/src/browse-client.ts'.replace(/^~(?=\\/)/, os.homedir()),`]);
      expect(text).toContain(`The active gstack skills install at \`~/${host.globalRoot}/\``);
    });
  }
});
