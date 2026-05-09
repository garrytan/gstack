/**
 * Final ship step.
 *
 * After all phases are committed, spawn the configured ship and land roles
 * to run `/ship` followed by `/land-and-deploy`. We delegate to the
 * existing gstack skills rather than calling `gh pr create` directly
 * because those skills enforce CI/CD safety gates that we don't want
 * to bypass.
 *
 * Returns the SubAgentResult so the driver can record outcome and log.
 */

import { runShip, runSlashCommand, type SubAgentResult } from './sub-agents';
import type { RoleConfig } from './role-config';
import { ensureLogDir, logDir } from './state';
import * as fs from 'fs';
import * as path from 'path';

export async function shipAndDeploy(args: {
  cwd: string;
  slug: string;
  shipRole: RoleConfig;
  landRole: RoleConfig;
}): Promise<SubAgentResult> {
  return runShip({
    cwd: args.cwd,
    slug: args.slug,
    ship: {
      provider: args.shipRole.provider,
      model: args.shipRole.model,
      reasoning: args.shipRole.reasoning,
      command: args.shipRole.command || '/gstack-ship',
    },
    land: {
      provider: args.landRole.provider,
      model: args.landRole.model,
      reasoning: args.landRole.reasoning,
      command: args.landRole.command || '/gstack-land-and-deploy',
    },
  });
}

export async function shipOnly(args: {
  cwd: string;
  slug: string;
  shipRole: RoleConfig;
}): Promise<SubAgentResult> {
  ensureLogDir(args.slug);
  const shipInput = path.join(logDir(args.slug), 'ship-input.md');
  const shipOutput = path.join(logDir(args.slug), 'ship-output.md');
  fs.writeFileSync(
    shipInput,
    `Run ${args.shipRole.command || '/gstack-ship'} for this repository. Report exactly what happened.`,
  );
  fs.writeFileSync(shipOutput, '');
  return runSlashCommand({
    inputFilePath: shipInput,
    outputFilePath: shipOutput,
    cwd: args.cwd,
    slug: args.slug,
    logPrefix: 'ship',
    role: {
      provider: args.shipRole.provider,
      model: args.shipRole.model,
      reasoning: args.shipRole.reasoning,
      command: args.shipRole.command || '/gstack-ship',
    },
    timeoutMs: 60 * 60 * 1000,
    gate: false,
  });
}

export async function landOnly(args: {
  cwd: string;
  slug: string;
  landRole: RoleConfig;
}): Promise<SubAgentResult> {
  ensureLogDir(args.slug);
  const landInput = path.join(logDir(args.slug), 'land-and-deploy-input.md');
  const landOutput = path.join(logDir(args.slug), 'land-and-deploy-output.md');
  fs.writeFileSync(
    landInput,
    `Run ${args.landRole.command || '/gstack-land-and-deploy'} for this repository. Report exactly what happened.`,
  );
  fs.writeFileSync(landOutput, '');
  return runSlashCommand({
    inputFilePath: landInput,
    outputFilePath: landOutput,
    cwd: args.cwd,
    slug: args.slug,
    logPrefix: 'land-and-deploy',
    role: {
      provider: args.landRole.provider,
      model: args.landRole.model,
      reasoning: args.landRole.reasoning,
      command: args.landRole.command || '/gstack-land-and-deploy',
    },
    timeoutMs: 60 * 60 * 1000,
    gate: false,
  });
}
