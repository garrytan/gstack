import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  GROUND_RULES_HEADING,
  GROUND_RULES_MAX_BYTES,
  generateGroundRules,
} from '../scripts/resolvers/preamble/generate-ground-rules';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('Ground Rules preamble section', () => {
  const block = generateGroundRules();

  test('stays within its byte budget', () => {
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(GROUND_RULES_MAX_BYTES);
  });

  test('names every command that prints a whole environment, git config or process table, and the by-name alternative', () => {
    for (const cmd of ['`env`', 'bare `printenv`', '`set` or `export`', '`export $(...)`', '`export -p`/`-n`', '`declare -p`/`-x`', '`typeset -p`', '`set -x`', '`git config --list`/`-l`', 'any `ps` with full args (`aux`, `-ef`, `-o args`)', '`docker top ... args`', '`docker inspect` Env']) {
      expect(block).toContain(cmd);
    }
    expect(block).toContain('`git config --get <name>`');
    expect(block).toContain('`[ -n "${NAME:-}" ] && echo set`');
  });

  test('tells agents to wait on CI with gstack-pr-wait, not a polling loop or the GraphQL-spending gh watcher', () => {
    expect(block).toContain('`gstack-pr-wait <n> --until green`');
    expect(block).toContain('never a poll loop or `gh pr checks --watch`');
  });

  test('asks each question once and carries it as one waiting line, and checks every handed-over file for placeholders', () => {
    expect(block).toContain('Ask each question once');
    expect(block).toContain('one waiting line');
    expect(block).toContain('Open every file you hand over and remove placeholders first');
  });

  test('the Capy factory page points at the shared ask-once rule instead of restating it', () => {
    const item11 = read('capy/skill/gstack/factory.md').split('\n').find(l => l.startsWith('11. '))!;
    expect(item11).toContain("(every skill's Ground Rules)");
    expect(item11).not.toContain('check what you can yourself');
  });

  test('renders inline in a tier 1 skill and in the shared preamble tier 2+ skills read', () => {
    expect(read('browse/SKILL.md')).toContain(block);
    expect(read('review/sections/preamble.md')).toContain(block);
  });

  test('is pinned, so no model loadout can drop it', () => {
    const loadouts = JSON.parse(read('modules/loadouts.json'));
    expect(loadouts.pinned).toContain('preamble:ground-rules');
    expect(block.startsWith(GROUND_RULES_HEADING)).toBe(true);
  });
});
