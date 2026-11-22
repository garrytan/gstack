import type { TemplateContext } from '../types';

/**
 * Ground Rules: the few habits every skill on every host carries, at every
 * tier. Tier 1 skills inline it; tier 2+ skills read it from the shared
 * sections/preamble.md. Each rule is here because agents broke it in real
 * runs, so keep each bullet to one habit and the block at or under
 * GROUND_RULES_MAX_BYTES; test/ground-rules.test.ts pins that budget.
 */
export const GROUND_RULES_MAX_BYTES = 900;

export const GROUND_RULES_HEADING = '## Ground Rules';

export const GROUND_RULES_BULLETS = [
  'Never print a whole environment, git config or process table; tokens ride in them. Banned: `env`, bare `printenv`, `set` or `export` (or an empty `export $(...)`), `export -p`/`-n`, `declare -p`/`-x`, `typeset -p`, `set -x`, `git config --list`/`-l`, any `ps` with full args (`aux`, `-ef`, `-o args`), `docker top ... args`, `docker inspect` Env. Read one value by name (`git config --get <name>`), check a variable with `[ -n "${NAME:-}" ] && echo set`, list processes by name or pid.',
  'Wait on CI with one `gstack-pr-wait <n> --until green` call, never a poll loop or `gh pr checks --watch`.',
  'Ask each question once, after checking what you can yourself; until it is answered, list it as one waiting line in later updates instead of asking again.',
  'Open every file you hand over and remove placeholders first: TODO, `<fill in>`, lorem ipsum, broken links and images.',
] as const;

export function generateGroundRules(_ctx?: TemplateContext): string {
  return `${GROUND_RULES_HEADING}

${GROUND_RULES_BULLETS.map(bullet => `- ${bullet}`).join('\n')}`;
}
