/**
 * autoplan/DRIVER.md resolvers (field wave item 13): the compact entry a parent
 * agent on any host reads to drive an unattended /autoplan run through
 * `gstack-autoplan`, instead of autoplan/SKILL.md. Every list comes from code:
 * the phase order (PHASES), the scope flags (SCOPE_FLAG_TOKENS), the run
 * directory files (FILES), the reviewer RESULT FORMAT, the result codes
 * (RESULT_CODES). The command lines and the gate reply forms are stated once
 * here; test/autoplan-driver.test.ts checks them against `gstack-autoplan
 * --help` and the gate parser.
 */
import { FILES } from '../../lib/autoplan-state';
import { PHASES, RESULT_FORMAT } from '../../lib/autoplan-prompts';
import { SCOPE_FLAG_TOKENS } from '../../lib/autoplan-scope';
import { RESULT_CODES } from '../../lib/result-codes';
import { DEFAULT_HOST_ESTIMATE_USD, DEFAULT_MAX_ROUNDS } from '../../lib/autoplan-budget';
import type { ResolverFn } from './types';

/** One entry per command line the loop runs, as the field-wave plan specifies them. */
export const AUTOPLAN_DRIVER_COMMANDS: Array<{ cmd: string; does: string }> = [
  { cmd: 'gstack-autoplan next --out <dir> --plan <plan.md> [scope flags] [--light] [--spend-cap <usd>] [--max-rounds <n>] [--scaffold]', does: `first call: init the run, print PHASE:, SCOPE:, DRIVER: and one ATTEMPT: per voice; --max-rounds caps review rounds per phase (default ${DEFAULT_MAX_ROUNDS} unattended), and an unattended Capy run reserves ${DEFAULT_HOST_ESTIMATE_USD.toFixed(2)} per host attempt unless --estimate-usd <n> says otherwise, so --spend-cap binds` },
  { cmd: 'gstack-autoplan next --out <dir> [--redispatch <attempt>]', does: 'later calls: open the next phase or reprint open attempts; never redispatches on its own' },
  { cmd: 'gstack-autoplan submit --out <dir> --phase <p> --voice native|outside --record <file.md> --model <id> [--attempt <id>]', does: 'bind a free-form review record (canonical fence, one findings table or list, or `No findings.`)' },
  { cmd: 'gstack-autoplan submit ... --record <file.md> --attest "<reason>" --attempt <id>', does: 'bind a record with no INPUT: line as receipt: attested (a wrong INPUT: always refuses)' },
  { cmd: 'gstack-autoplan submit --out <dir> --phase <p> --voice native|outside --result <file> --model <id> --attempt <id> [--reconcile <jsonl>]', does: 'bind a canonical result (the RESULT FORMAT below); on the submit that closes the phase, `--reconcile` takes your own pairing of findings both voices raised, one `{"outside_id","native_id","disposition","resolution"}` row each, over the structural one' },
  { cmd: 'gstack-autoplan submit --out <dir> --phase <p> --voice outside --unavailable|--failed "<reason>"', does: 'close the phase native-only when no outside voice can run' },
  { cmd: 'gstack-autoplan answer --out <dir> --gate-rev <n> --reply "<reply>" --by human|agent:<id> [--owner-reply <text>|-] [--rec-hash <h>]', does: 'answer the gate with the reply grammar below; an agent answer stores the owner\'s words verbatim' },
  { cmd: 'gstack-autoplan recommend --out <dir> --gate-rev <n> --item <id> --option <k> --basis "<why>"', does: 'change one recommendation before relay; then render and relay again (a `rec` needs the new `--rec-hash`)' },
  { cmd: 'gstack-autoplan revise --out <dir> --plan <plan v2> --incorporates <decision ids>', does: 'bind the amended plan; reopens every phase whose reviewed plan changed, Eng last' },
  { cmd: 'gstack-autoplan revise --out <dir> --settle <decision id|d4>', does: 'discharge a packaging or ordering change with no plan edit; reopens nothing' },
  { cmd: 'gstack-autoplan revise --out <dir> --withdraw <decision id>', does: 'drop a pending amendment instead of applying it' },
  { cmd: 'gstack-autoplan close --out <dir> --phase <p> --deferred "<reason>" --by human|agent:<id>', does: 'close a phase accepted-with-findings: its open findings go to tasks.jsonl, and Critical, urgent or user-challenge findings become gate items; also the recovery from `STOP: reason=budget_exhausted`' },
  { cmd: 'gstack-autoplan budget --out <dir> [--spend-cap <usd>] [--max-rounds <n>] --by human|agent:<id>', does: 'the owner\'s journaled cap raise; after a budget stop, `resume` continues the run' },
  { cmd: 'gstack-autoplan export --out <dir>', does: 'write the artifact set; then `gstack-artifact validate <dir>/run.json`' },
  { cmd: 'gstack-autoplan export --out <dir> --public <pub>', does: 'a machine-path-free copy to commit or share (recorded roots rewritten, plan.md code kept, provenance digests); the private run is not touched; then `gstack-artifact validate --public <pub> --private <dir>/run.json` on this machine' },
  { cmd: 'gstack-autoplan status|resume --out <dir>', does: 'read the manifest (PENDING: lines name open attempts); take ownership after a crash (EXECUTION_UNKNOWN lists unfinished attempts)' },
  { cmd: 'gstack-autoplan resume --out <new dir> --from <checkpoint>', does: 'restore the newest valid checkpoint generation (GSTACK_AUTOPLAN_CHECKPOINT_DIR) into an empty directory and take ownership; `checkpoints --from <dir>` lists them' },
];

