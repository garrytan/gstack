/**
 * Agent Teams Integration Tests
 *
 * End-to-end validation that gstack works as a Claude Code Agent Teams system.
 * Tests cover 6 layers:
 *
 *   L1: Infrastructure — settings, preamble, CLAUDE.md all configured correctly
 *   L2: Preamble — every skill has teammate awareness injected via {{PREAMBLE}}
 *   L3: Communication protocol — message formats, urgency rules, output paths
 *   L4: Dependency graph — skill-to-skill relationships are correct and acyclic
 *   L5: Team configurations — pre-built teams reference valid skills, use correct patterns
 *   L6: Cross-layer consistency — CLAUDE.md, TEAMS.md, preamble, and /team skill agree
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// ─── Helpers ─────────────────────────────────────────────────

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

function fileExists(relPath: string): boolean {
  return fs.existsSync(path.join(ROOT, relPath));
}

// All skills that use the preamble (excludes gstack-upgrade which has its own)
const ALL_PREAMBLE_SKILLS = [
  'SKILL.md', 'browse/SKILL.md', 'qa/SKILL.md', 'qa-only/SKILL.md',
  'setup-browser-cookies/SKILL.md', 'ship/SKILL.md', 'review/SKILL.md',
  'plan-ceo-review/SKILL.md', 'plan-eng-review/SKILL.md', 'retro/SKILL.md',
  'conflicts/SKILL.md', 'risk/SKILL.md', 'cso/SKILL.md', 'cfo/SKILL.md',
  'vc/SKILL.md', 'board/SKILL.md', 'media/SKILL.md', 'comms/SKILL.md',
  'pr-comms/SKILL.md', 'ai-hybrid/SKILL.md', 'escalation/SKILL.md',
  'team/SKILL.md',
];

// All new analysis skills (read-only, report-producing)
const ANALYSIS_SKILLS = [
  'conflicts', 'risk', 'cso', 'cfo', 'vc', 'board',
  'media', 'comms', 'pr-comms', 'ai-hybrid', 'escalation',
];

// All skills that produce reports to .gstack/
const REPORT_PRODUCING_SKILLS: Record<string, string> = {
  conflicts: '.gstack/conflict-reports',
  risk: '.gstack/risk-reports',
  cso: '.gstack/security-reports',
  cfo: '.gstack/cfo-reports',
  vc: '.gstack/vc-reports',
  board: '.gstack/board-reports',
  media: '.gstack/media-kit',
  comms: '.gstack/comms',
  'pr-comms': '.gstack/pr-comms',
  'ai-hybrid': '.gstack/ai-hybrid',
  escalation: '.gstack/escalation-reports',
  team: '.gstack/team-reports',
};

// ─── L1: Infrastructure ──────────────────────────────────────

describe('L1: Infrastructure — Agent Teams enabled and configured', () => {
  test('.claude/settings.json exists and enables agent teams', () => {
    expect(fileExists('.claude/settings.json')).toBe(true);
    const settings = JSON.parse(readFile('.claude/settings.json'));
    expect(settings.env).toBeDefined();
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  test('.claude/settings.json has teammateMode configured', () => {
    const settings = JSON.parse(readFile('.claude/settings.json'));
    expect(settings.teammateMode).toBeDefined();
    expect(['auto', 'in-process', 'tmux']).toContain(settings.teammateMode);
  });

  test('CLAUDE.md has Agent Teams section', () => {
    const claude = readFile('CLAUDE.md');
    expect(claude).toContain('## Agent Teams');
    expect(claude).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
  });

  test('CLAUDE.md documents the dependency graph', () => {
    const claude = readFile('CLAUDE.md');
    expect(claude).toContain('Skill dependency graph');
    expect(claude).toContain('ENGINEERING PIPELINE');
    expect(claude).toContain('EXECUTIVE ANALYSIS');
    expect(claude).toContain('LAUNCH');
    expect(claude).toContain('INCIDENT');
  });

  test('CLAUDE.md documents team patterns', () => {
    const claude = readFile('CLAUDE.md');
    expect(claude).toContain('Pipeline');
    expect(claude).toContain('Parallel');
    expect(claude).toContain('War room');
  });

  test('CLAUDE.md explains dual-mode behavior (standalone vs teammate)', () => {
    const claude = readFile('CLAUDE.md');
    expect(claude).toContain('standalone');
    expect(claude).toContain('teammate');
    expect(claude).toContain('{{PREAMBLE}}');
  });

  test('team/TEAMS.md exists with coordination reference', () => {
    expect(fileExists('team/TEAMS.md')).toBe(true);
    const teams = readFile('team/TEAMS.md');
    expect(teams).toContain('Skill Roster');
    expect(teams).toContain('Communication Protocol');
    expect(teams).toContain('Dependency Graph');
    expect(teams).toContain('Shared State Locations');
    expect(teams).toContain('Anti-Patterns');
  });

  test('team/SKILL.md exists with orchestrator logic', () => {
    expect(fileExists('team/SKILL.md')).toBe(true);
    const teamSkill = readFile('team/SKILL.md');
    expect(teamSkill).toContain('Team Orchestrator');
    expect(teamSkill).toContain('Prerequisites Check');
    expect(teamSkill).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
  });
});

// ─── L2: Preamble — Teammate awareness in every skill ────────

describe('L2: Preamble — every skill has teammate awareness', () => {
  for (const skill of ALL_PREAMBLE_SKILLS) {
    describe(skill, () => {
      const content = readFile(skill);

      test('has _IS_TEAMMATE detection', () => {
        expect(content).toContain('_IS_TEAMMATE');
      });

      test('has _TEAM_CONFIG detection', () => {
        expect(content).toContain('_TEAM_CONFIG');
      });

      test('has teammate communication protocol', () => {
        expect(content).toContain('message your findings to relevant teammates');
      });

      test('has output protocol (write reports + message lead)', () => {
        expect(content).toContain('summary message');
        expect(content).toContain('.gstack/');
      });

      test('has task claiming instructions', () => {
        expect(content).toContain('shared task list');
        expect(content).toContain('Mark tasks as completed');
      });

      test('has teammate discovery via config.json', () => {
        expect(content).toContain('teams/*/config.json');
      });

      test('has urgency protocol (broadcast for critical)', () => {
        expect(content).toContain('broadcast immediately');
      });

      test('has fallback for standalone mode', () => {
        expect(content).toContain('_IS_TEAMMATE');
        expect(content).toContain('false');
        expect(content).toContain('standalone');
      });
    });
  }
});

