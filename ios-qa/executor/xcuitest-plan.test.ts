import { describe, expect, test } from 'bun:test';
import type { IOSQAFlow, XCUITestRunnerConfig } from './contract';
import { buildXCUITestPlan, selectorCandidates } from './xcuitest-plan';

const runner: XCUITestRunnerConfig = {
  projectPath: '/tmp/GStackIOSQARunner.xcodeproj',
  scheme: 'GStackIOSQARunner',
  testIdentifier: 'GStackIOSQARunnerUITests/FlowTests/testFlow',
};

const flow: IOSQAFlow = {
  version: 1,
  name: 'login',
  steps: [
    { id: 'launch', action: 'launch' },
    { id: 'email', action: 'typeText', selector: { identifier: 'login.email', label: 'Email', role: 'textField' }, text: 'qa@example.com' },
    { id: 'submit', action: 'tap', selector: { identifier: 'login.submit', label: 'Sign in', role: 'button' }, verify: { kind: 'exists', selector: { identifier: 'home.title' } } },
  ],
};

describe('buildXCUITestPlan', () => {
  test('orders stable identifiers before labels and preserves role narrowing', () => {
    expect(selectorCandidates({ identifier: 'cart.checkout', label: 'Checkout', role: 'button' })).toEqual([
      { strategy: 'identifier', value: 'cart.checkout', role: 'button' },
      { strategy: 'label', value: 'Checkout', role: 'button' },
    ]);
  });

  test.each([
    [{ kind: 'simulator', udid: 'SIM-1' } as const, 'simulator', 'iOS Simulator'],
    [{ kind: 'device', udid: 'PHONE-1' } as const, 'device', 'iOS'],
  ])('routes %s through the same semantic flow contract', (target, kind, platform) => {
    const result = buildXCUITestPlan(flow, target, runner, './flow.json');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.plan.target.kind).toBe(kind);
    expect(result.plan.command.args).toContain(`platform=${platform},id=${target.udid}`);
    expect(result.plan.command.args).toContain(`-only-testing:${runner.testIdentifier}`);
    expect(result.plan.command.args).toContain(`GSTACK_IOS_QA_TARGET_KIND_VALUE=${kind}`);
    expect(result.plan.command.env.GSTACK_IOS_QA_TARGET_KIND).toBe(kind);
    expect(JSON.parse(Buffer.from(result.plan.command.env.GSTACK_IOS_QA_FLOW_JSON_BASE64, 'base64').toString('utf8'))).toMatchObject({
      version: 1,
      name: 'login',
    });
    expect(result.plan.command.args.some((arg) => arg.startsWith('GSTACK_IOS_QA_FLOW_JSON_BASE64_VALUE='))).toBe(true);
    expect(result.plan.flow.steps[1]).toMatchObject({ timeoutMs: 10_000 });
    expect(result.plan.capabilities.coordinateTaps).toBe(false);
    expect(result.plan.capabilities.semanticSelectors).toEqual(['identifier', 'role', 'label']);
  });

  test('returns unsupported instead of guessing a coordinate for an unresolvable selector', () => {
    const bad: IOSQAFlow = { ...flow, steps: [{ id: 'mystery', action: 'tap', selector: { role: 'button' } }] };
    expect(buildXCUITestPlan(bad, { kind: 'simulator', udid: 'SIM-1' }, runner, './flow.json')).toEqual({
      status: 'unsupported',
      reason: 'selector needs an accessibility identifier or label',
      stepId: 'mystery',
    });
  });

  test('blocks before execution when runner configuration is ambiguous', () => {
    const result = buildXCUITestPlan(flow, { kind: 'device', udid: 'PHONE-1' }, { ...runner, workspacePath: '/tmp/a.xcworkspace' }, './flow.json');
    expect(result).toMatchObject({ status: 'blocked', reason: 'runner needs exactly one projectPath or workspacePath' });
  });

  test('builds argv without shell interpolation for physical devices', () => {
    const result = buildXCUITestPlan(flow, { kind: 'device', udid: 'PHONE 1; touch /tmp/pwned' }, runner, './flow.json');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.plan.command.executable).toBe('xcodebuild');
    expect(result.plan.command.args).toContain('platform=iOS,id=PHONE 1; touch /tmp/pwned');
    expect(result.plan.command.args).not.toContain('touch');
  });

  test('reports malformed JSON actions and target kinds as unsupported', () => {
    const badAction = { ...flow, steps: [{ id: 'bad', action: 'coordinateTap', x: 10, y: 20 }] } as unknown as IOSQAFlow;
    expect(buildXCUITestPlan(badAction, { kind: 'simulator', udid: 'SIM-1' }, runner, './flow.json')).toMatchObject({
      status: 'unsupported', reason: 'action coordinateTap is unsupported', stepId: 'bad',
    });
    expect(buildXCUITestPlan(flow, { kind: 'watch' as 'device', udid: 'WATCH-1' }, runner, './flow.json')).toMatchObject({
      status: 'unsupported', reason: 'target kind watch is unsupported',
    });
  });
});
