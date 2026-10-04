/**
 * Q3 (#2719, PR #2729): in Conductor (or when AskUserQuestion fails) prose is
 * the only channel, and the prose fallback defined only the `D<N>` decision
 * brief. Office-hours' Phase 2A/2B diagnostic questions have no option set, so
 * the model dropped them. Office-hours now carries a `Q<N>` open-question form
 * and its diagnostic phases name it; other skills are unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { generateAskUserFormat } from '../scripts/resolvers/preamble/generate-ask-user-format';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const ctx = (host: string, skillName: string): TemplateContext => ({ host, skillName, tmplPath: '', paths: HOST_PATHS[host] });

describe('Q3: open-question prose form', () => {
  for (const host of ['claude', 'codex']) {
    test(`${host}: office-hours defines the Q<N> form and routes free-text replies to it`, () => {
      const text = generateAskUserFormat(ctx(host, 'office-hours'));
      expect(text).toContain('**Open-question prose form (`Q<N>`)**');
      expect(text).toContain("Q<N> — <question, verbatim>\nWhy I'm asking:");
      expect(text).toContain("Reply in your own words — I'll wait.");
      expect(text).toContain('a free-text reply answers the most recent unanswered `Q<N>`');
      expect(text).toContain('Questions with discrete options always use `D<N>`');
    });

    test(`${host}: other skills keep only the D<N> brief`, () => {
      expect(generateAskUserFormat(ctx(host, 'review'))).not.toContain('Q<N>');
    });
  }

  test('the Phase 2A and 2B diagnostic sections ask in Q<N> form when prose is the channel', () => {
    for (const file of ['office-hours/sections/phase-2a-startup-diagnostic.md.tmpl', 'office-hours/sections/phase-2b-builder-brainstorm.md.tmpl']) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toContain('ask each in the `Q<N>` open-question prose form, never as a `D<N>` decision brief');
    }
  });
});
