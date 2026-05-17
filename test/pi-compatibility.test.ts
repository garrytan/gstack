import { beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PI_SKILLS_DIR = path.join(ROOT, '.pi', 'skills');

function generatePiSkills() {
  const result = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'pi'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function readGeneratedPiSkills(): Array<{ name: string; content: string }> {
  const skills: Array<{ name: string; content: string }> = [];
  for (const entry of fs.readdirSync(PI_SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(PI_SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    skills.push({ name: entry.name, content: fs.readFileSync(skillMd, 'utf-8') });
  }
  return skills;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generatedPiSkillCommands(skills: Array<{ name: string; content: string }>, options: { includeEndpointLike?: boolean } = {}): string {
  const commands = new Set<string>();
  for (const skill of skills) {
    if (skill.name === 'gstack') continue;
    commands.add(skill.name.replace(/^gstack-/, ''));
    commands.add(skill.name);
  }
  if (!options.includeEndpointLike) commands.delete('health');
  return [...commands]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
}

function generatedPiSkillCommandPattern(skills: Array<{ name: string; content: string }>): RegExp {
  const commands = generatedPiSkillCommands(skills, { includeEndpointLike: true });
  return new RegExp('\\b(invoke|invokes|invoked|run|runs|running|type|types|typed|call|calls|called|use|uses|using|via)\\s+`?\\/(' + commands + ')(?=`|\\s|$)', 'i');
}

function generatedPiSkillExamplePattern(skills: Array<{ name: string; content: string }>): RegExp {
  const commands = generatedPiSkillCommands(skills);
  return new RegExp('(^|\\n)\\s*[-*]\\s+`\\/(' + commands + ')(?=`|\\s)', 'i');
}

function generatedPiEscapedSkillPattern(skills: Array<{ name: string; content: string }>): RegExp {
  const commands = generatedPiSkillCommands(skills);
  return new RegExp('\\\\`\\/(' + commands + ')(?=\\\\`|\\s)', 'i');
}

function generatedPiInlineSkillPattern(skills: Array<{ name: string; content: string }>): RegExp {
  const commands = generatedPiSkillCommands(skills);
  return new RegExp('(?<![\\w.:/->])\\/(' + commands + ')(?![\\w-])');
}

describe('Pi generated skill compatibility', () => {
  beforeAll(() => {
    generatePiSkills();
  });

  test('generated Pi skills avoid unsupported host-specific runtime contracts', () => {
    const violations: string[] = [];
    const skills = readGeneratedPiSkills();
    const forbidden: Array<[string, RegExp]> = [
      ['MCP-style ask_user_question resolver', /mcp__\*?__ask_user_question|host MCP variant|native Claude Code tool/i],
      ['Claude plan-mode tool contract', /ExitPlanMode/],
      ['Claude vendored-skill migration path', /git add \.claude\/|\.claude\/skills\/gstack/],
      ['direct repo-local Pi runtime asset path', /\.pi\/skills\/gstack\//],
      ['HOME-prefixed GSTACK env var path', /\$HOME\$GSTACK_[A-Z_]+/],
      ['HOME/GSTACK_ROOT path', /\$HOME\/\$GSTACK_ROOT|\$\{HOME\}\/\$GSTACK_ROOT/],
      ['repo-root/GSTACK_ROOT path', /\$_ROOT\/\$GSTACK_ROOT/],
      ['Claude Agent tool wording', /\bAgent tool\b/],
      ['Claude Grep tool wording', /\bGrep tool\b/],
      ['Claude Skill tool wording', /\bSkill tool\b/],
      ['unsupported bare slash skill command', generatedPiSkillCommandPattern(skills)],
      ['unsupported bare slash skill example', generatedPiSkillExamplePattern(skills)],
      ['unsupported escaped slash skill table entry', generatedPiEscapedSkillPattern(skills)],
      ['unsupported inline slash skill reference', generatedPiInlineSkillPattern(skills)],
      ['double-prefixed Pi skill command', /\/skill:gstack-gstack-/],
      ['generic slash skill placeholder', /\/skillname|\/gstack-\*|\/skill:gstack-\[skill-name\]|\[skill-name\]/],
      ['unsupported future automate skill command', /\/automate/],
      ['Pi rewrite inside filesystem path', /<gstack-install>\/skill:gstack-/],
      ['skipped Codex skill command', /`\/codex(?:\s+review)?`|\\`\/codex(?:\s+review)?\\`|invoke `\/codex`/],
    ];

    for (const skill of skills) {
      for (const [label, pattern] of forbidden) {
        if (pattern.test(skill.content)) violations.push(`${skill.name}: ${label}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('generated Pi skills positively describe Pi runtime capabilities', () => {
    const root = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack', 'SKILL.md'), 'utf-8');
    expect(root).toContain('invoke it with the matching /skill:gstack-* command');
    expect(root).toContain('/skill:gstack-plan-ceo-review');
    expect(root).toContain('/skill:gstack-investigate');
    expect(root).not.toContain('invoke /plan-ceo-review');
    expect(root).not.toContain('/plan-design-review');
    expect(root).not.toContain('/qa-only');
    expect(root).not.toContain('/land-and-deploy');

    const upgrade = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack-upgrade', 'SKILL.md'), 'utf-8');
    expect(upgrade).toContain('# /skill:gstack-upgrade');
    expect(upgrade).toContain('Run `/skill:gstack-upgrade` manually to retry');
    expect(upgrade).not.toContain('/skill:gstack-gstack-upgrade');
    expect(upgrade).not.toContain('as `/gstack-upgrade`');

    const canary = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack-canary', 'SKILL.md'), 'utf-8');
    expect(canary).toContain('- `/skill:gstack-canary <url>`');
    expect(canary).not.toContain('- `/canary <url>`');

    const planEng = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack-plan-eng-review', 'SKILL.md'), 'utf-8');
    expect(planEng).toContain('\\`/skill:gstack-plan-ceo-review\\`');
    expect(planEng).toContain('\\`codex review\\`');
    expect(planEng).not.toContain('\\`/codex review\\`');

    const officeHours = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack-office-hours', 'SKILL.md'), 'utf-8');
    expect(officeHours).toContain('**`/skill:gstack-plan-ceo-review`**');
    expect(officeHours).not.toContain('**`/plan-ceo-review`**');

    const planCeo = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack-plan-ceo-review', 'SKILL.md'), 'utf-8');
    expect(planCeo).toContain('offer `/skill:gstack-office-hours`');
    expect(planCeo).not.toContain('offer `/office-hours`');

    const skillify = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack-skillify', 'SKILL.md'), 'utf-8');
    expect(skillify).toContain('<gstack-install>/browse/src/browse-client.ts');
    expect(skillify).not.toContain('<gstack-install>/skill:gstack-browse');

    const setupDeploy = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack-setup-deploy', 'SKILL.md'), 'utf-8');
    expect(setupDeploy).toContain('or `/health` if the app has one');
    expect(setupDeploy).toContain('(e.g., /health, /api/status)');

    const review = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack-review', 'SKILL.md'), 'utf-8');
    expect(review).toContain('GSTACK_ROOT="$_ROOT/.pi/skills/gstack"');
    expect(review).toContain('ask_user_question is the Pi custom tool');
    expect(review).toContain('$GSTACK_ROOT/review/checklist.md');

    const browse = fs.readFileSync(path.join(PI_SKILLS_DIR, 'gstack-browse', 'SKILL.md'), 'utf-8');
    expect(browse).toContain('[ -n "$GSTACK_BROWSE" ] && [ -x "$GSTACK_BROWSE/browse" ] && B="$GSTACK_BROWSE/browse"');
  });
});
