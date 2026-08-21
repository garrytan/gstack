import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const BROWSER_ROUTING_GUIDANCE = [
  'first-party web search/fetch for research and source lookup',
  'g-stack /browse for rendered-page interaction, visual or responsive qa, screenshots',
  'dom/console/network inspection, downloads, local html rendering, or persistent browser state',
  'never use mcp__claude-in-chrome__* tools',
  'pin each concurrent browser task to its own tab id',
  '--tab-id',
  'browse_tab',
  'serialize browser work',
] as const;

function expectBrowserRoutingGuidance(source: string): void {
  const normalized = source.toLowerCase().replaceAll('\\', '');
  for (const text of BROWSER_ROUTING_GUIDANCE) {
    expect(normalized).toContain(text);
  }
  expect(normalized).not.toMatch(/\/browse(?: skill)?(?: from gstack)? for all web browsing/);
}

describe('browser routing guidance', () => {
  test('installation prompt separates research from interactive browser work', () => {
    const installPrompt = README.slice(
      README.indexOf('### Step 1: Install on your machine'),
      README.indexOf('### Step 2: Team mode'),
    );
    expectBrowserRoutingGuidance(installPrompt);
  });

  test('troubleshooting snippet separates research from interactive browser work', () => {
    const troubleshootingSnippet = README.slice(
      README.indexOf("**Claude says it can't see the skills?**"),
      README.indexOf('## License'),
    );
    expectBrowserRoutingGuidance(troubleshootingSnippet);
  });
});
