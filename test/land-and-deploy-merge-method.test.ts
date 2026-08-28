import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const template = readFileSync(
  join(
    import.meta.dir,
    '..',
    'land-and-deploy',
    'sections',
    'merge-and-deploy.md.tmpl',
  ),
  'utf8',
);

describe('land-and-deploy merge command invariants', () => {
  test('every non-interactive merge example binds one target and one method', () => {
    const commands = template.match(/^gh pr merge\b.*$/gm) ?? [];
    expect(commands.length).toBeGreaterThan(0);

    for (const command of commands) {
      const tokens = command.split(/\s+/);
      expect(tokens[3]).toBe('<resolved-pr>');
      const methodCount = ['--merge', '--rebase', '--squash'].filter((flag) =>
        tokens.includes(flag),
      ).length;
      expect(methodCount).toBe(1);
    }
  });

  test('push examples never receive a PR merge-method flag', () => {
    expect(template).not.toContain('git push --squash');
    expect(template).not.toContain('git push --merge');
    expect(template).not.toContain('git push --rebase');
  });
});
