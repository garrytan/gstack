/**
 * The red-census docs stay true to the code they describe: the failure-cause
 * glossary in docs/TESTING_INTERNALS.md lists exactly FAILURE_CAUSES, the
 * guide's commands use flags eval:pass-rates and test-paid-shards accept, and
 * the guide is linked from CONTRIBUTING.md and both census reports.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { FAILURE_CAUSES } from './helpers/eval-store';
import { parsePassRatesArgs } from '../scripts/lib/eval-history';

const ROOT = path.join(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const internals = read('docs/TESTING_INTERNALS.md');
const guide = read('docs/evals/census-red.md');

describe('red-census docs', () => {
  test('the failure-cause glossary has one row per FAILURE_CAUSES value, in precedence order', () => {
    const section = internals.slice(internals.indexOf('<a id="failure-causes"></a>'));
    const rows = [...section.slice(0, section.indexOf('\n\n', section.indexOf('| `failure_cause` |'))).matchAll(/^\| `([a-z_]+)` \|/gm)]
      .map(m => m[1]).filter(cause => cause !== 'failure_cause');
    expect(rows).toEqual([...FAILURE_CAUSES]);
  });

  test('every eval:pass-rates command in the guide parses', () => {
    const commands = [...guide.matchAll(/^bun run eval:pass-rates ([^\n#]*)/gm)].map(m => m[1]!.trim());
    expect(commands.length).toBeGreaterThanOrEqual(6);
    for (const command of commands) {
      const args = command.replace(/<[^>]+>/g, 'x').split(/\s+/).filter(Boolean)
        .map((arg, i, all) => (all[i - 1] === '--run' || all[i - 1] === '--runs' ? '10' : arg));
      const parsed = parsePassRatesArgs(args, () => true);
      expect('error' in parsed ? parsed.error : null, command).toBeNull();
    }
  });

  test('the guide is linked from CONTRIBUTING, TESTING_INTERNALS and both census reports', () => {
    expect(read('CONTRIBUTING.md')).toContain('docs/evals/census-red.md');
    expect(internals).toContain('(evals/census-red.md)');
    for (const workflow of ['evals-periodic.yml', 'evals-marathon.yml']) {
      expect(read(`.github/workflows/${workflow}`)).toContain('/docs/evals/census-red.md');
    }
    for (const anchor of ['failure-causes', 'eval-verdict-policy']) expect(internals).toContain(`<a id="${anchor}"></a>`);
  });
});
