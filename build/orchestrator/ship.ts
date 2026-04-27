/**
 * Final ship step.
 *
 * After all phases are committed, spawn a single Claude Code subprocess
 * to run `/ship` followed by `/land-and-deploy`. We delegate to the
 * existing gstack skills rather than calling `gh pr create` directly
 * because those skills enforce CI/CD safety gates that we don't want
 * to bypass.
 *
 * Returns the SubAgentResult so the driver can record outcome and log.
 */

import { runShip, type SubAgentResult } from './sub-agents';

export async function shipAndDeploy(args: {
  cwd: string;
  slug: string;
}): Promise<SubAgentResult> {
  return runShip({ cwd: args.cwd, slug: args.slug });
}
