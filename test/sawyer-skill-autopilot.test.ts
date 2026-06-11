import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recommendSawyerSkillAutopilot } from '../lib/sawyer-skill-autopilot';

const ROOT = path.resolve(import.meta.dir, '..');
const CLI = path.join(ROOT, 'bin', 'gstack-sawyer-skill-autopilot');
const AUTOPILOT = path.join(ROOT, 'bin', 'gstack-autopilot');
const CONFIG = path.join(ROOT, 'bin', 'gstack-config');

describe('Sawyer skill autopilot routing', () => {
  test('routes review prompts to /review', () => {
    const rec = recommendSawyerSkillAutopilot({ prompt: 'check my diff before we merge this' });
    expect(rec.action).toBe('invoke');
    expect(rec.skill).toBe('review');
    expect(rec.phase).toBe('first-skill');
  });

  test('routes ship prompts to /ship with a push boundary', () => {
    const rec = recommendSawyerSkillAutopilot({ prompt: 'ship this and open the PR' });
    expect(rec.skill).toBe('ship');
    expect(rec.permissionBoundary).toBe('push-pr');
  });

  test('routes post-merge runtime proof to the external closeout skill', () => {
    const rec = recommendSawyerSkillAutopilot({ prompt: 'PR merged, run post merge runtime closeout and prove live root' });
    expect(rec.skill).toBe('post-merge-runtime-closeout');
    expect(rec.skillSource).toBe('external');
    expect(rec.permissionBoundary).toBe('live-runtime');
  });

  test('chains clean review plus ship request into /ship', () => {
    const rec = recommendSawyerSkillAutopilot({
      prompt: 'great, ship it',
      lastSkill: '/review',
      lastOutcome: 'clean',
    });
    expect(rec.phase).toBe('post-skill');
    expect(rec.skill).toBe('ship');
  });

  test('stops after /ship creates an open PR unless landing is requested', () => {
    const rec = recommendSawyerSkillAutopilot({
      lastSkill: 'ship',
      prState: 'open',
    });
    expect(rec.action).toBe('stop');
    expect(rec.permissionBoundary).toBe('merge-deploy');
  });

  test('chains open PR plus land request into /land-and-deploy', () => {
    const rec = recommendSawyerSkillAutopilot({
      prompt: 'land it',
      lastSkill: 'ship',
      prState: 'open',
    });
    expect(rec.action).toBe('invoke');
    expect(rec.skill).toBe('land-and-deploy');
    expect(rec.permissionBoundary).toBe('merge-deploy');
  });

  test('chains deployed developer-facing changes into /devex-review', () => {
    const rec = recommendSawyerSkillAutopilot({
      lastSkill: 'land-and-deploy',
      deployStatus: 'healthy',
      developerFacing: true,
    });
    expect(rec.skill).toBe('devex-review');
  });
});

