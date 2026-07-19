import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

const skillPaths = [
  'ship/SKILL.md.tmpl',
  'ship/SKILL.md',
  'test/fixtures/golden/claude-ship-SKILL.md',
  'test/fixtures/golden/codex-ship-SKILL.md',
  'test/fixtures/golden/factory-ship-SKILL.md',
];

const engineeringHeadings = [
  '### Outcome',
  '### Problem and root cause',
  '### Investigation and decisions',
  '### Implementation',
  '### Verification',
  '### Risks and operational impact',
  '### Remaining work',
  '### Decision required',
];

describe('ship completion report', () => {
  for (const relativePath of skillPaths) {
    test(`${relativePath} requires a self-contained engineering handoff`, () => {
      const skill = readFileSync(join(root, relativePath), 'utf8');
      const handoff = skill.indexOf('## Step 22: Full engineering handoff');
      const workContext = skill.indexOf('## What this work was about', handoff);
      const engineeringSummary = skill.indexOf('## Engineering summary', handoff);
      const uiEvidence = skill.indexOf('### UI before/after evidence', handoff);
      const putSimply = skill.lastIndexOf('### Put simply');
      const uiEvidenceGate = skill.indexOf('3. **UI evidence gate:**');
      const pushStep = skill.indexOf('## Step 17: Push');

      expect(handoff).toBeGreaterThan(-1);
      expect(workContext).toBeGreaterThan(handoff);
      expect(engineeringSummary).toBeGreaterThan(workContext);
      expect(skill).toContain('Use each heading');
      expect(skill.slice(workContext, engineeringSummary)).toContain(
        'Assume the reader remembers nothing from the earlier conversation.',
      );
      expect(skill.slice(workContext, engineeringSummary)).toContain(
        'Name the product, system, or feature being changed',
      );
      expect(skill.slice(workContext, engineeringSummary)).toContain(
        'what it did before',
      );
      expect(skill.slice(workContext, engineeringSummary)).toContain(
        'the intended outcome',
      );

      let previousHeading = engineeringSummary;
      for (const heading of engineeringHeadings) {
        const headingIndex = skill.indexOf(heading, previousHeading);
        expect(headingIndex).toBeGreaterThan(previousHeading);
        previousHeading = headingIndex;
      }

      expect(uiEvidence).toBeGreaterThan(previousHeading);
      expect(skill).toContain('Write `None` when the completion contract is fully satisfied.');
      expect(skill).toContain('Write `None` when no decision is required.');
      expect(skill).toContain('matched **Before** and **After** screenshots');
      expect(skill).toContain('merge-base/base revision in an isolated worktree');
      expect(skill).toContain('current branch after implementation and verification');
      expect(skill).toContain('route, application state, data, viewport, theme, and zoom');
      expect(skill).toContain('Use safe test data; never expose credentials, customer data, or private information.');
      expect(skill).toContain('`![Before](path)` and `![After](path)` inline');
      expect(skill).toContain('include both artifact paths');
      expect(skill).toContain('Do not commit screenshot artifacts unless the repository explicitly requires it.');
      expect(skill).toContain('claim UI completion');
      expect(uiEvidenceGate).toBeGreaterThan(-1);
      expect(pushStep).toBeGreaterThan(uiEvidenceGate);
      expect(skill).toMatch(/do not\s+push or create\/update the PR\/MR/);
      expect(skill).toContain('STOP before Step 17');
      expect(skill).toContain('or offer a waiver');
      expect(putSimply).toBeGreaterThan(uiEvidence);
      expect(skill.slice(putSimply)).toContain('- **Why:**');
      expect(skill.slice(putSimply)).toContain('- **What:**');
      expect(skill.slice(putSimply)).toContain('- **How:**');
      expect(skill.slice(uiEvidence)).toContain('must stand on its own');
      expect(skill.slice(uiEvidence)).toContain('Name the concrete subject');
      expect(skill.slice(uiEvidence)).toContain('Never rely only on `it`, `this`, or `the change`');
      expect(skill.slice(handoff).match(/^### .+$/gm)?.at(-1)).toBe('### Put simply');
      expect(skill.slice(handoff).match(/^## Step /gm)?.length).toBe(1);
      expect(skill).not.toContain('output the PR URL at the end');
    });
  }
});
