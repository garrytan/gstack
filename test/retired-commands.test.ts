/**
 * Retired package scripts keep a one-release stub that names the replacement
 * and exits 1, so an old command in agent memory or a stale doc fails loudly
 * instead of running zero cases. TODOS.md "Remove one-release command stubs"
 * deletes the stubs, scripts/retired-command.ts and this test next release.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RETIRED_COMMANDS, retiredMessage } from '../scripts/retired-command';

const ROOT = path.resolve(import.meta.dir, '..');
const scripts: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');

describe('retired package scripts', () => {
  for (const [name, entry] of Object.entries(RETIRED_COMMANDS)) {
    test(`${name} is a stub that points at its replacement`, () => {
      expect(scripts[name], `package.json has no "${name}" stub; fix: add "${name}": "bun run scripts/retired-command.ts ${name}"`)
        .toBe(`bun run scripts/retired-command.ts ${name}`);
      const replacementScript = /^bun run ([\w:-]+)$/.exec(entry.replacement)?.[1];
      if (replacementScript) {
        expect(scripts[replacementScript], `${name} points at "${entry.replacement}", which is not a package script; fix: point RETIRED_COMMANDS["${name}"] at a live script`).toBeDefined();
        expect(RETIRED_COMMANDS[replacementScript], `${name} points at another retired name`).toBeUndefined();
      }
      expect(contributing, `CONTRIBUTING.md "Retired commands" lacks a row for \`${name}\`; fix: add "| \`${name}\` | ... |"`)
        .toContain(`| \`${name}\` |`);
    });
  }

  test('a stub prints the replacement on stderr and exits 1', () => {
    const result = Bun.spawnSync(['bun', 'run', 'scripts/retired-command.ts', 'test:evals'], { cwd: ROOT, timeout: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(retiredMessage('test:evals')!);
    expect(result.stderr.toString()).toContain('Use instead: bun run eval:bg:pr');
  });

  test('an unknown name exits 2 and lists the known names', () => {
    const result = Bun.spawnSync(['bun', 'run', 'scripts/retired-command.ts', 'test:nope'], { cwd: ROOT, timeout: 30_000 });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('test:evals');
  });
});
