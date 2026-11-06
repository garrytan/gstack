/**
 * GST-1688: a cleared pregate.json/remote_gate stands in for a /ship lane whose ship_lanes_from inventory refuses HEAD's own
 * tree (gbrain's runs_may_attest refuses, on purpose, a tree that changes CI-reuse files). It stands in only when the
 * repository's pregate.json was recorded for HEAD's exact tree and verifies (gstack-pregate verify), and its remote_gate
 * receipt is the gate's own report for that same tree: `remote-gate tree=<HEAD's tree> tests=<n>`, n > 0, run on that tree
 * rather than accepted from a stamp-only predecessor, cleared within the evidence max age, by a pregate run against
 * origin/<base> under origin/<base>'s own policy (the one whose ship_lanes_from maps the lane, so the gate command is that
 * policy's). Anything else returns why, and the lane stops as before.
 */
import * as path from 'node:path';
import { REMOTE_GATE_LANE } from './pregate/checks/lanes';
import { PREGATE_OUT_REL, readPregateFile, verifyPregate } from './pregate/index';
import { DEFAULT_MAX_AGE_HOURS } from './run-evidence';

export type RemoteGateStandIn = { ok: true; receipt: string; tests: number; clearedAt: string } | { ok: false; why: string };

export function remoteGateStandIn(repoRoot: string, tree: string, base: string, now = Date.now()): RemoteGateStandIn {
  const short = tree.slice(0, 12);
  const baseRef = `origin/${base.replace(/^origin\//, '')}`;
  const { file } = readPregateFile(path.join(repoRoot, PREGATE_OUT_REL));
  if (!file) return { ok: false, why: `no readable ${PREGATE_OUT_REL}` };
  if (file.tree !== tree) return { ok: false, why: `${PREGATE_OUT_REL} was recorded for tree ${file.tree.slice(0, 12)}, not HEAD's tree ${short}` };
  if (!file.base?.startsWith(`${baseRef}@`)) return { ok: false, why: `${PREGATE_OUT_REL} was recorded against ${file.base ?? 'no base'}, not ${baseRef}` };
  if (!file.policy?.startsWith(`${baseRef}@`)) return { ok: false, why: `${PREGATE_OUT_REL} ran under policy ${file.policy ?? 'unrecorded'}, not ${baseRef}'s .gstack/pregate.json` };
  const verified = verifyPregate(repoRoot, file);
  if (!verified.ok) return { ok: false, why: `gstack-pregate verify refuses it (${verified.code}: ${verified.message})` };
  const gate = file.requires_remote?.find(r => r.lane === REMOTE_GATE_LANE);
  if (!gate?.receipt) return { ok: false, why: `${PREGATE_OUT_REL} holds no cleared ${REMOTE_GATE_LANE}` };
  if (gate.substitution) return { ok: false, why: `its receipt was accepted from gated tree ${gate.substitution.gated_tree.slice(0, 12)}, not run on ${short}` };
  const report = /^remote-gate tree=([0-9a-f]{12}) tests=(\d+)(?: |$)/.exec(gate.receipt);
  if (!report) return { ok: false, why: `its receipt (${gate.receipt}) is not the remote gate's own report` };
  if (report[1] !== short) return { ok: false, why: `its receipt names tree ${report[1]}, not HEAD's tree ${short}` };
  if (Number(report[2]) <= 0) return { ok: false, why: 'its receipt reports 0 tests' };
  const clearedAt = /(\S+)$/.exec(gate.cleared_by ?? '')?.[1];
  if (!clearedAt || Number.isNaN(Date.parse(clearedAt))) return { ok: false, why: `its clear records no time (cleared_by: ${gate.cleared_by ?? 'none'})` };
  const age = now - Date.parse(clearedAt);
  if (!(age >= 0 && age <= DEFAULT_MAX_AGE_HOURS * 3600_000)) return { ok: false, why: `its clear at ${clearedAt} is not within the last ${DEFAULT_MAX_AGE_HOURS}h; rerun the remote gate` };
  return { ok: true, receipt: gate.receipt, tests: Number(report[2]), clearedAt: new Date(clearedAt).toISOString() };
}
