import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

export interface ShippedSkillRouting {
  /** The whole `## Skill routing` section gstack offered to append to CLAUDE.md. */
  section: string;
  /** The heading plus the opening instruction, without the per-skill rules. */
  instruction: string;
  /** The `- request → invoke /skill` rule lines. */
  rules: string[];
}

/**
 * Read the `## Skill routing` section bin/gstack-skill-start offered to append
 * to CLAUDE.md until the prompt-routing hook replaced it (B1e). gstack no longer
 * writes it, but projects set up before then still carry it, so E2E fixtures
 * use these exact bytes (test/fixtures/claude-md-skill-routing.md).
 */
export function readShippedSkillRouting(root = ROOT): ShippedSkillRouting {
  const file = path.join(root, 'test', 'fixtures', 'claude-md-skill-routing.md');
  if (!fs.existsSync(file)) throw new Error('test/fixtures/claude-md-skill-routing.md: routing section fixture not found');
  const section = fs.readFileSync(file, 'utf8').trim();
  const rules = section.split('\n').filter(line => /^- .+→ invoke \//.test(line));
  const instruction = section.split(/\n\n/).slice(0, 2).join('\n\n');
  if (!section.startsWith('## Skill routing\n') || rules.length === 0 || !/Skill tool/.test(instruction)) {
    throw new Error('test/fixtures/claude-md-skill-routing.md: ## Skill routing section has an unexpected shape');
  }
  return { section, instruction, rules };
}
