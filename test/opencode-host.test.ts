import { describe, expect, test } from 'bun:test';
import { claude, opencode } from '../hosts/index';

describe('OpenCode host tool rewrites', () => {
  test('rewrites Claude interaction tools to OpenCode equivalents', () => {
    expect(opencode.toolRewrites).toEqual({
      AskUserQuestion: 'question',
      ExitPlanMode: 'end plan mode',
    });
  });

  test('does not alter Claude host tool vocabulary', () => {
    expect(claude.toolRewrites).toEqual({});
  });
});
