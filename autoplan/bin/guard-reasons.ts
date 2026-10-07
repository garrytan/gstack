/**
 * Every /autoplan publication-guard outcome: one stable code, its disposition,
 * its text and its troubleshooting anchor. docs/autoplan-guard-troubleshooting.md
 * carries one anchor per code (test/autoplan-guard-reasons.test.ts holds both to it).
 *
 * Dispositions:
 * - `fallback`: retrying cannot help; the denial prints the supported fallback.
 * - `corrective`: the model or user must take the named action first.
 * - `transient`: names what to wait for.
 * - `unverified`: Claude Code made the session uncheckable; the call is allowed
 *   with a visible warning and a log line, and phase-report enforcement is skipped.
 */
export const GUIDE = 'https://github.com/garrytan/gstack/blob/main/docs/autoplan-guard-troubleshooting.md';

export type Disposition = 'fallback' | 'corrective' | 'transient' | 'unverified';
export type Detail = { phase?: string | number; keys?: string[]; cause?: string; size?: string; limit?: string };
interface Reason { disposition: Disposition; text: (d: Detail) => string }

export const FALLBACK = 'Fallback: run /plan-ceo-review, then /plan-devex-review, then /plan-eng-review by hand; ' +
  'or run /context-save, start a new Claude Code session (not --resume), run /context-restore, then /autoplan <plan path>.';
const PUBLISH_SEPARATELY = (d: Detail) => `Publish the filled Phase ${d.phase} report as your own parent assistant text in a message ` +
  `whose only tool call is the Bash no-op \`: autoplan-published <phase>\`, then make this phase-entry call in a later message.`;

