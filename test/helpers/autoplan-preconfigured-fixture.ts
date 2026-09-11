import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Real project routing, matching the section offered by gstack-skill-start.
const ROUTING = `## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
`;

/** Only the chain-ordering fixture starts with these onboarding prerequisites. */
export function seedAutoplanOnboarding(cwd: string): void {
  const plan = readFileSync(join(cwd, '.claude/plans/ui-heavy-feature.md'), 'utf8');
  const section = (title: string): string => {
    const heading = `## ${title}\n`;
    const starts = [...plan.matchAll(/^## .*\n/gm)].filter(match => match[0] === heading);
    if (starts.length !== 1) throw new Error(`Expected one ${title} section in the chain plan`);
    const start = starts[0].index!;
    const next = plan.indexOf('\n## ', start + heading.length);
    const text = plan.slice(start, next < 0 ? undefined : next + 1);
    if (!text.slice(heading.length).trim()) throw new Error(`Empty ${title} section in the chain plan`);
    return text;
  };
  // Copy background only. The plan retains all new work and review decisions.
  const brief = section('Context') + section('Existing product and application contracts');
  const routingFile = join(cwd, 'CLAUDE.md');
  const designDir = join(cwd, 'docs/designs');
  if (existsSync(routingFile) || existsSync(join(cwd, 'DESIGN.md')) || existsSync(designDir)) {
    throw new Error('Autoplan onboarding seed requires a fresh chain fixture');
  }
  mkdirSync(designDir, { recursive: true });
  writeFileSync(join(designDir, 'dashboard-context.md'), brief, { flag: 'wx' });
  writeFileSync(routingFile, ROUTING, { flag: 'wx' });
}
