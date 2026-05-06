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

import { runShip, type SubAgentResult } from './sub-agents';
import type { RoleConfig } from './role-config';

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