export const REASONS = {
  // Journal ownership (lib/claude-public-transcript.ts OwnedTranscriptReason).
  competing_root: { disposition: 'fallback', text: () => 'The session journal has more than one conversation root, so this session cannot be identified.' },
  foreign_cwd: { disposition: 'fallback', text: () => "The session journal was started in a different project directory than this hook's project." },
  sidechain: { disposition: 'fallback', text: () => "The session journal's first turn or its ancestry is a sidechain record, not the parent session." },
  agent: { disposition: 'fallback', text: () => "The session journal's conversation ancestry passes through a subagent record." },
  cycle: { disposition: 'fallback', text: () => "The session journal's parent links form a cycle." },
  identity: { disposition: 'fallback', text: () => 'The session journal failed its identity checks (a link, a foreign session, the wrong directory layout, or a different or shrunken file).' },
  malformed: { disposition: 'fallback', text: () => 'A complete session journal record is not valid JSON or UTF-8, or its records contradict each other.' },
  journal_missing: { disposition: 'fallback', text: () => 'The session journal does not exist, so no missing-publication conclusion has been made.' },
  changing: { disposition: 'transient', text: () => 'Claude Code was still writing the session journal on every read. Wait for the current response to finish, then make this phase-entry call again; no missing-publication conclusion has been made.' },
  // Environment-unverifiable (UC1): allowed with a warning.
  unrecognized_shape: { disposition: 'unverified', text: d => `This Claude Code journal shape is not recognized (${d.cause}).` },
  journal_lag: { disposition: 'unverified', text: () => 'Claude Code has not written the previous assistant message to the session journal.' },
  rewritten: { disposition: 'unverified', text: () => 'The session journal was rewritten while the guard read it.' },
  too_large: { disposition: 'unverified', text: d => `A single session journal record is ${d.size ?? 'over the limit'}, over the ${d.limit} record limit /autoplan can verify.` },
  unseen_version: { disposition: 'unverified', text: d => `This Claude Code version passes the guard a tool input without ${d.keys?.join(', ')}, and gstack has not checked that version yet.` },
  // Current call and its batch.
  event_order: { disposition: 'fallback', text: () => 'The native parent event order is unavailable or inconsistent.' },
  tool_identity: { disposition: 'fallback', text: () => 'Two journal records claim the same native tool identity.' },
  current_mismatch: { disposition: 'fallback', text: () => 'Current native phase-entry identity is unavailable: the journal records this call with a different tool or input than Claude Code passed to the guard.' },
  agent_key: { disposition: 'fallback', text: d => `The reviewer dispatch carries input keys outside the allowed set (${d.keys?.join(', ')}). ` +
    (d.keys?.includes('model') ? 'A model override is not allowed for /autoplan reviewer dispatch. ' : '') +
    'Dispatch exactly the snapshot prompt with only prompt, description, subagent_type general-purpose and, if available, run_in_background.' },
  cross_phase_batch: { disposition: 'fallback', text: () => 'One assistant message enters two different phases. Each phase entry must go in its own message after the previous phase report.' },
  entry_pending: { disposition: 'transient', text: () => 'A prior phase-entry tool is still pending. Wait for its native result before requesting another phase.' },
  // Installation and invocation.
  hook_input: { disposition: 'corrective', text: () => 'Publication hook could not load its native input. Restore this /autoplan installation (run ./setup), then make this call again.' },
  evidence: { disposition: 'fallback', text: () => 'Autoplan phase evidence could not be parsed or changed while the guard read it.' },
  installation: { disposition: 'corrective', text: () => 'Hook installation or native evidence is unavailable. Restore this /autoplan installation (run ./setup), then make this call again.' },
  foreign_install: { disposition: 'corrective', text: () => 'Autoplan phase entry belongs to a different or unavailable installation. Restore this invocation’s hook installation (run ./setup), then make this call again.' },
  init_required: { disposition: 'corrective', text: () => 'Autoplan invocation evidence is unavailable. Complete the existing snapshot init step before phase entry.' },
  init_own: { disposition: 'corrective', text: () => 'This Autoplan invocation needs its own successful init before phase entry. Complete the existing snapshot init step.' },
  init_failed: { disposition: 'corrective', text: () => 'Autoplan initialization did not succeed. Complete the existing init step first.' },
  init_unbindable: { disposition: 'corrective', text: () => 'Autoplan invocation evidence is unavailable: snapshot init ran through a shell variable, substitution, chaining, ' +
    'a pipe or a redirect, which this guard cannot bind. Re-run it as one Bash call with the literal absolute paths: ' +
    '`bun "<SNAPSHOT_TOOL>" init "<SOURCE_PLAN>" "<ACTIVE_PLAN>" "<RESTORE_PATH>"` (it answers reused:true), then make this call again.' },
  init_mismatch: { disposition: 'fallback', text: () => 'Autoplan initialization artifacts do not match this parent invocation.' },
  snapshot: { disposition: 'fallback', text: d => `${d.cause ?? 'A native phase artifact is unavailable or changed'}. The immutable phase snapshot is missing or was changed.` },
  dispatch_prompt: { disposition: 'fallback', text: () => 'Native phase dispatch differs from its exact immutable snapshot prompt.' },
  phase_order: { disposition: 'corrective', text: () => 'Read the current Phase 1 CEO entry successfully before entering a later phase.' },
  // Phase close and publication.
  close_required: { disposition: 'corrective', text: d => `Finish the existing Phase ${d.phase} close procedure and Read its complete current close packet before entering the next phase.` },
  close_incomplete: { disposition: 'corrective', text: d => `Read every line of the current Phase ${d.phase} close packet successfully before entering the next phase.` },
  close_stale: { disposition: 'corrective', text: d => `${d.cause}. Finish the existing close procedure with a fresh packet.` },
  close_edits: { disposition: 'corrective', text: d => `${d.cause}. Repeat the existing close procedure.` },
  mutation_pending: { disposition: 'transient', text: () => 'An active-plan mutation is pending after the close Read. Wait for its result, then verify the current close input.' },
  publication_missing: { disposition: 'corrective', text: d => `Publish the filled Phase ${d.phase} report as your own parent assistant text now. The close packet or a saved report does not publish it. ` + PUBLISH_SEPARATELY(d) },
  publication_unflushed: { disposition: 'corrective', text: d => `The Phase ${d.phase} report is not yet followed by a journaled record, so Claude Code may not have written it. ` + PUBLISH_SEPARATELY(d) },
  publication_repeat: { disposition: 'fallback', text: d => `The Phase ${d.phase} report still cannot be verified after it was published separately once in this invocation.` },
} satisfies Record<string, Reason>;

export type ReasonCode = keyof typeof REASONS;
/** Codes the October 7 wave removed; their anchors stay so old reports still resolve. */
export const REMOVED_CODES = ['current_missing', 'pending_read'] as const;

export const anchor = (code: string) => code.replace(/_/g, '-');
export const reasonCode = (code: string): ReasonCode =>
  (code.startsWith('unrecognized_shape:') ? 'unrecognized_shape' : code) as ReasonCode;

/** The full denial or warning: cause, action, fallback, code, version and anchor. */
export function reasonText(code: string, detail: Detail = {}, claudeVersion?: string): string {
  const reason: Reason = REASONS[reasonCode(code)];
  const tail = `(code ${code}, Claude Code ${claudeVersion ?? 'version unknown'}). Troubleshooting: ${GUIDE}#${anchor(reasonCode(code))}`;
  if (reason.disposition === 'unverified')
    return `phase publication was NOT verified for this session (${code.startsWith('unrecognized_shape:') ? `journal shape ${code}` : code}): ` +
      `${reason.text(detail)} Phase-report enforcement was skipped for this call. ${tail}`;
  return `${reason.text(detail)}${reason.disposition === 'fallback' ? ` ${FALLBACK}` : ''} ${tail}`;
}
