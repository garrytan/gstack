import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('generated release workflow rollout', () => {
  test('ship uses one strict anchored decision and retires only after the ShipReceipt', () => {
    const ship = read('ship/SKILL.md.tmpl');
    expect(ship).toContain('$GSTACK_ANCHOR_INVOCATION gstack-version-bump classify');
    expect(ship).toContain('--lane "$ECPE_EXECUTION_LANE"');
    expect(ship).toContain('RELEASE_APPLICABLE');
    expect(ship).toContain('RELEASE_TITLE_POLICY');
    expect(ship).toContain('RELEASE_REQUEST_ARGS');
    expect(ship).toContain('$GSTACK_ANCHOR_INVOCATION gstack-pr-title-rewrite');
    expect(ship).not.toContain('gstack-pr-title-rewrite.sh');
    expect(ship).not.toContain('bun run ~/.claude/skills/gstack/bin/gstack-version-bump');
    expect(ship).not.toContain('CANARY_HANDOFF_ASSERTIONS=(--lane auto)');
    const receipt = ship.indexOf('gstack-ship-handoff create');
    const retire = ship.indexOf('gstack-version-bump retire');
    expect(receipt).toBeGreaterThan(0);
    expect(retire).toBeGreaterThan(receipt);
  });

  test('PR body consumes policy-derived title and carries exact provider identity into ShipReceipt', () => {
    const body = read('ship/sections/pr-body.md.tmpl');
    expect(body).toContain('$GSTACK_ANCHOR_INVOCATION gstack-pr-title-rewrite');
    expect(body).toContain('--lane "$ECPE_EXECUTION_LANE"');
    expect(body).toContain('PROVIDER_TITLE_ASSERTIONS');
    expect(body).toContain('--assert-release-mode "$RELEASE_MODE"');
    expect(body).toContain('PR_TITLE_CANDIDATE');
    expect(body).toContain('discover --skill ship');
    expect(body).toContain('Never issue a raw provider lookup in the new-PR branch');
    expect(body).not.toMatch(/\b(?:gh pr view|glab mr view)\b/);
    expect(body).toContain('PR_NUMBER=$(printf');
    expect(body).toContain('PROVIDER_PR_ACTION_ARGS=(update --pr "$PR_NUMBER")');
    expect(body).toContain('--provider "$PROVIDER_KIND"');
    expect(body).toContain('PR_NUMBER=$RESULT_PR_NUMBER');
    expect(body).not.toContain('gstack-pr-title-rewrite.sh');
    expect(body).not.toContain('Always update the PR title to start with `v$NEW_VERSION`');
  });

  test('documentation mutation precedes release write and the PR section cannot mutate it again', () => {
    const ship = read('ship/SKILL.md.tmpl');
    const body = read('ship/sections/pr-body.md.tmpl');
    expect(ship.indexOf('## Step 11.5: Documentation sync')).toBeLessThan(ship.indexOf('## Step 12: Resolve and apply the release decision'));
    expect(ship.indexOf('## Step 11.5: Documentation sync')).toBeLessThan(ship.indexOf('gstack-version-bump write'));
    expect(body).toContain('## Step 18: Documentation handoff');
    expect(body).not.toContain('Dispatch /document-release as a subagent');
  });

  test('land always sends the exact ShipReceipt into the fused merge authority', () => {
    const workflow = read('land-and-deploy/SKILL.md.tmpl');
    const readiness = read('land-and-deploy/sections/readiness-gate.md.tmpl');
    const merge = read('land-and-deploy/sections/merge-and-deploy.md.tmpl');
    expect(workflow).not.toContain('QUEUE_JSON=$(bun run ~/.claude/skills/gstack/bin/gstack-next-version');
    expect(workflow).toContain('drift_status=not_applicable');
    expect(workflow).toContain('LANDING_COMPLETE=1');
    expect(workflow).toContain('raw provider state is not typed terminal evidence');
    expect(readiness).toContain('$GSTACK_ANCHOR_INVOCATION gstack-ship-handoff inspect');
    expect(readiness).toContain('SHIP_RELEASE_APPLICABLE');
    expect(readiness).toContain('SHIP_RELEASE_DRIFT_STATUS');
    expect(merge).toContain('LANDING_ASSERTIONS=(--assert-ship-receipt "$SHIP_RECEIPT_ID")');
    expect(merge).toContain('provider-merge discover');
    expect(merge.indexOf('provider-merge discover')).toBeLessThan(merge.indexOf('provider-merge direct'));
    expect(merge).toContain('delivery.merged');
    expect(merge).toContain('providerBaseAtomicity');
  });
});
