import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { generateCodexPlanReview } from '../scripts/resolvers/outside-voice-steps';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';
import { RESULT_CODES } from '../lib/result-codes';

// #3182: Claude Code 2.1.277 removed TaskOutput. The plan-review native
// fallback must bound its reviewer with primitives the host still has: a
// background timer whose exit re-invokes the parent, the background agent's
// completion notification, and TaskStop. These checks pin the generated
// instructions, not a model's compliance with them.

const ROOT = path.resolve(import.meta.dir, '..');
const SKILLS = ['plan-ceo-review', 'plan-eng-review', 'plan-devex-review'] as const;
const flat = (text: string) => text.replace(/\s+/g, ' ');

function bounded(content: string): string {
  return content.match(/\*\*Bounded outside-voice wait[\s\S]*?(?=\*\*(?:Integrate reviewer findings|Cross-model tension):\*\*)/)?.[0] ?? '';
}

function renders(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const skill of SKILLS) {
    out.push([`${skill}/sections/review-sections.md`, fs.readFileSync(path.join(ROOT, skill, 'sections/review-sections.md'), 'utf8')]);
    for (const host of ALL_HOST_CONFIGS) {
      if (host.name === 'codex') continue;
      const ctx: TemplateContext = { host: host.name, skillName: skill, tmplPath: `${skill}/sections/review-sections.md.tmpl`, paths: HOST_PATHS[host.name] };
      out.push([`${host.name}:${skill}`, generateCodexPlanReview(ctx)]);
    }
  }
  return out;
}

describe('native outside-voice fallback without TaskOutput (#3182)', () => {
  test('no rendered plan-review section requires the removed TaskOutput tool', () => {
    for (const [name, content] of renders()) {
      const section = bounded(content);
      expect(section.length, name).toBeGreaterThan(0);
      expect(section, name).not.toContain('TaskOutput');
      expect(section, name).not.toContain('block: true');
    }
  });

  test('the deadline is a host timer started before dispatch, and TaskStop ends the loser', () => {
    for (const [name, section] of renders().map(([n, c]) => [n, bounded(c)] as const)) {
      const timer = section.indexOf('`command: "sleep 300"`');
      const dispatch = section.indexOf('`subagent_type: "Plan"`');
      expect(timer, name).toBeGreaterThan(0);
      expect(dispatch, name).toBeGreaterThan(timer);
      expect(section.slice(timer, dispatch), name).toContain('`run_in_background: true`');
      expect(flat(section), name).toContain('call TaskStop with the timer');
      expect(flat(section), name).toContain('TaskStop with the same ID as the agent');
      expect(flat(section), name).toContain('End your turn and wait for task notifications');
      expect(flat(section), name).toContain('do not poll, sleep, Read either output file');
    }
  });

  test('only the matching completed notification that beats the timer counts', () => {
    for (const [name, section] of renders().map(([n, c]) => [n, bounded(c)] as const)) {
      for (const guard of ['`<task-notification>`', 'arriving before the timer', '`<task-id>` must match the agent ID',
        '`<status>` must be `completed`', 'is waiting on its own background work', 'turn limit', '[Subagent hand-back]',
        'identifiable complete final reviewer report', 'Reject raw or in-progress transcripts',
        'still give no late-result credit', 'cancellation is unconfirmed']) {
        expect(flat(section), `${name}: ${guard}`).toContain(guard);
      }
      // A foreground run returns a report the host never bounded: no credit.
      expect(flat(section), name).toMatch(/Agent returns a report directly: no enforced deadline, so no credit/);
    }
  });

  test('the unavailable line names its cause and fix, in the output and the persisted row', () => {
    for (const [name, content] of renders()) {
      const unavailable = flat(content.slice(content.indexOf('**Unavailable path:**')));
      expect(unavailable, name).toContain('Outside voice unavailable: <cause>. Fix: <fix>.');
      for (const cause of ['Plan agent type not offered', 'TaskStop not offered', 'background tasks unavailable',
        'no complete report within five minutes']) expect(unavailable, `${name}: ${cause}`).toContain(cause);
      expect(unavailable, name).toContain('(OUTSIDE_VOICE_UNAVAILABLE)');
      expect(unavailable, name).toContain('`"unavailable_reason":"<cause>"`');
      if (name.startsWith('claude:')) expect(unavailable, name).toContain('Claude Code 2.1.277+, background tasks on');
    }
    expect(RESULT_CODES.OUTSIDE_VOICE_UNAVAILABLE.anchor).toBe('outside-voice-unavailable');
  });

  test('Codex, with no Plan subagent type or TaskStop, takes the unavailable path without launching (#4476)', () => {
    for (const skill of SKILLS) {
      const content = generateCodexPlanReview({ host: 'codex', skillName: skill, tmplPath: `${skill}/sections/review-sections.md.tmpl`, paths: HOST_PATHS.codex });
      const section = flat(bounded(content));
      expect(section, skill).toContain('take the unavailable path without launching a native subagent');
      expect(section, skill).toContain('A native result never supplies outside coverage.');
      expect(section, skill).not.toMatch(/TaskStop|run_in_background|subagent_type|task-notification/);
      const unavailable = flat(content.slice(content.indexOf('**Unavailable path:**')));
      expect(unavailable, skill).toContain('Outside voice unavailable: <cause>. Fix: <fix>.');
      expect(unavailable, skill).toContain('Codex has no read-only native subagent');
      expect(unavailable, skill).toContain('`"unavailable_reason":"<cause>"`');
      expect(unavailable, skill).toContain('Do not record a clean review when no reviewer completed.');
    }
  });
});