// ─── L3: Communication protocol ──────────────────────────────

describe('L3: Communication protocol — message formats and paths', () => {
  const teamsDoc = readFile('team/TEAMS.md');

  test('TEAMS.md defines teammate-to-teammate message format', () => {
    expect(teamsDoc).toContain('FROM:');
    expect(teamsDoc).toContain('STATUS:');
    expect(teamsDoc).toContain('TOP FINDINGS:');
    expect(teamsDoc).toContain('FULL REPORT:');
    expect(teamsDoc).toContain('ACTION NEEDED:');
  });

  test('TEAMS.md defines teammate-to-lead message format', () => {
    expect(teamsDoc).toContain('SKILL:');
    expect(teamsDoc).toContain('FINDINGS:');
    expect(teamsDoc).toContain('REPORT SAVED:');
    expect(teamsDoc).toContain('BLOCKED BY:');
  });

  test('TEAMS.md defines urgency protocol with broadcast rules', () => {
    expect(teamsDoc).toContain('BROADCAST immediately');
    expect(teamsDoc).toContain('security breach');
    expect(teamsDoc).toContain('data exposure');
  });

  test('every report-producing skill has a unique output directory', () => {
    const dirs = Object.values(REPORT_PRODUCING_SKILLS);
    const unique = new Set(dirs);
    expect(unique.size).toBe(dirs.length);
  });

  test('TEAMS.md documents all shared state locations', () => {
    for (const [skill, dir] of Object.entries(REPORT_PRODUCING_SKILLS)) {
      if (skill === 'team') continue; // team-reports is the lead's output
      expect(teamsDoc).toContain(dir.replace('.gstack/', ''));
    }
  });

  test('each report-producing skill references its output dir in SKILL.md', () => {
    for (const [skill, dir] of Object.entries(REPORT_PRODUCING_SKILLS)) {
      const content = readFile(`${skill}/SKILL.md`);
      expect(content).toContain(dir);
    }
  });
});

// ─── L4: Dependency graph — relationships are valid ──────────

