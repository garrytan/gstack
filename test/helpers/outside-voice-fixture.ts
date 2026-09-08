/** Extract the installed review workflow, handling carved and inline host renders. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSkillSections } from './skill-fixture';

export function installOutsideReviewFixture(rendered: string, host: 'claude' | 'codex', repo: string, runtimeRoot: string): string {
  const source = host === 'claude' ? join(rendered, 'review') : join(rendered, '.agents', 'skills', 'gstack-review');
  const name = host === 'claude' ? 'review' : 'gstack-review';
  const destination = join(repo, host === 'claude' ? '.claude' : '.agents', 'skills', name);
  mkdirSync(destination, { recursive: true });
  const head = extractSkillSections(source, ['Step 0: Detect platform and base branch', 'Step 3: Get the diff']);
  const sectionPath = join(source, 'sections', 'adversarial.md');
  const section = existsSync(sectionPath) ? readFileSync(sectionPath, 'utf8')
    : extractSkillSections(source, ['Step 5.7: Adversarial review (always-on)']).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  if (!section.includes('Adversarial review (always-on)')) throw new Error(`Missing adversarial workflow: ${source}`);
  // Runtime paths are the only fixture substitution. Provider selection,
  // caller controls, prompt, probes, and execution code stay generated verbatim.
  const content = (head + '\n' + section)
    .replaceAll('~/.claude/skills/gstack', runtimeRoot)
    .replaceAll('$HOME/.claude/skills/gstack', runtimeRoot)
    .replaceAll('${GSTACK_BIN}', join(runtimeRoot, 'bin'))
    .replaceAll('$GSTACK_BIN', join(runtimeRoot, 'bin'))
    .replaceAll('$GSTACK_ROOT', runtimeRoot);
  writeFileSync(join(destination, 'SKILL.md'), content);
  return destination;
}