describe('Sawyer skill autopilot replay pack', () => {
  const cases = [
    {
      name: 'low-signal continue uses context restore',
      input: { prompt: 'Continue' },
      action: 'invoke',
      skill: 'context-restore',
    },
    {
      name: 'hot-thread recovery resumes handoff first',
      input: { prompt: 'resume the hot-thread recovery handoff' },
      action: 'invoke',
      skill: 'context-restore',
    },
    {
      name: 'full review chain uses autoplan',
      input: { prompt: 'Plan-Eng-review plan design review then ship it' },
      action: 'invoke',
      skill: 'autoplan',
    },
    {
      name: 'review status routes to landing report',
      input: { prompt: 'Did we plan-design-review this and are we cleared to ship?' },
      action: 'invoke',
      skill: 'landing-report',
    },
    {
      name: 'bug routes to investigate',
      input: { prompt: 'why is this broken in production?' },
      action: 'invoke',
      skill: 'investigate',
    },
    {
      name: 'security routes to cso',
      input: { prompt: 'is this webhook secure against replay attacks?' },
      action: 'invoke',
      skill: 'cso',
    },
    {
      name: 'qa report-only routes to qa-only before qa',
      input: { prompt: 'QA the staging site and report only, no code changes' },
      action: 'invoke',
      skill: 'qa-only',
    },
    {
      name: 'visual polish routes to design review',
      input: { prompt: 'this UI looks off, run a design review' },
      action: 'invoke',
      skill: 'design-review',
    },
    {
      name: 'developer onboarding routes to devex review',
      input: { prompt: 'test the developer experience and TTHW' },
      action: 'invoke',
      skill: 'devex-review',
    },
    {
      name: 'docs after ship routes to document release',
      input: { prompt: 'update docs after shipping this feature' },
      action: 'invoke',
      skill: 'document-release',
    },
    {
      name: 'clean review plus ship chains to ship',
      input: { prompt: 'great, ship it', lastSkill: 'review', lastOutcome: 'clean' },
      action: 'invoke',
      skill: 'ship',
    },
    {
      name: 'ship-created PR stops at merge boundary',
      input: { lastSkill: 'ship', prState: 'open' },
      action: 'stop',
      skill: undefined,
    },
    {
      name: 'open PR plus land request chains to land and deploy',
      input: { prompt: 'land it and verify deploy', lastSkill: 'ship', prState: 'open' },
      action: 'invoke',
      skill: 'land-and-deploy',
    },
    {
      name: 'missing runtime proof after land chains to runtime closeout',
      input: { lastSkill: 'land-and-deploy', runtimeProof: 'missing' as const },
      action: 'invoke',
      skill: 'post-merge-runtime-closeout',
    },
    {
      name: 'deployed developer-facing change chains to devex',
      input: { lastSkill: 'land-and-deploy', deployStatus: 'healthy', developerFacing: true },
      action: 'invoke',
      skill: 'devex-review',
    },
  ];

  for (const replay of cases) {
    test(replay.name, () => {
      const rec = recommendSawyerSkillAutopilot(replay.input);
      expect(rec.action).toBe(replay.action);
      expect(rec.skill).toBe(replay.skill);
      expect(rec.confidence).not.toBe('low');
    });
  }
});

describe('gstack-sawyer-skill-autopilot CLI', () => {
  test('is off by default', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sawyer-auto-'));
    try {
      const out = spawnSync(CLI, ['--prompt', 'ship this'], {
        encoding: 'utf-8',
        env: { ...process.env, GSTACK_HOME: home },
      });
      expect(out.status).toBe(0);
      const json = JSON.parse(out.stdout);
      expect(json.enabled).toBe(false);
      expect(json.mode).toBe('off');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('honors suggest mode from config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sawyer-auto-'));
    try {
      const set = spawnSync(CONFIG, ['set', 'sawyer_skill_autopilot', 'suggest'], {
        encoding: 'utf-8',
        env: { ...process.env, GSTACK_HOME: home },
      });
      expect(set.status).toBe(0);

      const out = spawnSync(CLI, ['--prompt', 'ship this'], {
        encoding: 'utf-8',
        env: { ...process.env, GSTACK_HOME: home },
      });
      expect(out.status).toBe(0);
      const json = JSON.parse(out.stdout);
      expect(json.enabled).toBe(true);
      expect(json.mode).toBe('suggest');
      expect(json.skill).toBe('ship');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('gstack-autopilot shortcut', () => {
  test('shows status and simple on/off controls', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sawyer-toggle-'));
    try {
      const status = spawnSync(AUTOPILOT, ['status'], {
        encoding: 'utf-8',
        env: { ...process.env, GSTACK_HOME: home },
      });
      expect(status.status).toBe(0);
      expect(status.stdout).toContain('off');

      const on = spawnSync(AUTOPILOT, ['on'], {
        encoding: 'utf-8',
        env: { ...process.env, GSTACK_HOME: home },
      });
      expect(on.status).toBe(0);
      expect(on.stdout).toContain('on (suggest mode)');

      const strict = spawnSync(AUTOPILOT, ['strict'], {
        encoding: 'utf-8',
        env: { ...process.env, GSTACK_HOME: home },
      });
      expect(strict.status).toBe(0);
      expect(strict.stdout).toContain('on (strict mode)');

      const off = spawnSync(AUTOPILOT, ['off'], {
        encoding: 'utf-8',
        env: { ...process.env, GSTACK_HOME: home },
      });
      expect(off.status).toBe(0);
      expect(off.stdout).toContain('off');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
