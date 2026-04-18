import { describe, it, expect } from 'bun:test';
import {
  canonicalizeCommand,
  COMMAND_ALIASES,
  NEW_IN_VERSION,
  buildUnknownCommandError,
  ALL_COMMANDS,
} from '../src/commands';

describe('canonicalizeCommand', () => {
  it('resolves setcontent → load-html', () => {
    expect(canonicalizeCommand('setcontent')).toBe('load-html');
  });

  it('resolves set-content → load-html', () => {
    expect(canonicalizeCommand('set-content')).toBe('load-html');
  });

  it('resolves setContent → load-html (case-sensitive key)', () => {
    expect(canonicalizeCommand('setContent')).toBe('load-html');
  });

  it('passes canonical names through unchanged', () => {
    expect(canonicalizeCommand('load-html')).toBe('load-html');
    expect(canonicalizeCommand('goto')).toBe('goto');
  });

  it('passes unknown names through unchanged (alias map is allowlist, not filter)', () => {
    expect(canonicalizeCommand('totally-made-up')).toBe('totally-made-up');
  });
});

describe('buildUnknownCommandError', () => {
  it('names the input in every error', () => {
    const msg = buildUnknownCommandError('xyz', ALL_COMMANDS);
    expect(msg).toContain(`Unknown command: 'xyz'`);
  });

  it('suggests closest match within Levenshtein 2 when input length >= 4', () => {
    const msg = buildUnknownCommandError('load-htm', ALL_COMMANDS);
    expect(msg).toContain(`Did you mean 'load-html'?`);
  });

  it('does NOT suggest for short inputs (< 4 chars, avoids noise on js/is typos)', () => {
    // 'j' is distance 1 from 'js' but only 1 char — suggestion would be noisy
    const msg = buildUnknownCommandError('j', ALL_COMMANDS);
    expect(msg).not.toContain('Did you mean');
  });

  it('uses alphabetical tiebreak for deterministic suggestions', () => {
    // Synthetic command set where two commands tie on distance from input
    const syntheticSet = new Set(['alpha', 'beta']);
    // 'alpha' vs 'delta' = 3 edits; 'beta' vs 'delta' = 2 edits
    // Let's use a case that genuinely ties.
    const ties = new Set(['abcd', 'abce']); // both distance 1 from 'abcf'
    const msg = buildUnknownCommandError('abcf', ties, {}, {});
    // Alphabetical first: 'abcd' comes before 'abce'
    expect(msg).toContain(`Did you mean 'abcd'?`);
  });

  it('appends upgrade hint when command appears in NEW_IN_VERSION', () => {
    // Synthetic: pretend load-html isn't in the command set (agent on older build)
    const noLoadHtml = new Set([...ALL_COMMANDS].filter(c => c !== 'load-html'));
    const msg = buildUnknownCommandError('load-html', noLoadHtml, COMMAND_ALIASES, NEW_IN_VERSION);
    expect(msg).toContain('added in browse v');
    expect(msg).toContain('Upgrade:');
  });

  it('omits upgrade hint for unknown commands not in NEW_IN_VERSION', () => {
    const msg = buildUnknownCommandError('notarealcommand', ALL_COMMANDS);
    expect(msg).not.toContain('added in browse v');
  });

  it('NEW_IN_VERSION has load-html entry', () => {
    expect(NEW_IN_VERSION['load-html']).toBeTruthy();
  });

  it('COMMAND_ALIASES + command set are consistent — all alias targets exist', () => {
    for (const target of Object.values(COMMAND_ALIASES)) {
      expect(ALL_COMMANDS.has(target)).toBe(true);
    }
  });
});

describe('Alias + SCOPE_WRITE integration invariant', () => {
  it('load-html is in SCOPE_WRITE (alias canonicalization happens before scope check)', async () => {
    const { SCOPE_WRITE } = await import('../src/token-registry');
    expect(SCOPE_WRITE.has('load-html')).toBe(true);
  });

  it('setcontent is NOT directly in any scope set (must canonicalize first)', async () => {
    const { SCOPE_WRITE, SCOPE_READ, SCOPE_ADMIN, SCOPE_CONTROL } = await import('../src/token-registry');
    // The alias itself must NOT appear in any scope set — only the canonical form.
    // This proves scope enforcement relies on canonicalization at dispatch time,
    // not on the alias leaking through as an acceptable command.
    expect(SCOPE_WRITE.has('setcontent')).toBe(false);
    expect(SCOPE_READ.has('setcontent')).toBe(false);
    expect(SCOPE_ADMIN.has('setcontent')).toBe(false);
    expect(SCOPE_CONTROL.has('setcontent')).toBe(false);
  });
});