/** The reply grammar `gstack-gate` parses, one form per line. */
export const GATE_REPLY_FORMS: Array<{ reply: string; means: string }> = [
  { reply: 'rec', means: 'every item takes its recommendation, plan changes included (each prints APPLY:); `all` and `do it` are aliases' },
  { reply: 'as-is', means: 'keep every direction; no plan change' },
  { reply: 'd3b uc1a', means: 'one <id><option> token per item you set; unanswered auto items take their default' },
  { reply: 'rec except d3b', means: 'recommendations, with the listed overrides' },
];

/** Result codes the loop can print, in the order a run meets them. */
export const DRIVER_CODES = ['RUN_NOT_INITIALIZED', 'PLAN_SECTIONS_INVALID', 'RUN_LOCKED', 'EXECUTION_UNKNOWN', 'SPEND_CAP_EXCEEDED', 'PHASE_NOT_AWAITING', 'ATTEMPT_MISMATCH',
  'RESULT_RECEIPT_MISSING', 'RESULT_FINDINGS_MISSING', 'MODEL_FAMILY_CONFLICT', 'CONSENSUS_MISSING', 'GATE_REV_STALE', 'GATE_REPLY_UNPARSED', 'GATE_REC_STALE', 'OWNER_REPLY_REQUIRED', 'GATE_OWNER_REPLY_MISMATCH', 'PLAN_AMEND_PENDING', 'AMENDMENT_NOT_SETTLEABLE', 'CHECKPOINT_INVALID', 'GSTACK_VERSION_CHANGED'] as const;
/** Fix text for codes the plan specifies and lane B-core adds to lib/result-codes.ts; the table's own fix wins once it exists. */
const PENDING_FIX: Record<string, string> = {
  PLAN_SECTIONS_INVALID: 'the plan needs one `## Implementation plan` and one `## Review record`; rerun `next --scaffold` to wrap a plan that has neither',
  PLAN_AMEND_PENDING: 'edit the plan for each APPLY: line and run `revise --incorporates <ids>`, or `revise --withdraw <id>`',
  GSTACK_VERSION_CHANGED: 'notice only: the run was started on another gstack; forward migrations ran and were journaled',
};

export const generateAutoplanDriverPhases: ResolverFn = () => [
  `Order: ${PHASES.join(' → ')}. Design runs only with UI scope, DX only with DX scope, Eng always and last.`,
  `Scope flags on the first \`next\`: ${SCOPE_FLAG_TOKENS.map(t => `\`${t}\``).join(', ')}. \`--developer-tool\` and \`--agent-primary\` only enable DX.`,
].join('\n');

export const generateAutoplanDriverCommands: ResolverFn = () =>
  AUTOPLAN_DRIVER_COMMANDS.map(c => `- \`${c.cmd}\`\n  ${c.does}.`).join('\n');

export const generateAutoplanDriverGate: ResolverFn = () =>
  GATE_REPLY_FORMS.map(f => `- \`${f.reply}\`: ${f.means}.`).join('\n');

export const generateAutoplanDriverFiles: ResolverFn = () =>
  `Runner state: ${Object.values(FILES).map(f => `\`${f}\``).join(', ')}.`;

export const generateAutoplanDriverResultFormat: ResolverFn = () =>
  RESULT_FORMAT('<phase>', '<snapshot sha256>', '<result file>').replace(/^\n---\n/, '').trimEnd();

export const generateAutoplanDriverCodes: ResolverFn = () => DRIVER_CODES.map(code => {
  const row = (RESULT_CODES as Record<string, { fix: string }>)[code];
  return `- \`${code}\`: ${row?.fix ?? PENDING_FIX[code]}`;
}).join('\n');