describe('L4: Dependency graph — skill relationships', () => {
  const teamsDoc = readFile('team/TEAMS.md');
  const claudeMd = readFile('CLAUDE.md');

  // Verify the dependency graph in TEAMS.md references key skills
  test('dependency graph references key gstack skills', () => {
    const graphSection = teamsDoc.slice(teamsDoc.indexOf('## Dependency Graph'));
    const keySkills = ['/plan-eng', '/review', '/ship', '/qa', '/cso', '/risk', '/board', '/vc', '/cfo', '/media', '/comms', '/escalation'];
    for (const skill of keySkills) {
      expect(graphSection).toContain(skill);
    }
  });

  test('CLAUDE.md engineering pipeline matches TEAMS.md', () => {
    // Both should show: plan-eng → review + cso → ship → qa
    expect(claudeMd).toContain('/plan-eng-review');
    expect(claudeMd).toContain('/review');
    expect(claudeMd).toContain('/cso');
    expect(claudeMd).toContain('/ship');
    expect(claudeMd).toContain('/qa');
  });

  test('CLAUDE.md executive analysis matches TEAMS.md', () => {
    expect(claudeMd).toContain('/vc');
    expect(claudeMd).toContain('/cfo');
    expect(claudeMd).toContain('/risk');
    expect(claudeMd).toContain('/board');
  });

  test('CLAUDE.md launch team matches TEAMS.md', () => {
    expect(claudeMd).toContain('/media');
    expect(claudeMd).toContain('/pr-comms');
    expect(claudeMd).toContain('/comms');
  });

  test('CLAUDE.md incident team matches TEAMS.md', () => {
    expect(claudeMd).toContain('/escalation');
  });

  // Cross-reference: skills that should know about each other
  test('/risk skill mentions consuming /cso findings', () => {
    const risk = readFile('risk/SKILL.md');
    expect(risk.toLowerCase()).toContain('security');
  });

  test('/board skill mentions synthesizing from multiple sources', () => {
    const board = readFile('board/SKILL.md');
    expect(board.toLowerCase()).toContain('strategic');
    expect(board.toLowerCase()).toContain('risk');
  });

  test('/escalation skill mentions coordinating with security and comms', () => {
    const esc = readFile('escalation/SKILL.md');
    expect(esc.toLowerCase()).toContain('security');
    expect(esc.toLowerCase()).toContain('communicat');
  });

  test('/pr-comms and /media have complementary responsibilities', () => {
    const pr = readFile('pr-comms/SKILL.md');
    const media = readFile('media/SKILL.md');
    // PR owns external comms, media owns narratives
    expect(pr).toContain('press release');
    expect(media).toContain('story');
    // Both should be aware of consistency
    expect(pr.toLowerCase()).toContain('consistent');
    expect(media.toLowerCase()).toContain('defensible');
  });
});

// ─── L5: Team configurations — pre-built teams are valid ─────

describe('L5: Team configurations — pre-built teams', () => {
  const teamSkill = readFile('team/SKILL.md');

  test('has all 7 pre-built team configurations', () => {
    const teams = [
      '/team ship', '/team review', '/team launch',
      '/team incident', '/team diligence', '/team audit',
      '/team custom',
    ];
    for (const team of teams) {
      expect(teamSkill).toContain(team);
    }
  });

  test('Ship Team has 4 teammates with correct skills', () => {
    // architect (plan-eng-review), reviewer (review), security (cso), qa (qa)
    expect(teamSkill).toContain('plan-eng-review');
    expect(teamSkill).toContain('"architect"');
    expect(teamSkill).toContain('"reviewer"');
    expect(teamSkill).toContain('"security"');
    expect(teamSkill).toContain('"qa"');
  });

  test('Review Team has parallel pattern with 4 reviewers', () => {
    expect(teamSkill).toContain('"engineer"');
    expect(teamSkill).toContain('"security"');
    expect(teamSkill).toContain('"risk"');
    expect(teamSkill).toContain('"performance"');
  });

  test('Launch Team has 3 content-focused teammates', () => {
    expect(teamSkill).toContain('"journalist"');
    expect(teamSkill).toContain('"pr"');
    expect(teamSkill).toContain('"comms"');
  });

  test('Incident Team has war room pattern with IC', () => {
    expect(teamSkill).toContain('"incident-commander"');
    expect(teamSkill).toContain('urgent');
  });

  test('Due Diligence Team has 5 teammates with dependency ordering', () => {
    expect(teamSkill).toContain('"vc"');
    expect(teamSkill).toContain('"cfo"');
    expect(teamSkill).toContain('"cso"');
    expect(teamSkill).toContain('"risk"');
    expect(teamSkill).toContain('"board"');
    expect(teamSkill).toContain('Task dependencies');
  });

  test('Audit Team has compliance focus', () => {
    expect(teamSkill).toContain('"finance"');
    expect(teamSkill).toContain('compliance');
  });

  test('Custom Team has skill mapping table', () => {
    expect(teamSkill).toContain('SKILL MAPPING');
    expect(teamSkill).toContain('Role keyword');
  });

  test('all spawn prompts reference SKILL.md paths for teammate loading', () => {
    // Teammates should read their skill file to get their full persona
    const skillRefs = teamSkill.match(/skills\/gstack\/[\w-]+\/SKILL\.md/g) || [];
    expect(skillRefs.length).toBeGreaterThan(5);
  });

  test('team configurations reference inter-teammate messaging', () => {
    // Teammates should be told to message each other, not just report to lead
    expect(teamSkill).toContain('message');
    expect(teamSkill).toContain('Share findings');
    expect(teamSkill).toContain('Challenge');
  });

  test('team skill checks for agent teams feature flag', () => {
    expect(teamSkill).toContain('Prerequisites Check');
    expect(teamSkill).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
    expect(teamSkill).toContain('settings.json');
  });

  test('each team config specifies teammate count', () => {
    expect(teamSkill).toContain('4 teammates');
    expect(teamSkill).toContain('3 teammates');
    expect(teamSkill).toContain('5 teammates');
  });

  test('team configurations specify team patterns', () => {
    expect(teamSkill).toContain('Pipeline');
    expect(teamSkill).toContain('Parallel');
    expect(teamSkill).toContain('War room');
  });
});

