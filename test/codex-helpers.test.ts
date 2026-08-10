/**
 * scripts/resolvers/codex-helpers.ts — frontmatter transform for external hosts.
 *
 * This module had zero test coverage: it is only exercised indirectly through
 * full gen-skill-docs runs, which assert on rendered skill files rather than on
 * the parser itself. The bug classes that live here are all silent:
 * a missed frontmatter boundary yields `name: ''` (a skill Codex can't route
 * to), the OpenAI short-description condenser can emit a string over the
 * 120-char interface limit, and `externalSkillName` can double-prefix
 * (`gstack-gstack-upgrade`).
 */

import { describe, test, expect } from 'bun:test';
import {
  extractNameAndDescription,
  condenseOpenAIShortDescription,
  generateOpenAIYaml,
  externalSkillName,
  transformFrontmatter,
  extractHookSafetyProse,
} from '../scripts/resolvers/codex-helpers';

const OPENAI_LIMIT = 120;

describe('extractNameAndDescription', () => {
  test('inline description', () => {
    const content = '---\nname: review\ndescription: Pre-landing PR review.\n---\n\n# Review\n';
    expect(extractNameAndDescription(content)).toEqual({
      name: 'review',
      description: 'Pre-landing PR review.',
    });
  });

  test('block scalar description keeps newlines and de-indents', () => {
    const content = [
      '---',
      'name: ship',
      'description: |',
      '  Run tests, review, push.',
      '  Workspace-aware version queue.',
      '---',
      'body',
    ].join('\n');
    expect(extractNameAndDescription(content)).toEqual({
      name: 'ship',
      description: 'Run tests, review, push.\nWorkspace-aware version queue.',
    });
  });

  test('block scalar stops at the next unindented key', () => {
    const content = [
      '---',
      'name: qa',
      'description: |',
      '  Find bugs in a real browser.',
      'allowed-tools: Bash, Edit',
      '---',
      'body',
    ].join('\n');
    const { description } = extractNameAndDescription(content);
    expect(description).toBe('Find bugs in a real browser.');
    expect(description).not.toContain('allowed-tools');
  });

  test('inline description wins over later keys and stops parsing', () => {
    const content = '---\nname: a\ndescription: First.\nversion: 2\n---\nbody';
    expect(extractNameAndDescription(content).description).toBe('First.');
  });

  test('frontmatter not at offset 0 → empty result', () => {
    const content = '\n---\nname: a\ndescription: b\n---\n';
    expect(extractNameAndDescription(content)).toEqual({ name: '', description: '' });
  });

  test('unterminated frontmatter → empty result', () => {
    expect(extractNameAndDescription('---\nname: a\ndescription: b\n')).toEqual({
      name: '',
      description: '',
    });
  });

  test('missing name → empty name, description still parsed', () => {
    expect(extractNameAndDescription('---\ndescription: b\n---\nbody')).toEqual({
      name: '',
      description: 'b',
    });
  });
});

describe('condenseOpenAIShortDescription', () => {
  test('short single line passes through unchanged', () => {
    expect(condenseOpenAIShortDescription('Ship it.')).toBe('Ship it.');
  });

  test('only the first paragraph is used', () => {
    expect(condenseOpenAIShortDescription('First para.\n\nSecond para.')).toBe('First para.');
  });

  test('internal whitespace and newlines collapse to single spaces', () => {
    expect(condenseOpenAIShortDescription('  Run   tests,\nthen ship.  ')).toBe(
      'Run tests, then ship.',
    );
  });

  test('long text truncates at a word boundary and stays within the limit', () => {
    const long = 'word '.repeat(60).trim();
    const out = condenseOpenAIShortDescription(long);
    expect(out.length).toBeLessThanOrEqual(OPENAI_LIMIT);
    expect(out.endsWith('...')).toBe(true);
    expect(out).not.toContain('wor...');
  });

  test('long single token with no early space truncates hard, not at char 0', () => {
    const out = condenseOpenAIShortDescription('x'.repeat(200));
    expect(out.length).toBe(OPENAI_LIMIT);
    expect(out.endsWith('...')).toBe(true);
  });

  test('exactly at the limit is not truncated', () => {
    const exact = 'y'.repeat(OPENAI_LIMIT);
    expect(condenseOpenAIShortDescription(exact)).toBe(exact);
  });
});

