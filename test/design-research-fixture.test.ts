import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractDesignResearchContract } from './helpers/skill-fixture';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const source = readFileSync(new URL('../design-consultation/SKILL.md', import.meta.url), 'utf8');

test('research-only fixture supplies actual readiness and egress dependencies without expanding scope', () => {
  const contract = extractDesignResearchContract(source);
  expect(contract.match(/console\.log\("ASIDE_READY /g)).toHaveLength(1);
  expect(contract).toContain('GSTACK_SKIP_ASIDE');
  expect(contract).toContain('Reuse the Phase 0 BROWSER SETUP result');
  expect(contract).toContain('_gstack_egress_run open aside-agent');
  expect(contract.indexOf('ASIDE_READY')).toBeLessThan(contract.indexOf('## Web research runs in Aside'));
  expect(contract).not.toContain('## Phase 2: Research');
  expect(contract).not.toContain('**Step 2: Visual research');
  expect(contract).not.toContain('best websites {current year}');
  expect(contract).not.toContain('DESIGN.md');
  expect(extractDesignResearchContract(source.replace('ASIDE_READY', 'PROBE_CHANGED'))).toContain('PROBE_CHANGED');
});

test.each(['## BROWSER SETUP', '### Rules for driving a real browser', '## Web research runs in Aside',
  '## Phase 2: Research', '**Step 1: Identify', '**Step 2: Visual research', '_aside_exec()'])('missing %s fails closed before a paid run', marker => {
  expect(() => extractDesignResearchContract(source.replace(marker, 'REMOVED'))).toThrow();
});

test('research fixture changes select their actual live consumer', () => {
  for (const file of ['test/helpers/skill-fixture.ts', 'test/design-research-fixture.test.ts']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toContain('design-consultation-research');
  }
});