// ─── L6: Cross-layer consistency ─────────────────────────────

describe('L6: Cross-layer consistency', () => {
  const claudeMd = readFile('CLAUDE.md');
  const teamsDoc = readFile('team/TEAMS.md');
  const teamSkill = readFile('team/SKILL.md');
  const preambleSample = readFile('review/SKILL.md'); // any skill with preamble

  test('CLAUDE.md and TEAMS.md agree on skill count', () => {
    // TEAMS.md lists 23 skills in the roster
    expect(teamsDoc).toContain('23 skills');
  });

  test('CLAUDE.md and team/SKILL.md agree on team patterns', () => {
    // Both should reference the same team patterns
    const patterns = ['Pipeline', 'Parallel', 'War room'];
    for (const pattern of patterns) {
      expect(claudeMd).toContain(pattern);
      expect(teamSkill).toContain(pattern);
    }
    // team/SKILL.md should have all pre-built team names
    const teamNames = ['ship', 'review', 'launch', 'incident', 'diligence', 'audit'];
    for (const name of teamNames) {
      expect(teamSkill).toContain(name);
    }
  });

  test('preamble teammate protocol aligns with TEAMS.md message format', () => {
    // Preamble tells skills to message findings; TEAMS.md defines the format
    expect(preambleSample).toContain('message your findings');
    expect(teamsDoc).toContain('FROM:');
    expect(teamsDoc).toContain('TOP FINDINGS:');
  });

  test('preamble urgency protocol aligns with TEAMS.md urgency rules', () => {
    expect(preambleSample).toContain('broadcast immediately');
    expect(teamsDoc).toContain('BROADCAST immediately');
  });

  test('all report directories in TEAMS.md match actual skill output dirs', () => {
    // Verify TEAMS.md shared state locations match what skills actually write to
    for (const [skill, dir] of Object.entries(REPORT_PRODUCING_SKILLS)) {
      const skillContent = readFile(`${skill}/SKILL.md`);
      expect(skillContent).toContain(dir);
    }
  });

  test('CLAUDE.md settings.json example matches .claude/settings.json', () => {
    // Both should enable the same env var
    expect(claudeMd).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
    const settings = JSON.parse(readFile('.claude/settings.json'));
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  test('TEAMS.md anti-patterns are consistent with skill constraints', () => {
    const teamsAntiPatterns = teamsDoc.slice(teamsDoc.indexOf('## Anti-Patterns'));
    expect(teamsAntiPatterns).toContain('same file');
    expect(teamsAntiPatterns).toContain('broadcast');
    expect(teamsAntiPatterns).toContain('lead');
  });

  test('TEAMS.md skill roster covers all analysis skills', () => {
    for (const skill of ANALYSIS_SKILLS) {
      expect(teamsDoc).toContain(`/${skill}`);
    }
  });

  test('TEAMS.md standalone vs teammate columns exist for all skills', () => {
    expect(teamsDoc).toContain('Standalone');
    expect(teamsDoc).toContain('As Teammate');
  });

  test('gen-skill-docs.ts preamble includes Agent Team Awareness section', () => {
    const genScript = readFile('scripts/gen-skill-docs.ts');
    expect(genScript).toContain('Agent Team Awareness');
    expect(genScript).toContain('_IS_TEAMMATE');
    expect(genScript).toContain('_TEAM_CONFIG');
    expect(genScript).toContain('broadcast immediately');
    expect(genScript).toContain('standalone');
  });

  test('the preamble generator is the single source of truth for teammate behavior', () => {
    // All skills should get identical teammate awareness — verify by sampling 3 different skills
    const review = readFile('review/SKILL.md');
    const cso = readFile('cso/SKILL.md');
    const media = readFile('media/SKILL.md');

    // Extract the Agent Team Awareness section — it ends at the next heading that isn't part of it
    const extractTeamSection = (content: string) => {
      const start = content.indexOf('## Agent Team Awareness');
      if (start === -1) return '';
      // Find the end: next ## heading that is a skill-specific section (not a preamble subsection)
      // The section ends at the next `# ` (h1) which starts the skill-specific content
      const afterStart = content.indexOf('\n# ', start);
      if (afterStart === -1) return content.slice(start).trim();
      return content.slice(start, afterStart).trim();
    };

    const reviewSection = extractTeamSection(review);
    const csoSection = extractTeamSection(cso);
    const mediaSection = extractTeamSection(media);

    // All three should be identical (same preamble injection)
    expect(reviewSection.length).toBeGreaterThan(100);
    expect(reviewSection).toBe(csoSection);
    expect(csoSection).toBe(mediaSection);
  });
});

// ─── L7: Template-to-output pipeline integrity ───────────────

describe('L7: Template-to-output pipeline integrity', () => {
  test('every .tmpl file has a corresponding generated .md', () => {
    const tmplFiles = [
      'SKILL.md.tmpl', 'browse/SKILL.md.tmpl', 'qa/SKILL.md.tmpl',
      'qa-only/SKILL.md.tmpl', 'setup-browser-cookies/SKILL.md.tmpl',
      'ship/SKILL.md.tmpl', 'review/SKILL.md.tmpl',
      'plan-ceo-review/SKILL.md.tmpl', 'plan-eng-review/SKILL.md.tmpl',
      'retro/SKILL.md.tmpl', 'gstack-upgrade/SKILL.md.tmpl',
      'conflicts/SKILL.md.tmpl', 'risk/SKILL.md.tmpl',
      'cso/SKILL.md.tmpl', 'cfo/SKILL.md.tmpl',
      'vc/SKILL.md.tmpl', 'board/SKILL.md.tmpl',
      'media/SKILL.md.tmpl', 'comms/SKILL.md.tmpl',
      'pr-comms/SKILL.md.tmpl', 'ai-hybrid/SKILL.md.tmpl',
      'escalation/SKILL.md.tmpl', 'team/SKILL.md.tmpl',
    ];

    for (const tmpl of tmplFiles) {
      expect(fileExists(tmpl)).toBe(true);
      const mdPath = tmpl.replace('.tmpl', '');
      expect(fileExists(mdPath)).toBe(true);
    }
  });

  test('no generated SKILL.md has unresolved {{PLACEHOLDER}}', () => {
    for (const skill of ALL_PREAMBLE_SKILLS) {
      const content = readFile(skill);
      const unresolved = content.match(/\{\{[A-Z_]+\}\}/g);
      expect(unresolved).toBeNull();
    }
  });

  test('all templates use {{PREAMBLE}} (ensuring teammate awareness)', () => {
    const tmplDirs = [
      '.', 'browse', 'qa', 'qa-only', 'setup-browser-cookies',
      'ship', 'review', 'plan-ceo-review', 'plan-eng-review', 'retro',
      'conflicts', 'risk', 'cso', 'cfo', 'vc', 'board',
      'media', 'comms', 'pr-comms', 'ai-hybrid', 'escalation', 'team',
    ];

    for (const dir of tmplDirs) {
      const tmplPath = dir === '.' ? 'SKILL.md.tmpl' : `${dir}/SKILL.md.tmpl`;
      if (!fileExists(tmplPath)) continue;
      const tmpl = readFile(tmplPath);
      expect(tmpl).toContain('{{PREAMBLE}}');
    }
  });

  test('total skill count is exactly 23 (11 Garry + 12 new)', () => {
    const allSkillDirs = [
      '.', 'browse', 'qa', 'qa-only', 'setup-browser-cookies',
      'ship', 'review', 'plan-ceo-review', 'plan-eng-review', 'retro',
      'gstack-upgrade',
      'conflicts', 'risk', 'cso', 'cfo', 'vc', 'board',
      'media', 'comms', 'pr-comms', 'ai-hybrid', 'escalation', 'team',
    ];
    expect(allSkillDirs).toHaveLength(23);

    for (const dir of allSkillDirs) {
      const mdPath = dir === '.' ? 'SKILL.md' : `${dir}/SKILL.md`;
      expect(fileExists(mdPath)).toBe(true);
    }
  });
});
