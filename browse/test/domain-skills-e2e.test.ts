/**
 * E2E (gate tier): boots a real Chromium via BrowserManager.launch(), navigates
 * to the fixture server, exercises $B domain-skill save/show/list end-to-end.
 *
 * Verifies (T3 + T4 + T6):
 *  - host derives from active tab top-level origin (not agent-supplied)
 *  - save lands in JSONL state:"quarantined"
 *  - listSkills surfaces the saved row
 *  - 3 successful uses promote to active; readSkill then returns it
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';

const TMP_HOME = path.join(os.tmpdir(), `gstack-domain-e2e-${process.pid}-${Date.now()}`);
process.env.GSTACK_HOME = TMP_HOME;
process.env.GSTACK_PROJECT_SLUG = 'e2e-test-slug';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

async function fakeBodyPipe(body: string): Promise<string> {
  // Some subcommands read from stdin or --from-file. We use --from-file with a tmp.
  const tmpFile = path.join(os.tmpdir(), `e2e-body-${process.pid}-${Date.now()}.md`);
  await fs.writeFile(tmpFile, body, 'utf8');
  return tmpFile;
}

beforeAll(async () => {
  await fs.rm(TMP_HOME, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP_HOME, 'projects', 'e2e-test-slug'), { recursive: true });
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(async () => {
  try { await bm.cleanup?.(); } catch {}
  try { testServer.server.stop(); } catch {}
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe('$B domain-skill (E2E gate tier)', () => {
  test('save: derives host from active tab, writes quarantined row, list surfaces it', async () => {
    const { handleDomainSkillCommand } = await import('../src/domain-skill-commands');
    // Navigate to a test page (host: 127.0.0.1 in this fixture server)
    await bm.getPage().goto(baseUrl + '/basic.html');

    const bodyFile = await fakeBodyPipe('# Test skill\n\nThis page is the basic fixture.');
    const out = await handleDomainSkillCommand(['save', '--from-file', bodyFile], bm);

    // Output is structured per DX D5
    expect(out).toContain('Saved');
    expect(out).toContain('quarantined');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('Next:');

    // Check the JSONL file actually has it
    const jsonl = await fs.readFile(
      path.join(TMP_HOME, 'projects', 'e2e-test-slug', 'learnings.jsonl'),
      'utf8',
    );
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    const skill = lines.find((r: any) => r.type === 'domain' && r.host === '127.0.0.1');
    expect(skill).toBeTruthy();
    expect(skill.state).toBe('quarantined');
    expect(skill.scope).toBe('project');
    expect(skill.body).toContain('Test skill');
    expect(skill.source).toBe('agent');

    await fs.unlink(bodyFile).catch(() => {});
  });

  test('list: shows the saved skill with state', async () => {
    const { handleDomainSkillCommand } = await import('../src/domain-skill-commands');
    const out = await handleDomainSkillCommand(['list'], bm);
    expect(out).toContain('Project (per-project):');
    expect(out).toContain('[quarantined] 127.0.0.1');
  });

  test('readSkill returns null until the skill is promoted to active (T6)', async () => {
    const { readSkill, recordSkillUse } = await import('../src/domain-skills');
    // While quarantined, readSkill returns null
    expect(await readSkill('127.0.0.1', 'e2e-test-slug')).toBeNull();
    // Three uses without flag triggers auto-promote
    await recordSkillUse('127.0.0.1', 'e2e-test-slug', false);
    await recordSkillUse('127.0.0.1', 'e2e-test-slug', false);
    await recordSkillUse('127.0.0.1', 'e2e-test-slug', false);
    const result = await readSkill('127.0.0.1', 'e2e-test-slug');
    expect(result).not.toBeNull();
    expect(result!.row.state).toBe('active');
    expect(result!.source).toBe('project');
  });

  test('save without an active page errors with structured guidance', async () => {
    const { handleDomainSkillCommand } = await import('../src/domain-skill-commands');
    // Navigate to about:blank — domain-skill save must refuse
    await bm.getPage().goto('about:blank');
    const bodyFile = await fakeBodyPipe('# Should fail');
    await expect(handleDomainSkillCommand(['save', '--from-file', bodyFile], bm)).rejects.toThrow(/no top-level URL/);
    await fs.unlink(bodyFile).catch(() => {});
  });
});
