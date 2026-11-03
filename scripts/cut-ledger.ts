/**
 * R56 cut ledger (GST-1088): the pieces cut from one skill's render in every
 * loadout and on every host. modules/cuts.json is the hand-written source;
 * test/cut-ledger.test.ts is its ratchet. Each cut is a skill-qualified
 * module id (`part:<skill>/<name>`) that `gstack-modules list` shows with
 * status cut. A cut with `preamble_piece` is applied by preambleSections()
 * for that skill alone; any other cut was removed from the skill's template,
 * and the ratchet keeps its `match` text out of every generated SKILL.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
export const CUT_LEDGER_FILE = 'modules/cuts.json';

export interface CutEntry {
  id: string;
  skill: string;
  status: 'cut';
  /** Where the cut text lived; restoring it starts here. */
  source: string;
  /** Text that marks the piece in a generated SKILL.md; the ratchet fails when it reappears. */
  match: string;
  /** PREAMBLE_PIECES id this cut removes from the skill's preamble. */
  preamble_piece?: string;
  why: string;
  evidence: string;
}

export interface CutLedger {
  version: 1;
  note: string;
  cuts: CutEntry[];
  /** Always-loaded bytes of <skill>/SKILL.md (frontmatter included) per targeted skill: an exact ratchet. */
  pins: Record<string, number>;
  /** Who approves a restore or a raised pin. */
  approver: string;
}

let cached: CutLedger | undefined;

export function loadCutLedger(root = ROOT): CutLedger {
  if (root === ROOT && cached) return cached;
  const ledger = JSON.parse(fs.readFileSync(path.join(root, CUT_LEDGER_FILE), 'utf-8')) as CutLedger;
  if (root === ROOT) cached = ledger;
  return ledger;
}

/** PREAMBLE_PIECES ids cut from this skill's preamble. */
export function preambleCuts(skill: string): Set<string> {
  return new Set(loadCutLedger().cuts.filter(c => c.skill === skill && c.preamble_piece).map(c => c.preamble_piece!));
}