describe('generateOpenAIYaml', () => {
  test('emits interface + policy blocks with JSON-escaped values', () => {
    const yaml = generateOpenAIYaml('gstack-review', 'Pre-landing PR review');
    expect(yaml).toContain('display_name: "gstack-review"');
    expect(yaml).toContain('short_description: "Pre-landing PR review"');
    expect(yaml).toContain('default_prompt: "Use gstack-review for this task."');
    expect(yaml).toContain('allow_implicit_invocation: true');
  });

  test('quotes and newlines in the description are escaped, not raw', () => {
    const yaml = generateOpenAIYaml('a"b', 'line1\nline2');
    expect(yaml).toContain('display_name: "a\\"b"');
    expect(yaml).toContain('short_description: "line1\\nline2"');
    // One YAML line per key — a raw newline would break the document.
    expect(yaml.split('\n').filter(l => l.includes('short_description')).length).toBe(1);
  });
});

describe('externalSkillName', () => {
  test('root skill dir maps to bare gstack', () => {
    expect(externalSkillName('.')).toBe('gstack');
    expect(externalSkillName('')).toBe('gstack');
  });

  test('plain skill dirs get the gstack- prefix', () => {
    expect(externalSkillName('review')).toBe('gstack-review');
  });

  test('already-prefixed dirs are not double-prefixed', () => {
    expect(externalSkillName('gstack-upgrade')).toBe('gstack-upgrade');
  });
});

describe('transformFrontmatter', () => {
  const rich = [
    '---',
    'name: review',
    'description: Pre-landing PR review.',
    'allowed-tools: Bash, Edit, Write',
    'version: 1.2.3',
    '---',
    '',
    '# Review',
    'Body stays.',
  ].join('\n');

  test('claude host is a pass-through', () => {
    expect(transformFrontmatter(rich, 'claude')).toBe(rich);
  });

  test('codex frontmatter keeps only name + description as a block scalar', () => {
    const out = transformFrontmatter(rich, 'codex');
    expect(out).toContain('name: review');
    expect(out).toContain('description: |\n  Pre-landing PR review.');
    expect(out).not.toContain('allowed-tools');
    expect(out).not.toContain('version: 1.2.3');
    expect(out).toContain('# Review');
    expect(out).toContain('Body stays.');
  });

  test('multiline description is re-indented under the block scalar', () => {
    const content = '---\nname: a\ndescription: |\n  one\n  two\n---\nbody';
    const out = transformFrontmatter(content, 'codex');
    expect(out).toContain('description: |\n  one\n  two\n---');
  });

  test('description over the 1024-char Codex limit throws with the skill name', () => {
    const content = `---\nname: fat\ndescription: ${'z'.repeat(1100)}\n---\nbody`;
    expect(() => transformFrontmatter(content, 'codex')).toThrow(/"fat" is 1100 chars/);
  });

  test('content without frontmatter passes through untouched', () => {
    expect(transformFrontmatter('# no frontmatter\n', 'codex')).toBe('# no frontmatter\n');
    expect(transformFrontmatter('---\nname: a\n', 'codex')).toBe('---\nname: a\n');
  });
});

describe('extractHookSafetyProse', () => {
  test('no hooks key → null', () => {
    expect(extractHookSafetyProse('---\nname: a\n---\nbody')).toBeNull();
  });

  test('hooks key with no matchers → null', () => {
    expect(extractHookSafetyProse('hooks:\n  PreToolUse: []\n')).toBeNull();
  });

  test('known matchers map to their advisory prose, deduped', () => {
    const tmpl = [
      'hooks:',
      '  PreToolUse:',
      '    - matcher: "Bash"',
      '    - matcher: "Edit"',
      '    - matcher: "Edit"',
      '',
    ].join('\n');
    const prose = extractHookSafetyProse(tmpl);
    expect(prose).toContain('Safety Advisory');
    expect(prose).toContain('destructive operations');
    expect(prose).toContain('scope boundary');
    // Deduped: the Edit description appears once, not twice.
    expect(prose!.match(/file edits are within the allowed scope/g)!.length).toBe(1);
  });

  test('unknown matcher falls back to a generic check description', () => {
    const prose = extractHookSafetyProse('hooks:\n  - matcher: "WebFetch"\n');
    expect(prose).toContain('check WebFetch operations for safety');
  });

  test('hooks: must be at line start to count', () => {
    expect(extractHookSafetyProse('  hooks:\n  - matcher: "Bash"\n')).toBeNull();
  });
});
