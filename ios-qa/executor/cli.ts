#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { buildXCUITestPlan } from './xcuitest-plan';
import type { IOSQAFlow, IOSQATarget, XCUITestRunnerConfig } from './contract';

function usage(): never {
  console.error('usage: bun ios-qa/executor/cli.ts <flow.json> <target.json> <runner.json>');
  process.exit(2);
}

const [, , flowPath, targetPath, runnerPath] = process.argv;
if (!flowPath || !targetPath || !runnerPath) usage();

try {
  const flow = JSON.parse(readFileSync(flowPath, 'utf8')) as IOSQAFlow;
  const target = JSON.parse(readFileSync(targetPath, 'utf8')) as IOSQATarget;
  const runner = JSON.parse(readFileSync(runnerPath, 'utf8')) as XCUITestRunnerConfig;
  const result = buildXCUITestPlan(flow, target, runner, flowPath);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'ready') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: 'blocked', reason: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
